import { zeroAddress, type Address, type Hex } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import type { ScannedLog } from '@/lib/hook-logs'
import {
  decodeHookLog,
  projectCreationBlock,
  stickyEvents,
  stickyHolderEvents,
  stickyProjectsOn,
  type StickyEvent,
  type StickyReadDeps,
} from '@/lib/sticky-events'
import type { IndexedProjects, IndexedSetting, IndexedStickyEvent } from '@/lib/sticky-indexed'
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
  SENDER,
  SET_TOKEN,
  TOPIC,
  deployment,
  deploySticky,
  granterSet,
  orphanExcluded,
  raw,
  staked,
  streakEnded,
  streakStarted,
  topic,
  trustSet,
  unstaked,
  words,
} from './sticky-log-fixtures'

// Every read goes through the `deps` a call is given, so nothing here reaches Bendystraw or Center. The
// default reads have tests of their own in sticky-events-center.test.ts.

// ev(txHash, logIndex, timestamp) is an indexed event (no block number);
// log(txHash, logIndex, blockNumber) is a raw hook log from the scanner.
const ev = (txHash: string, logIndex: number, timestamp: number): IndexedStickyEvent => ({
  chainId: CHAIN,
  projectId: 23n,
  txHash: txHash as Hex,
  logIndex,
  timestamp,
  holder: HOLDER,
  type: 'staked',
  payer: HOLDER,
  count: 1n,
  stakedBalance: 1n,
})
const log = (txHash: string, logIndex: number, blockNumber: bigint) =>
  staked(HOLDER, HOLDER, 1n, 1n, { txHash, logIndex, blockNumber })

type Place = { txHash: string; logIndex: number; timestamp: number; projectId?: bigint }
const placed = ({ txHash, logIndex, timestamp, projectId = 23n }: Place) => ({
  chainId: CHAIN,
  projectId,
  txHash: txHash as Hex,
  logIndex,
  timestamp,
})
/** Rows as Bendystraw's readers give them. */
const row = {
  staked: (holder: Address, payer: Address, count: bigint, stakedBalance: bigint, at: Place): IndexedStickyEvent => ({
    ...placed(at),
    holder,
    type: 'staked',
    payer,
    count,
    stakedBalance,
  }),
  unstaked: (holder: Address, count: bigint, stakedBalance: bigint, at: Place): IndexedStickyEvent => ({
    ...placed(at),
    holder,
    type: 'unstaked',
    count,
    stakedBalance,
  }),
  streakStarted: (holder: Address, at: Place): IndexedStickyEvent => ({ ...placed(at), holder, type: 'streakStarted' }),
  streakEnded: (holder: Address, duration: number, at: Place): IndexedStickyEvent => ({
    ...placed(at),
    holder,
    type: 'streakEnded',
    duration,
  }),
  granter: (granter: Address, at: Place): IndexedSetting => ({ ...placed(at), type: 'granterSet', granter, caller: DEPLOYER }),
  trust: (holder: Address, sender: Address, trusted: boolean, at: Place): IndexedSetting => ({
    ...placed(at),
    type: 'trustedSenderSet',
    holder,
    sender,
    trusted,
  }),
  orphans: (amount: bigint, at: Place): IndexedSetting => ({
    ...placed(at),
    type: 'orphanedBalanceExcluded',
    amount,
    caller: OTHER,
  }),
}

/** What Bendystraw answers: its rows, and the block its events read, and unless told otherwise its settings
 * read, is as of. Without a `block` (or with a null `settingsBlock`) it has no status for the chain. */
type Answer = {
  block?: bigint
  events?: IndexedStickyEvent[]
  settings?: IndexedSetting[]
  settingsBlock?: bigint | null
}
type Spec = {
  indexed: Answer | Error
  /** A failure of the settings read alone. */
  settings?: Error
  /** What a scan of the hook finds: past Bendystraw's block, or a holder's history. */
  tail?: ScannedLog[] | Error
  /** What a scan of a project's whole history finds. */
  full?: ScannedLog[] | Error
}

const unexpected = (name: string) => () => {
  throw new Error(`unexpected ${name}`)
}

/** Fakes of every read. `scans` lists where each scan started, a tail's and a whole history's alike,
 * `filters` what each hook scan asked for, and `signals` the signal each read was handed, in order. */
