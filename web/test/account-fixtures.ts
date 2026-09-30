import {
  BaseError,
  ContractFunctionExecutionError,
  getAddress,
  multicall3Abi,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import type { StickyEvent } from '@/lib/sticky-events'
import type { IndexedPosition } from '@/lib/sticky-indexed'

// The account page's fixtures, shared by its read model's, its hook's and its components' tests. A test sets the fields
// its expectations rest on and leaves the rest to these.

export const E18 = 10n ** 18n
export const E6 = 10n ** 6n
export const HOLDER = `0x${'a'.repeat(40)}` as Address
export const OTHER = `0x${'b'.repeat(40)}` as Address

/** An indexed position of HOLDER, as Bendystraw lists it. The balance is whatever the index last saw. */
export function positionRow(chainId: number, projectId: bigint, extra: Partial<IndexedPosition> = {}): IndexedPosition {
  return { chainId, projectId, holder: HOLDER, stakedBalance: E18, streakStartedAt: null, longestCompletedStreak: 0, ...extra }
}

let events = 0

/** A stick by HOLDER, paid by HOLDER, in a transaction of its own unless `extra` says otherwise. */
export function stick(chainId: number, projectId: bigint, timestamp: number, extra: Partial<StickyEvent> = {}): StickyEvent {
  events += 1
  return {
    kind: 'stick',
    chainId,
    projectId,
    holder: HOLDER,
    txHash: `0x${events.toString(16).padStart(64, '0')}` as Hex,
    logIndex: 1,
    blockNumber: null,
    timestamp,
    payer: HOLDER,
    count: 10n * E18,
    balance: 10n * E18,
    ...extra,
  }
}

// A fake chain. What it holds of a project is a `Fixture`, and a fake client answers the reads the account page makes
// of it: StickyHook's views of HOLDER, and the deployment's contracts, the tokens and the terminal's store for a
// project's figures.

/** What a fake chain holds of one project. */
type Fixture = {
  /** The staked token's symbol and decimals. */
  symbol?: string
  decimals?: number
  /** The Sticky token's symbol. */
  stSymbol?: string
  /** The Sticky shares in circulation and the backing behind them, in the staked token's units. */
  supply?: bigint
  backing?: bigint
  /** What HOLDER has staked in it, when its streak started and the longest one they had. */
  staked?: bigint
  start?: number
  longest?: number
  /** Whether the staked token loses the whole request that asks it anything, as a token can by answering with more than
   * Center carries. */
  hostile?: boolean
}

/** A chain's projects by ID. */
export type FakeChain = Record<string, Fixture>

/** One request a fake client got: which chain, and whether it has started or ended. */
export type Call = { chainId: number; phase: 'start' | 'end'; what: string }

const STORE = getAddress(`0x${'4'.repeat(40)}`)
const OFFSET_WORD: Hex = `0x${'0'.repeat(62)}20`

/** A staked token's address (`kind` 1) or a Sticky token's (`kind` 2), which names the project it belongs to. */
const tokenAt = (kind: '1' | '2', chainId: number, projectId: bigint) =>
  getAddress(`0x${kind}5717${chainId.toString(16).padStart(15, '0')}${projectId.toString(16).padStart(20, '0')}`)
/** The project a token of `tokenAt` belongs to, or null for any other address. */
function projectOf(token: string) {
  const found = /^0x([12])5717([0-9a-f]{15})([0-9a-f]{20})$/i.exec(token)
  return found ? { kind: found[1], chainId: parseInt(found[2], 16), projectId: BigInt(`0x${found[3]}`) } : null
}

/** Where a request that never got an answer is named: for Multicall3's function, not the call's. */
const unanswered = () =>
  new ContractFunctionExecutionError(new BaseError('Request exceeds defined limit.'), {
    abi: multicall3Abi,
    args: [],
    functionName: 'aggregate3',
  })

type Round = {
  contracts: readonly { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }[]
  allowFailure?: boolean
  batchSize?: number
}

const returnsBytes32 = ({ abi, functionName }: Round['contracts'][number]) =>
  abi.some(item => item.type === 'function' && item.name === functionName && item.outputs[0]?.type === 'bytes32')

/**
 * The clients Center gives, one per chain, over `chains`, with every request logged in `calls` when it starts and when
 * it ends. A request takes a few turns of the event loop, so two chains read at once would show in the log. A chain in
 * `broken` fails everything with `rpc down`.
 */
export function fakeCenter(
  chains: Record<number, FakeChain>,
  calls: Call[] = [],
  { broken = new Set<number>() }: { broken?: Set<number> } = {},
) {
  const clients = new Map<number, PublicClient>()
  return (chainId: number): PublicClient => {
    const known = clients.get(chainId)
    if (known) return known
    const fixture = (projectId: bigint) => chains[chainId]?.[projectId.toString()] ?? {}
    const request = async <T>(what: string, work: () => T): Promise<T> => {
      calls.push({ chainId, phase: 'start', what })
      try {
        await Promise.resolve()
        await Promise.resolve()
        if (broken.has(chainId)) throw new Error('rpc down')
        return work()
      } finally {
        calls.push({ chainId, phase: 'end', what })
      }
    }
    const tokenOf = (call: Round['contracts'][number]) => {
      const found = projectOf(call.address)
      if (!found) throw new Error(`the fake chain has no token at ${call.address}`)
      return found
    }
    const answer = (call: Round['contracts'][number]): unknown => {
      const [first, second] = call.args ?? []
      switch (call.functionName) {
        case 'stakedBalanceOf':
          return fixture(first as bigint).staked ?? 0n
        case 'streakStartOf':
          return BigInt(fixture(first as bigint).start ?? 0)
        case 'longestStreakOf':
          return BigInt(fixture(first as bigint).longest ?? 0)
        case 'STORE':
          return STORE
        case 'stakedTokenOf':
          return tokenAt('1', chainId, first as bigint)
        case 'cashOutTaxRateOf':
          return 1_000n
        case 'tokenOf':
          return tokenAt('2', chainId, first as bigint)
        case 'orphanedBalanceOf':
          return 0n
        case 'uriOf':
          return ''
        case 'SOULBOUND':
          return false
        case 'balanceOf':
          if (call.address === STORE && second !== undefined) return fixture(second as bigint).backing ?? E18
          throw new Error(`the fake chain has no balanceOf on ${call.address}`)
        case 'decimals':
          return fixture(tokenOf(call).projectId).decimals ?? 18
        case 'totalSupply':
          return fixture(tokenOf(call).projectId).supply ?? E18
        case 'symbol':
        case 'name': {
          if (returnsBytes32(call)) return OFFSET_WORD
          const { kind, projectId } = tokenOf(call)
          if (call.functionName === 'name') return kind === '1' ? 'Coupon' : 'Sticky Coupon'
          return kind === '1' ? (fixture(projectId).symbol ?? 'CPN') : (fixture(projectId).stSymbol ?? 'STK')
        }
        default:
          throw new Error(`the fake chain has no ${call.functionName}`)
      }
    }
    const hostile = (call: Round['contracts'][number]) => {
      const found = projectOf(call.address)
      return found !== null && found.kind === '1' && found.chainId === chainId && !!fixture(found.projectId).hostile
    }
    // Only these two reads exist: any other way of reaching the chain is a TypeError.
    const client = {
      getBlockNumber: () => request('getBlockNumber', () => 100n),
      multicall: ({ contracts, allowFailure }: Round) =>
        request(`multicall ${[...new Set(contracts.map(call => call.functionName))].join(',')}`, () => {
          if (contracts.some(hostile)) {
            if (!allowFailure) throw unanswered()
            return contracts.map(() => ({ status: 'failure' as const, error: unanswered() }))
          }
          const answers = contracts.map(answer)
          return allowFailure ? answers.map(result => ({ status: 'success' as const, result })) : answers
        }),
    } as unknown as PublicClient
    clients.set(chainId, client)
    return client
  }
}

/** The chains of `calls` that made requests, in the order they first did. */
export const chainsOf = (calls: readonly Call[]) => [...new Set(calls.map(call => call.chainId))]

/** Whether no chain of `calls` began a request while another chain's was still under way. */
export function oneAfterAnother(calls: readonly Call[]): boolean {
  let current: number | null = null
  let open = 0
  for (const { chainId, phase } of calls) {
    if (chainId !== current) {
      if (open !== 0) return false
      current = chainId
    }
    open += phase === 'start' ? 1 : -1
  }
  return open === 0
}
