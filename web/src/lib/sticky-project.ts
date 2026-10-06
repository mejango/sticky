import {
  ContractFunctionExecutionError,
  erc20Abi,
  erc20Abi_bytes32,
  hexToString,
  isAddressEqual,
  zeroAddress,
  type Address,
  type ContractFunctionParameters,
  type Hex,
} from 'viem'
import { freshHead, untilAborted } from '@/lib/hook-logs'
import { jbCenterPublicClient } from '@/lib/jbcenter-rpc'
import {
  controllerAbi,
  stickyDeployerAbi,
  stickyHookAbi,
  stickyTokenAbi,
  terminalAbi,
  terminalStoreAbi,
} from '@/lib/sticky-abis'
import { deploymentOn, type StickyDeployment } from '@/lib/sticky-addresses'
import { parseStickyUri } from '@/lib/sticky-metadata'

/** One Sticky project on one chain, as of `blockNumber`. */
export type StickyProjectInfo = {
  chainId: number
  projectId: bigint
  /** The Sticky token, and its own symbol and name. Its shares have 18 decimals. */
  stToken: Address
  stSymbol: string
  stName: string
  /** The token holders stick, and its symbol, name and decimals. */
  stakedToken: Address
  symbol: string
  name: string
  decimals: number
  /** The stickiness bonus, out of 10,000: what an unstick leaves behind for the holders who stay. */
  cashOutTaxRate: bigint
  /** True when transfers are off. A token that cannot say reads as locked. */
  soulbound: boolean
  /** Sticky shares in circulation. */
  totalSupply: bigint
  /** What holders can claim, in the staked token's units: `rawBacking` less `orphaned`. */
  backing: bigint
  /** Backing nobody can claim, left when everyone unstuck. While no shares exist it is all of it. */
  orphaned: bigint
  /** What the terminal holds of the staked token for this project, before the unowned part comes out. */
  rawBacking: bigint
  /** The unowned backing the hook has recorded. It is `orphaned` except while no shares exist, when
   * `orphaned` is all of `rawBacking` and this stays what was recorded. The backing chart needs it. */
  savedOrphaned: bigint
  /** Shared by every chain's copy of one launch, so it groups them. Null when the uri names none. */
  launchId: string | null
  /** The chains the launch was planned on, as its uri lists them: where the Chains card expects a copy. Null when the
   * uri lists none. */
  plannedChains: number[] | null
  blockNumber: bigint
}

/** What `shares` Sticky shares can claim of a project's backing, in the staked token's units and rounded down.
 * With no shares in circulation there is nothing to claim it with. */
export function backingOfShares(
  shares: bigint,
  { totalSupply, backing }: Pick<StickyProjectInfo, 'totalSupply' | 'backing'>,
): bigint {
  return totalSupply > 0n ? (shares * backing) / totalSupply : 0n
}

type Difference = {
  name: 'HOOK' | 'TERMINAL' | 'CONTROLLER'
  expected: Address
  /** Null when the deployer would not answer. */
  actual: Address | null
}

/** The deployer on a chain answers with contracts other than the ones this site recorded, or does not
 * answer as a Sticky deployer at all. */
export class StickyDeploymentMismatch extends Error {
  readonly chainId: number
  readonly differences: readonly Difference[]

  constructor(chainId: number, differences: readonly Difference[]) {
    super(
      `Sticky's deployer on chain ${chainId} does not match this site's records: ${differences
        .map(({ name, expected, actual }) => `${name}() is ${actual ?? 'unreadable'}, expected ${expected}`)
        .join('; ')}.`,
    )
    this.name = 'StickyDeploymentMismatch'
    this.chainId = chainId
    this.differences = differences
  }
}

export type Answer<T> = { status: 'success'; result: T } | { status: 'failure'; error: Error }

