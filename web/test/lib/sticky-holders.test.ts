import { zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HistoryTooLongError, type ScannedLog } from '@/lib/hook-logs'
import { decodeHookLog, type StickyEvent, type StickyEventsResult } from '@/lib/sticky-events'
import {
  holderRows,
  pinnedBlock,
  positionRows,
  readStickyPosition,
  stickAges,
  stickyHolders,
  verifyHolderPage,
  type HolderReadDeps,
  type HolderRow,
} from '@/lib/sticky-holders'
import type { IndexedPosition } from '@/lib/sticky-indexed'
import {
  CHAIN,
  CREATED,
  GRANTER,
  HOLDER,
  HOOK,
  OTHER,
  POSITION_TOPICS,
  SENDER,
  STAKED_TOKEN,
  deployment,
  staked,
  streakEnded,
  streakStarted,
  timeAt,
  topic,
  unstaked,
} from './sticky-log-fixtures'

// stickyHolders' reads go through the deps each call is given; verifyHolderPage and pinnedBlock read Center, which
// is a fake client here. The default reads have tests of their own in sticky-holders-center.test.ts.

const center = vi.hoisted(() => ({ client: vi.fn() }))
vi.mock('@/lib/jbcenter-rpc', () => ({ jbCenterPublicClient: center.client }))