function fakeDeps(spec: Spec) {
  const scans: { fromBlock: bigint }[] = []
  const filters: Parameters<StickyReadDeps['scan']>[1][] = []
  const signals: (AbortSignal | undefined)[] = []
  const { indexed: answer } = spec
  const blocks = (block: bigint | null | undefined) =>
    new Map<number, bigint>(block === undefined || block === null ? [] : [[CHAIN, block]])
  const found = async (logs: ScannedLog[] | Error | undefined) => {
    if (logs instanceof Error) throw logs
    return logs ?? []
  }
  const deps = {
    indexedEvents: vi.fn<StickyReadDeps['indexedEvents']>(async (_q, signal) => {
      signals.push(signal)
      if (answer instanceof Error) throw answer
      return { rows: answer.events ?? [], blocks: blocks(answer.block) }
    }),
    indexedSettings: vi.fn<StickyReadDeps['indexedSettings']>(async (_chainId, _projectId, signal) => {
      signals.push(signal)
      if (spec.settings) throw spec.settings
      if (answer instanceof Error) throw answer
      return { rows: answer.settings ?? [], blocks: blocks(answer.settingsBlock === undefined ? answer.block : answer.settingsBlock) }
    }),
    scan: vi.fn<StickyReadDeps['scan']>(async (_chainId, filter, { signal }) => {
      scans.push({ fromBlock: filter.fromBlock })
      filters.push(filter)
      signals.push(signal)
      return found(spec.tail)
    }),
    projectLogs: vi.fn<StickyReadDeps['projectLogs']>(async (_chainId, _projectId, fromBlock, { signal }) => {
      scans.push({ fromBlock })
      signals.push(signal)
      return found(spec.full)
    }),
    creationBlock: vi.fn<StickyReadDeps['creationBlock']>(async (_chainId, _projectId, { signal }) => {
      signals.push(signal)
      return CREATED
    }),
    indexedCreateTx: vi.fn<StickyReadDeps['indexedCreateTx']>(unexpected('indexedCreateTx')),
    head: vi.fn<StickyReadDeps['head']>(unexpected('head')),
    receipt: vi.fn<StickyReadDeps['receipt']>(unexpected('receipt')),
    projectCount: vi.fn<StickyReadDeps['projectCount']>(unexpected('projectCount')),
  } satisfies StickyReadDeps
  return { ...deps, scans, filters, signals }
}

const hashes = (events: StickyEvent[]) => events.map(event => event.txHash)
const keys = (events: StickyEvent[]) => events.map(event => `${event.chainId}:${event.txHash}:${event.logIndex}`)

