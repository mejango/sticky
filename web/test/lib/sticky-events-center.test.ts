import { pad, toHex, type Address, type Hex, type PublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScannedLog } from '@/lib/hook-logs'
import { controllerAbi, projectsAbi } from '@/lib/sticky-abis'
import { stickyDeployment } from '@/lib/sticky-addresses'
import { projectCreationBlock, stickyEvents, stickyHolderEvents, stickyProjectsOn } from '@/lib/sticky-events'
import type { IndexedStickyEvent } from '@/lib/sticky-indexed'
import {
  CHAIN,
  CREATED,
  DEPLOYER,
  GRANTER,
  HOLDER,
  HOOK,
  OTHER,
  POSITION_TOPICS,
  PROJECT_TOPICS,
  TOPIC,
  deployment,
  deploySticky,
  granterSet,
  staked,
  streakStarted,
  timeAt,
  topic,
} from './sticky-log-fixtures'

// The reads sticky-events makes when a caller gives it none: Bendystraw's readers, and Center through the hook-log
// scanner and its saved history, which run for real here. Center is a fake client that answers from a list of logs,
// receipts and past counts. Each case is about a project of its own, since the session keeps creation blocks.

const center = vi.hoisted(() => ({ client: vi.fn() }))
vi.mock('@/lib/jbcenter-rpc', () => ({ jbCenterPublicClient: center.client }))
const bendystraw = vi.hoisted(() => ({ events: vi.fn(), settings: vi.fn(), createTx: vi.fn() }))
vi.mock('@/lib/sticky-indexed', () => ({
  indexedStickyEvents: bendystraw.events,
  indexedStickySettings: bendystraw.settings,
  indexedStickyCreateTx: bendystraw.createTx,
}))

const PROJECTS = `0x${'5'.repeat(40)}` as Address
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

type Filter = { address: Address; topics: (Hex | Hex[] | null)[]; fromBlock: Hex; toBlock: Hex }
type Read = { address: Address; abi: unknown; functionName: string; blockNumber?: bigint }

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

function matches(entry: ScannedLog, { address, topics, fromBlock, toBlock }: Filter): boolean {
  const inRange = entry.blockNumber >= BigInt(fromBlock) && entry.blockNumber <= BigInt(toBlock)
  const topicsMatch = topics.every(
    (wanted, i) => wanted === null || (Array.isArray(wanted) ? wanted.includes(entry.topics[i]!) : wanted === entry.topics[i]),
  )
  return same(entry.address, address) && inRange && topicsMatch
}

type Chain = {
  head: bigint
  logs?: ScannedLog[]
  receipts?: Record<Hex, { blockNumber: bigint; logs: ScannedLog[] }>
  /** JBProjects.count() at a block. */
  count?: (block: bigint) => bigint
  /** Block times, by block number. */
  times?: Record<string, bigint>
}

/** Center, as the one client every chain read goes through. `requests` lists each eth_getLogs filter sent. */
function node({ head, logs = [], receipts = {}, count, times = {} }: Chain) {
  const requests: Filter[] = []
  const client = {
    getBlockNumber: vi.fn(async () => head),
    request: vi.fn(async ({ method, params }: { method: string; params: [Filter] }, _options?: unknown) => {
      if (method !== 'eth_getLogs') throw new Error(`unexpected ${method}`)
      requests.push(params[0])
      return logs.filter(entry => matches(entry, params[0])).map(rpcLog)
    }),
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => {
      const receipt = receipts[hash]
      if (!receipt) throw new Error(`Transaction receipt with hash "${hash}" could not be found.`)
      return receipt
    }),
    readContract: vi.fn(async ({ address, functionName, blockNumber }: Read) => {
      if (functionName === 'PROJECTS' && same(address, deployment.controller)) return PROJECTS
      if (functionName === 'count' && same(address, PROJECTS) && count && blockNumber !== undefined) return count(blockNumber)
      throw new Error(`unexpected ${functionName} of ${address}`)
    }),
    getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => {
      const timestamp = times[String(blockNumber)]
      if (timestamp === undefined) throw new Error(`unexpected block ${blockNumber}`)
      return { number: blockNumber, timestamp }
    }),
  }
  center.client.mockReturnValue(client as unknown as PublicClient)
  return { ...client, requests }
}

