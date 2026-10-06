import {
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  getAddress,
  multicall3Abi,
  numberToHex,
  pad,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from 'viem'
import { vi } from 'vitest'
import type { ScannedLog } from '@/lib/hook-logs'
import {
  controllerAbi,
  projectsAbi,
  stickyDeployerAbi,
  stickyHookAbi,
  stickyTokenAbi,
  terminalAbi,
  terminalStoreAbi,
  tokensAbi,
} from '@/lib/sticky-abis'
import { stickyDeployment } from '@/lib/sticky-addresses'
import type {
  IndexedFee,
  IndexedMove,
  IndexedPosition,
  IndexedProjects,
  IndexedRows,
  IndexedSetting,
  IndexedStickyEvent,
} from '@/lib/sticky-indexed'
import { deploySticky } from './lib/sticky-log-fixtures'

// A page's reads against a fake Center at the HTTP boundary, as the suite's *-center tests fake it, and fake Bendystraw
// readers, in which every request takes the same time and nothing else takes any. So when a figure shows, counted in
// requests, is its sequential depth: how many requests stood one after another before it, each waiting on another's
// answer or for its turn. The traffic is counted as it goes: how many requests, and how many were in flight at once.
//
// The real Center reader runs (viem, its Multicall3 batching and its head cache, the SDK's provider and Sticky's
// transport), and so does every read above it. Only `fetch` answers for Center, and the readers of
// `@/lib/sticky-indexed`, which a test mocks with `fakeBendystraw`, for Bendystraw.

/** How long every request takes, Center's and Bendystraw's alike: one step of a page's sequential depth. It is the round
 * trip staging measured (task A.2: 0.35 to 0.5 s to Center), so the reads that go by the clock (an index that is no
 * longer fresh, the account's 15-second refresh) come when they would. */
export const STEP_MS = 400

export const E18 = 10n ** 18n

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'
/** JBTerminalStore, JBProjects and JBTokens, as the deployment's contracts name them on every fake chain. */
const STORE = getAddress(`0x${'4'.repeat(40)}`)
const PROJECTS = getAddress(`0x${'6'.repeat(40)}`)
const TOKENS = getAddress(`0x${'7'.repeat(40)}`)

/** A staked token's address (`kind` 1) or a Sticky token's (`kind` 2), which names the project it belongs to. */
const tokenAt = (kind: '1' | '2', chainId: number, projectId: bigint) =>
  getAddress(`0x${kind}5717${chainId.toString(16).padStart(15, '0')}${projectId.toString(16).padStart(20, '0')}`)
function tokenOwner(token: string) {
  const found = /^0x([12])5717([0-9a-f]{15})([0-9a-f]{20})$/i.exec(token)
  return found ? { kind: found[1], chainId: parseInt(found[2], 16), projectId: BigInt(`0x${found[3]}`) } : null
}

/** What a fake chain holds of one project: its tokens and backing, and each holder's stick. */
export type FakeProject = {
  symbol: string
  decimals: number
  stSymbol: string
  supply: bigint
  backing: bigint
  /** The block the project was created in, which JBProjects' count goes by. */
  created: bigint
  /** What each holder (lowercase) has staked, when their streak started and the longest one they had. */
  holders?: Record<string, { staked: bigint; start: number; longest: number }>
}

/** What Bendystraw holds of a chain. */
export type FakeIndex = {
  events: IndexedStickyEvent[]
  settings: IndexedSetting[]
  positions: IndexedPosition[]
  moves: IndexedMove[]
  fees: IndexedFee[]
}

/** One fake chain: its head, its projects by ID, every log on it, and what Bendystraw has of it, as of `asOf`. A chain
 * with no `asOf` is one Bendystraw has no status for. */
export type FakeChain = {
  head: bigint
  projects: Record<string, FakeProject>
  logs: ScannedLog[]
  asOf?: bigint
  index?: FakeIndex
}

export type FakeWorld = {
  chains: Record<number, FakeChain>
  /** Whether Bendystraw answers at all. */
  bendystraw: boolean
}

/** The transaction that created a project, which Bendystraw names and whose receipt shows the deployer launching it. */
const creationTx = (chainId: number, projectId: bigint): Hex =>
  pad(toHex((BigInt(chainId) << 64n) + projectId), { size: 32 })

/** A block's time on every fake chain, in Unix seconds. */
export const timeOf = (block: bigint) => 1_790_000_000 + Number(block % 10_000_000n)

/** One request: which service, what it asked and with what, and when it began and ended, in ms since the page opened. */
export type Request = {
  service: 'center' | 'bendystraw'
  what: string
  chainId: number | null
  params?: unknown[]
  start: number
  end?: number
}

/** The traffic of a page: every request in order, and the most of Center's that were in flight at once. */
export class Traffic {
  readonly requests: Request[] = []
  peak = 0
  private open = 0
  private readonly origin = Date.now()

  begin(service: Request['service'], what: string, chainId: number | null, params?: unknown[]): Request {
    const request: Request = { service, what, chainId, params, start: Date.now() - this.origin }
    this.requests.push(request)
    if (service === 'center') {
      this.open += 1
      this.peak = Math.max(this.peak, this.open)
    }
    return request
  }

  end(request: Request): void {
    request.end = Date.now() - this.origin
    if (request.service === 'center') this.open -= 1
  }

  /** The time now, in ms since the page opened. */
  now(): number {
    return Date.now() - this.origin
  }

  /** The requests of `service` that began before `ms`. */
  of(service: Request['service'], ms = Infinity): Request[] {
    return this.requests.filter(request => request.service === service && request.start < ms)
  }
}

/** Waits one step of fake time, or rejects with the reason the moment `signal` aborts, as a request in flight does. */
function step(signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, STEP_MS)
    function abort() {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

type Contract = { abi: Abi; answer: (functionName: string, args: readonly unknown[], block: bigint) => unknown }

/** What each contract of a fake chain answers, by its lowercase address. */
function contractsOf(chainId: number, chain: FakeChain): Map<string, Contract> {
  const deployment = stickyDeployment(chainId)!
  const project = (projectId: unknown) => {
    const found = chain.projects[String(projectId)]
    if (!found) throw new Error(`The fake chain ${chainId} has no project ${String(projectId)}.`)
    return found
  }
  const holding = (projectId: unknown, holder: unknown) =>
    project(projectId).holders?.[String(holder).toLowerCase()] ?? { staked: 0n, start: 0, longest: 0 }
  // Project IDs count up: a chain's projects here are its newest, and every older one was created before them.
  const ids = Object.keys(chain.projects).map(BigInt)
  const older = ids.reduce((low, id) => (id < low ? id : low), ids[0] ?? 1n) - 1n
  const contracts = new Map<string, Contract>()
  const at = (address: Address, contract: Contract) => contracts.set(address.toLowerCase(), contract)
  at(deployment.terminal, { abi: terminalAbi, answer: name => (name === 'STORE' ? STORE : undefined) })
  at(deployment.deployer, {
    abi: stickyDeployerAbi,
    answer: (name, [projectId]) =>
      name === 'stakedTokenOf'
        ? (project(projectId), tokenAt('1', chainId, projectId as bigint))
        : name === 'cashOutTaxRateOf'
          ? 1_000n
          : name === 'TOKENS'
            ? TOKENS
            : undefined,
  })
  at(deployment.hook, {
    abi: stickyHookAbi,
    answer: (name, [projectId, holder]) => {
      switch (name) {
        case 'tokenOf':
          return tokenAt('2', chainId, projectId as bigint)
        case 'orphanedBalanceOf':
          return 0n
        case 'stakedBalanceOf':
          return holding(projectId, holder).staked
        case 'streakStartOf':
          return BigInt(holding(projectId, holder).start)
        case 'longestStreakOf':
          return BigInt(holding(projectId, holder).longest)
        default:
          return undefined
      }
    },
  })
  at(deployment.controller, {
    abi: controllerAbi,
    answer: name => (name === 'uriOf' ? '' : name === 'PROJECTS' ? PROJECTS : undefined),
  })
  at(STORE, { abi: terminalStoreAbi, answer: (name, [, projectId]) => (name === 'balanceOf' ? project(projectId).backing : undefined) })
  at(PROJECTS, {
    abi: projectsAbi,
    answer: (name, _args, block) =>
      name === 'count'
        ? ids.filter(id => chain.projects[id.toString()].created <= block).reduce((high, id) => (id > high ? id : high), older)
        : undefined,
  })
  // No staked token here is a Juicebox project's: a project's logo costs its two reads and no more.
  at(TOKENS, { abi: tokensAbi, answer: name => (name === 'projectIdOf' ? 0n : undefined) })
  return contracts
}

/** What a call to a fake token answers, or undefined when `to` is no token of the chain's. */
function tokenCall(chainId: number, chain: FakeChain, to: string, data: Hex): Hex | undefined {
  const token = tokenOwner(to)
  if (!token || token.chainId !== chainId) return undefined
  const project = chain.projects[token.projectId.toString()]
  if (!project) throw new Error(`The fake chain ${chainId} has no project ${token.projectId}.`)
  const staked = token.kind === '1'
  const abi = staked ? erc20Abi : stickyTokenAbi
  const { functionName } = decodeFunctionData({ abi, data })
  const answers: Record<string, unknown> = {
    symbol: staked ? project.symbol : project.stSymbol,
    name: staked ? 'Coupon' : `Sticky ${project.symbol}`,
    decimals: project.decimals,
    totalSupply: project.supply,
    SOULBOUND: false,
  }
  if (!(functionName in answers)) throw new Error(`The fake token ${to} has no ${functionName}.`)
  return encodeFunctionResult({ abi, functionName, result: answers[functionName] } as never)
}

/** What one call answers on a fake chain at `block`. */
function callOn(chainId: number, chain: FakeChain, contracts: Map<string, Contract>, to: string, data: Hex, block: bigint): Hex {
  const fromToken = tokenCall(chainId, chain, to, data)
  if (fromToken !== undefined) return fromToken
  const contract = contracts.get(to.toLowerCase())
  if (!contract) throw new Error(`The fake chain ${chainId} has no contract at ${to}.`)
  const { functionName, args = [] } = decodeFunctionData({ abi: contract.abi, data })
  const result = contract.answer(functionName, args, block)
  if (result === undefined) throw new Error(`The fake contract ${to} has no ${functionName}.`)
  return encodeFunctionResult({ abi: contract.abi, functionName, result } as never)
}

type LogFilter = { address: string; topics?: (Hex | Hex[] | null)[]; fromBlock: Hex; toBlock: Hex }

/** Whether a log matches an eth_getLogs filter: its address, its block, and each topic the filter names. */
function matches(log: ScannedLog, filter: LogFilter) {
  const inRange = log.blockNumber >= BigInt(filter.fromBlock) && log.blockNumber <= BigInt(filter.toBlock)
  const topics = (filter.topics ?? []).every((wanted, at) => {
    const own = log.topics[at]?.toLowerCase()
    return wanted === null || (Array.isArray(wanted) ? wanted.some(one => one.toLowerCase() === own) : wanted.toLowerCase() === own)
  })
  return log.address.toLowerCase() === filter.address.toLowerCase() && inRange && topics
}

/** A log as Center sends it, with its block's time. */
const onWire = (log: ScannedLog) => ({
  address: log.address,
  blockHash: log.blockHash,
  blockNumber: numberToHex(log.blockNumber),
  blockTimestamp: numberToHex(log.blockTimestamp ?? BigInt(timeOf(log.blockNumber))),
  data: log.data,
  logIndex: numberToHex(log.logIndex),
  removed: false,
  topics: log.topics,
  transactionHash: log.transactionHash,
  transactionIndex: numberToHex(log.transactionIndex),
})

/** Answers one JSON-RPC request on a fake chain. */
function answerRpc(chainId: number, chain: FakeChain, method: string, params: unknown[]): unknown {
  const blockOf = (tag: unknown) => (typeof tag === 'string' && tag.startsWith('0x') ? BigInt(tag) : chain.head)
  switch (method) {
    case 'eth_blockNumber':
      return numberToHex(chain.head)
    case 'eth_getBlockByNumber': {
      const number = blockOf(params[0])
      return {
        number: numberToHex(number),
        hash: pad(toHex(number), { size: 32 }),
        parentHash: pad(toHex(number - 1n), { size: 32 }),
        timestamp: numberToHex(timeOf(number)),
        transactions: [],
      }
    }
    case 'eth_getLogs':
      return chain.logs.filter(log => matches(log, params[0] as LogFilter)).map(onWire)
    case 'eth_getTransactionReceipt': {
      const [hash] = params as [Hex]
      const projectId = Object.keys(chain.projects).map(BigInt).find(id => creationTx(chainId, id) === hash)
      if (projectId === undefined) return null
      const created = chain.projects[projectId.toString()].created
      const launch = deploySticky(projectId, {
        address: stickyDeployment(chainId)!.deployer,
        blockNumber: created,
        txHash: hash,
        time: BigInt(timeOf(created)),
      })
      return {
        blockHash: launch.blockHash,
        blockNumber: numberToHex(created),
        logs: [onWire(launch)],
        status: '0x1',
        transactionHash: hash,
        transactionIndex: '0x0',
      }
    }
    case 'eth_call': {
      const [{ to, data }, tag] = params as [{ to: string; data: Hex }, unknown]
      const block = blockOf(tag)
      const contracts = contractsOf(chainId, chain)
      if (to.toLowerCase() !== MULTICALL3) return callOn(chainId, chain, contracts, to, data, block)
      const [calls] = decodeFunctionData({ abi: multicall3Abi, data }).args as readonly [readonly { target: Address; callData: Hex }[]]
      return encodeFunctionResult({
        abi: multicall3Abi,
        functionName: 'aggregate3',
        result: calls.map(({ target, callData }) => ({
          success: true,
          returnData: callOn(chainId, chain, contracts, target, callData, block),
        })),
      })
    }
    default:
      throw new Error(`The fake Center has no ${method}.`)
  }
}

/** Center for `world`, at the HTTP boundary: each request takes one step, and `traffic` counts it. */
export function serveCenter(world: FakeWorld, traffic: Traffic): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      const found = /\/v1\/rpc\/(\d+)$/.exec(url)
      if (!found) throw new Error(`Unexpected request to ${url}`)
      const chainId = Number(found[1])
      const chain = world.chains[chainId]
      if (!chain) throw new Error(`The fake Center has no chain ${chainId}.`)
      const { id, method, params = [] } = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown[] }
      const request = traffic.begin('center', method, chainId, params)
      try {
        await step(init?.signal)
        const result = answerRpc(chainId, chain, method, params)
        return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: { 'content-type': 'application/json' } })
      } finally {
        traffic.end(request)
      }
    }),
  )
}