describe('stickyEvents', () => {
  it('uses Bendystraw and scans only past its indexed block', async () => {
    const deps = fakeDeps({ indexed: { block: 100n, events: [ev('0xa', 1, 90)] }, tail: [log('0xb', 1, 101n)] })
    const result = await stickyEvents(8453, 23n, deps)
    expect(result.source).toBe('indexed')
    expect(result.events.map(e => e.txHash)).toEqual(['0xa', '0xb'])
    expect(deps.scans).toEqual([{ fromBlock: 101n }])
  })
  it('never double counts an event both sources returned', async () => {
    const deps = fakeDeps({ indexed: { block: 99n, events: [ev('0xa', 1, 100)] }, tail: [log('0xa', 1, 100n)] })
    expect((await stickyEvents(8453, 23n, deps)).events).toHaveLength(1)
  })
  it('falls back to a full scan, marked degraded, when Bendystraw fails', async () => {
    const deps = fakeDeps({ indexed: new Error('Cannot query field "stickyEvents"'), full: [log('0xa', 1, 5n)] })
    const result = await stickyEvents(8453, 23n, deps)
    expect(result).toMatchObject({ source: 'scanned', degraded: 'indexer-error' })
    expect(result.events).toHaveLength(1)
  })
  it('rejects when both sources fail, instead of returning an empty history', async () => {
    const deps = fakeDeps({ indexed: new Error('down'), full: new Error('429 budget spent') })
    await expect(stickyEvents(8453, 23n, deps)).rejects.toThrow()
  })

  it('reads a chain Bendystraw does not index from the project\'s creation block, marked not indexed', async () => {
    const deps = fakeDeps({ indexed: { events: [] }, full: [log('0xa', 1, CREATED + 3n)] })
    const result = await stickyEvents(CHAIN, 23n, deps)
    expect(result).toEqual({ events: [expect.objectContaining({ txHash: '0xa' })], source: 'scanned', degraded: 'not-indexed' })
    expect(deps.creationBlock).toHaveBeenCalledWith(CHAIN, 23n, expect.anything())
    expect(deps.scans).toEqual([{ fromBlock: CREATED }])
    expect(deps.scan).not.toHaveBeenCalled()
  })

  it('counts a chain as not indexed when either read has no status for it', async () => {
    const deps = fakeDeps({ indexed: { block: 100n, events: [ev('0xa', 1, 90)], settingsBlock: null } })
    expect(await stickyEvents(CHAIN, 23n, deps)).toEqual({ events: [], source: 'scanned', degraded: 'not-indexed' })
    expect(deps.scans).toEqual([{ fromBlock: CREATED }])
  })

  it('reads the chain when either Bendystraw read fails, not only the events one', async () => {
    const deps = fakeDeps({
      indexed: { block: 100n, events: [ev('0xa', 1, 90)] },
      settings: new Error('Unknown type "stickySettingEventFilter"'),
      full: [log('0xb', 1, 5n)],
    })
    const result = await stickyEvents(CHAIN, 23n, deps)
    expect(result).toMatchObject({ source: 'scanned', degraded: 'indexer-error' })
    expect(hashes(result.events)).toEqual(['0xb'])
    expect(deps.scans).toEqual([{ fromBlock: CREATED }])
  })

  it('completes a stale indexed answer to the head, without counting twice what a later page already had', async () => {
    // Bendystraw's status says block 5,000, from its first page. A later page was read after it had indexed
    // further, so it already has the stick at 5,010. The scan from 5,001 finds that one again, and newer ones.
    const deps = fakeDeps({
      indexed: {
        block: 5_000n,
        events: [
          row.staked(HOLDER, HOLDER, 5n, 5n, { txHash: '0x1', logIndex: 3, timestamp: 4_000 }),
          row.staked(OTHER, OTHER, 2n, 2n, { txHash: '0x2', logIndex: 0, timestamp: 5_020 }),
        ],
      },
      tail: [
        staked(OTHER, OTHER, 2n, 2n, { txHash: '0x2', logIndex: 0, blockNumber: 5_010n }),
        unstaked(HOLDER, 5n, 0n, { txHash: '0x3', logIndex: 7, blockNumber: 7_000n }),
        streakEnded(HOLDER, 3_000n, { txHash: '0x3', logIndex: 8, blockNumber: 7_000n }),
      ],
    })
    const result = await stickyEvents(CHAIN, 23n, deps)
    expect(result).toMatchObject({ source: 'indexed', degraded: null })
    expect(deps.scans).toEqual([{ fromBlock: 5_001n }])
    expect(keys(result.events)).toEqual([`${CHAIN}:0x1:3`, `${CHAIN}:0x2:0`, `${CHAIN}:0x3:7`, `${CHAIN}:0x3:8`])
    // The event both had is Bendystraw's, where Bendystraw put it.
    expect(result.events.map(event => event.blockNumber)).toEqual([null, null, 7_000n, 7_000n])
  })

  it('scans the hook for the project\'s seven events, as the old client did', async () => {
    const deps = fakeDeps({ indexed: { block: 100n } })
    await stickyEvents(CHAIN, 23n, deps)
    expect(deps.filters).toEqual([{ address: HOOK, topics: [PROJECT_TOPICS, topic(23n)], fromBlock: 101n }])
  })

  it('asks Bendystraw about this project on its chain', async () => {
    const deps = fakeDeps({ indexed: { block: 100n } })
    await stickyEvents(CHAIN, 23n, deps)
    expect(deps.indexedEvents).toHaveBeenCalledWith({ chainId: CHAIN, projectId: 23n }, undefined)
    expect(deps.indexedSettings).toHaveBeenCalledWith(CHAIN, 23n, undefined)
  })

  it('adds granters, trusted senders and exclusions, each read past the block of the read that had it', async () => {
    // The settings read is as of an older block than the events read: the scan starts after the older one.
    const deps = fakeDeps({
      indexed: {
        block: 300n,
        settingsBlock: 200n,
        events: [row.staked(HOLDER, HOLDER, 5n, 5n, { txHash: '0x5', logIndex: 0, timestamp: 150 })],
        settings: [
          row.granter(GRANTER, { txHash: '0x1', logIndex: 4, timestamp: 100 }),
          row.trust(HOLDER, SENDER, true, { txHash: '0x2', logIndex: 1, timestamp: 120 }),
          row.orphans(9n, { txHash: '0x3', logIndex: 2, timestamp: 110 }),
        ],
      },
      tail: [
        trustSet(OTHER, SENDER, true, { txHash: '0x6', blockNumber: 250n }),
        // Through block 300 the events read is the account of sticks, so the scan's copy of this one is not used.
        staked(OTHER, OTHER, 1n, 1n, { txHash: '0x7', blockNumber: 260n }),
        trustSet(HOLDER, SENDER, false, { txHash: '0x8', blockNumber: 301n }),
        staked(OTHER, OTHER, 1n, 2n, { txHash: '0x9', blockNumber: 302n }),
      ],
    })
    const result = await stickyEvents(CHAIN, 23n, deps)
    expect(deps.scans).toEqual([{ fromBlock: 201n }])
    expect(result.events.map(event => [event.txHash, event.kind])).toEqual([
      ['0x1', 'granter'],
      ['0x3', 'excludeOrphan'],
      ['0x2', 'trust'],
      ['0x5', 'stick'],
      ['0x6', 'trust'],
      ['0x8', 'trust'],
      ['0x9', 'stick'],
    ])
    expect(result.events[0]).toMatchObject({ holder: GRANTER, trusted: true })
    expect(result.events[1]).toMatchObject({ holder: zeroAddress, amount: 9n })
    expect(result.events[5]).toMatchObject({ holder: HOLDER, sender: SENDER, trusted: false })
  })

  it('reads the settings from a full scan too', async () => {
    const deps = fakeDeps({
      indexed: new Error('down'),
      full: [granterSet(GRANTER, { blockNumber: CREATED }), log('0xa', 0, CREATED + 1n), orphanExcluded(4n)],
    })
    const result = await stickyEvents(CHAIN, 23n, deps)
    expect(result.events.map(event => event.kind)).toEqual(['granter', 'stick', 'excludeOrphan'])
  })

  it('orders indexed events by time and log index, then scanned ones as the scanner found them', async () => {
    const deps = fakeDeps({
      indexed: {
        block: 100n,
        events: [ev('0x3', 0, 50), ev('0x2', 5, 40), ev('0x1', 9, 40)],
        settings: [row.granter(GRANTER, { txHash: '0x0', logIndex: 7, timestamp: 40 })],
      },
      // Two blocks with one timestamp, as Arbitrum has: the scanner's block order stands.
      tail: [log('0x5', 3, 102n), log('0x4', 0, 103n)].map(entry => ({ ...entry, blockTimestamp: 60n })),
    })
    const result = await stickyEvents(CHAIN, 23n, deps)
    expect(hashes(result.events)).toEqual(['0x2', '0x0', '0x1', '0x3', '0x5', '0x4'])
  })

  it('leaves out another project\'s events, from either source', async () => {
    const deps = fakeDeps({
      indexed: { block: 100n, events: [ev('0x1', 0, 10), { ...ev('0x9', 0, 10), projectId: 24n }] },
      tail: [log('0x2', 0, 101n), staked(HOLDER, HOLDER, 1n, 1n, { txHash: '0x8', project: 24n, blockNumber: 102n })],
    })
    expect(hashes((await stickyEvents(CHAIN, 23n, deps)).events)).toEqual(['0x1', '0x2'])

    const scanned = fakeDeps({
      indexed: new Error('down'),
      full: [log('0x3', 0, CREATED), staked(HOLDER, HOLDER, 1n, 1n, { txHash: '0x7', project: 24n })],
    })
    expect(hashes((await stickyEvents(CHAIN, 23n, scanned)).events)).toEqual(['0x3'])
  })

  it('counts an event once when a scan reports it twice', async () => {
    // As a reorg deeper than the saved history's margin could leave it: one transaction in two blocks.
    const deps = fakeDeps({ indexed: new Error('down'), full: [log('0xa', 1, CREATED + 1n), log('0xa', 1, CREATED + 2n)] })
    expect((await stickyEvents(CHAIN, 23n, deps)).events.map(event => event.blockNumber)).toEqual([CREATED + 1n])
  })

  it('takes a transaction hash in either case for the same event', async () => {
    const deps = fakeDeps({
      indexed: { block: 99n, events: [ev(`0x${'A'.repeat(64)}`, 1, 100)] },
      tail: [log(`0x${'a'.repeat(64)}`, 1, 100n)],
    })
    expect(hashes((await stickyEvents(CHAIN, 23n, deps)).events)).toEqual([`0x${'a'.repeat(64)}`])
  })

  it('rejects when the scan past Bendystraw\'s block fails, rather than end the history at that block', async () => {
    const deps = fakeDeps({ indexed: { block: 100n, events: [ev('0xa', 1, 90)] }, tail: new Error('429') })
    await expect(stickyEvents(CHAIN, 23n, deps)).rejects.toThrow('429')
    // A failed tail is no reason to scan everything.
    expect(deps.projectLogs).not.toHaveBeenCalled()
  })

  it('rejects when a scanned hook log cannot be read, rather than leave it out', async () => {
    const short = { ...log('0xb', 1, 101n), data: words(HOLDER, 1n) }
    const deps = fakeDeps({ indexed: { block: 100n, events: [ev('0xa', 1, 90)] }, tail: [short] })
    await expect(stickyEvents(CHAIN, 23n, deps)).rejects.toThrow()
  })

  it('hands the caller\'s signal to every read', async () => {
    const { signal } = new AbortController()
    const indexedPath = fakeDeps({ indexed: { block: 100n } })
    await stickyEvents(CHAIN, 23n, { ...indexedPath, signal })
    expect(indexedPath.signals).toEqual([signal, signal, signal])

    const scannedPath = fakeDeps({ indexed: new Error('down') })
    await stickyEvents(CHAIN, 23n, { ...scannedPath, signal })
    expect(scannedPath.signals).toEqual([signal, signal, signal, signal])
  })

  it('stops when the caller cancels: it rejects with the caller\'s reason and starts no scan', async () => {
    const controller = new AbortController()
    const reason = new Error('left the page')
    const deps = fakeDeps({ indexed: { block: 100n } })
    // Rejecting the way Bendystraw's readers do when their signal aborts: with the signal's reason.
    deps.indexedEvents.mockImplementation(
      (_q, signal) =>
        new Promise<never>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason))),
    )
    const read = stickyEvents(CHAIN, 23n, { ...deps, signal: controller.signal })
    controller.abort(reason)
    await expect(read).rejects.toBe(reason)
    expect(deps.scan).not.toHaveBeenCalled()
    expect(deps.creationBlock).not.toHaveBeenCalled()
    expect(deps.projectLogs).not.toHaveBeenCalled()
  })

  it('refuses a chain without Sticky, and a number that is no project, before reading anything', async () => {
    const deps = fakeDeps({ indexed: { block: 100n } })
    await expect(stickyEvents(137, 23n, deps)).rejects.toThrow('Sticky is not deployed on chain 137.')
    await expect(stickyEvents(CHAIN, 0n, deps)).rejects.toThrow(RangeError)
    expect(deps.indexedEvents).not.toHaveBeenCalled()
  })
})