const indexedAt = (block: bigint) => ({ rows: [], blocks: new Map([[CHAIN, block]]) })
const historyKey = (projectId: bigint) => `sticky.history.v1:${CHAIN}:${HOOK.toLowerCase()}:${projectId}`

beforeEach(() => {
  localStorage.clear()
  for (const mock of [center.client, bendystraw.events, bendystraw.settings, bendystraw.createTx]) mock.mockReset()
  // A read that falls back tells the console why; sticky-events.test.ts checks what it says.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('stickyEvents through Center', () => {
  it('completes Bendystraw\'s answer with a scan of the hook from 64 blocks below the block after its own through the head', async () => {
    const block = CREATED + 1_000n
    const known = staked(HOLDER, HOLDER, 1n, 1n, { blockNumber: block })
    // Bendystraw has the stick at its own block; the scan reads it again, and counts it once.
    const row: IndexedStickyEvent = {
      chainId: CHAIN,
      projectId: 23n,
      txHash: known.transactionHash,
      logIndex: known.logIndex,
      timestamp: timeAt(block),
      holder: HOLDER,
      type: 'staked',
      payer: HOLDER,
      count: 1n,
      stakedBalance: 1n,
    }
    bendystraw.events.mockResolvedValue({ ...indexedAt(block), rows: [row] })
    bendystraw.settings.mockResolvedValue(indexedAt(block))
    const chain = node({
      head: block + 300n,
      logs: [
        known,
        staked(HOLDER, HOLDER, 1n, 2n, { blockNumber: block + 5n }),
        staked(HOLDER, HOLDER, 1n, 1n, { blockNumber: block + 6n, project: 24n }),
      ],
    })
    const { signal } = new AbortController()

    const result = await stickyEvents(CHAIN, 23n, { signal })

    expect(result).toMatchObject({ source: 'indexed', degraded: null })
    expect(result.events.map(event => [event.blockNumber, event.balance])).toEqual([
      [null, 1n],
      [block + 5n, 2n],
    ])
    expect(bendystraw.events).toHaveBeenCalledWith({ chainId: CHAIN, projectId: 23n }, signal)
    expect(bendystraw.settings).toHaveBeenCalledWith(CHAIN, 23n, signal)
    expect(chain.requests).toEqual([
      { address: HOOK, topics: [PROJECT_TOPICS, topic(23n)], fromBlock: toHex(block + 1n - 64n), toBlock: toHex(block + 300n) },
    ])
    expect(chain.request.mock.calls[0][1]).toEqual({ signal })
    // Through the head as Center says it now: a read right after a write reaches the write's block.
    expect(chain.getBlockNumber).toHaveBeenCalledWith({ cacheTime: 0 })
    expect(chain.getBlockNumber).not.toHaveBeenCalledWith()
  })

  it('without Bendystraw, scans the project\'s history from its checked creation block, and keeps it in this browser', async () => {
    const created = CREATED + 2_000n
    const head = created + 400n
    const tx = `0x${'2'.repeat(64)}` as Hex
    bendystraw.events.mockRejectedValue(new Error('Unknown type "stickyEventFilter"'))
    bendystraw.settings.mockRejectedValue(new Error('Unknown type "stickySettingEventFilter"'))
    bendystraw.createTx.mockResolvedValue(tx)
    const chain = node({
      head,
      receipts: { [tx]: { blockNumber: created, logs: [deploySticky(25n, { blockNumber: created })] } },
      logs: [
        granterSet(GRANTER, { project: 25n, blockNumber: created }),
        staked(HOLDER, HOLDER, 1n, 1n, { project: 25n, blockNumber: created + 10n }),
      ],
    })

    const result = await stickyEvents(CHAIN, 25n)

    expect(result).toMatchObject({ source: 'scanned', degraded: 'indexer-error' })
    expect(result.events.map(event => event.kind)).toEqual(['granter', 'stick'])
    expect(bendystraw.createTx).toHaveBeenCalledWith(CHAIN, 25n, undefined)
    expect(chain.getTransactionReceipt).toHaveBeenCalledWith({ hash: tx })
    expect(chain.requests).toEqual([
      { address: HOOK, topics: [PROJECT_TOPICS, topic(25n)], fromBlock: toHex(created), toBlock: toHex(head) },
    ])
    expect(JSON.parse(localStorage.getItem(historyKey(25n))!)).toMatchObject({
      from: String(created),
      through: String(head - 64n),
    })
  })

  describe('when neither Bendystraw nor the chain can place the project\'s creation', () => {
    const outage = (head: bigint) => {
      bendystraw.events.mockRejectedValue(new Error('down'))
      bendystraw.settings.mockRejectedValue(new Error('down'))
      bendystraw.createTx.mockRejectedValue(new Error('down'))
      // No `count`: a node without archive state refuses every read at a past block.
      return node({ head, logs: [staked(HOLDER, HOLDER, 1n, 2n, { project: 40n, blockNumber: head - 10n })] })
    }

    it('resumes the history this browser saved after its last block, and scans nothing before', async () => {
      const created = CREATED + 9_000n
      const through = created + 500n
      const saved = [staked(HOLDER, HOLDER, 1n, 1n, { project: 40n, blockNumber: created + 20n })]
      localStorage.setItem(
        historyKey(40n),
        JSON.stringify({ from: String(created), through: String(through), all: saved.map(rpcLog) }),
      )
      const chain = outage(through + 200n)

      const result = await stickyEvents(CHAIN, 40n)

      expect(result).toMatchObject({ source: 'scanned', degraded: 'indexer-error' })
      expect(result.events.map(event => event.blockNumber)).toEqual([created + 20n, through + 190n])
      expect(chain.requests.map(request => BigInt(request.fromBlock))).toEqual([through + 1n])
    })

    it('without a saved history, scans from the deployer\'s block', async () => {
      const chain = outage(deployment.fromBlock + 400n)

      const result = await stickyEvents(CHAIN, 41n)

      expect(result.events).toEqual([])
      expect(chain.requests.map(request => BigInt(request.fromBlock))).toEqual([deployment.fromBlock])
    })
  })

  it('reads the block time of a log the old client kept without one, once a session', async () => {
    const created = CREATED + 3_000n
    const tx = `0x${'3'.repeat(64)}` as Hex
    bendystraw.events.mockRejectedValue(new Error('down'))
    bendystraw.settings.mockRejectedValue(new Error('down'))
    bendystraw.createTx.mockResolvedValue(tx)
    // The old client's history: no start of its own, and logs from an RPC that sent no times.
    const kept = [
      staked(HOLDER, HOLDER, 1n, 1n, { project: 26n, blockNumber: created + 10n, time: null }),
      streakStarted(HOLDER, { project: 26n, blockNumber: created + 10n, logIndex: 1, time: null }),
    ]
    localStorage.setItem(historyKey(26n), JSON.stringify({ through: String(created + 100n), all: kept.map(rpcLog) }))
    const chain = node({
      head: created + 300n,
      receipts: { [tx]: { blockNumber: created, logs: [deploySticky(26n)] } },
      times: { [String(created + 10n)]: 1_700_000_000n },
    })

    const first = await stickyEvents(CHAIN, 26n)
    const again = await stickyEvents(CHAIN, 26n)

    expect(first.events.map(event => [event.kind, event.timestamp])).toEqual([
      ['stick', 1_700_000_000],
      ['streakStart', 1_700_000_000],
    ])
    expect(again.events).toEqual(first.events)
    expect(chain.getBlock).toHaveBeenCalledTimes(1)
    expect(chain.getBlock).toHaveBeenCalledWith({ blockNumber: created + 10n })
  })

})