/** With `allowFailure`, viem also reports a request that never got an answer (a rate limit, a timeout)
 * as a failed call, and names it for Multicall3's `aggregate3`, where a contract's own failure is named
 * for the function it failed. A revert is an answer and some of them are read as facts; a lost request
 * is not one, so it is thrown, whichever calls it took with it. */
export function answered<T extends readonly Answer<unknown>[]>(answers: T): T {
  for (const answer of answers) {
    if (answer.status !== 'failure') continue
    const own = answer.error instanceof ContractFunctionExecutionError && answer.error.functionName !== 'aggregate3'
    if (!own) throw answer.error
  }
  return answers
}

/** The launch id and the planned chains that a Sticky launch wrote in its project's uri (see `parseStickyUri`). A uri
 * that is not a Sticky launch's has neither. */
function launchIn(uri: string): Pick<StickyProjectInfo, 'launchId' | 'plannedChains'> {
  const sticky = parseStickyUri(uri)
  return { launchId: sticky?.launchId ?? null, plannedChains: sticky?.chains ?? null }
}

/** The launch id in a Sticky project's uri, which a launch stores as a data URI. Anything else has none. */
export function launchIdIn(uri: string): string | null {
  return launchIn(uri).launchId
}

/** How a read takes an unowned balance the hook recorded above what the terminal holds, which consistent
 * accounting never shows. `'strict'` fails the read: quotes and minimums rest on a project's backing.
 * `'clamp'` reads it as all of the terminal's balance, so that nothing is claimable. */
export type OrphanedPolicy = 'strict' | 'clamp'

/** The most characters of a token's symbol or name that are kept: what the browser keeps of a project stays bounded,
 * as a project's name from its metadata is (`sticky-metadata.ts`). A longer one is cut, never inside a character. */
const MAX_TOKEN_TEXT = 256
export const capped = (text: string) =>
  text.length <= MAX_TOKEN_TEXT ? text : Array.from(text).slice(0, MAX_TOKEN_TEXT).join('')

/** How many projects one Multicall3 request carries. A project's second round is ten calls. */
const PROJECTS_PER_REQUEST = 25

/** A project's figures, or why it has none. */
type ProjectRead = { projectId: bigint; info: StickyProjectInfo } | Failed

/** What the deployment's contracts say of a project: the first round of its read. */
type Recorded = {
  projectId: bigint
  stakedToken: Address
  cashOutTaxRate: bigint
  stToken: Address
  savedOrphaned: bigint
  store: Address
  uriOf: Answer<string>
}

/** The reads of one project's answers, whose failures name the project and what could not be read. */
function reading(chainId: number, projectId: bigint) {
  const where = `Sticky project ${projectId} on chain ${chainId}`
  const unreadable = (read: string, cause: Error): never => {
    throw new Error(`${where}: ${read} could not be read.`, { cause })
  }
  const need = <T>(answer: Answer<T>, read: string): T =>
    answer.status === 'success' ? answer.result : unreadable(read, answer.error)
  // A token's symbol or name is the string most tokens return, or the NUL-padded bytes32 some return
  // (MKR). Reading a string's return as a bytes32 gives its offset word rather than an error, so the
  // string reading comes first and the bytes32 one only when it fails.
  const text = (asString: Answer<string>, asBytes32: Answer<Hex>, read: string): string => {
    if (asString.status === 'success') return capped(asString.result)
    if (asBytes32.status === 'success') return hexToString(asBytes32.result, { size: 32 }).replace(/\0+$/, '')
    return unreadable(read, asString.error)
  }
  return { need, text }
}

type Failed = { projectId: bigint; error: Error }
type Attempt<T> = { projectId: bigint; value: T } | Failed
const failed = <T>(read: Attempt<T>): read is Failed => 'error' in read

/** What `read` gives for `projectId`, or the error that says why it gives nothing. */
function attempt<T>(projectId: bigint, read: () => T): Attempt<T> {
  try {
    return { projectId, value: read() }
  } catch (error) {
    return { projectId, error: error instanceof Error ? error : new Error(String(error)) }
  }
}