describe('stickyHolderEvents', () => {
  const holderTopic = topic(HOLDER)

  it('reads the holder from Bendystraw and scans the hook for their position events past its block', async () => {
    const deps = fakeDeps({
      indexed: {
        block: 700n,
        events: [
          row.streakStarted(HOLDER, { txHash: '0x1', logIndex: 1, timestamp: 10 }),
          row.staked(HOLDER, OTHER, 3n, 3n, { txHash: '0x1', logIndex: 0, timestamp: 10 }),
          row.staked(HOLDER, HOLDER, 1n, 1n, { txHash: '0x2', logIndex: 0, timestamp: 20, projectId: 5n }),
        ],
      },
      tail: [unstaked(HOLDER, 1n, 0n, { txHash: '0x3', project: 5n, blockNumber: 701n })],
    })
    const result = await stickyHolderEvents(CHAIN, HOLDER, deps)
    expect(result).toMatchObject({ source: 'indexed', degraded: null })
    expect(result.events.map(event => [event.txHash, event.kind, event.projectId])).toEqual([
      ['0x1', 'stick', 23n],
      ['0x1', 'streakStart', 23n],
      ['0x2', 'stick', 5n],
      ['0x3', 'unstick', 5n],
    ])
    expect(deps.indexedEvents).toHaveBeenCalledWith({ chainId: CHAIN, holder: HOLDER }, undefined)
    expect(deps.filters).toEqual([{ address: HOOK, topics: [POSITION_TOPICS, null, holderTopic], fromBlock: 701n }])
  })

  it('counts an event both sources reported once', async () => {
    // A later page of Bendystraw's answer, read after it had indexed further, has what the scan also finds.
    const deps = fakeDeps({
      indexed: { block: 700n, events: [row.staked(HOLDER, HOLDER, 1n, 1n, { txHash: '0x5', logIndex: 2, timestamp: 9 })] },
      tail: [staked(HOLDER, HOLDER, 1n, 1n, { txHash: '0x5', logIndex: 2, blockNumber: 701n })],
    })
    const { events } = await stickyHolderEvents(CHAIN, HOLDER, deps)
    expect(events.map(event => [event.txHash, event.blockNumber])).toEqual([['0x5', null]])
  })

  it('asks about the holder in lowercase, however the address is written', async () => {
    const deps = fakeDeps({ indexed: { block: 700n } })
    await stickyHolderEvents(CHAIN, `0x${'A'.repeat(40)}` as Address, deps)
    expect(deps.indexedEvents).toHaveBeenCalledWith({ chainId: CHAIN, holder: HOLDER }, undefined)
    expect(deps.filters[0].topics[2]).toBe(holderTopic)
  })

  it.each<[string, Answer | Error, 'indexer-error' | 'not-indexed']>([
    ['fails', new Error('down'), 'indexer-error'],
    ['has no status for the chain', { events: [] }, 'not-indexed'],
  ])('scans from the deployer\'s block when Bendystraw %s', async (_case, answer, degraded) => {
    const deps = fakeDeps({ indexed: answer, tail: [streakStarted(HOLDER, { blockNumber: deployment.fromBlock + 9n })] })
    const result = await stickyHolderEvents(CHAIN, HOLDER, deps)
    expect(result).toMatchObject({ source: 'scanned', degraded })
    expect(result.events.map(event => event.kind)).toEqual(['streakStart'])
    expect(deps.filters).toEqual([
      { address: HOOK, topics: [POSITION_TOPICS, null, holderTopic], fromBlock: deployment.fromBlock },
    ])
  })

  it('leaves out other holders\' events and every other kind', async () => {
    const deps = fakeDeps({
      indexed: { block: 700n, events: [row.staked(OTHER, OTHER, 1n, 1n, { txHash: '0x9', logIndex: 0, timestamp: 1 })] },
      tail: [
        staked(OTHER, OTHER, 1n, 1n, { txHash: '0x8', blockNumber: 701n }),
        trustSet(HOLDER, SENDER, true, { txHash: '0x7', blockNumber: 702n }),
        staked(HOLDER, HOLDER, 1n, 1n, { txHash: '0x6', blockNumber: 703n }),
      ],
    })
    expect(hashes((await stickyHolderEvents(CHAIN, HOLDER, deps)).events)).toEqual(['0x6'])
  })

  it('rejects when both sources fail', async () => {
    const deps = fakeDeps({ indexed: new Error('down'), tail: new Error('over budget') })
    await expect(stickyHolderEvents(CHAIN, HOLDER, deps)).rejects.toThrow('over budget')
  })

  it('refuses something that is not an address, before reading anything', async () => {
    const deps = fakeDeps({ indexed: { block: 700n } })
    await expect(stickyHolderEvents(CHAIN, '0x1234' as Address, deps)).rejects.toThrow(TypeError)
    expect(deps.indexedEvents).not.toHaveBeenCalled()
  })

  it('stops when the caller cancels, without scanning', async () => {
    const controller = new AbortController()
    controller.abort(new Error('gone'))
    const deps = fakeDeps({ indexed: { block: 700n } })
    deps.indexedEvents.mockImplementation(async (_q, signal) => {
      throw signal!.reason
    })
    await expect(stickyHolderEvents(CHAIN, HOLDER, { ...deps, signal: controller.signal })).rejects.toThrow('gone')
    expect(deps.scan).not.toHaveBeenCalled()
  })
})