describe('projectCreationBlock through Center', () => {
  it('searches JBProjects.count() at past blocks, on the JBProjects the controller names, asked once a session', async () => {
    // A chain no other case here reads JBProjects on, since the session keeps it.
    const arbitrumSepolia = stickyDeployment(421614)!
    const at27 = arbitrumSepolia.fromBlock + 777n
    const at29 = arbitrumSepolia.fromBlock + 3_210n
    bendystraw.createTx.mockResolvedValue(null)
    const chain = node({
      head: arbitrumSepolia.fromBlock + 5_000n,
      count: block => (block >= at29 ? 29n : block >= at27 ? 27n : 26n),
    })
    const { signal } = new AbortController()

    expect(await projectCreationBlock(421614, 27n, { signal })).toBe(at27)
    expect(await projectCreationBlock(421614, 29n, { signal })).toBe(at29)

    expect(center.client.mock.calls.every(([chainId]) => chainId === 421614)).toBe(true)
    const reads = chain.readContract.mock.calls.map(([read]) => read)
    expect(reads.filter(read => read.functionName === 'PROJECTS')).toEqual([
      { address: arbitrumSepolia.controller, abi: controllerAbi, functionName: 'PROJECTS' },
    ])
    const counts = reads.filter(read => read.functionName === 'count')
    expect(counts.length).toBeGreaterThan(0)
    expect(counts.every(read => read.address === PROJECTS && read.abi === projectsAbi && read.blockNumber !== undefined)).toBe(true)
  })
})

