import {
  encodeAbiParameters,
  getAbiItem,
  parseAbiParameters,
  toEventSelector,
  zeroAddress,
  type AbiEvent,
  type Address,
  type Hex,
} from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScannedLog } from '@/lib/hook-logs'
import { terminalEventsAbi } from '@/lib/sticky-abis'
import {
  backingFlows,
  backingSeries,
  orphanExclusions,
  supplyPoints,
  type BackingSeries,
  type FlowReadDeps,
  type SupplyPoint,
} from '@/lib/sticky-backing'
import type { StickyEvent } from '@/lib/sticky-events'
import type { IndexedMove } from '@/lib/sticky-indexed'
import { CHAIN, HOLDER, TOPIC, deployment, raw, topic, words } from './sticky-log-fixtures'

// The chart's series is pure; backingFlows reads through the deps each call is given. Its default reads, through
// Center and Bendystraw, have tests of their own in sticky-backing-center.test.ts.

const E18 = 10n ** 18n
const E6 = 10n ** 6n
// SLOPSHOP has 6 decimals; its Sticky token always has 18.
const TOKENS = { symbol: 'SLOPSHOP', stSymbol: 'STICKYSLOPSHOP', decimals: 6 }
const info = (rawBacking: bigint, savedOrphaned: bigint) => ({ ...TOKENS, rawBacking, savedOrphaned })

// Share supply points, as supplyPoints builds them: oldest first, the last one now.
const points = (...rows: [number, bigint][]): SupplyPoint[] =>
  rows.map(([timestamp, staked]) => ({ timestamp, streaks: staked > 0n ? 1 : 0, staked }))
const values = (series: BackingSeries) => series.points.map(point => point.value)

describe('backingSeries', () => {
  it('a stick adds its pay, and the latest point is today\'s backing', () => {
    const series = backingSeries([{ timestamp: 10, delta: 101n * E6 }], {
      supply: points([0, 0n], [10, 100n * E18], [30, 100n * E18]),
      info: info(101n * E6, 0n),
    })
    expect(values(series)).toEqual([0n, 101n * E6, 101n * E6])
  })

  it('an unstick removes what the holder got and the fee that left with it', () => {
    // 100 shares in for 100; 40 out for a 39 reclaim after a 1 fee. Today's backing is 60.
    const flows = [
      { timestamp: 20, delta: -39n * E6 },
      { timestamp: 10, delta: 100n * E6 },
      { timestamp: 20, delta: -1n * E6 },
    ]
    const series = backingSeries(flows, {
      supply: points([0, 0n], [10, 100n * E18], [20, 60n * E18], [30, 60n * E18]),
      info: info(60n * E6, 0n),
    })
    expect(values(series)).toEqual([0n, 100n * E6, 60n * E6, 60n * E6])
  })

  it('the latest point equals the anchor even when older flows are missing', () => {
    // A donation the logs never saw: history shifts, today does not.
    const series = backingSeries([{ timestamp: 10, delta: 10n * E6 }], {
      supply: points([0, 0n], [10, 10n * E18], [30, 10n * E18]),
      info: info(15n * E6, 0n),
    })
    expect(series.points.at(-1)?.value).toBe(15n * E6)
    expect(series.points[1].value).toBe(15n * E6)
  })

  it('history is clamped at zero and is zero while no Sticky tokens exist', () => {
    // Flows after ts 10 exceed today's balance, so the reconstruction would go negative there.
    const series = backingSeries([{ timestamp: 20, delta: 50n * E6 }], {
      supply: points([0, 0n], [10, 5n * E18], [20, 50n * E18], [30, 50n * E18]),
      info: info(40n * E6, 0n),
    })
    expect(values(series)).toEqual([0n, 0n, 40n * E6, 40n * E6])
    for (const point of series.points) expect(point.value >= 0n).toBe(true)
    // Everyone left: the leftover backing is orphaned, not stuck. The hook's saved exclusion, not the whole balance
    // the page counts as orphaned while no shares exist, is what the older points subtract.
    const empty = backingSeries([{ timestamp: 10, delta: 10n * E6 }], {
      supply: points([0, 0n], [10, 10n * E18], [20, 0n], [30, 0n]),
      info: info(10n * E6, 0n),
    })
    expect(values(empty)).toEqual([0n, 10n * E6, 0n, 0n])
  })

  it('orphaned funds are excluded from the point they were excluded on', () => {
    // 10 stuck, everyone left 4 behind (fee-free rounding), a new holder stuck 10 and the 4 became orphaned.
    const series = backingSeries(
      [
        { timestamp: 10, delta: 10n * E6 },
        { timestamp: 20, delta: -6n * E6 },
        { timestamp: 25, delta: 10n * E6 },
      ],
      {
        supply: points([0, 0n], [10, 10n * E18], [20, 0n], [25, 10n * E18], [30, 10n * E18]),
        info: info(14n * E6, 4n * E6),
        orphans: [{ timestamp: 25, amount: 4n * E6 }],
      },
    )
    expect(values(series)).toEqual([0n, 10n * E6, 0n, 10n * E6, 10n * E6])
  })

  it('keeps each point\'s time, active streaks and shares beside its value', () => {
    const series = backingSeries([{ timestamp: 10, delta: 101n * E6 }], {
      supply: points([0, 0n], [10, 100n * E18]),
      info: info(101n * E6, 0n),
    })
    expect(series.points).toEqual([
      { timestamp: 0, streaks: 0, staked: 0n, value: 0n },
      { timestamp: 10, streaks: 1, staked: 100n * E18, value: 101n * E6 },
    ])
  })

  it('has no points without supply points', () => {
    expect(backingSeries([], { supply: [], info: info(0n, 0n) }).points).toEqual([])
    expect(backingSeries(null, { supply: [], info: info(0n, 0n) }).points).toEqual([])
  })
})