beforeEach(() => {
  center.client.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

const HOLDER_A = HOLDER
const HOLDER_B = OTHER
const HOLDER_C = SENDER

// ---------------------------------------------------------------- events, as stickyEvents gives them

let nextIndex = 0
function event(
  kind: StickyEvent['kind'],
  holder: Address,
  timestamp: number,
  fields: Partial<StickyEvent> = {},
): StickyEvent {
  nextIndex += 1
  return {
    kind,
    chainId: CHAIN,
    projectId: 7n,
    holder,
    txHash: `0x${nextIndex.toString(16).padStart(64, '0')}` as Hex,
    logIndex: nextIndex,
    blockNumber: null,
    timestamp,
    ...fields,
  }
}
const stick = (holder: Address, count: bigint, balance: bigint, at: number, fields: Partial<StickyEvent> = {}) =>
  event('stick', holder, at, { payer: holder, count, balance, ...fields })
const unstick = (holder: Address, count: bigint, balance: bigint, at: number) =>
  event('unstick', holder, at, { count, balance })
const streakStart = (holder: Address, at: number) => event('streakStart', holder, at)
const streakEnd = (holder: Address, length: bigint, at: number) => event('streakEnd', holder, at, { length })

const summary = (rows: HolderRow[]) => rows.map(row => [row.holder, row.staked, row.current, row.longest])

describe('holderRows', () => {
  it('holders come from the hook events: last balance, live streak, and record, with no per-holder reads', () => {
    const events = [
      // A: two stakes, then a partial exit. Streak from t=100.
      streakStart(HOLDER_A, 100),
      stick(HOLDER_A, 5n, 5n, 100),
      stick(HOLDER_A, 3n, 8n, 200),
      unstick(HOLDER_A, 2n, 6n, 300),
      // B: in and fully out; the ended streak is the record.
      streakStart(HOLDER_B, 100),
      stick(HOLDER_B, 4n, 4n, 100),
      streakEnd(HOLDER_B, 800n, 900),
      unstick(HOLDER_B, 4n, 0n, 900),
    ]
    expect(summary(holderRows(events, 1000))).toEqual([
      [HOLDER_A, 6n, 900, 900],
      [HOLDER_B, 0n, 0, 800],
    ])
    // Another project's event is ignored: stickyHolders keeps to its project's events (see below).
  })

  it('keeps each row\'s streak start, so an age can be measured again at a later time', () => {
    const [row] = holderRows([streakStart(HOLDER_A, 100), stick(HOLDER_A, 5n, 5n, 100)], 1000)
    expect(row).toEqual({ holder: HOLDER_A, staked: 5n, start: 100, current: 900, longest: 900 })
  })

  it('starts a new streak after a full exit, and the record keeps the longer one', () => {
    const events = [
      streakStart(HOLDER_A, 100),
      stick(HOLDER_A, 4n, 4n, 100),
      streakEnd(HOLDER_A, 800n, 900),
      unstick(HOLDER_A, 4n, 0n, 900),
      streakStart(HOLDER_A, 950),
      stick(HOLDER_A, 1n, 1n, 950),
    ]
    expect(holderRows(events, 1000)).toEqual([{ holder: HOLDER_A, staked: 1n, start: 950, current: 50, longest: 800 }])
  })

  it('keeps the record when a shorter streak ends after it', () => {
    const events = [
      streakStart(HOLDER_A, 100),
      stick(HOLDER_A, 4n, 4n, 100),
      streakEnd(HOLDER_A, 800n, 900),
      unstick(HOLDER_A, 4n, 0n, 900),
      streakStart(HOLDER_A, 910),
      stick(HOLDER_A, 1n, 1n, 910),
      streakEnd(HOLDER_A, 50n, 960),
      unstick(HOLDER_A, 1n, 0n, 960),
    ]
    expect(holderRows(events, 1000)).toEqual([{ holder: HOLDER_A, staked: 0n, start: 0, current: 0, longest: 800 }])
  })

  it('makes no rows of granters, trusted senders or exclusions', () => {
    const events = [
      event('granter', GRANTER, 100, { trusted: true }),
      event('trust', HOLDER_B, 110, { sender: HOLDER_C, trusted: true }),
      event('excludeOrphan', zeroAddress, 120, { amount: 4n }),
      stick(HOLDER_A, 5n, 5n, 130),
    ]
    expect(holderRows(events, 1000).map(row => row.holder)).toEqual([HOLDER_A])
  })

  it('changes nothing when the same history is applied again', () => {
    const events = [
      streakStart(HOLDER_A, 100),
      stick(HOLDER_A, 5n, 5n, 100),
      unstick(HOLDER_A, 2n, 3n, 300),
      streakStart(HOLDER_B, 100),
      stick(HOLDER_B, 4n, 4n, 100),
      streakEnd(HOLDER_B, 800n, 900),
      unstick(HOLDER_B, 4n, 0n, 900),
    ]
    expect(holderRows([...events, ...events], 1000)).toEqual(holderRows(events, 1000))
  })

  it('measures the active streak at the time it is given, never below zero', () => {
    const events = [streakStart(HOLDER_A, 1_000), stick(HOLDER_A, 5n, 5n, 1_000)]
    expect(holderRows(events, 900)).toEqual([{ holder: HOLDER_A, staked: 5n, start: 1_000, current: 0, longest: 0 }])
  })

  it('refuses a stick or unstick without the balance it left, and a streak end without its length', () => {
    // A stick made from a pay alone has no balance: the rows it would give could not be told from the right ones.
    const payOnly = stick(HOLDER_A, 5n, 5n, 100, { balance: undefined })
    expect(() => holderRows([payOnly], 1000)).toThrow(
      new TypeError(`A stick in ${payOnly.txHash} lacks the balance it left.`),
    )
    const exit = { ...unstick(HOLDER_A, 5n, 0n, 200), balance: undefined }
    expect(() => holderRows([exit], 1000)).toThrow(new TypeError(`An unstick in ${exit.txHash} lacks the balance it left.`))
    const ended = { ...streakEnd(HOLDER_A, 5n, 200), length: undefined }
    expect(() => holderRows([ended], 1000)).toThrow(new TypeError(`A streak end in ${ended.txHash} lacks its length.`))
  })

  it('reads a holder\'s address in any case as one holder, in lowercase', () => {
    const upper = HOLDER_A.toUpperCase().replace('0X', '0x') as Address
    const rows = holderRows([stick(upper, 5n, 5n, 100), unstick(HOLDER_A, 2n, 3n, 200)], 1000)
    expect(summary(rows)).toEqual([[HOLDER_A, 3n, 0, 0]])
  })
})

// ---------------------------------------------------------------- pinned block and header ages

describe('pinned block ages', () => {
  it('the header ages come from one pinned block and the streak start, the same definition as your position', async () => {
    const getBlock = vi.fn(async (_args?: unknown) => ({ number: 0x99n, timestamp: 1074n }))
    center.client.mockReturnValue({ getBlock } as unknown as PublicClient)
    const events = [
      streakStart(HOLDER_A, 1000),
      stick(HOLDER_A, 5n, 5n, 1000),
      // A second stick 44 seconds later does not move the streak start.
      stick(HOLDER_A, 2n, 7n, 1044),
    ]
    const pin = await pinnedBlock(CHAIN)
    expect(pin).toEqual({ number: 0x99n, timestamp: 1074 })
    // One read of the latest block, on the page's chain.
    expect(getBlock).toHaveBeenCalledTimes(1)
    expect(getBlock.mock.calls[0]).toEqual([])
    expect(center.client).toHaveBeenCalledWith(CHAIN)
    const rows = holderRows(events, pin.timestamp)
    expect(stickAges(rows, pin.timestamp)).toEqual({ average: 74, longest: 74 })
    expect(rows[0].current).toBe(74)
  })

  it('averages the active streaks of the holders with shares, rounding down, and counts one without a streak as none', () => {
    const row = (staked: bigint, start: number): HolderRow => ({ holder: HOLDER_A, staked, start, current: 0, longest: 0 })
    expect(stickAges([row(1n, 900), row(1n, 999), row(0n, 100), row(1n, 0)], 1000)).toEqual({ average: 33, longest: 100 })
    expect(stickAges([row(1n, 1100)], 1000)).toEqual({ average: 0, longest: 0 })
    expect(stickAges([row(0n, 100)], 1000)).toEqual({ average: 0, longest: 0 })
    expect(stickAges([], 1000)).toEqual({ average: 0, longest: 0 })
  })

  it('rejects with the caller\'s reason when it cancels the block read', async () => {
    center.client.mockReturnValue({ getBlock: () => new Promise(() => {}) } as unknown as PublicClient)
    const controller = new AbortController()
    const read = pinnedBlock(CHAIN, { signal: controller.signal })
    controller.abort(new Error('left the page'))
    await expect(read).rejects.toThrow('left the page')
  })
})

// ---------------------------------------------------------------- one holder's stick

describe('readStickyPosition', () => {
  const ST_TOKEN = `0x${'5'.repeat(40)}` as Address
  const project = { projectId: 7n, stToken: ST_TOKEN, stakedToken: STAKED_TOKEN }
  type Read = { address: Address; functionName: string; args: readonly unknown[] }
  type Batch = { contracts: readonly Read[]; allowFailure?: boolean; blockNumber?: bigint }

  function chainWith(answers: readonly bigint[], time = 10_000n) {
    const getBlock = vi.fn(async (_args?: unknown) => ({ number: 0x99n, timestamp: time }))
    const multicall = vi.fn(async (_batch: Batch) => answers)
    center.client.mockReturnValue({ getBlock, multicall } as unknown as PublicClient)
    return { getBlock, multicall }
  }

  it('reads a holder\'s shares, wallet and streaks at one pinned block, measuring the streak at that block\'s time', async () => {
    const { getBlock, multicall } = chainWith([500n, 9_000n, 5_000n, 25n])

    expect(await readStickyPosition(CHAIN, project, HOLDER_A)).toEqual({
      staked: 500n,
      wallet: 25n,
      start: 9_000,
      current: 1_000,
      longest: 5_000,
      blockNumber: 0x99n,
      timestamp: 10_000,
    })

    // The latest block once, then one request at that block: the Sticky token's balance, the hook's streak start and
    // record, and the staked token's balance.
    expect(getBlock).toHaveBeenCalledTimes(1)
    expect(multicall).toHaveBeenCalledTimes(1)
    const [{ contracts, blockNumber, allowFailure }] = multicall.mock.calls[0]
    expect(blockNumber).toBe(0x99n)
    expect(allowFailure).toBe(false)
    expect(contracts.map(read => [read.address, read.functionName, read.args])).toEqual([
      [ST_TOKEN, 'balanceOf', [HOLDER_A]],
      [HOOK, 'streakStartOf', [7n, HOLDER_A]],
      [HOOK, 'longestStreakOf', [7n, HOLDER_A]],
      [STAKED_TOKEN, 'balanceOf', [HOLDER_A]],
    ])
  })

  it('counts the active streak toward the record, and has none without a streak start', async () => {
    chainWith([500n, 9_000n, 400n, 25n])
    expect(await readStickyPosition(CHAIN, project, HOLDER_A)).toMatchObject({ current: 1_000, longest: 1_000 })

    chainWith([0n, 0n, 400n, 25n])
    expect(await readStickyPosition(CHAIN, project, HOLDER_A)).toMatchObject({ start: 0, current: 0, longest: 400 })

    // A start ahead of the block's time is no streak yet.
    chainWith([500n, 12_000n, 0n, 25n])
    expect(await readStickyPosition(CHAIN, project, HOLDER_A)).toMatchObject({ current: 0, longest: 0 })
  })

  it('rejects when the chain cannot be read', async () => {
    const { multicall } = chainWith([])
    multicall.mockRejectedValue(new Error('429'))
    await expect(readStickyPosition(CHAIN, project, HOLDER_A)).rejects.toThrow('429')
  })

  it('rejects with the caller\'s reason when it cancels', async () => {
    const { multicall } = chainWith([])
    multicall.mockReturnValue(new Promise(() => {}))
    const controller = new AbortController()
    const read = readStickyPosition(CHAIN, project, HOLDER_A, { signal: controller.signal })
    await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort(new Error('left the page'))
    await expect(read).rejects.toThrow('left the page')
  })

  it('refuses a chain Sticky is not deployed on', async () => {
    await expect(readStickyPosition(999, project, HOLDER_A)).rejects.toThrow('Sticky is not deployed on chain 999.')
  })
})

// ---------------------------------------------------------------- the visible page, read again

type Round = {
  contracts: readonly { address: Address; functionName: string; args: readonly [bigint, Address] }[]
  allowFailure?: boolean
  batchSize?: number
  blockNumber?: bigint
}

describe('verifyHolderPage', () => {
  const row = (holder: Address, staked: bigint): HolderRow => ({ holder, staked, start: 100, current: 900, longest: 900 })

  it('the shown holder page is re-read from the hook at one block and corrects a stale balance', async () => {
    const multicall = vi.fn(async ({ contracts }: Round) => contracts.map(call => (call.args[1] === HOLDER_B ? 3n : 6n)))
    center.client.mockReturnValue({ multicall } as unknown as PublicClient)
    const shown = [row(HOLDER_A, 6n), row(HOLDER_B, 4n)]
    const checked = await verifyHolderPage(CHAIN, 7n, shown, 0x77n)
    expect(checked.map(entry => entry.staked)).toEqual([6n, 3n])
    // One request, at the block given, of the hook's stakedBalanceOf for each holder shown.
    expect(multicall).toHaveBeenCalledTimes(1)
    const [{ contracts, blockNumber, allowFailure, batchSize }] = multicall.mock.calls[0]
    expect(blockNumber).toBe(0x77n)
    expect(allowFailure).toBe(false)
    // A page is one request: viem splits a batch above 1 KB of calldata unless told not to.
    expect(batchSize).toBe(0)
    expect(contracts.map(call => [call.address, call.functionName, call.args])).toEqual([
      [HOOK, 'stakedBalanceOf', [7n, HOLDER_A]],
      [HOOK, 'stakedBalanceOf', [7n, HOLDER_B]],
    ])
    // A balance that holds leaves its row as it was; the corrected one keeps everything but the balance.
    expect(checked[0]).toBe(shown[0])
    expect(checked[1]).toEqual({ ...shown[1], staked: 3n })
  })

  it('reads nothing for an empty page', async () => {
    const multicall = vi.fn()
    center.client.mockReturnValue({ multicall } as unknown as PublicClient)
    expect(await verifyHolderPage(CHAIN, 7n, [], 0x77n)).toEqual([])
    expect(multicall).not.toHaveBeenCalled()
  })

  it('rejects when the hook cannot be read, so the page keeps the rows it has', async () => {
    const multicall = vi.fn(async () => Promise.reject(new Error('429')))
    center.client.mockReturnValue({ multicall } as unknown as PublicClient)
    await expect(verifyHolderPage(CHAIN, 7n, [row(HOLDER_A, 6n)], 0x77n)).rejects.toThrow('429')
  })

  it('refuses a chain Sticky is not deployed on', async () => {
    await expect(verifyHolderPage(999, 7n, [row(HOLDER_A, 6n)], 0x77n)).rejects.toThrow(
      'Sticky is not deployed on chain 999.',
    )
  })
})

// ---------------------------------------------------------------- stickyHolders

/** Where these projects' positions are indexed through, and the time streaks are measured at. */
const AS_OF = CREATED + 1_000n
const NOW = timeAt(CREATED + 2_000n)

const position = (
  holder: Address,
  stakedBalance: bigint,
  streakStartedAt: number | null,
  longestCompletedStreak: number,
  projectId = 23n,
): IndexedPosition => ({ chainId: CHAIN, projectId, holder, stakedBalance, streakStartedAt, longestCompletedStreak })

type Spec = {
  /** Bendystraw's positions and the block they are as of. Without a block it has no status for the chain. */
  positions: { block?: bigint; rows?: IndexedPosition[] } | Error
  /** What the scan past Bendystraw's block finds. */
  tail?: ScannedLog[] | Error
  /** The project's events, when the positions cannot answer. */
  events?: StickyEventsResult | Error
}

function fakeDeps(spec: Spec) {
  const unexpected = (what: string) => new Error(`unexpected ${what}`)
  return {
    indexedPositions: vi.fn<HolderReadDeps['indexedPositions']>(async () => {
      if (spec.positions instanceof Error) throw spec.positions
      const { block, rows = [] } = spec.positions
      return { rows, blocks: new Map(block === undefined ? [] : [[CHAIN, block]]) }
    }),
    scan: vi.fn<HolderReadDeps['scan']>(async () => {
      if (spec.tail instanceof Error) throw spec.tail
      return spec.tail ?? []
    }),
    events: vi.fn<HolderReadDeps['events']>(async () => {
      if (spec.events === undefined) throw unexpected('events read')
      if (spec.events instanceof Error) throw spec.events
      return spec.events
    }),
  } satisfies HolderReadDeps
}

const at = (offset: bigint, logIndex = 0) => ({ blockNumber: AS_OF + offset, logIndex })

describe('stickyHolders', () => {
  it('maps indexed positions to rows: the current streak from its start, the longest with the active one', async () => {
    const deps = fakeDeps({
      positions: {
        block: AS_OF,
        rows: [
          position(HOLDER_A, 5n, NOW - 1_000, 300),
          position(HOLDER_C, 3n, NOW - 100, 900),
        ],
      },
    })
    const result = await stickyHolders(CHAIN, 23n, { ...deps, now: NOW })
    expect(result).toEqual({
      rows: [
        { holder: HOLDER_A, staked: 5n, start: NOW - 1_000, current: 1_000, longest: 1_000 },
        { holder: HOLDER_C, staked: 3n, start: NOW - 100, current: 100, longest: 900 },
      ],
      source: 'indexed',
      degraded: null,
    })
    expect(deps.events).not.toHaveBeenCalled()
  })

  it('a holder whose indexed balance is 0 drops out of active rows', async () => {
    const deps = fakeDeps({
      positions: { block: AS_OF, rows: [position(HOLDER_A, 5n, NOW - 10, 0), position(HOLDER_B, 0n, null, 500)] },
    })
    const { rows } = await stickyHolders(CHAIN, 23n, { ...deps, now: NOW })
    expect(rows.map(row => row.holder)).toEqual([HOLDER_A])
  })

  it('a tail-scan Staked past the indexed block raises that holder\'s balance', async () => {
    const start = NOW - 5_000
    const deps = fakeDeps({
      positions: { block: AS_OF, rows: [position(HOLDER_A, 5n, start, 0)] },
      tail: [staked(HOLDER_A, HOLDER_A, 3n, 8n, at(10n))],
    })
    const { rows } = await stickyHolders(CHAIN, 23n, { ...deps, now: NOW })
    expect(rows).toEqual([{ holder: HOLDER_A, staked: 8n, start, current: 5_000, longest: 5_000 }])
  })

  it('scans the hook\'s position events of the project from just below the indexed block', async () => {
    const deps = fakeDeps({ positions: { block: AS_OF } })
    await stickyHolders(CHAIN, 23n, { ...deps, now: NOW })
    expect(deps.scan).toHaveBeenCalledTimes(1)
    expect(deps.scan).toHaveBeenCalledWith(
      CHAIN,
      { address: HOOK, topics: [POSITION_TOPICS, topic(23n)], fromBlock: AS_OF + 1n - 64n },
      { signal: undefined },
    )
  })

  it('never scans from below the deployer\'s block, whatever block Bendystraw is indexed through', async () => {
    const deps = fakeDeps({ positions: { block: deployment.fromBlock + 10n } })
    await stickyHolders(CHAIN, 23n, { ...deps, now: NOW })
    expect(deps.scan.mock.calls[0][1].fromBlock).toBe(deployment.fromBlock)
  })

  it('changes nothing when the tail reads again what the positions already count, however many times', async () => {
    // Bendystraw's positions count every event through AS_OF. The tail starts 63 blocks below it and reads the last
    // of them again: A's second stick, and B's exit with the streak it ended.
    const start = NOW - 9_000
    const positions = [
      position(HOLDER_A, 7n, start, 0),
      position(HOLDER_C, 2n, NOW - 50, 0),
      position(HOLDER_B, 0n, null, 800),
    ]
    const overlap = [
      staked(HOLDER_A, HOLDER_A, 2n, 7n, at(-20n)),
      streakEnded(HOLDER_B, 800n, at(-5n, 0)),
      unstaked(HOLDER_B, 4n, 0n, at(-5n, 1)),
    ]
    const alone = await stickyHolders(CHAIN, 23n, {
      ...fakeDeps({ positions: { block: AS_OF, rows: positions } }),
      now: NOW,
    })
    const again = await stickyHolders(CHAIN, 23n, {
      ...fakeDeps({ positions: { block: AS_OF, rows: positions }, tail: overlap }),
      now: NOW,
    })
    const twice = await stickyHolders(CHAIN, 23n, {
      ...fakeDeps({ positions: { block: AS_OF, rows: positions }, tail: [...overlap, ...overlap] }),
      now: NOW,
    })
    expect(again).toEqual(alone)
    expect(twice).toEqual(alone)
    expect(alone.rows.map(row => [row.holder, row.staked])).toEqual([
      [HOLDER_A, 7n],
      [HOLDER_C, 2n],
    ])
  })

  it('catches up positions whose rows are older than the block Bendystraw says, within the overlap', async () => {
    // Bendystraw's status says AS_OF, but its rows were written before A's second stick 20 blocks earlier.
    const start = NOW - 9_000
    const deps = fakeDeps({
      positions: { block: AS_OF, rows: [position(HOLDER_A, 5n, start, 0)] },
      tail: [staked(HOLDER_A, HOLDER_A, 2n, 7n, at(-20n))],
    })
    const { rows } = await stickyHolders(CHAIN, 23n, { ...deps, now: NOW })
    expect(rows.map(row => [row.holder, row.staked, row.start])).toEqual([[HOLDER_A, 7n, start]])
  })

  it('ends a streak from the tail, keeps the longer record, and drops the holder it left with nothing', async () => {
    const indexed = [position(HOLDER_A, 5n, NOW - 9_000, 100), position(HOLDER_B, 2n, NOW - 50, 0)]
    const tail = [streakEnded(HOLDER_A, 5_000n, at(5n, 0)), unstaked(HOLDER_A, 5n, 0n, at(5n, 1))]
    const deps = fakeDeps({ positions: { block: AS_OF, rows: indexed }, tail })
    const { rows } = await stickyHolders(CHAIN, 23n, { ...deps, now: NOW })
    expect(rows.map(row => row.holder)).toEqual([HOLDER_B])
    expect(positionRows(indexed, decoded(tail), NOW)[0]).toEqual({
      holder: HOLDER_A,
      staked: 0n,
      start: 0,
      current: 0,
      longest: 5_000,
    })
  })

  it('adds a holder the tail found who Bendystraw has not reached, with the streak the tail started', async () => {
    const tail = [streakStarted(HOLDER_C, at(3n, 0)), staked(HOLDER_C, HOLDER_C, 2n, 2n, at(3n, 1))]
    const deps = fakeDeps({ positions: { block: AS_OF, rows: [] }, tail })
    const { rows } = await stickyHolders(CHAIN, 23n, { ...deps, now: NOW })
    const start = timeAt(AS_OF + 3n)
    expect(rows).toEqual([{ holder: HOLDER_C, staked: 2n, start, current: NOW - start, longest: NOW - start }])
  })

  it('applies the tail in the chain\'s order, by block and then by log, whatever order the scan gave it in', async () => {
    // In the chain's order: 8 at block 4, then 5 and 6 in block 9. The last balance stands.
    const tail = [
      staked(HOLDER_A, HOLDER_A, 1n, 6n, at(9n, 2)),
      unstaked(HOLDER_A, 3n, 5n, at(9n, 1)),
      staked(HOLDER_A, HOLDER_A, 3n, 8n, at(4n)),
    ]
    const deps = fakeDeps({ positions: { block: AS_OF, rows: [position(HOLDER_A, 5n, NOW - 9_000, 0)] }, tail })
    const { rows } = await stickyHolders(CHAIN, 23n, { ...deps, now: NOW })
    expect(rows.map(row => row.staked)).toEqual([6n])
  })

  it('keeps to the project: another project\'s positions and tail events are left out', async () => {
    const deps = fakeDeps({
      positions: { block: AS_OF, rows: [position(HOLDER_A, 5n, NOW - 10, 0), position(HOLDER_B, 9n, NOW - 10, 0, 24n)] },
      tail: [staked(HOLDER_C, HOLDER_C, 9n, 9n, { ...at(3n), project: 24n })],
    })
    const { rows } = await stickyHolders(CHAIN, 23n, { ...deps, now: NOW })
    expect(rows.map(row => row.holder)).toEqual([HOLDER_A])
  })

  it('orders the holders by shares, most first, and by address between equals', async () => {
    const deps = fakeDeps({
      positions: {
        block: AS_OF,
        rows: [
          position(HOLDER_C, 2n, NOW - 10, 0),
          position(HOLDER_B, 5n, NOW - 10, 0),
          position(HOLDER_A, 2n, NOW - 10, 0),
        ],
      },
    })
    const { rows } = await stickyHolders(CHAIN, 23n, { ...deps, now: NOW })
    expect(rows.map(row => row.holder)).toEqual([HOLDER_B, HOLDER_A, HOLDER_C])
  })

  it('asks Bendystraw for this project\'s positions on its chain, with the caller\'s signal', async () => {
    const deps = fakeDeps({ positions: { block: AS_OF } })
    const { signal } = new AbortController()
    await stickyHolders(CHAIN, 23n, { ...deps, now: NOW, signal })
    expect(deps.indexedPositions).toHaveBeenCalledWith({ chainId: CHAIN, projectId: 23n }, signal)
    expect(deps.scan.mock.calls[0][2]).toEqual({ signal })
  })

  it('measures streaks at the clock\'s time when no time is given', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date((NOW + 60) * 1000))
    const deps = fakeDeps({ positions: { block: AS_OF, rows: [position(HOLDER_A, 5n, NOW - 1_000, 0)] } })
    const { rows } = await stickyHolders(CHAIN, 23n, deps)
    expect(rows[0].current).toBe(1_060)
  })

  describe('when Bendystraw cannot answer', () => {
    const history = (events: StickyEvent[]): StickyEventsResult => ({ events, source: 'scanned', degraded: 'indexer-error' })
    const ofProject = (projectId: bigint, e: StickyEvent) => ({ ...e, chainId: CHAIN, projectId })

    it('builds the rows from the project\'s events, and says where they came from', async () => {
      const failure = new Error('Cannot query field "stickyPositions"')
      const events = [
        ofProject(23n, streakStart(HOLDER_A, NOW - 500)),
        ofProject(23n, stick(HOLDER_A, 5n, 5n, NOW - 500)),
        ofProject(23n, stick(HOLDER_B, 1n, 1n, NOW - 400)),
        ofProject(23n, unstick(HOLDER_B, 1n, 0n, NOW - 300)),
        // Another project's event is ignored.
        ofProject(24n, stick(HOLDER_C, 9n, 9n, NOW - 100)),
      ]
      const deps = fakeDeps({ positions: failure, events: history(events) })
      const { signal } = new AbortController()
      const result = await stickyHolders(CHAIN, 23n, { ...deps, now: NOW, signal })
      expect(result).toEqual({
        rows: [{ holder: HOLDER_A, staked: 5n, start: NOW - 500, current: 500, longest: 500 }],
        source: 'scanned',
        degraded: 'indexer-error',
      })
      expect(deps.events).toHaveBeenCalledWith(CHAIN, 23n, { signal })
      expect(deps.scan).not.toHaveBeenCalled()
      expect(vi.mocked(console.warn).mock.calls).toEqual([
        [
          "Bendystraw could not list the holders; building them from the project's events.",
          { chainId: CHAIN, projectId: 23n },
          failure,
        ],
      ])
    })

    it('reads the events of a chain Bendystraw has no status for', async () => {
      const deps = fakeDeps({
        positions: { rows: [position(HOLDER_A, 5n, NOW - 10, 0)] },
        events: { events: [ofProject(23n, stick(HOLDER_B, 2n, 2n, NOW - 10))], source: 'scanned', degraded: 'not-indexed' },
      })
      const result = await stickyHolders(CHAIN, 23n, { ...deps, now: NOW })
      expect(result).toMatchObject({ source: 'scanned', degraded: 'not-indexed' })
      expect(result.rows.map(row => row.holder)).toEqual([HOLDER_B])
      expect(deps.scan).not.toHaveBeenCalled()
      expect(console.warn).not.toHaveBeenCalled()
    })

    it('says the events came from Bendystraw\'s own events when that read answered', async () => {
      const deps = fakeDeps({
        positions: new Error('502'),
        events: { events: [ofProject(23n, stick(HOLDER_A, 2n, 2n, NOW - 10))], source: 'indexed', degraded: null },
      })
      expect(await stickyHolders(CHAIN, 23n, { ...deps, now: NOW })).toMatchObject({ source: 'indexed', degraded: null })
    })

    it('rejects when the events cannot be read either, instead of returning no holders', async () => {
      const deps = fakeDeps({ positions: new Error('down'), events: new Error('This history spans 9000000 blocks') })
      await expect(stickyHolders(CHAIN, 23n, deps)).rejects.toThrow('This history spans 9000000 blocks')
    })
  })

  it('builds the rows from the project\'s events, as when Bendystraw cannot answer, when the tail is too long to scan', async () => {
    // Bendystraw answers, but is far behind the head, as when it replays its history.
    const tooLong = new HistoryTooLongError('This history spans 600000 blocks, more than this RPC can scan in 1024 requests.')
    const deps = fakeDeps({
      positions: { block: AS_OF, rows: [position(HOLDER_A, 5n, NOW - 10, 0)] },
      tail: tooLong,
      events: {
        events: [{ ...stick(HOLDER_B, 2n, 2n, NOW - 10), chainId: CHAIN, projectId: 23n }],
        source: 'scanned',
        degraded: 'not-indexed',
      },
    })
    const result = await stickyHolders(CHAIN, 23n, { ...deps, now: NOW })
    expect(result).toMatchObject({ source: 'scanned', degraded: 'not-indexed' })
    expect(result.rows.map(row => row.holder)).toEqual([HOLDER_B])
    expect(deps.events).toHaveBeenCalledWith(CHAIN, 23n, { signal: undefined })
    expect(vi.mocked(console.warn).mock.calls).toEqual([
      ["Bendystraw could not list the holders; building them from the project's events.", { chainId: CHAIN, projectId: 23n }, tooLong],
    ])
  })

  it('rejects when the tail scan fails, instead of returning positions it could not bring up to date', async () => {
    const deps = fakeDeps({
      positions: { block: AS_OF, rows: [position(HOLDER_A, 5n, NOW - 10, 0)] },
      tail: new Error('429'),
    })
    await expect(stickyHolders(CHAIN, 23n, deps)).rejects.toThrow('429')
    expect(deps.events).not.toHaveBeenCalled()
  })

  it('rejects with the caller\'s reason when it cancels, and reads nothing else', async () => {
    const controller = new AbortController()
    const deps = fakeDeps({ positions: { block: AS_OF } })
    deps.indexedPositions.mockImplementation(async () => {
      controller.abort(new Error('left the page'))
      throw new Error('aborted')
    })
    await expect(stickyHolders(CHAIN, 23n, { ...deps, signal: controller.signal })).rejects.toThrow('left the page')
    expect(deps.events).not.toHaveBeenCalled()
    expect(deps.scan).not.toHaveBeenCalled()
  })

  it('refuses a chain Sticky is not deployed on', async () => {
    await expect(stickyHolders(999, 23n, fakeDeps({ positions: { block: AS_OF } }))).rejects.toThrow(
      'Sticky is not deployed on chain 999.',
    )
  })
})