describe('cancelling', () => {
  const never = () => new Promise<never>(() => {})
  /** What a case starts, how to tell the read left unanswered has been asked, and what must not be read after. */
  type Hung = { read: (signal: AbortSignal) => Promise<unknown>; asked: () => boolean; untouched: { mock: { calls: unknown[] } }[] }
  /** The whole history of a project Bendystraw cannot answer for, created at `created` by a checked transaction. */
  const unindexed = (projectId: bigint, created: bigint, logs: ScannedLog[] = []) => {
    const tx = pad(toHex(projectId), { size: 32 })
    bendystraw.events.mockRejectedValue(new Error('down'))
    bendystraw.settings.mockRejectedValue(new Error('down'))
    bendystraw.createTx.mockResolvedValue(tx)
    return node({ head: created + 300n, logs, receipts: { [tx]: { blockNumber: created, logs: [deploySticky(projectId)] } } })
  }

  it.each<[string, () => Hung]>([
    [
      'the head, before a scan past Bendystraw\'s block',
      () => {
        const block = CREATED + 6_000n
        bendystraw.events.mockResolvedValue(indexedAt(block))
        bendystraw.settings.mockResolvedValue(indexedAt(block))
        const chain = node({ head: block })
        chain.getBlockNumber.mockImplementation(never)
        return { read: signal => stickyEvents(CHAIN, 32n, { signal }), asked: () => chain.getBlockNumber.mock.calls.length > 0, untouched: [chain.request] }
      },
    ],
    [
      'the head, before a scan of the whole history',
      () => {
        const chain = unindexed(34n, CREATED + 8_000n)
        chain.getBlockNumber.mockImplementation(never)
        return { read: signal => stickyEvents(CHAIN, 34n, { signal }), asked: () => chain.getBlockNumber.mock.calls.length > 0, untouched: [chain.request] }
      },
    ],
    [
      'a block\'s time',
      () => {
        const created = CREATED + 7_000n
        const kept = [staked(HOLDER, HOLDER, 1n, 1n, { project: 38n, blockNumber: created + 10n, time: null })]
        localStorage.setItem(historyKey(38n), JSON.stringify({ through: String(created + 100n), all: kept.map(rpcLog) }))
        const chain = unindexed(38n, created)
        chain.getBlock.mockImplementation(never)
        return { read: signal => stickyEvents(CHAIN, 38n, { signal }), asked: () => chain.getBlock.mock.calls.length > 0, untouched: [] }
      },
    ],
    [
      'a receipt',
      () => {
        const tx = `0x${'4'.repeat(64)}` as Hex
        bendystraw.createTx.mockResolvedValue(tx)
        const chain = node({ head: deployment.fromBlock + 5_000n, count: () => 33n })
        chain.getTransactionReceipt.mockImplementation(never)
        return {
          read: signal => projectCreationBlock(CHAIN, 33n, { signal }),
          asked: () => chain.getTransactionReceipt.mock.calls.length > 0,
          // Cancelling is no reason to search instead.
          untouched: [chain.getBlockNumber, chain.readContract],
        }
      },
    ],
    [
      'the head, before a search',
      () => {
        bendystraw.createTx.mockResolvedValue(null)
        const chain = node({ head: 0n })
        chain.getBlockNumber.mockImplementation(never)
        return { read: signal => projectCreationBlock(CHAIN, 35n, { signal }), asked: () => chain.getBlockNumber.mock.calls.length > 0, untouched: [chain.readContract] }
      },
    ],
    [
      'JBProjects',
      () => {
        // On a chain whose JBProjects this session has not read yet.
        bendystraw.createTx.mockResolvedValue(null)
        const chain = node({ head: 50_000_000n })
        chain.readContract.mockImplementation(never)
        return { read: signal => projectCreationBlock(84532, 36n, { signal }), asked: () => chain.readContract.mock.calls.length > 0, untouched: [] }
      },
    ],
    [
      'a count',
      () => {
        bendystraw.createTx.mockResolvedValue(null)
        const chain = node({ head: deployment.fromBlock + 5_000n, count: () => 37n })
        const answer = chain.readContract.getMockImplementation()!
        chain.readContract.mockImplementation(read => (read.functionName === 'count' ? never() : answer(read)))
        const counts = () => chain.readContract.mock.calls.filter(([read]) => read.functionName === 'count')
        return { read: signal => projectCreationBlock(CHAIN, 37n, { signal }), asked: () => counts().length > 0, untouched: [] }
      },
    ],
  ])('stops waiting on %s when the caller cancels', async (_read, start) => {
    const { read, asked, untouched } = start()
    const controller = new AbortController()
    const reason = new Error('left the page')

    const reading = read(controller.signal)
    await vi.waitFor(() => expect(asked()).toBe(true))
    const before = untouched.map(mock => mock.mock.calls.length)
    controller.abort(reason)

    await expect(reading).rejects.toBe(reason)
    expect(untouched.map(mock => mock.mock.calls.length)).toEqual(before)
  })
})