// ---------------------------------------------------------------- the chart's units

let nextIndex = 0
function event(kind: StickyEvent['kind'], timestamp: number, fields: Partial<StickyEvent> = {}): StickyEvent {
  nextIndex += 1
  return {
    kind,
    chainId: CHAIN,
    projectId: 42n,
    holder: HOLDER,
    txHash: `0x${nextIndex.toString(16).padStart(64, '0')}` as Hex,
    logIndex: nextIndex,
    blockNumber: null,
    timestamp,
    ...fields,
  }
}
const stick = (count: bigint, at: number) => event('stick', at, { payer: HOLDER, count, balance: count })
const unstick = (count: bigint, at: number) => event('unstick', at, { count, balance: 0n })

describe('the chart', () => {
  const now = 1_000_000
  const events = [stick(200n * E18, now - 100), unstick(60n * E18, now - 50)]

  it('the chart labels Total stuck in the underlying token\'s decimals and symbol', () => {
    const series = backingSeries(
      [
        { timestamp: now - 100, delta: 1010n * E6 },
        { timestamp: now - 50, delta: -303n * E6 },
      ],
      { supply: supplyPoints(events, now), info: info(707n * E6, 0n) },
    )
    expect(series.unit).toEqual({ decimals: 6, symbol: 'SLOPSHOP' })
    expect(series.supplyFallback).toBe(false)
    // "Peak: 1,010 SLOPSHOP stuck", never the Sticky symbol.
    expect(values(series).reduce((peak, value) => (value > peak ? value : peak), 0n)).toBe(1010n * E6)
    expect(values(series)).toEqual([0n, 1010n * E6, 707n * E6, 707n * E6])
  })

  it('without balance history the chart falls back to Sticky token supply in the Sticky symbol', () => {
    const series = backingSeries(null, { supply: supplyPoints(events, now), info: info(707n * E6, 0n) })
    expect(series.supplyFallback).toBe(true)
    expect(series.unit).toEqual({ decimals: 18, symbol: 'STICKYSLOPSHOP' })
    // "Peak: 200 STICKYSLOPSHOP stuck".
    expect(values(series)).toEqual([0n, 200n * E18, 140n * E18, 140n * E18])
  })
})