describe('decodeHookLog', () => {
  const at = { txHash: `0x${'1'.repeat(64)}`, logIndex: 4, blockNumber: 60_000_000n, time: 1_760_000_000n }
  const time = { txHash: at.txHash, logIndex: 4, timestamp: 1_760_000_000 }
  const place = {
    chainId: CHAIN,
    projectId: 23n,
    txHash: at.txHash,
    logIndex: 4,
    blockNumber: 60_000_000n,
    timestamp: 1_760_000_000,
  }

  it.each<[string, ScannedLog, Partial<StickyEvent>]>([
    ['a stick', staked(HOLDER, OTHER, 7n, 12n, at), { kind: 'stick', holder: HOLDER, payer: OTHER, count: 7n, balance: 12n }],
    ['an unstick', unstaked(HOLDER, 7n, 5n, at), { kind: 'unstick', holder: HOLDER, count: 7n, balance: 5n }],
    ['a streak\'s start', streakStarted(HOLDER, at), { kind: 'streakStart', holder: HOLDER }],
    ['a streak\'s end', streakEnded(HOLDER, 86_400n, at), { kind: 'streakEnd', holder: HOLDER, length: 86_400n }],
    ['a granter, who is one for good', granterSet(GRANTER, at), { kind: 'granter', holder: GRANTER, trusted: true }],
    ['a trusted sender', trustSet(HOLDER, SENDER, true, at), { kind: 'trust', holder: HOLDER, sender: SENDER, trusted: true }],
    ['a sender no longer trusted', trustSet(HOLDER, SENDER, false, at), { kind: 'trust', holder: HOLDER, sender: SENDER, trusted: false }],
    ['an exclusion, which is nobody\'s', orphanExcluded(3n, at), { kind: 'excludeOrphan', holder: zeroAddress, amount: 3n }],
  ])('reads %s', (_name, entry, fields) => {
    expect(decodeHookLog(entry, CHAIN)).toEqual({ ...place, ...fields })
  })

  it('writes addresses and the hash in lowercase', () => {
    const hash = `0x${'ab'.repeat(32)}`
    const entry = staked(HOLDER, OTHER, 1n, 1n, { ...at, txHash: hash })
    const shouted = (value: string) => `0x${value.slice(2).toUpperCase()}`
    const decoded = decodeHookLog(
      { ...entry, address: shouted(HOOK) as Address, transactionHash: shouted(hash) as Hex },
      CHAIN,
    )
    expect(decoded).toMatchObject({ holder: HOLDER, payer: OTHER, txHash: hash })
  })

  it.each<[string, IndexedStickyEvent, ScannedLog]>([
    ['a stick', row.staked(HOLDER, OTHER, 7n, 12n, time), staked(HOLDER, OTHER, 7n, 12n, at)],
    ['an unstick', row.unstaked(HOLDER, 7n, 5n, time), unstaked(HOLDER, 7n, 5n, at)],
    ['a streak\'s start', row.streakStarted(HOLDER, time), streakStarted(HOLDER, at)],
    ['a streak\'s end', row.streakEnded(HOLDER, 86_400, time), streakEnded(HOLDER, 86_400n, at)],
  ])('reads %s the same whether Bendystraw or the chain reports it', async (_name, indexedRow, entry) => {
    const [fromIndex] = (await stickyEvents(CHAIN, 23n, fakeDeps({ indexed: { block: 1n, events: [indexedRow] } }))).events
    expect(fromIndex).toEqual({ ...decodeHookLog(entry, CHAIN), blockNumber: null })
  })

  it.each<[string, IndexedSetting, ScannedLog]>([
    ['a granter', row.granter(GRANTER, time), granterSet(GRANTER, at)],
    ['a trusted sender', row.trust(HOLDER, SENDER, false, time), trustSet(HOLDER, SENDER, false, at)],
    ['an exclusion', row.orphans(3n, time), orphanExcluded(3n, at)],
  ])('reads %s the same whether Bendystraw or the chain reports it', async (_name, indexedRow, entry) => {
    const [fromIndex] = (await stickyEvents(CHAIN, 23n, fakeDeps({ indexed: { block: 1n, settings: [indexedRow] } }))).events
    expect(fromIndex).toEqual({ ...decodeHookLog(entry, CHAIN), blockNumber: null })
  })

  it('is null for a log of another contract, an event it does not read, a removed log, or a chain without Sticky', () => {
    expect(decodeHookLog(staked(HOLDER, OTHER, 1n, 1n, { ...at, address: OTHER }), CHAIN)).toBeNull()
    expect(decodeHookLog(raw([SET_TOKEN, topic(23n)], words(OTHER, DEPLOYER), at), CHAIN)).toBeNull()
    expect(decodeHookLog(deploySticky(23n, { ...at, address: HOOK }), CHAIN)).toBeNull()
    expect(decodeHookLog({ ...staked(HOLDER, OTHER, 1n, 1n, at), removed: true }, CHAIN)).toBeNull()
    expect(decodeHookLog({ ...staked(HOLDER, OTHER, 1n, 1n, at), topics: [] }, CHAIN)).toBeNull()
    expect(decodeHookLog(staked(HOLDER, OTHER, 1n, 1n, at), 137)).toBeNull()
  })

  it('throws for a hook event it cannot read, rather than pass over it', () => {
    const entry = staked(HOLDER, OTHER, 1n, 1n, at)
    expect(() => decodeHookLog({ ...entry, data: words(OTHER, 1n) }, CHAIN)).toThrow()
    expect(() => decodeHookLog({ ...entry, topics: entry.topics.slice(0, 2) as ScannedLog['topics'] }, CHAIN)).toThrow()
    expect(() => decodeHookLog(streakStarted(HOLDER, { ...at, time: null }), CHAIN)).toThrow(/time/)
    const pending = { ...entry, blockHash: null, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null }
    expect(() => decodeHookLog(pending, CHAIN)).toThrow(/block/)
  })
})