describe('stickyHolderEvents through Center', () => {
  it('scans the hook for the holder\'s position events from 64 blocks below the block after Bendystraw\'s', async () => {
    const block = CREATED + 4_000n
    bendystraw.events.mockResolvedValue(indexedAt(block))
    const chain = node({
      head: block + 100n,
      logs: [
        streakStarted(HOLDER, { blockNumber: block + 7n, project: 30n }),
        streakStarted(OTHER, { blockNumber: block + 8n, project: 30n }),
      ],
    })

    const result = await stickyHolderEvents(CHAIN, HOLDER)

    expect(result.events.map(event => [event.kind, event.projectId, event.holder])).toEqual([['streakStart', 30n, HOLDER]])
    expect(chain.requests).toEqual([
      { address: HOOK, topics: [POSITION_TOPICS, null, topic(HOLDER)], fromBlock: toHex(block + 1n - 64n), toBlock: toHex(block + 100n) },
    ])
  })
})

describe('stickyProjectsOn through Center', () => {
  it('scans the deployer for launches from 64 blocks below the block after the index\'s, counting each once', async () => {
    const block = CREATED + 5_000n
    const chain = node({
      head: block + 50n,
      logs: [deploySticky(31n, { blockNumber: block + 3n }), deploySticky(9n, { blockNumber: block - 1n })],
    })

    const result = await stickyProjectsOn(CHAIN, { blocks: new Map([[CHAIN, block]]), projects: [{ chainId: CHAIN, projectId: 9n }] })

    expect(result.projects.map(project => project.projectId)).toEqual([9n, 31n])
    expect(chain.requests).toEqual([
      { address: DEPLOYER, topics: [TOPIC.DeploySticky], fromBlock: toHex(block + 1n - 64n), toBlock: toHex(block + 50n) },
    ])
  })
})