describe('supplyPoints', () => {
  it('steps the active streaks and the shares in circulation at each event, from nothing to now', () => {
    const steps = supplyPoints(
      [
        event('streakStart', 100),
        stick(5n, 100),
        stick(3n, 200),
        event('streakEnd', 300, { length: 200n }),
        unstick(8n, 300),
      ],
      1_000,
    )
    expect(steps).toEqual([
      { timestamp: 100, streaks: 0, staked: 0n },
      { timestamp: 100, streaks: 1, staked: 0n },
      { timestamp: 100, streaks: 1, staked: 5n },
      { timestamp: 200, streaks: 1, staked: 8n },
      { timestamp: 300, streaks: 0, staked: 8n },
      { timestamp: 300, streaks: 0, staked: 0n },
      { timestamp: 1_000, streaks: 0, staked: 0n },
    ])
  })

  it('takes the events in the order of their time', () => {
    const steps = supplyPoints([stick(3n, 200), stick(5n, 100)], 1_000)
    expect(steps.map(step => [step.timestamp, step.staked])).toEqual([
      [100, 0n],
      [100, 5n],
      [200, 8n],
      [1_000, 8n],
    ])
  })

  it('leaves out granters, trusted senders and exclusions, and has no points without a stick or streak', () => {
    const settings = [
      event('granter', 50, { trusted: true }),
      event('trust', 60, { sender: HOLDER, trusted: true }),
      event('excludeOrphan', 70, { holder: zeroAddress, amount: 4n }),
    ]
    expect(supplyPoints(settings, 1_000)).toEqual([])
    expect(supplyPoints([...settings, stick(1n, 80)], 1_000).map(step => step.timestamp)).toEqual([80, 80, 1_000])
  })

  it('ends at the last event when the clock is behind it', () => {
    expect(supplyPoints([stick(1n, 500)], 400).at(-1)).toEqual({ timestamp: 500, streaks: 0, staked: 1n })
  })

  it('refuses a stick or unstick without the shares it moved', () => {
    const bare = event('stick', 100, { payer: HOLDER })
    expect(() => supplyPoints([bare], 1_000)).toThrow(new TypeError(`A stick in ${bare.txHash} lacks its share count.`))
  })
})

describe('orphanExclusions', () => {
  it('is each exclusion\'s time and the backing it excluded from then on', () => {
    const excluded = [
      event('excludeOrphan', 25, { holder: zeroAddress, amount: 4n * E6 }),
      stick(1n, 30),
      unstick(1n, 35),
      event('streakEnd', 35, { length: 5n }),
      event('excludeOrphan', 40, { holder: zeroAddress, amount: 0n }),
    ]
    expect(orphanExclusions(excluded)).toEqual([
      { timestamp: 25, amount: 4n * E6 },
      { timestamp: 40, amount: 0n },
    ])
  })

  it('refuses an exclusion without its amount', () => {
    const bare = event('excludeOrphan', 25, { holder: zeroAddress })
    expect(() => orphanExclusions([bare])).toThrow(new TypeError(`An exclusion in ${bare.txHash} lacks its amount.`))
  })
})

// ---------------------------------------------------------------- the terminal's history

const TERMINAL = deployment.terminal
const PAY = '0x133161f1c9161488f777ab9a26aae91d47c0d9a3fafb398960f138db02c73797'
const CASH_OUT = '0xfaf1d4bf1b08470c7ed8c351c5065f51af70b36b237723173f898453b9724142'
const PROCESS_FEE = '0xb514e730b3f8ad3aa94b6857bcc5ff4a46954bdcf8c4b0346705b1d0ac7a4325'
const ADD_TO_BALANCE = '0x9ecaf7fc3dfffd6867c175d6e684b1f1e3aef019398ba8db2c1ffab4a09db253'
const TOKEN = `0x${'e'.repeat(40)}` as Address

type Place = { block: bigint; logIndex?: number; project?: bigint; time?: bigint; txHash?: string }
const on = ({ block, logIndex = 0, time = block, txHash }: Place) => ({
  address: TERMINAL,
  blockNumber: block,
  logIndex,
  time,
  ...(txHash === undefined ? {} : { txHash }),
})
const id = (project = 42n) => topic(project)

// Each event's fields that are not topics, in the ABI's layout, with an empty memo or metadata where it has one.
// Pay: payer, beneficiary, amount, count, memo, metadata, caller.
const payLog = (amount: bigint, count: bigint, at: Place) =>
  raw([PAY, topic(1n), topic(1n), id(at.project)], words(HOLDER, HOLDER, amount, count, 224n, 256n, HOLDER, 0n, 0n), on(at))
// CashOutTokens: holder, beneficiary, count, taxRate, reclaimAmount, metadata, caller.
const cashOutLog = (count: bigint, reclaim: bigint, at: Place) =>
  raw(
    [CASH_OUT, topic(1n), topic(1n), id(at.project)],
    words(HOLDER, HOLDER, count, 1000n, reclaim, 224n, HOLDER, 0n),
    on(at),
  )
