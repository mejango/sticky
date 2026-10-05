/**
 * A token's Juicebox project metadata: the name and logo of the project whose ERC-20 a Sticky token stakes, and the
 * launch a Sticky project's own uri carries. A project's uri is either a `data:` URI, read in place, or an
 * `ipfs://` one, whose document comes through Center's gateway; content addressed, so a document read once is that
 * document for good. Anything else is not read: a project's uri is written by whoever owns it, and a server must
 * not be sent to fetch whatever URL they name.
 *
 * What is untrusted here is kept to a small, checked shape (`ProjectMetadata`), because it is rendered and kept in
 * the browser's storage: a logo is an https URL without credentials, a name is text, and the rest of a document is
 * left where it was. A launch is read from a data uri only, never from a fetched document: a launch writes its own
 * uri inline, and a document is free text from its owner, whose launch fields would be kept in the browser too.
 */

import type { Address } from 'viem'
import { untilAborted } from '@/lib/hook-logs'
import { jbCenterPublicClient } from '@/lib/jbcenter-rpc'
import { controllerAbi, stickyDeployerAbi, tokensAbi } from '@/lib/sticky-abis'
import { deploymentOn } from '@/lib/sticky-addresses'
import { withTimeout } from '@/lib/with-timeout'

/**
 * Juicebox Center's IPFS gateway, the one the other Juicebox sites use. ipfs.io and dweb.link are sunset.
 *
 * A fetched document is kept in the browser as `reduced` shapes it, with its logo at this gateway. Changing the
 * gateway, or what `reduced` keeps, means bumping METADATA_VERSION, or a browser goes on reading a document as an
 * earlier version kept it.
 */
export const IPFS_GATEWAY = 'https://juicebox.center/ipfs/'

/** The version of what is kept of a fetched document. `useProjectMetadata` puts it in the document's query key. */
export const METADATA_VERSION = 'v1'

const MAX_URL_LENGTH = 8_192
/** A name any longer is not a project's name, and would be kept in the browser as it stands. */
const MAX_NAME_LENGTH = 256
const MAX_CHAINS = 32
/** A launch id is a UUID; one longer is not a launch's, and is not kept. */
const MAX_LAUNCH_ID_LENGTH = 128
/** How long the gateway has to answer: a project shows without its logo, so a slow gateway should not hold a page. */
const DOCUMENT_TIMEOUT_MS = 10_000
/** How much of a document is read. A project's metadata is a few kilobytes; the owner can point its uri at any file. */
const MAX_DOCUMENT_BYTES = 1_000_000
/** A path segment of a gateway URL: a CID or a file name, with no escape, separator or query in it. */
const SEGMENT = /^[A-Za-z\d._~-]{1,128}$/

/** What a Sticky launch writes in its project's uri, a data URI of `{protocol: 'Sticky', version, launchId,
 * environment, chains}`: the launch id its copies share, and the chains it was planned on. Each is null when the uri
 * has none that reads. */
export type StickyUri = { protocol: 'Sticky'; launchId: string | null; chains: number[] | null }

/** All that is kept of a project's uri. `logoUri` is an https URL, the gateway's for an ipfs one. Render it with
 * `next/image` unoptimized: the image optimizer is set up for Center's gateway only, and a logo can be on any https
 * host. `sticky` is there only when the uri is a data uri that is a Sticky launch's. */
export type ProjectMetadata = { name?: string; logoUri?: string; sticky?: StickyUri }

type Cancel = { signal?: AbortSignal }

export type MetadataOptions = Cancel & {
  /** In tests, the fetch to use instead of the browser's. */
  fetch?: typeof fetch
}

/**
 * The gateway URL of an `ipfs://` uri, or null when it is not one, or its path is not a plain CID and file names.
 * The strictness is on purpose: no dot segment, escape, query or authority can turn the URL into another path on
 * the gateway's host, and at most eight segments of 128 characters keep a URL, and what is stored under it, short.
 * A leading `ipfs/` segment, which some tools write, is dropped.
 */