/** Each covered chain's rows of an answer, with the block each is indexed through. */
function rowsOf<T>(world: FakeWorld, chainIds: readonly number[], pick: (index: FakeIndex) => T[]): IndexedRows<T> {
  const blocks = new Map<number, bigint>()
  const rows: T[] = []
  for (const chainId of chainIds) {
    const chain = world.chains[chainId]
    if (chain?.asOf === undefined || !chain.index) continue
    blocks.set(chainId, chain.asOf)
    rows.push(...pick(chain.index))
  }
  return { rows, blocks }
}

type Question = { chainId?: number; chainIds?: readonly number[]; projectId?: bigint; holder?: Address }
const chainsIn = ({ chainId, chainIds }: Question) => (chainId === undefined ? (chainIds ?? []) : [chainId])
const askedAbout =
  ({ projectId, holder }: Question) =>
  (row: { projectId: bigint; holder?: Address }) =>
    (projectId === undefined || row.projectId === projectId) &&
    (holder === undefined || row.holder?.toLowerCase() === holder.toLowerCase())

/** Bendystraw's readers for `world`, to stand in for `@/lib/sticky-indexed`'s: each answer takes one step and `traffic`
 * counts it, and a world whose Bendystraw is down has every read fail after its step. A read of moves is two requests
 * at once, pays and cash outs, as the real reader sends them, and a read of fees is two, the fees and the additions. */