/** Some of a chain's projects, read in two Multicall3 requests at `blockNumber`: first what the deployment's contracts
 * say of each, and the store; then the tokens and store they name, for each project the first round could read. */
async function readSome(
  chainId: number,
  deployment: StickyDeployment,
  projectIds: readonly bigint[],
  blockNumber: bigint,
  orphans: OrphanedPolicy,
  signal: AbortSignal | undefined,
): Promise<ProjectRead[]> {
  const client = jbCenterPublicClient(chainId, signal)
  const { deployer, hook, terminal, controller } = deployment
  // Each round is one request: the projects are already counted out, so viem is told not to split it.
  const ask = async (contracts: ContractFunctionParameters[]) =>
    answered(
      (await untilAborted(
        client.multicall({ contracts, allowFailure: true, batchSize: 0, blockNumber }),
        signal,
      )) as Answer<unknown>[],
    )
  const first = await ask([
    { address: terminal, abi: terminalAbi, functionName: 'STORE' },
    ...projectIds.flatMap(projectId => [
      { address: deployer, abi: stickyDeployerAbi, functionName: 'stakedTokenOf', args: [projectId] },
      { address: deployer, abi: stickyDeployerAbi, functionName: 'cashOutTaxRateOf', args: [projectId] },
      // The hook binds each project to the one token allowed to report its transfers and burns.
      { address: hook, abi: stickyHookAbi, functionName: 'tokenOf', args: [projectId] },
      { address: hook, abi: stickyHookAbi, functionName: 'orphanedBalanceOf', args: [projectId] },
      { address: controller, abi: controllerAbi, functionName: 'uriOf', args: [projectId] },
    ]),
  ])
  const [storeOf, ...perProject] = first
  const recorded = projectIds.map((projectId, index) =>
    attempt(projectId, (): Recorded => {
      const [stakedTokenOf, taxRateOf, tokenOf, orphanedOf, uriOf] = perProject.slice(index * 5, index * 5 + 5) as [
        Answer<Address>,
        Answer<bigint>,
        Answer<Address>,
        Answer<bigint>,
        Answer<string>,
      ]
      const { need } = reading(chainId, projectId)
      const stakedToken = need(stakedTokenOf, 'the staked token')
      if (stakedToken === zeroAddress) {
        throw new Error(`Project ${projectId} is not a Sticky token of this deployer.`)
      }
      return {
        projectId,
        cashOutTaxRate: need(taxRateOf, 'the stickiness bonus'),
        stToken: need(tokenOf, 'the Sticky token'),
        savedOrphaned: need(orphanedOf, 'the unowned backing'),
        store: need(storeOf as Answer<Address>, 'the store'),
        stakedToken,
        uriOf,
      }
    }),
  )
  const readable = recorded.flatMap(read => (failed(read) ? [] : [read.value]))
  if (!readable.length) return recorded.filter(failed)
  if (signal?.aborted) throw signal.reason

  const second = await ask(
    readable.flatMap(({ projectId, stakedToken, stToken, store }) => [
      { address: stakedToken, abi: erc20Abi, functionName: 'symbol' },
      { address: stakedToken, abi: erc20Abi, functionName: 'decimals' },
      { address: stakedToken, abi: erc20Abi, functionName: 'name' },
      { address: stakedToken, abi: erc20Abi_bytes32, functionName: 'symbol' },
      { address: stakedToken, abi: erc20Abi_bytes32, functionName: 'name' },
      { address: stToken, abi: stickyTokenAbi, functionName: 'symbol' },
      { address: stToken, abi: stickyTokenAbi, functionName: 'name' },
      { address: stToken, abi: stickyTokenAbi, functionName: 'SOULBOUND' },
      { address: stToken, abi: stickyTokenAbi, functionName: 'totalSupply' },
      { address: store, abi: terminalStoreAbi, functionName: 'balanceOf', args: [terminal, projectId, stakedToken] },
    ]),
  )
  const figures = new Map(
    readable.map((project, index) => [
      project.projectId,
      attempt(project.projectId, () =>
        figuresOf(chainId, project, second.slice(index * 10, index * 10 + 10), orphans, blockNumber),
      ),
    ]),
  )
  return recorded.map(read => {
    if (failed(read)) return read
    const found = figures.get(read.projectId)!
    return failed(found) ? found : { projectId: read.projectId, info: found.value }
  })
}

