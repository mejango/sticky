import {
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  multicall3Abi,
  pad,
  toFunctionSelector,
  toHex,
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
} from 'viem'
import { vi } from 'vitest'
import type { ScannedLog } from '@/lib/hook-logs'
import { stickyDeployment } from '@/lib/sticky-addresses'

// A Center that answers what the airdrop reads ask of the distributor, the hook, the adapter and the tokens, from a
// table of what each contract returns. Real viem and the real Center reader run against it: only the HTTP call is
// faked, so Multicall3 batching, pinned blocks and the shapes of a revert and of a lost request are all real.

export const CHAIN = 84532
/** Past Base Sepolia's Multicall3 deployment, which viem checks when a read is pinned to a block. */
export const HEAD = 47_400_000n
/** The pinned block's time, and so the clock a round's claim deadline is measured against. */
export const NOW = 1_790_000_000
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'

export const deployment = stickyDeployment(CHAIN)!
export const address = (digit: string) => getAddress(`0x${digit.repeat(40)}`)
export const STAKED = address('2')
export const STICKY = address('3')
export const HOLDER = address('1')
export const OTHER = address('9')
export const PROJECT = 12n

/** What an answer that reverts is written as. */
export const REVERT = Symbol('revert')

const RAW = Symbol('raw')
/** An answer written as the bytes a contract returns, for one that the ABI could not encode, like decimals of 256. */
export const returning = (data: Hex) => ({ [RAW]: data })

export type Read = { target: Address; functionName: string; args: readonly unknown[] }
/** `from` is the sender a read that is not batched names: a batched read has none, since Multicall3 is its sender. */
export type Request = { method: string; block?: unknown; reads?: Read[]; from?: Address }
type Answer = (args: readonly unknown[]) => unknown
type Stocked = { abi: Abi; item: AbiFunction; answer: unknown }

type Call = { target: Address; callData: Hex }
type Filter = { address: Address; topics: (Hex | Hex[] | null)[]; fromBlock: Hex; toBlock: Hex }

/** A log as a node writes it on the wire. */
const rpcLog = (entry: ScannedLog) => ({
  address: entry.address,
  blockHash: entry.blockHash,
  blockNumber: toHex(entry.blockNumber),
  ...(entry.blockTimestamp === undefined ? {} : { blockTimestamp: toHex(entry.blockTimestamp) }),
  data: entry.data,
  logIndex: toHex(entry.logIndex),
  removed: false,
  topics: entry.topics,
  transactionHash: entry.transactionHash,
  transactionIndex: toHex(entry.transactionIndex),
})

function inFilter(entry: ScannedLog, { address: wanted, topics, fromBlock, toBlock }: Filter): boolean {
  const inRange = entry.blockNumber >= BigInt(fromBlock) && entry.blockNumber <= BigInt(toBlock)
  const topicsMatch = topics.every(
    (each, i) => each === null || (Array.isArray(each) ? each.includes(entry.topics[i]!) : each === entry.topics[i]),
  )
  return entry.address.toLowerCase() === wanted.toLowerCase() && inRange && topicsMatch
}

/** The fake Center. `stock` says what a contract returns, `deploy` gives an account code, `lose` makes it refuse
 * requests, and `requests` lists every request it got, with the calls a Multicall3 request carried. A read that names a sender is not batched, and is
 * answered alone with that sender in the request. */