export function fakeBendystraw(world: FakeWorld, traffic: Traffic) {
  async function answer<T>(what: string, chainId: number | null, signal: AbortSignal | undefined, give: () => T, requests = 1) {
    const sent = Array.from({ length: requests }, () => traffic.begin('bendystraw', what, chainId))
    try {
      await step(signal)
      if (!world.bendystraw) throw new Error('Bendystraw unavailable')
      return give()
    } finally {
      for (const request of sent) traffic.end(request)
    }
  }
  return {
    events: (q: Question, signal?: AbortSignal) =>
      answer('events', q.chainId ?? null, signal, () => rowsOf(world, chainsIn(q), index => index.events.filter(askedAbout(q)))),
    settings: (chainId: number, projectId: bigint, signal?: AbortSignal) =>
      answer('settings', chainId, signal, () =>
        rowsOf(world, [chainId], index => index.settings.filter(row => row.projectId === projectId)),
      ),
    positions: (q: Question, signal?: AbortSignal) =>
      answer('positions', q.chainId ?? null, signal, () =>
        rowsOf(world, chainsIn(q), index => index.positions.filter(askedAbout(q))),
      ),
    moves: (chainId: number, projectIds: readonly bigint[], signal?: AbortSignal, since = 0) =>
      answer(
        'moves',
        chainId,
        signal,
        () => rowsOf(world, [chainId], index => index.moves.filter(move => projectIds.includes(move.projectId) && move.timestamp >= since)),
        2,
      ),
    fees: (chainId: number, projectId: bigint, signal?: AbortSignal) =>
      answer('fees', chainId, signal, () => rowsOf(world, [chainId], index => index.fees.filter(row => row.projectId === projectId)), 2),
    projects: (_network: string, signal?: AbortSignal): Promise<IndexedProjects> =>
      answer('projects', null, signal, () => {
        const { blocks } = rowsOf(world, Object.keys(world.chains).map(Number), () => [])
        const projects = [...blocks.keys()].flatMap(chainId =>
          Object.keys(world.chains[chainId].projects).map(projectId => ({ chainId, projectId: BigInt(projectId) })),
        )
        return { blocks, projects }
      }),
    createTx: (chainId: number, projectId: bigint, signal?: AbortSignal): Promise<Hex | null> =>
      answer('createTx', chainId, signal, () =>
        world.chains[chainId]?.projects[projectId.toString()] ? creationTx(chainId, projectId) : null,
      ),
  }
}