// ProcessFee(projectId, token, amount indexed; wasHeld, beneficiary, caller).
const feeLog = (amount: bigint, wasHeld: boolean, at: Place) =>
  raw([PROCESS_FEE, id(at.project), topic(TOKEN), topic(amount)], words(wasHeld, HOLDER, HOLDER), on(at))
// AddToBalance(projectId indexed; amount, returnedFees, memo, metadata, caller).
const addLog = (amount: bigint, returnedFees: bigint, at: Place) =>
  raw([ADD_TO_BALANCE, id(at.project)], words(amount, returnedFees, 160n, 192n, HOLDER, 0n, 0n), on(at))

// Bendystraw's pays and cash outs of project 42, as indexedStickyMoves gives them.
type MoveAt = { txHash: string; logIndex: number; timestamp: number; projectId?: bigint }
const indexedPay = (amount: bigint, tokens: bigint, { projectId = 42n, ...at }: MoveAt): IndexedMove => ({
  kind: 'stick',
  chainId: CHAIN,
  projectId,
  ...at,
  txHash: at.txHash as Hex,
  holder: HOLDER,
  payer: HOLDER,
  amount,
  tokens,
})
const indexedCashOut = (amount: bigint, tokens: bigint, { projectId = 42n, ...at }: MoveAt): IndexedMove => ({
  kind: 'unstick',
  chainId: CHAIN,
  projectId,
  ...at,
  txHash: at.txHash as Hex,
  holder: HOLDER,
  amount,
  tokens,
})
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`

type Filter = Parameters<FlowReadDeps['scan']>[1]
type KeptFilter = Parameters<FlowReadDeps['keptScan']>[2]
const FEES_KEY = `${CHAIN}:${TERMINAL.toLowerCase()}:42:fees`
const MOVES_KEY = `${CHAIN}:${TERMINAL.toLowerCase()}:42:moves`
const MOVE_TOPICS = [[PAY, CASH_OUT], null, null, id()]
const FEE_TOPICS = [[PROCESS_FEE, ADD_TO_BALANCE], id()]

type Spec = {
  /** Bendystraw's pays and cash outs and the block they are as of (none: no status for the chain), or how it fails. */
  indexed?: { rows: IndexedMove[]; block?: bigint } | Error
  /** The terminal's logs. Each scan answers with those of the events it asks for, by topic, as a node would. */
  logs?: ScannedLog[]
  /** How the plain scan fails, and how the kept one does. */
  scanFails?: Error
  keptFails?: Error
}

/** Fakes of the three reads. `scans` lists what each plain scan asked for, and `kept` each kept scan's key and filter. */
function fakeDeps({ indexed = new Error('Bendystraw is down'), logs = [], scanFails, keptFails }: Spec = {}) {
  const scans: Filter[] = []
  const kept: { key: string; filter: KeptFilter }[] = []
  const answering = (topics: Filter['topics']) => {
    const [signatures] = topics
    return logs.filter(log => Array.isArray(signatures) && signatures.includes(log.topics[0]!))
  }
  const deps = {
    indexedMoves: vi.fn<FlowReadDeps['indexedMoves']>(async () => {
      if (indexed instanceof Error) throw indexed
      return { rows: indexed.rows, blocks: new Map(indexed.block === undefined ? [] : [[CHAIN, indexed.block]]) }
    }),
    scan: vi.fn<FlowReadDeps['scan']>(async (_chainId, filter) => {
      scans.push(filter)
      if (scanFails) throw scanFails
      return answering(filter.topics)
    }),
    keptScan: vi.fn<FlowReadDeps['keptScan']>(async (_chainId, key, filter) => {
      kept.push({ key, filter })
      if (keptFails) throw keptFails
      return answering(filter.topics)
    }),
  } satisfies FlowReadDeps
  return { ...deps, scans, kept }
}

/** Where Bendystraw's pays and cash outs are indexed through in these tests, well past the deployer's block. */
const AS_OF = deployment.fromBlock + 10_000n
const MOVES_UNAVAILABLE = 'Bendystraw could not list the pays and cash outs; scanning the terminal for them instead.'

describe('backingFlows', () => {
  beforeEach(() => {
    nextIndex = 0
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('balance flows come from the terminal\'s Pay, CashOutTokens, AddToBalance and unheld ProcessFee', async () => {
    // Bendystraw cannot answer here, so the pays and cash outs are scanned too, the old client's two scans, and each
    // is kept in this browser under a key of its own.
    const deps = fakeDeps({
      logs: [
        payLog(100n * E6, 100n * E18, { block: 1n }),
        // The terminal takes a cash out's fee before it records the cash out, and a held fee moves nothing when paid.
        feeLog(1n * E6, false, { block: 3n, logIndex: 4 }),
        cashOutLog(40n * E18, 39n * E6, { block: 3n, logIndex: 5 }),
        feeLog(7n * E6, true, { block: 4n }),
        addLog(5n * E6, 2n * E6, { block: 2n }),
      ],
    })
    const flows = await backingFlows(CHAIN, 42n, 9n, deps)
    expect(flows).toEqual([
      { timestamp: 1, delta: 100n * E6 },
      { timestamp: 2, delta: 7n * E6 },
      { timestamp: 3, delta: -1n * E6 },
      { timestamp: 3, delta: -39n * E6 },
    ])
    expect(deps.scans).toEqual([])
    expect(deps.kept).toEqual([
      { key: MOVES_KEY, filter: { address: TERMINAL, topics: MOVE_TOPICS, fromBlock: 9n } },
      { key: FEES_KEY, filter: { address: TERMINAL, topics: FEE_TOPICS, fromBlock: 9n } },
    ])
    expect(deps.keptScan.mock.calls.map(([chainId]) => chainId)).toEqual([CHAIN, CHAIN])
    expect(vi.mocked(console.warn).mock.calls).toEqual([
      [MOVES_UNAVAILABLE, { chainId: CHAIN, projectId: 42n }, new Error('Bendystraw is down')],
    ])
  })

  it('the indexed path sends no Pay/CashOut scan of the project\'s history, only the tail past Bendystraw\'s block', async () => {
    const deps = fakeDeps({
      indexed: {
        rows: [
          indexedPay(100n * E6, 100n * E18, { txHash: hash(1), logIndex: 1, timestamp: 10 }),
          indexedCashOut(39n * E6, 40n * E18, { txHash: hash(3), logIndex: 5, timestamp: 30 }),
        ],
        block: AS_OF,
      },
      logs: [
        feeLog(1n * E6, false, { block: 3n, logIndex: 4, time: 30n }),
        addLog(5n * E6, 2n * E6, { block: 2n, time: 20n }),
      ],
    })
    const flows = await backingFlows(CHAIN, 42n, 9n, deps)
    expect(flows).toEqual([
      { timestamp: 10, delta: 100n * E6 },
      { timestamp: 20, delta: 7n * E6 },
      { timestamp: 30, delta: -1n * E6 },
      { timestamp: 30, delta: -39n * E6 },
    ])
    // One scan for pays and cash outs, from 64 blocks below the block after Bendystraw's, and the kept fee scan.
    expect(deps.scans).toEqual([{ address: TERMINAL, topics: MOVE_TOPICS, fromBlock: AS_OF + 1n - 64n }])
    expect(deps.kept).toEqual([{ key: FEES_KEY, filter: { address: TERMINAL, topics: FEE_TOPICS, fromBlock: 9n } }])
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('counts once an event both Bendystraw and the tail have, at the boundary, and adds the ones only the tail has', async () => {
    const deps = fakeDeps({
      indexed: {
        rows: [
          indexedPay(1n, 1n, { txHash: hash(0xa0), logIndex: 2, timestamp: 100 }),
          // Written in capitals: the same transaction as the tail's.
          indexedPay(5n, 5n, { txHash: hash(0xab).toUpperCase().replace('0X', '0x'), logIndex: 3, timestamp: 190 }),
          indexedCashOut(2n, 2n, { txHash: hash(0xac), logIndex: 7, timestamp: 195 }),
        ],
        block: AS_OF,
      },
      logs: [
        // Below Bendystraw's block, which the tail reads again, and which Bendystraw already has.
        payLog(5n, 5n, { block: AS_OF - 10n, logIndex: 3, time: 190n, txHash: hash(0xab) }),
        cashOutLog(2n, 2n, { block: AS_OF - 5n, logIndex: 7, time: 195n, txHash: hash(0xac) }),
        // The same transaction as one Bendystraw has, another event of it: not the same event.
        payLog(4n, 4n, { block: AS_OF - 5n, logIndex: 8, time: 195n, txHash: hash(0xac) }),
        // Past it: only the tail has these.
        payLog(8n, 8n, { block: AS_OF + 5n, time: 205n, txHash: hash(0xad) }),
        cashOutLog(3n, 3n, { block: AS_OF + 6n, time: 206n, txHash: hash(0xae) }),
      ],
    })
    expect(await backingFlows(CHAIN, 42n, 9n, deps)).toEqual([
      { timestamp: 100, delta: 1n },
      { timestamp: 190, delta: 5n },
      { timestamp: 195, delta: -2n },
      { timestamp: 195, delta: 4n },
      { timestamp: 205, delta: 8n },
      { timestamp: 206, delta: -3n },
    ])
  })

  it('starts the tail at the project\'s creation when Bendystraw is indexed only through an earlier block', async () => {
    // An indexer stalled since before the launch: no pay or cash out of the project is older than its creation.
    const past = AS_OF + 1n - 64n
    for (const [created, from] of [
      [AS_OF + 5_000n, AS_OF + 5_000n],
      [past + 1n, past + 1n],
      [past, past],
      [past - 1n, past],
    ]) {
      const deps = fakeDeps({ indexed: { rows: [], block: AS_OF } })
      await backingFlows(CHAIN, 42n, created, deps)
      expect(deps.scans.map(filter => filter.fromBlock)).toEqual([from])
      expect(deps.kept.map(({ filter }) => filter.fromBlock)).toEqual([created])
    }
  })

  it('keeps an addition\'s amounts in the fee history, and not its memo or metadata', async () => {
    const deps = fakeDeps({ indexed: { rows: [], block: AS_OF } })
    await backingFlows(CHAIN, 42n, 9n, deps)
    const [[, , , { keep }]] = deps.keptScan.mock.calls
    const memo = 'x'.repeat(10_000)
    const data = encodeAbiParameters(parseAbiParameters('uint256, uint256, string, bytes, address'), [
      5n,
      2n,
      memo,
      '0xabcdef',
      HOLDER,
    ])
    const addition = raw([ADD_TO_BALANCE, id()], data, on({ block: 2n }))
    const kept = keep!(addition)
    expect({ ...kept, data: addition.data }).toEqual(addition)
    expect(kept.data).toBe(
      encodeAbiParameters(parseAbiParameters('uint256, uint256, string, bytes, address'), [5n, 2n, '', '0x', HOLDER]),
    )
    const fee = feeLog(1n, false, { block: 3n })
    expect(keep!(fee)).toBe(fee)
  })

  it('scans the terminal for the pays and cash outs of a chain Bendystraw has no status for, as when it fails', async () => {
    const deps = fakeDeps({
      indexed: { rows: [indexedPay(999n, 999n, { txHash: hash(9), logIndex: 0, timestamp: 1 })] },
      logs: [payLog(5n, 5n, { block: 2n })],
    })
    expect(await backingFlows(CHAIN, 42n, 9n, deps)).toEqual([{ timestamp: 2, delta: 5n }])
    expect(deps.scans).toEqual([])
    expect(deps.kept[0]).toEqual({ key: MOVES_KEY, filter: { address: TERMINAL, topics: MOVE_TOPICS, fromBlock: 9n } })
  })

  it("keeps the pays and cash outs it scans without a pay's memo or either's metadata, as it keeps the fees", async () => {
    const deps = fakeDeps()
    await backingFlows(CHAIN, 42n, 9n, deps)
    const [[, movesKey, , { keep }]] = deps.keptScan.mock.calls
    expect(movesKey).toBe(MOVES_KEY)
    const pay = parseAbiParameters('address, address, uint256, uint256, string, bytes, address')
    const paid = raw([PAY, topic(1n), topic(1n), id()], encodeAbiParameters(pay, [HOLDER, HOLDER, 5n, 6n, 'x'.repeat(10_000), '0xabcd', HOLDER]), on({ block: 2n }))
    const kept = keep!(paid)
    expect({ ...kept, data: paid.data }).toEqual(paid)
    expect(kept.data).toBe(encodeAbiParameters(pay, [HOLDER, HOLDER, 5n, 6n, '', '0x', HOLDER]))
  })

  it('hands a creation block it could not find on as unknown to the kept scans, and reads it as the deployer\'s for a plain one', async () => {
    const down = fakeDeps()
    await backingFlows(CHAIN, 42n, null, down)
    expect(down.scans).toEqual([])
    expect(down.kept.map(({ key, filter }) => [key, filter.fromBlock])).toEqual([
      [MOVES_KEY, null],
      [FEES_KEY, null],
    ])

    const indexed = fakeDeps({ indexed: { rows: [], block: AS_OF } })
    await backingFlows(CHAIN, 42n, null, indexed)
    expect(indexed.scans.map(filter => filter.fromBlock)).toEqual([AS_OF + 1n - 64n])
    expect(indexed.kept.map(({ filter }) => filter.fromBlock)).toEqual([null])
  })

  it('leaves out Bendystraw\'s moves of another project and moves of nothing', async () => {
    const deps = fakeDeps({
      indexed: {
        rows: [
          indexedPay(7n, 7n, { txHash: hash(1), logIndex: 0, timestamp: 10, projectId: 43n }),
          indexedPay(0n, 0n, { txHash: hash(2), logIndex: 0, timestamp: 11 }),
          indexedCashOut(0n, 1n, { txHash: hash(3), logIndex: 0, timestamp: 12 }),
          indexedPay(3n, 3n, { txHash: hash(4), logIndex: 0, timestamp: 13 }),
        ],
        block: AS_OF,
      },
    })
    expect(await backingFlows(CHAIN, 42n, 9n, deps)).toEqual([{ timestamp: 13, delta: 3n }])
  })

  describe('charts the share supply instead only when no path can read the history', () => {
    it('rejects when Bendystraw cannot answer and the terminal cannot be scanned either', async () => {
      const deps = fakeDeps({ keptFails: new Error('rpc down') })
      await expect(backingFlows(CHAIN, 42n, 9n, deps)).rejects.toThrow('rpc down')
      // The pays and cash outs failed: the fees are not read.
      expect(deps.kept.map(({ key }) => key)).toEqual([MOVES_KEY])
    })

    it('rejects when the tail past Bendystraw\'s block cannot be read', async () => {
      const deps = fakeDeps({ indexed: { rows: [], block: AS_OF }, scanFails: new Error('429') })
      await expect(backingFlows(CHAIN, 42n, 9n, deps)).rejects.toThrow('429')
    })

    it('rejects when the fees cannot be read, which only the terminal records', async () => {
      const deps = fakeDeps({
        indexed: { rows: [], block: AS_OF },
        keptFails: new Error('This history spans 9000000 blocks'),
      })
      await expect(backingFlows(CHAIN, 42n, 9n, deps)).rejects.toThrow('This history spans 9000000 blocks')
    })

    it('a failed balance read rejects, so the page charts share supply instead', async () => {
      const deps = fakeDeps({ keptFails: new Error('rpc down') })
      await expect(backingFlows(CHAIN, 42n, 9n, deps)).rejects.toThrow('rpc down')
      // What the page charts then: the Sticky supply, in shares, marked as the fallback.
      const series = backingSeries(null, { supply: points([0, 0n], [10, 5n * E18]), info: info(5n * E6, 0n) })
      expect(series).toMatchObject({ supplyFallback: true, unit: { decimals: 18, symbol: 'STICKYSLOPSHOP' } })
      expect(values(series)).toEqual([0n, 5n * E18])
    })

    it('rejects a history too long to scan, so the page charts share supply instead', async () => {
      const tooLong = new Error('This history spans 9000000 blocks, more than this RPC can scan in 1024 requests.')
      const deps = fakeDeps({ keptFails: tooLong })
      await expect(backingFlows(CHAIN, 42n, 9n, deps)).rejects.toThrow('more than this RPC can scan')
      expect(deps.keptScan).toHaveBeenCalledTimes(1)
    })
  })

  it('the new topics are the terminal\'s and the hook\'s event hashes', () => {
    const selector = (name: 'ProcessFee' | 'AddToBalance') =>
      toEventSelector(getAbiItem({ abi: terminalEventsAbi, name }) as AbiEvent)
    expect(selector('ProcessFee')).toBe(PROCESS_FEE)
    expect(selector('AddToBalance')).toBe(ADD_TO_BALANCE)
    expect(TOPIC.ExcludeOrphanedBalance).toBe('0xa0b9b2db99d31a6b0fbb43cedfc627f78ae7c1b1f39d286ed7c61b5c9bba83fa')
  })

  it('reads one source after another: Bendystraw, then the tail, then the fees', async () => {
    const order: string[] = []
    let answer: (logs: ScannedLog[]) => void = () => {}
    const deps = fakeDeps({ indexed: { rows: [], block: AS_OF } })
    deps.indexedMoves.mockImplementationOnce(async () => {
      order.push('bendystraw')
      return { rows: [], blocks: new Map([[CHAIN, AS_OF]]) }
    })
    deps.scan.mockImplementationOnce(() => {
      order.push('tail')
      return new Promise(resolve => (answer = resolve))
    })
    deps.keptScan.mockImplementationOnce(async () => {
      order.push('fees')
      return []
    })
    const flows = backingFlows(CHAIN, 42n, 9n, deps)
    await vi.waitFor(() => expect(order).toEqual(['bendystraw', 'tail']))
    answer([payLog(1n, 1n, { block: AS_OF + 1n, time: 50n })])
    expect(await flows).toEqual([{ timestamp: 50, delta: 1n }])
    expect(order).toEqual(['bendystraw', 'tail', 'fees'])
  })

  it('leaves out a pay of nothing and another project\'s events that a node sent anyway', async () => {
    const deps = fakeDeps({
      logs: [
        payLog(0n, 0n, { block: 1n }),
        payLog(5n, 5n, { block: 2n, project: 43n }),
        addLog(5n, 0n, { block: 3n, project: 43n }),
        feeLog(1n, false, { block: 4n, project: 43n }),
        addLog(0n, 0n, { block: 5n }),
        payLog(3n, 3n, { block: 6n }),
      ],
    })
    expect(await backingFlows(CHAIN, 42n, 1n, deps)).toEqual([{ timestamp: 6, delta: 3n }])
  })

  it('refuses a terminal log that came without its block\'s time', async () => {
    const untimed = raw([PAY, topic(1n), topic(1n), id()], words(HOLDER, HOLDER, 1n, 1n, 224n, 256n, HOLDER, 0n, 0n), {
      address: TERMINAL,
      blockNumber: 7n,
      time: null,
    })
    await expect(backingFlows(CHAIN, 42n, 1n, fakeDeps({ logs: [untimed] }))).rejects.toThrow(
      `A terminal log on chain ${CHAIN} came without its block's time.`,
    )
  })

  it('hands the caller\'s signal to every read, and rejects with its reason once it cancels', async () => {
    const controller = new AbortController()
    const { signal } = controller
    const deps = fakeDeps({ indexed: { rows: [], block: AS_OF } })
    await backingFlows(CHAIN, 42n, 9n, { ...deps, signal })
    expect(deps.indexedMoves).toHaveBeenCalledWith(CHAIN, [42n], signal)
    expect(deps.scan.mock.calls.map(([, , opts]) => opts)).toEqual([{ signal }])
    expect(deps.keptScan.mock.calls.map(([, , , opts]) => opts)).toEqual([{ signal, keep: expect.any(Function) }])

    deps.scan.mockImplementationOnce(async () => {
      controller.abort(new Error('left the page'))
      return []
    })
    await expect(backingFlows(CHAIN, 42n, 9n, { ...deps, signal })).rejects.toThrow('left the page')
    expect(deps.keptScan).toHaveBeenCalledTimes(1)
  })

  it('rejects with the caller\'s reason when it cancels during Bendystraw\'s read, and scans nothing', async () => {
    const controller = new AbortController()
    const deps = fakeDeps({ indexed: { rows: [], block: AS_OF } })
    deps.indexedMoves.mockImplementationOnce(async () => {
      controller.abort(new Error('left the page'))
      throw new Error('aborted')
    })
    await expect(backingFlows(CHAIN, 42n, 9n, { ...deps, signal: controller.signal })).rejects.toThrow('left the page')
    expect(deps.scan).not.toHaveBeenCalled()
    expect(deps.keptScan).not.toHaveBeenCalled()
  })

  it('refuses a chain Sticky is not deployed on', async () => {
    await expect(backingFlows(999, 42n, 9n, fakeDeps())).rejects.toThrow('Sticky is not deployed on chain 999.')
  })
})