/** A project's figures from its second round, as the old single read made them. */
function figuresOf(
  chainId: number,
  { projectId, stakedToken, cashOutTaxRate, stToken, savedOrphaned, uriOf }: Recorded,
  answers: Answer<unknown>[],
  orphans: OrphanedPolicy,
  blockNumber: bigint,
): StickyProjectInfo {
  const [
    symbolOf,
    decimalsOf,
    nameOf,
    symbolBytes32Of,
    nameBytes32Of,
    stSymbolOf,
    stNameOf,
    soulboundOf,
    totalSupplyOf,
    balanceOf,
  ] = answers as [
    Answer<string>,
    Answer<number>,
    Answer<string>,
    Answer<Hex>,
    Answer<Hex>,
    Answer<string>,
    Answer<string>,
    Answer<boolean>,
    Answer<bigint>,
    Answer<bigint>,
  ]
  const { need, text } = reading(chainId, projectId)
  const symbol = text(symbolOf, symbolBytes32Of, 'the underlying symbol')
  const decimals = need(decimalsOf, 'the underlying decimals')
  const name = text(nameOf, nameBytes32Of, 'the underlying name')
  // A launch picks its Sticky token's symbol and name, so they are cut like any token's.
  const stSymbol = capped(need(stSymbolOf, 'the Sticky symbol'))
  const stName = capped(need(stNameOf, 'the Sticky name'))
  const totalSupply = need(totalSupplyOf, 'the Sticky supply')
  const held = need(balanceOf, 'the terminal balance')

  if (savedOrphaned > held && orphans === 'strict') {
    throw new Error('The Sticky pool returned inconsistent backing accounting.')
  }
  // With no shares left, whatever the terminal still holds belongs to nobody.
  const unowned = totalSupply === 0n ? held : savedOrphaned
  const orphaned = unowned > held ? held : unowned

  return {
    chainId,
    projectId,
    stToken,
    stSymbol,
    stName,
    stakedToken,
    symbol,
    name,
    decimals,
    cashOutTaxRate,
    // A token that reverts on SOULBOUND() is treated as locked, the safe reading.
    soulbound: soulboundOf.status === 'success' ? soulboundOf.result : true,
    totalSupply,
    backing: held - orphaned,
    orphaned,
    rawBacking: held,
    savedOrphaned,
    // The launch id only groups sibling chains, so a uri that will not read means no siblings, and no planned chains.
    ...(uriOf.status === 'success' ? launchIn(uriOf.result) : { launchId: null, plannedChains: null }),
    blockNumber,
  }
}

/** Each of a chain's `projectIds`, read at one block, PROJECTS_PER_REQUEST projects to a request, one request after
 * another. A request that got no answer says nothing about the projects it carried, and one of them can lose it for the
 * rest (a staked token that answers with more than Center carries, or runs Multicall3 out of gas). So when one is lost
 * while reading several projects, Center is asked afresh for its head: if it answers, that request's projects are read
 * one at a time at the same block, and a project whose own request is lost is left out with why; if not, the lost
 * request's error is thrown. Reading one project, a lost request is thrown. */
