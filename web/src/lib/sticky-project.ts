import {
  ContractFunctionExecutionError,
  erc20Abi,
  isAddressEqual,
  zeroAddress,
  type Address,
} from 'viem'
import { jbCenterPublicClient } from '@/lib/jbcenter-rpc'
import {
  controllerAbi,
  stickyDeployerAbi,
  stickyHookAbi,
  stickyTokenAbi,
  terminalAbi,
  terminalStoreAbi,
} from '@/lib/sticky-abis'
import { stickyDeployment, type StickyDeployment } from '@/lib/sticky-addresses'

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
  /** What holders can claim, in the staked token's units: the terminal's balance less `orphaned`. */
  backing: bigint
  /** Backing nobody can claim, left when everyone unstuck. While no shares exist it is all of it. */
  orphaned: bigint
  /** Shared by every chain's copy of one launch, so it groups them. Null when the uri names none. */
  launchId: string | null
  blockNumber: bigint
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

function deploymentOn(chainId: number): StickyDeployment {
  const deployment = stickyDeployment(chainId)
  if (!deployment) throw new Error(`Sticky is not deployed on chain ${chainId}.`)
  return deployment
}

type Answer<T> = { status: 'success'; result: T } | { status: 'failure'; error: Error }

/** With `allowFailure`, viem also reports a request that never got an answer (a rate limit, a timeout)
 * as a failed call, and names it for Multicall3's `aggregate3`, where a contract's own failure is named
 * for the function it failed. A revert is an answer and some of them are read as facts; a lost request
 * is not one, so it is thrown, whichever calls it took with it. */
function answered<T extends readonly Answer<unknown>[]>(answers: T): T {
  for (const answer of answers) {
    if (answer.status !== 'failure') continue
    const own = answer.error instanceof ContractFunctionExecutionError && answer.error.functionName !== 'aggregate3'
    if (!own) throw answer.error
  }
  return answers
}

/** The launch id in a Sticky project's uri, which a launch stores as a data URI. Anything else has none. */
function launchIdIn(uri: string): string | null {
  if (!uri.startsWith('data:application/json')) return null
  const comma = uri.indexOf(',')
  if (comma < 0) return null
  try {
    const payload = uri.slice(comma + 1)
    const json = uri.slice(0, comma).includes(';base64') ? atob(payload) : decodeURIComponent(payload)
    const metadata: unknown = JSON.parse(json)
    if (typeof metadata !== 'object' || metadata === null) return null
    const { protocol, launchId } = metadata as { protocol?: unknown; launchId?: unknown }
    return protocol === 'Sticky' && typeof launchId === 'string' && launchId !== '' ? launchId : null
  } catch {
    return null
  }
}

/** One Sticky project: its tokens, its terminal balance and its supply, all read at one block. The
 * deployment's own contracts are asked first, and they name the two tokens and the store; those are
 * asked second. Each round is one Multicall3 request, and both ask the same block. */
export async function readStickyProject(
  chainId: number,
  projectId: bigint,
): Promise<StickyProjectInfo> {
  const deployment = deploymentOn(chainId)
  const client = jbCenterPublicClient(chainId)
  const blockNumber = await client.getBlockNumber()
  const where = `Sticky project ${projectId} on chain ${chainId}`
  const need = <T>(answer: Answer<T>, read: string): T => {
    if (answer.status === 'success') return answer.result
    throw new Error(`${where}: ${read} could not be read.`, { cause: answer.error })
  }

  const [stakedTokenOf, taxRateOf, tokenOf, orphanedOf, storeOf, uriOf] = answered(
    await client.multicall({
      contracts: [
        { address: deployment.deployer, abi: stickyDeployerAbi, functionName: 'stakedTokenOf', args: [projectId] },
        { address: deployment.deployer, abi: stickyDeployerAbi, functionName: 'cashOutTaxRateOf', args: [projectId] },
        // The hook binds each project to the one token allowed to report its transfers and burns.
        { address: deployment.hook, abi: stickyHookAbi, functionName: 'tokenOf', args: [projectId] },
        { address: deployment.hook, abi: stickyHookAbi, functionName: 'orphanedBalanceOf', args: [projectId] },
        { address: deployment.terminal, abi: terminalAbi, functionName: 'STORE' },
        { address: deployment.controller, abi: controllerAbi, functionName: 'uriOf', args: [projectId] },
      ],
      allowFailure: true,
      blockNumber,
    }),
  )
  const stakedToken = need(stakedTokenOf, 'the staked token')
  if (stakedToken === zeroAddress) {
    throw new Error(`Project ${projectId} is not a Sticky token of this deployer.`)
  }
  const cashOutTaxRate = need(taxRateOf, 'the stickiness bonus')
  const stToken = need(tokenOf, 'the Sticky token')
  const savedOrphaned = need(orphanedOf, 'the unowned backing')
  const store = need(storeOf, 'the store')

  const [symbolOf, decimalsOf, nameOf, stSymbolOf, stNameOf, soulboundOf, totalSupplyOf, balanceOf] = answered(
    await client.multicall({
      contracts: [
        { address: stakedToken, abi: erc20Abi, functionName: 'symbol' },
        { address: stakedToken, abi: erc20Abi, functionName: 'decimals' },
        { address: stakedToken, abi: erc20Abi, functionName: 'name' },
        { address: stToken, abi: stickyTokenAbi, functionName: 'symbol' },
        { address: stToken, abi: stickyTokenAbi, functionName: 'name' },
        { address: stToken, abi: stickyTokenAbi, functionName: 'SOULBOUND' },
        { address: stToken, abi: stickyTokenAbi, functionName: 'totalSupply' },
        {
          address: store,
          abi: terminalStoreAbi,
          functionName: 'balanceOf',
          args: [deployment.terminal, projectId, stakedToken],
        },
      ],
      allowFailure: true,
      blockNumber,
    }),
  )
  const symbol = need(symbolOf, 'the underlying symbol')
  const decimals = need(decimalsOf, 'the underlying decimals')
  const name = need(nameOf, 'the underlying name')
  const stSymbol = need(stSymbolOf, 'the Sticky symbol')
  const stName = need(stNameOf, 'the Sticky name')
  const totalSupply = need(totalSupplyOf, 'the Sticky supply')
  const held = need(balanceOf, 'the terminal balance')

  if (savedOrphaned > held) throw new Error('The Sticky pool returned inconsistent backing accounting.')
  // With no shares left, whatever the terminal still holds belongs to nobody.
  const orphaned = totalSupply === 0n ? held : savedOrphaned

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
    // The launch id only groups sibling chains, so a uri that will not read means no siblings.
    launchId: uriOf.status === 'success' ? launchIdIn(uriOf.result) : null,
    blockNumber,
  }
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