describe('projectCreationBlock', () => {
  // The session keeps what each lookup found, so each case below is about a project of its own.
  const TX = `0x${'7'.repeat(64)}` as Hex
  const HEAD = deployment.fromBlock + 10_000n

  type Chain = {
    tx?: Hex | null | Error
    receipt?: { blockNumber: bigint; logs: ScannedLog[] } | Error
    /** JBProjects.count() at a block. Without it every read fails, as on a node without archive state. */
    count?: (block: bigint) => bigint
  }
  function chain({ tx = null, receipt = new Error('Transaction receipt could not be found.'), count }: Chain) {
    const reads: bigint[] = []
    const deps = {
      indexedCreateTx: vi.fn<StickyReadDeps['indexedCreateTx']>(async () => {
        if (tx instanceof Error) throw tx
        return tx
      }),
      receipt: vi.fn<StickyReadDeps['receipt']>(async () => {
        if (receipt instanceof Error) throw receipt
        return receipt
      }),
      head: vi.fn<StickyReadDeps['head']>(async () => HEAD),
      projectCount: vi.fn<StickyReadDeps['projectCount']>(async (_chainId, block) => {
        reads.push(block)
        if (!count) throw new Error('missing trie node')
        return count(block)
      }),
      indexedEvents: vi.fn<StickyReadDeps['indexedEvents']>(unexpected('indexedEvents')),
      indexedSettings: vi.fn<StickyReadDeps['indexedSettings']>(unexpected('indexedSettings')),
      scan: vi.fn<StickyReadDeps['scan']>(unexpected('scan')),
      projectLogs: vi.fn<StickyReadDeps['projectLogs']>(unexpected('projectLogs')),
      creationBlock: vi.fn<StickyReadDeps['creationBlock']>(unexpected('creationBlock')),
    } satisfies StickyReadDeps
    return { ...deps, reads }
  }
  /** JBProjects' count when `projectId` was created at `block`. */
  const createdAt = (projectId: bigint, block: bigint) => (at: bigint) => (at >= block ? projectId : projectId - 1n)

  it('takes the block from the receipt of the transaction Bendystraw names, and keeps it for the session', async () => {
    const deps = chain({ tx: TX, receipt: { blockNumber: deployment.fromBlock + 77n, logs: [deploySticky(37n)] } })
    expect(await projectCreationBlock(CHAIN, 37n, deps)).toBe(deployment.fromBlock + 77n)
    expect(deps.indexedCreateTx).toHaveBeenCalledWith(CHAIN, 37n, undefined)
    expect(deps.receipt).toHaveBeenCalledWith(CHAIN, TX, { signal: undefined })
    expect(deps.projectCount).not.toHaveBeenCalled()

    const again = chain({})
    expect(await projectCreationBlock(CHAIN, 37n, again)).toBe(deployment.fromBlock + 77n)
    expect(again.indexedCreateTx).not.toHaveBeenCalled()
  })

  it.each<[string, bigint, (projectId: bigint) => ScannedLog[]]>([
    ['from another contract', 38n, projectId => [deploySticky(projectId, { address: OTHER })]],
    ['of another project', 39n, projectId => [deploySticky(projectId - 1n)]],
    ['that is not a DeploySticky', 40n, projectId => [staked(HOLDER, HOLDER, 1n, 1n, { project: projectId, address: DEPLOYER })]],
    ['that was removed', 41n, projectId => [{ ...deploySticky(projectId), removed: true }]],
    ['at all', 42n, () => []],
  ])('does not trust a creating transaction whose receipt has no launch %s, and searches JBProjects.count() instead', async (_case, projectId, logsOf) => {
    const created = deployment.fromBlock + 4_321n
    const deps = chain({
      tx: TX,
      receipt: { blockNumber: deployment.fromBlock + 5n, logs: logsOf(projectId) },
      count: createdAt(projectId, created),
    })
    expect(await projectCreationBlock(CHAIN, projectId, deps)).toBe(created)
    expect(deps.receipt).toHaveBeenCalledTimes(1)
    // A binary search between the deployer's block and the head: log2(10,000) reads and the two ends, not a scan.
    expect(deps.reads.length).toBeLessThanOrEqual(16)
    expect(deps.reads.every(block => block >= deployment.fromBlock && block <= HEAD)).toBe(true)
  })

  it('searches JBProjects.count() when Bendystraw names no creating transaction, or fails', async () => {
    const created = deployment.fromBlock + 9_999n
    const none = chain({ tx: null, count: createdAt(50n, created) })
    expect(await projectCreationBlock(CHAIN, 50n, none)).toBe(created)
    expect(none.receipt).not.toHaveBeenCalled()

    const down = chain({ tx: new Error('Bendystraw request failed (502)'), count: createdAt(51n, deployment.fromBlock + 1n) })
    expect(await projectCreationBlock(CHAIN, 51n, down)).toBe(deployment.fromBlock + 1n)
  })

  it('finds a project already there at the deployer\'s block at that block, and one made at the head at the head', async () => {
    expect(await projectCreationBlock(CHAIN, 52n, chain({ count: () => 60n }))).toBe(deployment.fromBlock)
    expect(await projectCreationBlock(CHAIN, 53n, chain({ count: createdAt(53n, HEAD) }))).toBe(HEAD)
  })

  it('uses the deployer\'s block when nothing answers, and tries again the next time', async () => {
    const deps = chain({ tx: new Error('down') })
    expect(await projectCreationBlock(CHAIN, 54n, deps)).toBe(deployment.fromBlock)
    expect(await projectCreationBlock(CHAIN, 54n, deps)).toBe(deployment.fromBlock)
    expect(deps.indexedCreateTx).toHaveBeenCalledTimes(2)
    expect(deps.projectCount).toHaveBeenCalledTimes(2)
  })

  it('uses the deployer\'s block for a project that does not exist yet, and does not keep it', async () => {
    const deps = chain({ count: () => 55n })
    expect(await projectCreationBlock(CHAIN, 56n, deps)).toBe(deployment.fromBlock)
    await projectCreationBlock(CHAIN, 56n, deps)
    expect(deps.head).toHaveBeenCalledTimes(2)
  })

  it('stops when the caller cancels, rather than fall back to the deployer\'s block', async () => {
    const controller = new AbortController()
    const reason = new Error('left the page')
    const deps = chain({ tx: TX })
    deps.receipt.mockImplementation(async () => {
      controller.abort(reason)
      throw reason
    })
    await expect(projectCreationBlock(CHAIN, 57n, { ...deps, signal: controller.signal })).rejects.toBe(reason)
    expect(deps.projectCount).not.toHaveBeenCalled()
  })

  it('hands the caller\'s signal to every read', async () => {
    const { signal } = new AbortController()
    const deps = chain({ tx: TX, count: createdAt(58n, deployment.fromBlock + 3n) })
    await projectCreationBlock(CHAIN, 58n, { ...deps, signal })
    expect(deps.indexedCreateTx).toHaveBeenCalledWith(CHAIN, 58n, signal)
    expect(deps.receipt).toHaveBeenCalledWith(CHAIN, TX, { signal })
    expect(deps.head).toHaveBeenCalledWith(CHAIN, { signal })
    expect(deps.projectCount.mock.calls.map(([, , options]) => options)).toEqual(deps.reads.map(() => ({ signal })))
  })

  it('refuses a chain without Sticky', async () => {
    await expect(projectCreationBlock(137, 59n, chain({}))).rejects.toThrow('Sticky is not deployed on chain 137.')
  })
})