async function readEach(
  chainId: number,
  projectIds: readonly bigint[],
  orphans: OrphanedPolicy,
  signal: AbortSignal | undefined,
): Promise<ProjectRead[]> {
  const deployment = deploymentOn(chainId)
  if (!projectIds.length) return []
  const blockNumber = await freshHead(chainId, signal)
  const read = (some: readonly bigint[]) => readSome(chainId, deployment, some, blockNumber, orphans, signal)
  const reads: ProjectRead[] = []
  for (let at = 0; at < projectIds.length; at += PROJECTS_PER_REQUEST) {
    if (signal?.aborted) throw signal.reason
    const some = projectIds.slice(at, at + PROJECTS_PER_REQUEST)
    try {
      reads.push(...(await read(some)))
    } catch (lost) {
      if (signal?.aborted || projectIds.length === 1) throw lost
      // Only a fresh head says Center still answers.
      await freshHead(chainId, signal).catch(() => {
        throw signal?.aborted ? signal.reason : lost
      })
      for (const projectId of some) {
        if (signal?.aborted) throw signal.reason
        const one = await read([projectId]).catch((error: Error) => {
          if (signal?.aborted) throw error
          return [{ projectId, error }]
        })
        reads.push(...one)
      }
    }
  }
  return reads
}

const PROJECT_UNREADABLE = 'Could not read a Sticky project; leaving it out.'

/** Some of a chain's Sticky projects, in the order asked, all read at one block in two Multicall3 rounds (PROJECTS_PER_REQUEST
 * projects to a request): what the deployment's contracts say of each, then the tokens and store they name. A project
 * that cannot be read is left out, and the console hears which and why; the others are still read. */
export async function readStickyProjects(
  chainId: number,
  projectIds: readonly bigint[],
  { orphans = 'strict', signal }: { orphans?: OrphanedPolicy; signal?: AbortSignal } = {},
): Promise<StickyProjectInfo[]> {
  const reads = await readEach(chainId, projectIds, orphans, signal)
  return reads.flatMap(read => {
    if ('info' in read) return [read.info]
    console.warn(PROJECT_UNREADABLE, { chainId, projectId: read.projectId }, read.error)
    return []
  })
}

/** One Sticky project: its tokens, its terminal balance and its supply, all read at one block. The
 * deployment's own contracts are asked first, and they name the two tokens and the store; those are
 * asked second. Each round is one Multicall3 request, and both ask the same block. It rejects with why the
 * project cannot be read, or with the signal's reason once it aborts. */
export async function readStickyProject(
  chainId: number,
  projectId: bigint,
  { orphans = 'strict', signal }: { orphans?: OrphanedPolicy; signal?: AbortSignal } = {},
): Promise<StickyProjectInfo> {
  const [read] = await readEach(chainId, [projectId], orphans, signal)
  if ('error' in read) throw read.error
  return read.info
}

/** Checks that the deployer on this chain still reports the hook, terminal and controller this site
 * recorded. A deployer that answers otherwise, or not as a Sticky deployer at all, throws
 * `StickyDeploymentMismatch`. A request that gets no answer throws its own error: it says nothing about
 * the deployment. */
export async function verifyStickyDeployment(chainId: number): Promise<void> {
  const deployment = deploymentOn(chainId)
  const answers = answered(
    await jbCenterPublicClient(chainId).multicall({
      contracts: [
        { address: deployment.deployer, abi: stickyDeployerAbi, functionName: 'HOOK' },
        { address: deployment.deployer, abi: stickyDeployerAbi, functionName: 'TERMINAL' },
        { address: deployment.deployer, abi: stickyDeployerAbi, functionName: 'CONTROLLER' },
      ],
      allowFailure: true,
    }),
  )
  const recorded = [
    ['HOOK', deployment.hook],
    ['TERMINAL', deployment.terminal],
    ['CONTROLLER', deployment.controller],
  ] as const
  const differences = recorded.flatMap(([name, expected], index): Difference[] => {
    const answer = answers[index]
    const actual = answer.status === 'success' ? answer.result : null
    return actual !== null && isAddressEqual(actual, expected) ? [] : [{ name, expected, actual }]
  })
  if (differences.length > 0) throw new StickyDeploymentMismatch(chainId, differences)
}
