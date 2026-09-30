import { getAbiItem, toEventSelector, zeroAddress, type AbiEvent, type Address, type Hex } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScannedLog } from '@/lib/hook-logs'
import { terminalEventsAbi } from '@/lib/sticky-abis'
import {
  backingFlows,
  backingSeries,
  orphanExclusions,
  supplyPoints,
  type BackingSeries,
  type FlowReadOptions,
  type SupplyPoint,
} from '@/lib/sticky-backing'
import type { StickyEvent } from '@/lib/sticky-events'
import { CHAIN, HOLDER, TOPIC, deployment, raw, topic, words } from './sticky-log-fixtures'

// The chart's series is pure; backingFlows reads through the `scan` each call is given. Its default read, through
// Center, has tests of its own in sticky-backing-center.test.ts.

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

type Place = { block: bigint; logIndex?: number; project?: bigint }
const on = ({ block, logIndex = 0 }: Place) => ({ address: TERMINAL, blockNumber: block, logIndex, time: block })
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

type Filter = Parameters<NonNullable<FlowReadOptions['scan']>>[1]

/** A scan that answers from `logs` by topic, the way a node filters them, and lists what each scan asked for. */
function fakeScan(logs: ScannedLog[] | Error) {
  const filters: Filter[] = []
  const scan = vi.fn<NonNullable<FlowReadOptions['scan']>>(async (_chainId, filter) => {
    filters.push(filter)
    if (logs instanceof Error) throw logs
    const [signatures] = filter.topics
    return logs.filter(log => Array.isArray(signatures) && signatures.includes(log.topics[0]!))
  })
  return { scan, filters }
}

describe('backingFlows', () => {
  beforeEach(() => {
    nextIndex = 0
  })

  it('balance flows come from the terminal\'s Pay, CashOutTokens, AddToBalance and unheld ProcessFee', async () => {
    const { scan, filters } = fakeScan([
      payLog(100n * E6, 100n * E18, { block: 1n }),
      // The terminal takes a cash out's fee before it records the cash out, and a held fee moves nothing when paid.
      feeLog(1n * E6, false, { block: 3n, logIndex: 4 }),
      cashOutLog(40n * E18, 39n * E6, { block: 3n, logIndex: 5 }),
      feeLog(7n * E6, true, { block: 4n }),
      addLog(5n * E6, 2n * E6, { block: 2n }),
    ])
    const flows = await backingFlows(CHAIN, 42n, 9n, { scan })
    expect(flows).toEqual([
      { timestamp: 1, delta: 100n * E6 },
      { timestamp: 2, delta: 7n * E6 },
      { timestamp: 3, delta: -1n * E6 },
      { timestamp: 3, delta: -39n * E6 },
    ])
    expect(scan).toHaveBeenCalledTimes(2)
    expect(scan.mock.calls.map(([chainId]) => chainId)).toEqual([CHAIN, CHAIN])
    expect(filters).toEqual([
      { address: TERMINAL, topics: [[PAY, CASH_OUT], null, null, id()], fromBlock: 9n },
      { address: TERMINAL, topics: [[PROCESS_FEE, ADD_TO_BALANCE], id()], fromBlock: 9n },
    ])
  })

  it('a failed balance read rejects, so the page charts share supply instead', async () => {
    const { scan } = fakeScan(new Error('rpc down'))
    await expect(backingFlows(CHAIN, 42n, 9n, { scan })).rejects.toThrow('rpc down')
    // What the page charts then: the Sticky supply, in shares, marked as the fallback.
    const series = backingSeries(null, { supply: points([0, 0n], [10, 5n * E18]), info: info(5n * E6, 0n) })
    expect(series).toMatchObject({ supplyFallback: true, unit: { decimals: 18, symbol: 'STICKYSLOPSHOP' } })
    expect(values(series)).toEqual([0n, 5n * E18])
  })

  it('rejects a history too long to scan, so the page charts share supply instead', async () => {
    const { scan } = fakeScan(new Error('This history spans 9000000 blocks, more than this RPC can scan in 1024 requests.'))
    await expect(backingFlows(CHAIN, 42n, 9n, { scan })).rejects.toThrow('more than this RPC can scan')
    expect(scan).toHaveBeenCalledTimes(1)
  })

  it('the new topics are the terminal\'s and the hook\'s event hashes', () => {
    const selector = (name: 'ProcessFee' | 'AddToBalance') =>
      toEventSelector(getAbiItem({ abi: terminalEventsAbi, name }) as AbiEvent)
    expect(selector('ProcessFee')).toBe(PROCESS_FEE)
    expect(selector('AddToBalance')).toBe(ADD_TO_BALANCE)
    expect(TOPIC.ExcludeOrphanedBalance).toBe('0xa0b9b2db99d31a6b0fbb43cedfc627f78ae7c1b1f39d286ed7c61b5c9bba83fa')
  })

  it('reads the second scan only after the first has answered', async () => {
    let answer: (logs: ScannedLog[]) => void = () => {}
    const scan = vi.fn<NonNullable<FlowReadOptions['scan']>>()
    scan.mockImplementationOnce(() => new Promise(resolve => (answer = resolve)))
    scan.mockImplementationOnce(async () => [])
    const flows = backingFlows(CHAIN, 42n, 9n, { scan })
    await Promise.resolve()
    expect(scan).toHaveBeenCalledTimes(1)
    answer([payLog(1n, 1n, { block: 10n })])
    expect(await flows).toEqual([{ timestamp: 10, delta: 1n }])
    expect(scan).toHaveBeenCalledTimes(2)
  })

  it('leaves out a pay of nothing and another project\'s events that a node sent anyway', async () => {
    const { scan } = fakeScan([
      payLog(0n, 0n, { block: 1n }),
      payLog(5n, 5n, { block: 2n, project: 43n }),
      addLog(5n, 0n, { block: 3n, project: 43n }),
      feeLog(1n, false, { block: 4n, project: 43n }),
      addLog(0n, 0n, { block: 5n }),
      payLog(3n, 3n, { block: 6n }),
    ])
    expect(await backingFlows(CHAIN, 42n, 1n, { scan })).toEqual([{ timestamp: 6, delta: 3n }])
  })

  it('refuses a terminal log that came without its block\'s time', async () => {
    const untimed = raw([PAY, topic(1n), topic(1n), id()], words(HOLDER, HOLDER, 1n, 1n, 224n, 256n, HOLDER, 0n, 0n), {
      address: TERMINAL,
      blockNumber: 7n,
      time: null,
    })
    await expect(backingFlows(CHAIN, 42n, 1n, fakeScan([untimed]))).rejects.toThrow(
      `A terminal log on chain ${CHAIN} came without its block's time.`,
    )
  })

  it('hands the caller\'s signal to both scans, and rejects with its reason once it cancels', async () => {
    const controller = new AbortController()
    const { scan } = fakeScan([])
    await backingFlows(CHAIN, 42n, 9n, { scan, signal: controller.signal })
    expect(scan.mock.calls.map(([, , opts]) => opts)).toEqual([{ signal: controller.signal }, { signal: controller.signal }])

    scan.mockImplementationOnce(async () => {
      controller.abort(new Error('left the page'))
      return []
    })
    await expect(backingFlows(CHAIN, 42n, 9n, { scan, signal: controller.signal })).rejects.toThrow('left the page')
    expect(scan).toHaveBeenCalledTimes(3)
  })

  it('refuses a chain Sticky is not deployed on', async () => {
    await expect(backingFlows(999, 42n, 9n, fakeScan([]))).rejects.toThrow('Sticky is not deployed on chain 999.')
  })
})