export function ipfsGatewayUrl(uri: string): string | null {
  if (!/^ipfs:\/\//i.test(uri)) return null
  const segments = uri.slice('ipfs://'.length).replace(/^ipfs\//, '').split('/')
  if (segments.length > 8 || segments.some(segment => segment === '.' || segment === '..' || !SEGMENT.test(segment))) {
    return null
  }
  return IPFS_GATEWAY + segments.join('/')
}

/** The URL an image or link from a project's metadata may be loaded from, or null. Only https, and never with a
 * user or password in it; an `ipfs://` one is the gateway's. It is at most MAX_URL_LENGTH characters as written and as
 * it is kept: the URL parser percent-encodes, so a URL that is short enough to read can come out nine times as long,
 * and what is kept in the browser is what comes out. */
export function assetUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return null
  if (/^ipfs:\/\//i.test(value)) return ipfsGatewayUrl(value)
  try {
    const url = new URL(value)
    const acceptable = url.protocol === 'https:' && !url.username && !url.password
    return acceptable && url.href.length <= MAX_URL_LENGTH ? url.href : null
  } catch {
    return null
  }
}

/** What a `data:application/json` uri carries, or null when it is not one or its payload does not parse. */
function inlineJson(uri: string): unknown {
  if (!uri.startsWith('data:application/json')) return null
  const comma = uri.indexOf(',')
  if (comma < 0) return null
  try {
    const payload = uri.slice(comma + 1)
    const bytes = uri.slice(0, comma).includes(';base64') ? Uint8Array.from(atob(payload), char => char.charCodeAt(0)) : null
    return JSON.parse(bytes ? new TextDecoder().decode(bytes) : decodeURIComponent(payload))
  } catch {
    return null
  }
}

function stickyIn(document: unknown): StickyUri | null {
  if (typeof document !== 'object' || document === null) return null
  const { protocol, launchId, chains } = document as Record<string, unknown>
  if (protocol !== 'Sticky') return null
  // A chain id is a whole number above 0, as the launch wrote it or as a numeric string; anything else is left out.
  const planned = Array.isArray(chains)
    ? [...new Set(chains.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))].slice(0, MAX_CHAINS)
    : []
  return {
    protocol: 'Sticky',
    launchId: typeof launchId === 'string' && launchId !== '' && launchId.length <= MAX_LAUNCH_ID_LENGTH ? launchId : null,
    chains: planned.length ? planned : null,
  }
}

/** The launch a Sticky project's data uri carries. Any other uri, and any other protocol, has none. */
export function parseStickyUri(uri: string): StickyUri | null {
  return stickyIn(inlineJson(uri))
}

/** What is kept of a project's document, which is whatever its owner wrote: a name and a logo. */
function reduced(document: unknown): Omit<ProjectMetadata, 'sticky'> {
  if (typeof document !== 'object' || document === null) return {}
  const { name, logoUri } = document as Record<string, unknown>
  const logo = typeof logoUri === 'string' ? assetUrl(logoUri) : null
  return {
    ...(typeof name === 'string' && name.trim() !== '' && name.length <= MAX_NAME_LENGTH ? { name } : {}),
    ...(logo ? { logoUri: logo } : {}),
  }
}

/** The text of `response`, or null when its body is more than MAX_DOCUMENT_BYTES: no more than that is read, and the
 * rest of the body is dropped. The same file is always as large, so that is an answer, not a failure. */
async function boundedText(response: Response): Promise<string | null> {
  if (Number(response.headers.get('content-length')) > MAX_DOCUMENT_BYTES) {
    await response.body?.cancel()
    return null
  }
  if (!response.body) return response.text()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    size += value.length
    if (size > MAX_DOCUMENT_BYTES) {
      await reader.cancel()
      return null
    }
    text += decoder.decode(value, { stream: true })
  }
}

/**
 * What the project uri `uri` says. A data uri is read in place, and is the only one whose launch is read. An
 * `ipfs://` uri is fetched through the gateway, with no credentials and no referrer, and rejects when the gateway
 * does not answer with a document, so that a failure is not remembered as a project with nothing to show. Any other
 * uri has nothing, and asks nothing, and neither does a document of more than a megabyte.
 */
export async function metadataOfUri(uri: string, { signal, fetch: fetcher = fetch }: MetadataOptions = {}): Promise<ProjectMetadata> {
  if (uri.startsWith('data:')) {
    const document = inlineJson(uri)
    const sticky = stickyIn(document)
    return { ...reduced(document), ...(sticky ? { sticky } : {}) }
  }
  const url = ipfsGatewayUrl(uri)
  if (url === null) return {}
  const document = await withTimeout(DOCUMENT_TIMEOUT_MS, signal, async timed => {
    const response = await fetcher(url, { signal: timed, credentials: 'omit', referrerPolicy: 'no-referrer' })
    if (!response.ok) throw new Error(`project metadata request failed (${response.status})`)
    const text = await boundedText(response)
    return text === null ? null : (JSON.parse(text) as unknown)
  })
  return reduced(document)
}

/** JBTokens on each chain, as the recorded deployer names it: the one the deployer itself asks which project a
 * token is the ERC-20 of. */
const tokensContracts = new Map<number, Address>()

async function tokensContract(chainId: number, deployer: Address, signal: AbortSignal | undefined): Promise<Address> {
  const known = tokensContracts.get(chainId)
  if (known) return known
  const read = jbCenterPublicClient(chainId).readContract({ address: deployer, abi: stickyDeployerAbi, functionName: 'TOKENS' })
  const tokens = await untilAborted(read, signal)
  tokensContracts.set(chainId, tokens)
  return tokens
}

/**
 * The uri of the Juicebox project that `stakedToken` is the ERC-20 of, or null when it is no project's, or the
 * project has none. The chain can change it, so it is read live; rejects when a read does not answer.
 */
export async function projectUriOf(chainId: number, stakedToken: Address, { signal }: Cancel = {}): Promise<string | null> {
  const deployment = deploymentOn(chainId)
  const tokens = await tokensContract(chainId, deployment.deployer, signal)
  const client = jbCenterPublicClient(chainId)
  const projectId = await untilAborted(
    client.readContract({ address: tokens, abi: tokensAbi, functionName: 'projectIdOf', args: [stakedToken] }),
    signal,
  )
  if (projectId === 0n) return null
  const uri = await untilAborted(
    client.readContract({ address: deployment.controller, abi: controllerAbi, functionName: 'uriOf', args: [projectId] }),
    signal,
  )
  return uri === '' ? null : uri
}

/**
 * What the project behind a Sticky project's staked token shows: its name and logo, or the launch its uri carries.
 * An empty object when the token is no project's or its uri names nothing to read; it rejects when the chain or
 * the gateway cannot be read. `useProjectMetadata` keeps the document by its uri.
 */
export async function projectMetadata(chainId: number, stakedToken: Address, options: MetadataOptions = {}): Promise<ProjectMetadata> {
  const uri = await projectUriOf(chainId, stakedToken, options)
  return uri === null ? {} : metadataOfUri(uri, options)
}
