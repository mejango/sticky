import {
  decodeFunctionResult,
  encodeFunctionData,
  hexToString,
  numberToHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { call } from 'viem/actions'
import { namehash, normalize } from 'viem/ens'
import { projectRouteSegmentFromPathname } from '@/lib/project-route'

// The two functions that read a route from the address bar are in project-route.ts, where a client can load them
// without the ENSIP-15 normalization this file needs.
export {
  decodeProjectRouteSegment,
  projectRouteSegmentFromPathname,
} from '@/lib/project-route'

/** JBProjectHandles is intentionally canonical on Ethereum mainnet. */
export const PROJECT_HANDLES_CHAIN_ID = 1 as const
export const PROJECT_HANDLES_ADDRESS =
  '0x726f4a3dfd2fb8297f8ab98d215b42a92d8eefe8' as Address
export const PROJECT_HANDLE_TEXT_KEY = 'juicebox'
/** Top-level eth_call budget: intrinsic/calldata gas plus the contract's 100k stipend. */
export const PROJECT_HANDLE_RESOLVER_READ_GAS = 125_000n
/** Reviewed execution cap for the exact resolver setText call. */
export const PROJECT_HANDLE_RESOLVER_WRITE_GAS = 1_000_000n
/** Reviewed execution cap for publishing one normalized handle claim. */
export const PROJECT_HANDLE_WRITE_GAS = 1_000_000n
/** Outer budget for formatting a canonical <=255-byte ENS handle. */
export const PROJECT_HANDLE_READ_GAS = 350_000n
/** Two ABI header words plus JBProjectHandles' 256-byte text payload cap. */
export const PROJECT_HANDLE_RESOLVER_MAX_RETURN_BYTES = 64 + 256
export const ENS_REGISTRY_ADDRESS =
  '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e' as Address
export const ENS_NAME_WRAPPER_ADDRESS =
  '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401' as Address

export const ensRegistryAbi = [
  {
    type: 'function',
    name: 'resolver',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }],
  },
] as const

const ensNameWrapperAbi = [
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
] as const

/** The narrow deployed ABI used by the handle editor and route verifier. */
export const jbProjectHandlesAbi = [
  {
    type: 'function',
    name: 'ensNamePartsOf',
    stateMutability: 'view',
    inputs: [
      { name: 'chainId', type: 'uint256' },
      { name: 'projectId', type: 'uint256' },
      { name: 'setter', type: 'address' },
    ],
    outputs: [{ name: '', type: 'string[]' }],
  },
  {
    type: 'function',
    name: 'handleOf',
    stateMutability: 'view',
    inputs: [
      { name: 'chainId', type: 'uint256' },
      { name: 'projectId', type: 'uint256' },
      { name: 'setter', type: 'address' },
    ],
    outputs: [{ name: 'handle', type: 'string' }],
  },
  {
    type: 'function',
    name: 'setEnsNamePartsFor',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'chainId', type: 'uint256' },
      { name: 'projectId', type: 'uint256' },
      { name: 'parts', type: 'string[]' },
    ],
    outputs: [],
  },
] as const

/** Standard ENS public-resolver text setter. */
export const ensTextResolverAbi = [
  {
    type: 'function',
    name: 'text',
    stateMutability: 'view',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'key', type: 'string' },
    ],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'setText',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'key', type: 'string' },
      { name: 'value', type: 'string' },
    ],
    outputs: [],
  },
] as const

export type NormalizedProjectHandle = {
  /** Canonical URL/contract form, without `@` or `.eth`. */
  handle: string
  /** Canonical ENS node, including `.eth`. */
  ensName: string
  /** Contract storage order: rightmost label first. */
  parts: string[]
}

/**
 * Navigate through the document for a mutable alias. Browsers treat an anchor
 * to the current pathname (for example `/@foo` from `/@foo#operator`) as an
 * in-document fragment change, so explicitly reload that case to force the
 * server to resolve ENS again.
 */