describe('positionRows', () => {
  it('applying the same tail twice gives what applying it once does', () => {
    const indexed = [position(HOLDER_A, 5n, NOW - 9_000, 100), position(HOLDER_B, 2n, NOW - 50, 0)]
    const tail = decoded([
      staked(HOLDER_A, HOLDER_A, 3n, 8n, at(-3n)),
      streakEnded(HOLDER_B, 50n, at(2n, 0)),
      unstaked(HOLDER_B, 2n, 0n, at(2n, 1)),
      streakStarted(HOLDER_C, at(4n, 0)),
      staked(HOLDER_C, HOLDER_B, 1n, 1n, at(4n, 1)),
    ])
    const once = positionRows(indexed, tail, NOW)
    expect(positionRows(indexed, [...tail, ...tail], NOW)).toEqual(once)
    expect(summary(once)).toEqual([
      [HOLDER_A, 8n, 9_000, 9_000],
      [HOLDER_B, 0n, 0, 50],
      [HOLDER_C, 1n, NOW - timeAt(AS_OF + 4n), NOW - timeAt(AS_OF + 4n)],
    ])
  })

  it('sets the streak start from the tail\'s StreakStarted, over whatever start the position had', () => {
    const tail = decoded([streakStarted(HOLDER_A, at(3n))])
    expect(positionRows([position(HOLDER_A, 5n, NOW - 9_000, 0)], tail, NOW)[0].start).toBe(timeAt(AS_OF + 3n))
  })

  it('keeps a longer record over a shorter streak the tail ended', () => {
    const tail = decoded([streakEnded(HOLDER_A, 50n, at(3n, 0)), unstaked(HOLDER_A, 5n, 0n, at(3n, 1))])
    expect(positionRows([position(HOLDER_A, 5n, NOW - 50, 9_000)], tail, NOW)[0]).toEqual({
      holder: HOLDER_A,
      staked: 0n,
      start: 0,
      current: 0,
      longest: 9_000,
    })
  })

  it('is the positions as they are when there is no tail', () => {
    expect(positionRows([position(HOLDER_A, 5n, null, 70)], [], NOW)).toEqual([
      { holder: HOLDER_A, staked: 5n, start: 0, current: 0, longest: 70 },
    ])
  })
})

/** The events hook logs record, as stickyHolders decodes them. */
const decoded = (logs: ScannedLog[]): StickyEvent[] => logs.flatMap(log => decodeHookLog(log, CHAIN) ?? [])