export function rewardChain(logs: ScannedLog[] = []) {
  const table = new Map<string, Stocked>()
  /** The code of the accounts that have any, by lowercase address. */
  const codes = new Map<string, Hex>()
  const requests: Request[] = []
  let refuses: (reads: readonly Read[]) => boolean = () => false
  let blockNumberDown = false

  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const { id, method, params } = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] }
      const envelope = (result: unknown) =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: { 'content-type': 'application/json' } })
      const refused = () =>
        new Response(JSON.stringify({ error: { message: 'slow down' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        })
      if (method === 'eth_blockNumber') {
        requests.push({ method })
        return blockNumberDown ? refused() : envelope(toHex(HEAD))
      }
      if (method === 'eth_getBlockByNumber') {
        requests.push({ method })
        return envelope({
          number: toHex(HEAD),
          timestamp: toHex(NOW),
          hash: pad(toHex(HEAD), { size: 32 }),
          transactions: [],
        })
      }
      if (method === 'eth_getCode') {
        const [target] = params as [string, unknown]
        requests.push({ method, block: params[1] })
        return envelope(codes.get(target.toLowerCase()) ?? '0x')
      }
      if (method === 'eth_getLogs') {
        const filter = params[0] as Filter
        requests.push({ method, block: filter })
        return envelope(logs.filter(entry => inFilter(entry, filter)).map(rpcLog))
      }
      const [call, block] = params as [{ from?: Address; to: string; data: Hex }, unknown]
      if (method !== 'eth_call') throw new Error(`unexpected ${method} to ${call?.to}`)
      const find = (target: string, callData: Hex) => {
        const entry = table.get(`${target.toLowerCase()}:${callData.slice(0, 10)}`)
        if (!entry) throw new Error(`the fake chain has nothing at ${target} for ${callData.slice(0, 10)}`)
        const { functionName, args } = decodeFunctionData({ abi: entry.abi, data: callData })
        return { entry, read: { target: target as Address, functionName, args: args ?? [] } }
      }
      const answerOf = ({ entry, read }: ReturnType<typeof find>) => {
        const value = typeof entry.answer === 'function' ? entry.answer(read.args) : entry.answer
        if (value === REVERT) return { success: false, returnData: '0x' as Hex }
        if (typeof value === 'object' && value !== null && RAW in value) {
          return { success: true, returnData: (value as { [RAW]: Hex })[RAW] }
        }
        return {
          success: true,
          // The overloads of a function share their name, so only its own item is asked to encode.
          returnData: encodeFunctionResult({ abi: [entry.item], functionName: entry.item.name, result: value } as never),
        }
      }
      if (call.to.toLowerCase() !== MULTICALL3) {
        const found = find(call.to, call.data)
        requests.push({ method, block, reads: [found.read], from: call.from })
        if (refuses([found.read])) return refused()
        const { success, returnData } = answerOf(found)
        if (success) return envelope(returnData)
        const error = { code: 3, message: 'execution reverted', data: '0x' }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id, error }), { headers: { 'content-type': 'application/json' } })
      }
      const [calls] = decodeFunctionData({ abi: multicall3Abi, data: call.data }).args as readonly [readonly Call[]]
      const decoded = calls.map(({ target, callData }) => find(target, callData))
      requests.push({ method, block, reads: decoded.map(({ read }) => read) })
      if (refuses(decoded.map(({ read }) => read))) return refused()
      const result = decoded.map(answerOf)
      return envelope(encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result }))
    }),
  )

  /** What `functionName` of `target` returns: a value, a function of the call's arguments, or `REVERT`. Of an
   * overloaded function, the one with `arity` parameters. */
  function stock(target: Address, abi: Abi, functionName: string, answer: Answer, arity?: number): void
  function stock(target: Address, abi: Abi, functionName: string, answer: unknown, arity?: number): void
  function stock(target: Address, abi: Abi, functionName: string, answer: unknown, arity?: number) {
    const item = abi.find(
      (entry): entry is AbiFunction =>
        entry.type === 'function' && entry.name === functionName && (arity === undefined || entry.inputs.length === arity),
    )
    if (!item) throw new Error(`no ${functionName} in the ABI`)
    table.set(`${target.toLowerCase()}:${toFunctionSelector(item)}`, { abi, item, answer })
  }

  return {
    requests,
    stock,
    /** Gives `target` code, so it reads as a contract that exists. */
    deploy(target: Address, code: Hex = '0x6080') {
      codes.set(target.toLowerCase(), code)
    },
    /** Refuses, with a 429 as Center does when it is busy, any Multicall3 request whose calls `test` picks out. */
    lose(test: (reads: readonly Read[]) => boolean) {
      refuses = test
    },
    /** Refuses every request for the head block, so Center reads as down. */
    takeDown() {
      blockNumberDown = true
    },
    /** Every call the Multicall3 requests carried, in order. */
    reads: () => requests.flatMap(request => request.reads ?? []),
  }
}

/** The requests as [method, block, number of calls]. */
export const shape = (requests: Request[]) =>
  requests.map(({ method, block, reads }) => [method, typeof block === 'string' ? block : undefined, reads?.length])

export const blockHex = toHex(HEAD)