export function navigateToProjectHandle(path: string): void {
  const targetPathname = path.split(/[?#]/u, 1)[0] || '/'
  const currentSegment = projectRouteSegmentFromPathname(
    window.location.pathname,
  )
  const targetSegment = projectRouteSegmentFromPathname(targetPathname)
  const currentHandle = currentSegment
    ? projectHandleFromRoute(currentSegment)?.handle
    : null
  const targetHandle = targetSegment
    ? projectHandleFromRoute(targetSegment)?.handle
    : null

  if (currentHandle && targetHandle === currentHandle) {
    window.history.replaceState(window.history.state, '', path)
    window.location.reload()
    return
  }
  window.location.assign(path)
}

/**
 * Normalize a user-facing handle with ENSIP-15. Inputs may include the URL's
 * leading `@` and/or ENS's trailing `.eth`; outputs never include either in
 * `handle`.
 */
export function normalizeProjectHandle(
  input: string,
): NormalizedProjectHandle | null {
  let value = input.trim()
  if (value.startsWith('@')) value = value.slice(1)
  if (!value) return null

  const candidate = /\.eth$/i.test(value) ? value : `${value}.eth`
  try {
    const ensName = normalize(candidate)
    const labels = ensName.split('.')
    if (labels.length < 2 || labels.at(-1) !== 'eth') return null
    const handleLabels = labels.slice(0, -1)
    if (handleLabels.some(label => !label || label === 'eth')) return null
    return {
      handle: handleLabels.join('.'),
      ensName,
      parts: [...handleLabels].reverse(),
    }
  } catch {
    return null
  }
}

/** Parse only the explicit `/@handle` route syntax. */
export function projectHandleFromRoute(
  segment: string,
): NormalizedProjectHandle | null {
  return segment.trim().startsWith('@')
    ? normalizeProjectHandle(segment)
    : null
}

/** Parse the ENS `juicebox` text record (`chainId:projectId`). */
export function parseProjectHandleRecord(
  value: string | null | undefined,
): { chainId: number; projectId: number } | null {
  const match = value?.match(/^([1-9]\d*):([1-9]\d*)$/)
  if (!match) return null
  const chainId = Number(match[1])
  const projectId = Number(match[2])
  if (!Number.isSafeInteger(chainId) || !Number.isSafeInteger(projectId)) {
    return null
  }
  return { chainId, projectId }
}

export function projectHandleRecord(chainId: number, projectId: number) {
  return `${chainId}:${projectId}`
}

export type ProjectHandleSetupPhase =
  | 'ens-record'
  | 'authority-claim'
  | 'verified'

export type ProjectHandleSetupResult =
  | 'ens-pending'
  | 'authority-pending'
  | 'verified'

/**
 * The editor is resumable across two independently authorized writes. Always
 * repair the exact ENS pointer first, then publish (or verify) the current
 * project authority's matching claim.
 */
export function projectHandleSetupPhase({
  expectedRecord,
  textRecord,
  requestedHandle,
  verifiedHandle,
}: {
  expectedRecord: string
  textRecord: string | null | undefined
  requestedHandle: string
  verifiedHandle: string | null | undefined
}): ProjectHandleSetupPhase {
  if (textRecord !== expectedRecord) return 'ens-record'
  return projectHandleMatches(requestedHandle, verifiedHandle)
    ? 'verified'
    : 'authority-claim'
}

/**
 * Continue the two-write setup without coupling their authorities. Each step
 * performs its own live reads and transaction review. A queued Safe action or
 * missing signer returns `false`, leaving the next click to retry that same
 * step; a confirmed ENS step advances immediately to the authority claim.
 */
export async function continueProjectHandleSetup({
  ensureEnsRecord,
  ensureAuthorityClaim,
}: {
  ensureEnsRecord: () => Promise<boolean>
  ensureAuthorityClaim: () => Promise<boolean>
}): Promise<ProjectHandleSetupResult> {
  if (!(await ensureEnsRecord())) return 'ens-pending'
  return (await ensureAuthorityClaim()) ? 'verified' : 'authority-pending'
}

/**
 * Accept only the exact contract/URL representation returned by an honest
 * JBProjectHandles resolver: ENSIP-15 canonical, without `@` or `.eth`.
 * Normalizing an untrusted return value before comparing it would let a
 * noncanonical claim masquerade as the requested handle.
 */
export function canonicalProjectHandle(
  value: string | null | undefined,
): string | null {
  if (!value) return null
  const normalized = normalizeProjectHandle(value)
  return normalized?.handle === value ? value : null
}

/** Both halves must agree; a forward ENS text record alone is not a route. */
export function projectHandleMatches(
  requested: string,
  verified: string | null | undefined,
): boolean {
  const requestedHandle = normalizeProjectHandle(requested)?.handle
  const verifiedHandle = canonicalProjectHandle(verified)
  return !!requestedHandle && requestedHandle === verifiedHandle
}

async function rawBoundedProjectHandlesCall(
  client: PublicClient,
  data: Hex,
  maxReturnBytes: number,
): Promise<Hex | null> {
  const result = await client.request({
    method: 'eth_call',
    params: [
      {
        to: PROJECT_HANDLES_ADDRESS,
        data,
        gas: numberToHex(PROJECT_HANDLE_READ_GAS),
      },
      'latest',
    ],
  })
  if (typeof result !== 'string' || !/^0x(?:[0-9a-f]{2})*$/iu.test(result)) {
    return null
  }
  const bytes = (result.length - 2) / 2
  return Number.isSafeInteger(bytes) && bytes <= maxReturnBytes
    ? (result as Hex)
    : null
}

/** Raw, CCIP-off and bounded reverse read used by server aliases and the editor. */
export async function readBoundedProjectHandle(
  client: PublicClient,
  {
    chainId,
    projectId,
    setter,
  }: { chainId: number; projectId: number; setter: Address },
): Promise<string | null> {
  const data = await rawBoundedProjectHandlesCall(
    client,
    encodeFunctionData({
      abi: jbProjectHandlesAbi,
      functionName: 'handleOf',
      args: [BigInt(chainId), BigInt(projectId), setter],
    }),
    PROJECT_HANDLE_RESOLVER_MAX_RETURN_BYTES,
  )
  if (!data || data.length < 130) return null
  const bytes = (data.length - 2) / 2
  const offset = BigInt(`0x${data.slice(2, 66)}`)
  const length = BigInt(`0x${data.slice(66, 130)}`)
  const paddedLength = ((length + 31n) / 32n) * 32n
  if (
    offset !== 32n ||
    length > 255n ||
    BigInt(bytes) !== 64n + paddedLength
  ) {
    return null
  }
  try {
    return canonicalProjectHandle(
      decodeFunctionResult({
        abi: jbProjectHandlesAbi,
        functionName: 'handleOf',
        data,
      }),
    )
  } catch {
    return null
  }
}

/** Bounded diagnostic read of the setter's stored (possibly unverified) labels. */
export async function readBoundedProjectHandleParts(
  client: PublicClient,
  {
    chainId,
    projectId,
    setter,
  }: { chainId: number; projectId: number; setter: Address },
): Promise<readonly string[] | null> {
  const data = await rawBoundedProjectHandlesCall(
    client,
    encodeFunctionData({
      abi: jbProjectHandlesAbi,
      functionName: 'ensNamePartsOf',
      args: [BigInt(chainId), BigInt(projectId), setter],
    }),
    16_384,
  )
  if (!data) return null
  try {
    const parts = decodeFunctionResult({
      abi: jbProjectHandlesAbi,
      functionName: 'ensNamePartsOf',
      data,
    })
    return parts.length <= 127 && parts.every(part => part.length <= 255)
      ? parts
      : null
  } catch {
    return null
  }
}

export type ProjectHandleAuthorityContext = {
  authority: Address
  isRevnet: boolean
}

/**
 * Verify a discovered authority before considering the expensive historical
 * fallback. A live, unique authority with a different reverse claim is a
 * definitive rejection; letting an arbitrary ENS owner trigger history in
 * that case turns invalid aliases into archive-RPC scan amplifiers.
 */
export async function verifyProjectHandleAuthorityWithFallback({
  requestedHandle,
  authorityContext,
  lookupHandle,
  recoverAuthority,
}: {
  requestedHandle: string
  authorityContext: ProjectHandleAuthorityContext | null
  lookupHandle: (authority: Address) => Promise<string | null>
  recoverAuthority: () => Promise<ProjectHandleAuthorityContext | null>
}): Promise<ProjectHandleAuthorityContext | null> {
  if (authorityContext) {
    const verified = await lookupHandle(authorityContext.authority)
    return projectHandleMatches(requestedHandle, verified)
      ? authorityContext
      : null
  }

  const recovered = await recoverAuthority()
  if (!recovered) return null
  const verified = await lookupHandle(recovered.authority)
  return projectHandleMatches(requestedHandle, verified) ? recovered : null
}

/**
 * Shape of the one resolver call whose semantics must match
 * JBProjectHandles. `ccipRead` is applied to an isolated Viem client below;
 * `gas` prevents a resolver from doing more work than the registry contract
 * itself permits, and `batch: false` keeps the exact target call intact.
 */
export function directEnsTextReadRequest(
  resolver: Address,
  node: Hex,
) {
  return {
    ccipRead: false as const,
    account: PROJECT_HANDLES_ADDRESS,
    to: resolver,
    data: encodeFunctionData({
      abi: ensTextResolverAbi,
      functionName: 'text',
      args: [node, PROJECT_HANDLE_TEXT_KEY],
    }),
    gas: PROJECT_HANDLE_RESOLVER_READ_GAS,
    batch: false as const,
  }
}

/** Read one exact resolver node/key with JBProjectHandles-equivalent bounds. */
export async function readDirectEnsText(
  client: PublicClient,
  resolver: Address,
  node: Hex,
  blockNumber?: bigint,
): Promise<string | null> {
  const { ccipRead, ...request } = directEnsTextReadRequest(resolver, node)
  try {
    const response = await call(
      { ...client, ccipRead },
      { ...request, ...(blockNumber === undefined ? {} : { blockNumber }) },
    )
    if (!response.data) return null
    const returnBytes = (response.data.length - 2) / 2
    if (
      !Number.isSafeInteger(returnBytes) ||
      returnBytes < 64 ||
      returnBytes > PROJECT_HANDLE_RESOLVER_MAX_RETURN_BYTES
    ) {
      return null
    }
    const offset = BigInt(`0x${response.data.slice(2, 66)}`)
    const length = BigInt(`0x${response.data.slice(66, 130)}`)
    if (
      offset !== 32n ||
      length > 256n ||
      length > BigInt(Number.MAX_SAFE_INTEGER) ||
      BigInt(returnBytes) < 64n + length
    ) {
      return null
    }
    const textLength = Number(length)
    return hexToString(
      `0x${response.data.slice(130, 130 + textLength * 2)}`,
    )
  } catch {
    return null
  }
}

/**
 * Read the exact resolver used by JBProjectHandles: the resolver stored on the
 * ENS registry for this node. Universal/wildcard resolver discovery is not
 * equivalent to the contract's direct lookup.
 */
export async function readDirectEnsProjectRecord(
  client: PublicClient,
  ensName: string,
): Promise<{
  resolver: Address | null
  controller: Address | null
  textRecord: string | null
}> {
  const node = namehash(ensName)
  const blockNumber = await client.getBlockNumber().catch(() => undefined)
  const block = blockNumber === undefined ? {} : { blockNumber }
  const [resolver, registryOwner] = (await Promise.all([
    client
      .readContract({
        address: ENS_REGISTRY_ADDRESS,
        abi: ensRegistryAbi,
        functionName: 'resolver',
        args: [node],
        ...block,
      })
      .catch(() => null),
    client
      .readContract({
        address: ENS_REGISTRY_ADDRESS,
        abi: ensRegistryAbi,
        functionName: 'owner',
        args: [node],
        ...block,
      })
      .catch(() => null),
  ])) as [Address | null, Address | null]
  let controller = registryOwner
  if (
    registryOwner?.toLowerCase() === ENS_NAME_WRAPPER_ADDRESS.toLowerCase()
  ) {
    controller = (await client
      .readContract({
        address: ENS_NAME_WRAPPER_ADDRESS,
        abi: ensNameWrapperAbi,
        functionName: 'ownerOf',
        args: [BigInt(node)],
        ...block,
      })
      .catch(() => null)) as Address | null
  }
  if (controller === zeroAddress) controller = null
  if (!resolver || resolver === zeroAddress) {
    return { resolver: null, controller, textRecord: null }
  }
  const textRecord = await readDirectEnsText(
    client,
    resolver,
    node,
    blockNumber,
  )
  return { resolver, controller, textRecord }
}

export type EncodedProjectHandleCall = {
  target: Address
  data: Hex
  abi: typeof jbProjectHandlesAbi | typeof ensTextResolverAbi
  functionName: 'setEnsNamePartsFor' | 'setText'
  args: readonly unknown[]
}

/** Exact mainnet JBProjectHandles request for an already-normalized handle. */
export function buildSetProjectHandleCall({
  chainId,
  projectId,
  parts,
}: {
  chainId: number
  projectId: number
  parts: readonly string[]
}): EncodedProjectHandleCall {
  const args = [BigInt(chainId), BigInt(projectId), [...parts]] as const
  return {
    target: PROJECT_HANDLES_ADDRESS,
    abi: jbProjectHandlesAbi,
    functionName: 'setEnsNamePartsFor',
    args,
    data: encodeFunctionData({
      abi: jbProjectHandlesAbi,
      functionName: 'setEnsNamePartsFor',
      args,
    }),
  }
}

/** Exact resolver request for the ENS half of the bidirectional claim. */
export function buildSetEnsProjectRecordCall({
  resolver,
  ensName,
  chainId,
  projectId,
}: {
  resolver: Address
  ensName: string
  chainId: number
  projectId: number
}): EncodedProjectHandleCall {
  const args = [
    namehash(ensName),
    PROJECT_HANDLE_TEXT_KEY,
    projectHandleRecord(chainId, projectId),
  ] as const
  return {
    target: resolver,
    abi: ensTextResolverAbi,
    functionName: 'setText',
    args,
    data: encodeFunctionData({
      abi: ensTextResolverAbi,
      functionName: 'setText',
      args,
    }),
  }
}
