/**
 * The `/@name` route: which Sticky project a handle names. Runs on the server. It needs ENSIP-15 normalization
 * (`project-handles.ts`), which the browser must never load, so nothing that a client component imports may import
 * this module either (test/client-imports.test.ts checks it).
 *
 * A name is a project's handle only when both halves of a claim agree. The ENS name's `juicebox` text record, read
 * from the resolver the ENS registry names for it, points at `chainId:projectId`. JBProjectHandles, which lives on
 * Ethereum, holds a claim for that project from its owner naming the same handle, and re-checks the record itself.
 * Either half alone is a candidate only: anyone can put a record on a name they own, and anyone can claim a name for
 * a project on the registry, under their own address. The owner is the one address whose claim counts. (A Sticky
 * project is owned by the StickyDeployer that launched it and can never be transferred, and the deployer has no
 * function that makes a claim, so today no Sticky project has a handle.)
 *
 * Names and handles are read only on production chains: a mainnet name does not describe a testnet project. A read
 * that answers with something that does not read names nothing, and so does a project that does not exist (JBProjects
 * reverts with `ERC721NonexistentToken`). A read that fails is no answer: it is told to the console and rejects, so
 * that the page can say the lookup failed and offer to try again, where a handle that names nothing is a 404. The
 * name's record is read by `readDirectEnsProjectRecord`, which takes a failed lookup for no record, so no record counts
 * as an answer only once Ethereum has answered a fresh request.
 */

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { BaseError, ContractFunctionRevertedError, toFunctionSelector, type Address } from 'viem'
import { jbCenterPublicClient } from '@/lib/jbcenter-rpc'
import {
  PROJECT_HANDLES_CHAIN_ID,
  normalizeProjectHandle,
  parseProjectHandleRecord,
  projectHandleMatches,
  readBoundedProjectHandle,
  readDirectEnsProjectRecord,
} from '@/lib/project-handles'
import { projectsAbi } from '@/lib/sticky-abis'
import { stickyChainIds } from '@/lib/sticky-addresses'
import { projectsContract } from '@/lib/sticky-events'

/** The project a handle names, and the handle in the form the contract and the URL use: lower case, ENSIP-15
 * normalized, with no `@` and no `.eth`. */
export type ResolvedProjectHandle = { chainId: JBChainId; projectId: number; handle: string }

/** The three reads a handle takes, so that a test can stand in for Ethereum and the project's chain. */
export type HandleReads = {
  /** The `juicebox` text record of an ENS name, or null when it has no resolver or record. It rejects when Ethereum
   * cannot be asked. */
  record: (ensName: string) => Promise<string | null>
  /** The owner of a project's NFT, or null when the project does not exist. It rejects when the chain cannot be
   * asked. */
  ownerOf: (chainId: number, projectId: number) => Promise<Address | null>
  /** The handle that `setter` has claimed for a project on JBProjectHandles and that the ENS record confirms, or
   * null when there is none. It rejects when Ethereum cannot be asked. */
  claim: (chainId: number, projectId: number, setter: Address) => Promise<string | null>
}

const HANDLE_UNREADABLE = 'A project handle could not be read; its page offers to try again.'

/** What JBProjects, an OpenZeppelin ERC-721, reverts with for a project that does not exist. */
const NONEXISTENT_TOKEN = toFunctionSelector('ERC721NonexistentToken(uint256)')

/** Whether `error` is JBProjects saying the project does not exist, which is an answer. viem also reads a node's
 * -32603 as a revert, one with no error in it: that, like every other failure, is a read that failed. */
function nonexistent(error: unknown): boolean {
  const revert = error instanceof BaseError ? error.walk(cause => cause instanceof ContractFunctionRevertedError) : null
  if (!(revert instanceof ContractFunctionRevertedError)) return false
  return revert.signature === NONEXISTENT_TOKEN || revert.data?.errorName === 'ERC721NonexistentToken'
}

/** Ethereum, through Center like every other chain: a public RPC that answers a browser can refuse a server. */
const ethereum = () => jbCenterPublicClient(PROJECT_HANDLES_CHAIN_ID)

const live: HandleReads = {
  async record(ensName) {
    const client = ethereum()
    const { textRecord } = await readDirectEnsProjectRecord(client, ensName)
    // cacheTime 0: the reader's own head read is cached for a moment, and only a fresh request says Ethereum answers.
    if (textRecord === null) await client.getBlockNumber({ cacheTime: 0 })
    return textRecord
  },
  async ownerOf(chainId, projectId) {
    const projects = await projectsContract(chainId, undefined)
    try {
      return await jbCenterPublicClient(chainId).readContract({
        address: projects,
        abi: projectsAbi,
        functionName: 'ownerOf',
        args: [BigInt(projectId)],
      })
    } catch (error) {
      if (nonexistent(error)) return null
      throw error
    }
  },
  claim(chainId, projectId, setter) {
    return readBoundedProjectHandle(ethereum(), { chainId, projectId, setter })
  },
}

/**
 * The project that `handle` names, or null when it names none: a handle that does not normalize, a name with no
 * record, a record on a chain Sticky is not on or on a testnet, a project that does not exist, or a claim from
 * the project's owner that is missing or names another handle. It rejects when a read fails, which the console hears
 * about first. `handle` may carry the route's `@` and ENS's `.eth`.
 */
export async function resolveProjectHandle(
  handle: string,
  reads: HandleReads = live,
): Promise<ResolvedProjectHandle | null> {
  const requested = normalizeProjectHandle(handle)
  if (!requested) return null
  try {
    const target = parseProjectHandleRecord(await reads.record(requested.ensName))
    if (!target || !stickyChainIds('production').includes(target.chainId)) return null
    const owner = await reads.ownerOf(target.chainId, target.projectId)
    if (!owner) return null
    const claimed = await reads.claim(target.chainId, target.projectId, owner)
    if (!projectHandleMatches(requested.handle, claimed)) return null
    return { chainId: target.chainId as JBChainId, projectId: target.projectId, handle: requested.handle }
  } catch (error) {
    console.warn(HANDLE_UNREADABLE, { handle: requested.handle }, error)
    throw error
  }
}