describe('stickyProjectsOn', () => {
  // A launch found here becomes its project's creation block for the session, so these use projects of their own.
  const INDEXED = deployment.fromBlock + 50_000n
  const index = (block: bigint | undefined, ...projects: [number, bigint][]): IndexedProjects => ({
    blocks: new Map<number, bigint>(block === undefined ? [] : [[CHAIN, block]]),
    projects: projects.map(([chainId, projectId]) => ({ chainId, projectId })),
  })
  const scanning = (logs: ScannedLog[] | Error) => fakeDeps({ indexed: new Error('not asked'), tail: logs })

  it('lists the index\'s projects and adds launches past its block from the deployer\'s logs, once each', async () => {
    // Project 72 is past the index's block, but on a page read later, so the scan finds it again.
    const deps = scanning([deploySticky(72n, { blockNumber: INDEXED + 5n }), deploySticky(73n, { blockNumber: INDEXED + 9n })])
    const result = await stickyProjectsOn(CHAIN, index(INDEXED, [CHAIN, 70n], [10, 71n], [CHAIN, 72n]), deps)
    expect(result).toEqual({
      projects: [70n, 72n, 73n].map(projectId => ({ chainId: CHAIN, projectId })),
      source: 'indexed',
      degraded: null,
    })
    expect(deps.filters).toEqual([{ address: DEPLOYER, topics: [TOPIC.DeploySticky], fromBlock: INDEXED + 1n }])
  })

  it('lists projects oldest first, whatever order the index gave them in', async () => {
    const deps = scanning([deploySticky(79n, { blockNumber: INDEXED + 1n })])
    const result = await stickyProjectsOn(CHAIN, index(INDEXED, [CHAIN, 78n], [CHAIN, 69n]), deps)
    expect(result.projects.map(project => project.projectId)).toEqual([69n, 78n, 79n])
  })

  it('keeps a launch it finds as its project\'s creation block', async () => {
    await stickyProjectsOn(CHAIN, index(INDEXED), scanning([deploySticky(74n, { blockNumber: INDEXED + 44n })]))
    const unreachable = fakeDeps({ indexed: new Error('not asked') })
    expect(await projectCreationBlock(CHAIN, 74n, unreachable)).toBe(INDEXED + 44n)
    expect(unreachable.indexedCreateTx).not.toHaveBeenCalled()
  })

  it.each<[string, IndexedProjects | null, 'not-indexed' | 'indexer-error']>([
    ['has no status for the chain', index(undefined, [10, 71n]), 'not-indexed'],
    ['failed', null, 'indexer-error'],
  ])('scans the chain from the deployer\'s block when the index %s', async (_case, given, degraded) => {
    const deps = scanning([deploySticky(75n, { blockNumber: deployment.fromBlock + 1n })])
    expect(await stickyProjectsOn(CHAIN, given, deps)).toEqual({
      projects: [{ chainId: CHAIN, projectId: 75n }],
      source: 'scanned',
      degraded,
    })
    expect(deps.filters).toEqual([{ address: DEPLOYER, topics: [TOPIC.DeploySticky], fromBlock: deployment.fromBlock }])
  })

  it('takes only this deployer\'s launches', async () => {
    const deps = scanning([
      deploySticky(76n, { address: OTHER }),
      { ...deploySticky(77n), removed: true },
      // Anything else the deployer logged is not a launch.
      raw([TOPIC.Staked, topic(78n), topic(HOLDER)], words(HOLDER, 1n, 1n, HOLDER), { address: DEPLOYER }),
    ])
    expect((await stickyProjectsOn(CHAIN, index(INDEXED), deps)).projects).toEqual([])
  })

  it('rejects when the scan fails, rather than list only what the index had', async () => {
    await expect(stickyProjectsOn(CHAIN, index(INDEXED, [CHAIN, 70n]), scanning(new Error('429')))).rejects.toThrow('429')
  })

  it('hands the caller\'s signal to the scan', async () => {
    const { signal } = new AbortController()
    const deps = scanning([])
    await stickyProjectsOn(CHAIN, index(INDEXED), { ...deps, signal })
    expect(deps.signals).toEqual([signal])
  })

  it('refuses a chain without Sticky', async () => {
    await expect(stickyProjectsOn(137, null, scanning([]))).rejects.toThrow('Sticky is not deployed on chain 137.')
  })
})
