import { getAbiItem, toEventSelector, type AbiEvent, type Address, type Hex } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScannedLog } from '@/lib/hook-logs'
import { terminalEventsAbi } from '@/lib/sticky-abis'
import type { StickyEvent } from '@/lib/sticky-events'
import {
  FEED_WINDOW,
  airdropEvents,
  airdropRows,
  feedRows,
  moveAmounts,
  moveEvents,
  moveKey,
  terminalMoves,
  type FeedAmount,
  type FeedLine,
  type FeedOptions,
  type FeedRow,
  type MoveReaders,
} from '@/lib/sticky-feed'
import type { IndexedMove } from '@/lib/sticky-indexed'
import { CHAIN, deployment, HOLDER, raw, topic, words } from './sticky-log-fixtures'

// Ported from the old client's test/feed-amounts.test.cjs and, for the feed built from Bendystraw's pays and cash
// outs, test/bendystraw.test.cjs: rows in place of the HTML it rendered, and StickyEvents in place of the hook logs it
// decoded. Every read goes through the readers a call is given, so nothing here reaches Bendystraw or Center; the
// default reads have tests of their own in sticky-feed-center.test.ts and sticky-feed-bendystraw.test.ts.

// A read that fails tells the console why. The tests that care read what it said.
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
const LABEL = 'Could not read stick and unstick amounts; showing Sticky token counts.'

const FUNDER = `0x${'b'.repeat(40)}` as Address
const RECIPIENT = `0x${'c'.repeat(40)}` as Address
const TERMINAL = deployment.terminal
/** The chain's auto-stick adapter as the records write it, with a checksum's mixed case. */
const ADAPTER = deployment.autoStick
const E18 = 10n ** 18n
const E6 = 10n ** 6n
// JBMultiTerminal's events by the topics the old client filtered on (webclient/app.js:94-95), from `cast keccak`.
const PAY = '0x133161f1c9161488f777ab9a26aae91d47c0d9a3fafb398960f138db02c73797'
const CASH_OUT = '0xfaf1d4bf1b08470c7ed8c351c5065f51af70b36b237723173f898453b9724142'
// SLOPSHOP has 6 decimals; its Sticky token always has 18.
const TOKENS = { symbol: 'SLOPSHOP', stSymbol: 'STICKYSLOPSHOP', decimals: 6 }
const options: FeedOptions = { adapter: null, tokens: () => TOKENS }

const tx = (short: string) => `0x${short.padStart(64, '0')}` as Hex
/** The same transaction hash written in capitals. */
const cased = (short: string) => `0x${tx(short).slice(2).toUpperCase()}` as Hex

// StickyEvents as sticky-events gives them: the block number is a scan's, and null for a row Bendystraw indexed.
type Place = Partial<Pick<StickyEvent, 'chainId' | 'projectId' | 'blockNumber' | 'timestamp' | 'logIndex' | 'txHash'>>
const place = (short: string, extra: Place = {}) => ({
  chainId: CHAIN,
  projectId: 42n,
  txHash: tx(short),
  logIndex: 0,
  blockNumber: 16n as bigint | null,
  timestamp: 100,
  ...extra,
})
const stick = (holder: Address, payer: Address, count: bigint, short: string, extra?: Place): StickyEvent => ({
  kind: 'stick',
  holder,
  payer,
  count,
  balance: count,
  ...place(short, extra),
})
const unstick = (holder: Address, count: bigint, balance: bigint, short: string, extra?: Place): StickyEvent => ({
  kind: 'unstick',
  holder,
  count,
  balance,
  ...place(short, extra),
})
const streakStart = (holder: Address, short: string, extra?: Place): StickyEvent => ({
  kind: 'streakStart',
  holder,
  ...place(short, extra),
})
const streakEnd = (holder: Address, length: bigint, short: string, extra?: Place): StickyEvent => ({
  kind: 'streakEnd',
  holder,
  length,
  ...place(short, extra),
})

// JBMultiTerminal Pay(rulesetId, cycle, projectId indexed; payer, beneficiary, amount, newlyIssuedTokenCount, memo,
// metadata, caller), written by hand: 224 is where the memo starts and 256 where the metadata does.
function payLog(
  beneficiary: Address,
  amount: bigint,
  count: bigint,
  txHash: Hex,
  projectId = 42n,
  payer = FUNDER,
): ScannedLog {
  return raw(
    [PAY, topic(1n), topic(1n), topic(projectId)],
    words(payer, beneficiary, amount, count, 224n, 256n, payer, 0n, 0n),
    { address: TERMINAL, txHash },
  )
}
// CashOutTokens(rulesetId, cycle, projectId indexed; holder, beneficiary, cashOutCount, cashOutTaxRate, reclaimAmount,
// metadata, caller).
function cashOutLog(
  holder: Address,
  count: bigint,
  reclaim: bigint,
  txHash: Hex,
  projectId = 42n,
  beneficiary = holder,
): ScannedLog {
  return raw(
    [CASH_OUT, topic(1n), topic(1n), topic(projectId)],
    words(holder, beneficiary, count, 0n, reclaim, 224n, holder, 0n),
    { address: TERMINAL, txHash },
  )
}

// Bendystraw's pays and cash outs. A pay's holder is its beneficiary and its `tokens` are the shares it issued.
type IndexedAt = { chainId?: number; projectId?: bigint; timestamp?: number; logIndex?: number }
const indexedStick = (
  holder: Address,
  payer: Address,
  amount: bigint,
  tokens: bigint,
  txHash: Hex,
  at: IndexedAt = {},
): IndexedMove => ({
  chainId: CHAIN,
  projectId: 42n,
  logIndex: 0,
  timestamp: 100,
  ...at,
  kind: 'stick',
  txHash,
  holder,
  payer,
  amount,
  tokens,
})
const indexedCashOut = (
  holder: Address,
  amount: bigint,
  tokens: bigint,
  txHash: Hex,
  at: IndexedAt = {},
): IndexedMove => ({
  chainId: CHAIN,
  projectId: 42n,
  logIndex: 0,
  timestamp: 100,
  ...at,
  kind: 'unstick',
  txHash,
  holder,
  amount,
  tokens,
})

type Spec = { terminal?: ScannedLog[] | Error; moves?: IndexedMove[] | Error }
/** Fakes of the two reads terminalMoves makes: Bendystraw's pays and cash outs, and what a scan of the terminal
 * finds, each or an error. */
function readers({ terminal = [], moves = [] }: Spec = {}) {
  const indexedMoves = vi.fn<MoveReaders['indexedMoves']>(async () => {
    if (moves instanceof Error) throw moves
    return moves
  })
  const scan = vi.fn<MoveReaders['scan']>(async () => {
    if (terminal instanceof Error) throw terminal
    return terminal
  })
  return { indexedMoves, scan }
}

const slop = (value: bigint): FeedAmount => ({ value, decimals: 6, symbol: 'SLOPSHOP' })
const shares = (value: bigint): FeedAmount => ({ value, decimals: 18, symbol: 'STICKYSLOPSHOP' })
/** The row the events of transaction `short`, at time 100 and log index 0 on the test chain and project, make. */
const row = (
  short: string,
  direction: FeedRow['direction'],
  amount: FeedRow['amount'],
  line: FeedLine,
  extra: Partial<Pick<FeedRow, 'chainId' | 'projectId' | 'timestamp' | 'logIndex'>> = {},
): FeedRow => ({
  chainId: CHAIN,
  projectId: 42n,
  timestamp: 100,
  logIndex: 0,
  txHash: tx(short),
  direction,
  amount,
  line,
  ...extra,
})

/** The rows a page shows for `events`, reading their amounts as it would. */
async function rowsFor(events: StickyEvent[], spec?: Spec) {
  return feedRows(events, await terminalMoves(events, readers(spec)), options)
}

describe('the terminal events', () => {
  it("are JBMultiTerminal's Pay and CashOutTokens", () => {
    const selector = (name: 'Pay' | 'CashOutTokens') =>
      toEventSelector(getAbiItem({ abi: terminalEventsAbi, name }) as AbiEvent)
    expect(selector('Pay')).toBe(PAY)
    expect(selector('CashOutTokens')).toBe(CASH_OUT)
  })
})

describe('sticks and unsticks', () => {
  it('show the underlying tokens that came in and went out, in its decimals and symbol', async () => {
    const events = [
      stick(HOLDER, HOLDER, 1000n * E18, 'a1', { blockNumber: 0x10n }),
      stick(RECIPIENT, FUNDER, 5n * E18, 'a2', { blockNumber: 0x12n }),
      unstick(HOLDER, 100n * E18, 900n * E18, 'a3', { blockNumber: 0x14n }),
    ]
    const reads = readers({
      terminal: [
        // The terminal's hash is in another case than the hook's.
        payLog(HOLDER, 1010n * E6, 1000n * E18, cased('a1')),
        payLog(RECIPIENT, 5n * E6, 5n * E18, tx('a2')),
        cashOutLog(HOLDER, 100n * E18, 99n * E6, tx('a3')),
      ],
    })

    const moves = await terminalMoves(events, reads)

    expect(feedRows(events, moves, options)).toStrictEqual([
      row('a3', 'out', slop(99n * E6), { kind: 'unstuck', holder: HOLDER }),
      row('a2', 'in', slop(5n * E6), { kind: 'gift', holder: RECIPIENT, payer: FUNDER }),
      row('a1', 'in', slop(1010n * E6), { kind: 'stuck', holder: HOLDER }),
    ])
    // One terminal scan, from the oldest shown event's block, for the shown projects only.
    expect(reads.scan).toHaveBeenCalledTimes(1)
    expect(reads.scan).toHaveBeenCalledWith(
      CHAIN,
      { address: TERMINAL, topics: [[PAY, CASH_OUT], null, null, [topic(42n)]], fromBlock: 0x10n },
      { signal: undefined },
    )
    expect(reads.indexedMoves).not.toHaveBeenCalled()
    expect(airdropRows(events, moves, options)).toStrictEqual([
      row('a2', 'in', slop(5n * E6), { kind: 'gift', holder: RECIPIENT, payer: FUNDER }),
    ])
  })

  it('in a transfer between holders move no underlying tokens and keep their Sticky token count', async () => {
    const events = [
      unstick(HOLDER, 10n * E18, 90n * E18, 'b1', { logIndex: 1 }),
      stick(RECIPIENT, HOLDER, 10n * E18, 'b1', { logIndex: 2 }),
    ]

    expect(await rowsFor(events)).toStrictEqual([
      row('b1', 'in', shares(10n * E18), { kind: 'gift', holder: RECIPIENT, payer: HOLDER }, { logIndex: 2 }),
      row('b1', 'out', shares(10n * E18), { kind: 'removed', holder: HOLDER }, { logIndex: 1 }),
    ])
  })

  it('never match a terminal event for another holder, count or transaction', async () => {
    const events = [stick(HOLDER, HOLDER, 10n * E18, 'c1'), unstick(HOLDER, 4n * E18, 6n * E18, 'c2')]
    const terminal = [
      payLog(RECIPIENT, 10n * E6, 10n * E18, tx('c1')),
      payLog(HOLDER, 10n * E6, 11n * E18, tx('c1')),
      payLog(HOLDER, 10n * E6, 10n * E18, tx('c9')),
      cashOutLog(HOLDER, 5n * E18, 4n * E6, tx('c2')),
      // Another project's, whose stick has the same holder, count and transaction.
      payLog(HOLDER, 10n * E6, 10n * E18, tx('c1'), 43n),
      // Paid by this holder for someone else, and cashed out by someone else for this holder.
      payLog(RECIPIENT, 10n * E6, 10n * E18, tx('c1'), 42n, HOLDER),
      cashOutLog(RECIPIENT, 4n * E18, 4n * E6, tx('c2'), 42n, HOLDER),
      // A log that is not a pay or a cash out that can be read at all.
      raw([PAY], '0x', { address: TERMINAL, txHash: tx('c1') }),
    ]

    expect(await rowsFor(events, { terminal })).toStrictEqual([
      row('c2', 'out', shares(4n * E18), { kind: 'removed', holder: HOLDER }),
      row('c1', 'in', shares(10n * E18), { kind: 'stuck', holder: HOLDER }),
    ])
  })

  it('match a cash out to the holder whose shares were cashed out, wherever the tokens went', async () => {
    const events = [unstick(HOLDER, 5n * E18, 0n, 'f2')]
    const terminal = [cashOutLog(HOLDER, 5n * E18, 3n * E6, tx('f2'), 42n, RECIPIENT)]

    expect(await rowsFor(events, { terminal })).toStrictEqual([
      row('f2', 'out', slop(3n * E6), { kind: 'unstuck', holder: HOLDER }),
    ])
  })

  it('fall back to Sticky token counts when the terminal read fails, instead of breaking the feed', async () => {
    const events = [stick(HOLDER, HOLDER, 3n * E18, 'd1')]
    const down = new Error('rpc down')

    expect(await rowsFor(events, { terminal: down })).toStrictEqual([
      row('d1', 'in', shares(3n * E18), { kind: 'stuck', holder: HOLDER }),
    ])
    expect(vi.mocked(console.warn).mock.calls).toEqual([[LABEL, { chainId: CHAIN }, down]])
  })

  it('on a chain with no Sticky deployment read nothing and keep Sticky token counts', async () => {
    const events = [
      stick(HOLDER, HOLDER, 3n * E18, 'd1', { chainId: 424_242 }),
      stick(HOLDER, HOLDER, 4n * E18, 'd2', { chainId: 424_242, blockNumber: null }),
    ]
    const reads = readers()

    const rows = feedRows(events, await terminalMoves(events, reads), options)

    expect(rows).toStrictEqual([
      row('d2', 'in', shares(4n * E18), { kind: 'stuck', holder: HOLDER }, { chainId: 424_242 }),
      row('d1', 'in', shares(3n * E18), { kind: 'stuck', holder: HOLDER }, { chainId: 424_242 }),
    ])
    expect(reads.scan).not.toHaveBeenCalled()
    expect(reads.indexedMoves).not.toHaveBeenCalled()
  })

  it('show a zero underlying amount, not the Sticky token count, when the terminal says zero', async () => {
    const events = [unstick(HOLDER, 5n * E18, 0n, 'f1')]

    expect(await rowsFor(events, { terminal: [cashOutLog(HOLDER, 5n * E18, 0n, tx('f1'))] })).toStrictEqual([
      row('f1', 'out', slop(0n), { kind: 'unstuck', holder: HOLDER }),
    ])
  })
})

describe('a streak', () => {
  it('that starts or ends in a stick or unstick transaction reads on that row', async () => {
    const events = [
      stick(HOLDER, HOLDER, 10n * E18, 'e1', { logIndex: 1 }),
      streakStart(HOLDER, 'e1', { txHash: cased('e1'), logIndex: 2 }),
      // Another holder's streak in the same transaction keeps its own row.
      streakStart(RECIPIENT, 'e1', { logIndex: 3 }),
      unstick(HOLDER, 10n * E18, 0n, 'e2', { logIndex: 4 }),
      streakEnd(HOLDER, 86_400n, 'e2', { logIndex: 5 }),
    ]

    const rows = await rowsFor(events)

    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ line: { kind: 'removed', holder: HOLDER, streak: { endedAfter: 86_400n } } })
    expect(rows[1]).toMatchObject({ line: { kind: 'gotSticky', holder: RECIPIENT } })
    expect(rows[2]).toMatchObject({ line: { kind: 'stuck', holder: HOLDER, streak: 'started' } })
    // A folded row is the stick or unstick's, so it has that log's index.
    expect(rows).toStrictEqual([
      row(
        'e2',
        'out',
        shares(10n * E18),
        { kind: 'removed', holder: HOLDER, streak: { endedAfter: 86_400n } },
        { logIndex: 4 },
      ),
      row('e1', null, null, { kind: 'gotSticky', holder: RECIPIENT }, { logIndex: 3 }),
      row('e1', 'in', shares(10n * E18), { kind: 'stuck', holder: HOLDER, streak: 'started' }, { logIndex: 1 }),
    ])
  })

  it.each<[string, StickyEvent[], number]>([
    // The hook emits a streak just before the stick or unstick that causes it. A source may list them either way.
    ['before it', [streakStart(HOLDER, 'e3', { logIndex: 1 }), stick(HOLDER, HOLDER, 1n, 'e3', { logIndex: 2 })], 2],
    ['after it', [stick(HOLDER, HOLDER, 1n, 'e3', { logIndex: 1 }), streakStart(HOLDER, 'e3', { logIndex: 2 })], 1],
  ])('reads on its stick when the events list it %s', async (_when, events, logIndex) => {
    expect(await rowsFor(events)).toStrictEqual([
      row('e3', 'in', shares(1n), { kind: 'stuck', holder: HOLDER, streak: 'started' }, { logIndex }),
    ])
  })

  it('reads on the row of an underlying amount, and on a gift', async () => {
    const events = [
      stick(RECIPIENT, FUNDER, 5n * E18, 'e4', { logIndex: 1 }),
      streakStart(RECIPIENT, 'e4', { logIndex: 2 }),
      unstick(HOLDER, 100n * E18, 0n, 'e5', { logIndex: 3 }),
      streakEnd(HOLDER, 60n, 'e5', { logIndex: 4 }),
    ]
    const terminal = [
      payLog(RECIPIENT, 5n * E6, 5n * E18, tx('e4')),
      cashOutLog(HOLDER, 100n * E18, 99n * E6, tx('e5')),
    ]

    expect(await rowsFor(events, { terminal })).toStrictEqual([
      row(
        'e5',
        'out',
        slop(99n * E6),
        { kind: 'unstuck', holder: HOLDER, streak: { endedAfter: 60n } },
        { logIndex: 3 },
      ),
      row(
        'e4',
        'in',
        slop(5n * E6),
        { kind: 'gift', holder: RECIPIENT, payer: FUNDER, streak: 'started' },
        { logIndex: 1 },
      ),
    ])
  })

  it('alone is a row of its own, with no amount and no direction', async () => {
    const events = [streakStart(HOLDER, 'e6', { logIndex: 8 }), streakEnd(RECIPIENT, 3_600n, 'e7', { logIndex: 9 })]

    expect(await rowsFor(events)).toStrictEqual([
      row('e7', null, null, { kind: 'cameUnstuck', holder: RECIPIENT, length: 3_600n }, { logIndex: 9 }),
      row('e6', null, null, { kind: 'gotSticky', holder: HOLDER }, { logIndex: 8 }),
    ])
  })

  it('never folds into another holder, project, chain or transaction', () => {
    const events = [
      stick(HOLDER, HOLDER, 1n, 'e8'),
      streakStart(RECIPIENT, 'e8'),
      streakStart(HOLDER, 'e8', { projectId: 43n }),
      streakStart(HOLDER, 'e8', { chainId: 10 }),
      streakStart(HOLDER, 'e9'),
    ]

    expect(feedRows(events, new Map(), options).map(({ line }) => line)).toStrictEqual([
      { kind: 'gotSticky', holder: HOLDER },
      { kind: 'gotSticky', holder: HOLDER },
      { kind: 'gotSticky', holder: HOLDER },
      { kind: 'gotSticky', holder: RECIPIENT },
      { kind: 'stuck', holder: HOLDER },
    ])
  })

  it('goes with the unstick it ends and the stick it starts when one transaction has both', async () => {
    // A holder cashes out everything and pays in again in one transaction: the hook's events, in its order.
    const events = [
      streakEnd(HOLDER, 500n, 'aa', { logIndex: 1 }),
      unstick(HOLDER, 10n * E18, 0n, 'aa', { logIndex: 2 }),
      streakStart(HOLDER, 'aa', { logIndex: 3 }),
      stick(HOLDER, HOLDER, 20n * E18, 'aa', { logIndex: 4 }),
    ]

    expect(await rowsFor(events)).toStrictEqual([
      row('aa', 'in', shares(20n * E18), { kind: 'stuck', holder: HOLDER, streak: 'started' }, { logIndex: 4 }),
      row(
        'aa',
        'out',
        shares(10n * E18),
        { kind: 'removed', holder: HOLDER, streak: { endedAfter: 500n } },
        { logIndex: 2 },
      ),
    ])
  })

  it('that ends after a partial unstick goes with the unstick that ended it', async () => {
    const events = [
      unstick(HOLDER, 1n * E18, 9n * E18, 'ab', { logIndex: 1 }),
      streakEnd(HOLDER, 500n, 'ab', { logIndex: 2 }),
      unstick(HOLDER, 9n * E18, 0n, 'ab', { logIndex: 3 }),
    ]

    expect(await rowsFor(events)).toStrictEqual([
      row(
        'ab',
        'out',
        shares(9n * E18),
        { kind: 'removed', holder: HOLDER, streak: { endedAfter: 500n } },
        { logIndex: 3 },
      ),
      row('ab', 'out', shares(1n * E18), { kind: 'removed', holder: HOLDER }, { logIndex: 1 }),
    ])
  })

  it('that starts with the first of two sticks goes with that one only', async () => {
    const events = [
      streakStart(HOLDER, 'ac', { logIndex: 1 }),
      stick(HOLDER, HOLDER, 1n, 'ac', { logIndex: 2 }),
      stick(HOLDER, HOLDER, 2n, 'ac', { logIndex: 3 }),
    ]

    expect(await rowsFor(events)).toStrictEqual([
      row('ac', 'in', shares(2n), { kind: 'stuck', holder: HOLDER }, { logIndex: 3 }),
      row('ac', 'in', shares(1n), { kind: 'stuck', holder: HOLDER, streak: 'started' }, { logIndex: 2 }),
    ])
  })

  it('with no stick or unstick of its kind in its transaction keeps a row of its own', async () => {
    // A start beside an unstick, which the hook never emits: the row that says it happened is not lost.
    const events = [unstick(HOLDER, 1n, 0n, 'ad', { logIndex: 1 }), streakStart(HOLDER, 'ad', { logIndex: 2 })]

    expect(await rowsFor(events)).toStrictEqual([
      row('ad', null, null, { kind: 'gotSticky', holder: HOLDER }, { logIndex: 2 }),
      row('ad', 'out', shares(1n), { kind: 'removed', holder: HOLDER }, { logIndex: 1 }),
    ])
  })
})

describe('feedRows', () => {
  it('is newest first, and puts a group where its newest member sat', () => {
    // The stick and its streak are one row, and the streak is the newer of the two.
    const events = [
      stick(HOLDER, HOLDER, 1n, 'b1', { timestamp: 10 }),
      stick(RECIPIENT, RECIPIENT, 2n, 'b2', { timestamp: 20 }),
      streakStart(HOLDER, 'b1', { timestamp: 10, logIndex: 5 }),
      stick(FUNDER, FUNDER, 3n, 'b3', { timestamp: 30 }),
    ]

    const rows = feedRows(events, new Map(), options)

    expect(rows.map(({ line }) => line.holder)).toEqual([FUNDER, HOLDER, RECIPIENT])
    expect(rows[1].line).toEqual({ kind: 'stuck', holder: HOLDER, streak: 'started' })
    expect(rows[1].logIndex).toBe(0)
  })

  it('leaves the list of events it was given as it was', () => {
    const events = [stick(HOLDER, HOLDER, 1n, 'b1'), unstick(HOLDER, 1n, 0n, 'b2')]
    const snapshot = [...events]

    feedRows(events, new Map(), options)

    expect(events).toEqual(snapshot)
  })

  it('keeps the rows of one transaction apart across projects and chains', () => {
    const events = [
      stick(HOLDER, HOLDER, 1n, 'b4'),
      stick(HOLDER, HOLDER, 1n, 'b4', { projectId: 43n }),
      stick(HOLDER, HOLDER, 1n, 'b4', { chainId: 10 }),
    ]

    expect(feedRows(events, new Map(), options).map(({ chainId, projectId }) => [chainId, projectId])).toEqual([
      [10, 42n],
      [CHAIN, 43n],
      [CHAIN, 42n],
    ])
  })

  it('reads a stick as auto-stuck, stuck or a gift by who paid', () => {
    const events = [
      stick(HOLDER, HOLDER, 1n, 'b5'),
      stick(HOLDER, ADAPTER.toLowerCase() as Address, 2n, 'b6'),
      stick(HOLDER, FUNDER, 3n, 'b7'),
    ]

    expect(feedRows(events, new Map(), { ...options, adapter: ADAPTER }).map(({ line }) => line)).toEqual([
      { kind: 'gift', holder: HOLDER, payer: FUNDER },
      { kind: 'autoStuck', holder: HOLDER },
      { kind: 'stuck', holder: HOLDER },
    ])
    // Where a chain has no adapter, whoever paid is only that.
    expect(feedRows(events, new Map(), options).map(({ line }) => line.kind)).toEqual(['gift', 'gift', 'stuck'])
  })

  it('reads an unstick as unstuck when it paid something out, and as removed when it did not', () => {
    const events = [unstick(HOLDER, 2n, 0n, 'b8'), unstick(HOLDER, 1n, 1n, 'b9')]
    const paid = new Map([[moveKey({ ...events[0], kind: 'unstick', count: 2n }), 7n]])

    const rows = feedRows(events, paid, options)

    expect(rows.map(({ line, amount, direction }) => [line.kind, amount, direction])).toEqual([
      ['removed', shares(1n), 'out'],
      ['unstuck', slop(7n), 'out'],
    ])
  })

  it('leaves out what is not a stick, an unstick or a streak', () => {
    const at = { chainId: CHAIN, projectId: 42n, logIndex: 0, blockNumber: null, timestamp: 1 }
    const events: StickyEvent[] = [
      { ...at, kind: 'trust', holder: HOLDER, txHash: tx('ba'), sender: FUNDER, trusted: true },
      { ...at, kind: 'granter', holder: HOLDER, txHash: tx('bb'), trusted: true },
      { ...at, kind: 'excludeOrphan', holder: `0x${'0'.repeat(40)}`, txHash: tx('bc'), amount: 5n },
    ]

    expect(feedRows(events, new Map(), options)).toEqual([])
  })

  it('leaves out the events of a project it has no tokens for, and the streaks with them', () => {
    const events = [
      stick(HOLDER, HOLDER, 1n, 'bd', { projectId: 7n }),
      streakStart(HOLDER, 'bd', { projectId: 7n }),
      stick(HOLDER, HOLDER, 2n, 'be'),
    ]
    const tokens = (_chainId: number, projectId: bigint) => (projectId === 42n ? TOKENS : undefined)

    expect(feedRows(events, new Map(), { ...options, tokens })).toStrictEqual([
      row('be', 'in', shares(2n), { kind: 'stuck', holder: HOLDER }),
    ])
  })

  it("names each project's own tokens, so one list can hold projects of different decimals", () => {
    const events = [stick(HOLDER, HOLDER, 1n, 'bf'), stick(HOLDER, HOLDER, 1n, 'bf', { projectId: 43n })]
    const tokens = (_chainId: number, projectId: bigint) =>
      projectId === 43n
        ? { symbol: 'USDC', stSymbol: 'STICKYUSDC', decimals: 6 }
        : { symbol: 'WBTC', stSymbol: 'STICKYWBTC', decimals: 8 }
    const moves = new Map([
      [moveKey({ ...events[0], kind: 'stick', count: 1n }), 100n],
      [moveKey({ ...events[1], kind: 'stick', count: 1n }), 200n],
    ])

    expect(feedRows(events, moves, { ...options, tokens }).map(({ amount }) => amount)).toEqual([
      { value: 200n, decimals: 6, symbol: 'USDC' },
      { value: 100n, decimals: 8, symbol: 'WBTC' },
    ])
  })

  it('refuses a stick, unstick or streak that lacks what its row needs, rather than dropping it', () => {
    const noPayer = { ...stick(HOLDER, HOLDER, 1n, 'c0'), payer: undefined }
    const noCount = { ...unstick(HOLDER, 1n, 0n, 'c1'), count: undefined }
    const noStickCount = { ...stick(HOLDER, HOLDER, 1n, 'c3'), count: undefined }
    const noLength = { ...streakEnd(HOLDER, 1n, 'c2'), length: undefined }
    const refused = (event: StickyEvent) => () => feedRows([event], new Map(), options)

    expect(refused(noPayer)).toThrow(new TypeError(`A stick in ${tx('c0')} lacks its payer.`))
    expect(refused(noCount)).toThrow(new TypeError(`An unstick in ${tx('c1')} lacks its share count.`))
    expect(refused(noStickCount)).toThrow(new TypeError(`A stick in ${tx('c3')} lacks its share count.`))
    expect(refused(noLength)).toThrow(new TypeError(`A streak end in ${tx('c2')} lacks its length.`))
  })
})

describe('a row', () => {
  const key = ({ chainId, txHash, logIndex }: FeedRow) => `${chainId}:${txHash}:${logIndex}`

  it('has a key of its own: two sticks by one holder in one transaction differ by their log index', async () => {
    const events = [
      stick(HOLDER, HOLDER, 3n, 'f0', { logIndex: 6 }),
      stick(HOLDER, HOLDER, 3n, 'f0', { logIndex: 9 }),
      unstick(HOLDER, 3n, 3n, 'f0', { logIndex: 11 }),
    ]

    const rows = await rowsFor(events)

    expect(rows.map(({ direction, amount }) => [direction, amount?.value])).toEqual([
      ['out', 3n],
      ['in', 3n],
      ['in', 3n],
    ])
    expect(rows.map(({ logIndex }) => logIndex)).toEqual([11, 9, 6])
    expect(new Set(rows.map(key)).size).toBe(rows.length)
  })

  it("is the stick or unstick's log when a streak folds into it, and the streak's own when it stands alone", () => {
    const events = [
      streakStart(HOLDER, 'f1', { logIndex: 4 }),
      stick(HOLDER, HOLDER, 1n, 'f1', { logIndex: 5 }),
      streakEnd(RECIPIENT, 60n, 'f1', { logIndex: 7 }),
    ]

    expect(feedRows(events, new Map(), options).map(({ line, logIndex }) => [line.kind, logIndex])).toEqual([
      ['cameUnstuck', 7],
      ['stuck', 5],
    ])
  })

  it('keeps the log index of a Bendystraw pay or cash out on the row it makes', () => {
    const moves = [
      indexedStick(HOLDER, HOLDER, 5n, 50n, tx('f2'), { logIndex: 31 }),
      indexedCashOut(HOLDER, 4n, 40n, tx('f2'), { logIndex: 38 }),
    ]

    expect(feedRows(moveEvents(moves), moveAmounts(moves), options).map(({ logIndex }) => logIndex)).toEqual([38, 31])
  })
})

describe('a folded streak', () => {
  it("is typed by the line it is on: a start on a stick, an end on an unstick", () => {
    // tsc checks these directives: an unused one is an error, so the types cannot allow what they name.
    const lines: FeedLine[] = [
      { kind: 'stuck', holder: HOLDER, streak: 'started' },
      { kind: 'autoStuck', holder: HOLDER, streak: 'started' },
      { kind: 'gift', holder: HOLDER, payer: FUNDER, streak: 'started' },
      { kind: 'unstuck', holder: HOLDER, streak: { endedAfter: 1n } },
      { kind: 'removed', holder: HOLDER, streak: { endedAfter: 1n } },
      // @ts-expect-error a stick cannot have ended a streak
      { kind: 'stuck', holder: HOLDER, streak: { endedAfter: 1n } },
      // @ts-expect-error nor an autoStuck
      { kind: 'autoStuck', holder: HOLDER, streak: { endedAfter: 1n } },
      // @ts-expect-error nor a gift
      { kind: 'gift', holder: HOLDER, payer: FUNDER, streak: { endedAfter: 1n } },
      // @ts-expect-error an unstick cannot have started one
      { kind: 'unstuck', holder: HOLDER, streak: 'started' },
      // @ts-expect-error nor a removal
      { kind: 'removed', holder: HOLDER, streak: 'started' },
      // @ts-expect-error a streak alone has no streak to fold
      { kind: 'gotSticky', holder: HOLDER, streak: 'started' },
    ]
    expect(lines).toHaveLength(11)
  })

  it('only ever comes out of feedRows as a start on a stick and an end on an unstick', async () => {
    const events = [
      streakEnd(HOLDER, 500n, 'f3', { logIndex: 1 }),
      unstick(HOLDER, 1n, 0n, 'f3', { logIndex: 2 }),
      streakStart(HOLDER, 'f3', { logIndex: 3 }),
      stick(HOLDER, HOLDER, 2n, 'f3', { logIndex: 4 }),
      streakStart(RECIPIENT, 'f4', { logIndex: 5 }),
      stick(RECIPIENT, FUNDER, 2n, 'f4', { logIndex: 6 }),
    ]

    const lines = (await rowsFor(events)).map(({ line }) => line)

    expect(lines.map(line => ('streak' in line ? [line.kind, line.streak] : [line.kind]))).toEqual([
      ['gift', 'started'],
      ['stuck', 'started'],
      ['removed', { endedAfter: 500n }],
    ])
  })
})

describe('airdrops', () => {
  it("are the sticks someone else paid for, newest first, without the auto-stick adapter's compounding", async () => {
    const feed = { ...options, adapter: ADAPTER }
    const events = [
      stick(HOLDER, HOLDER, 1n, 'd0'),
      stick(RECIPIENT, FUNDER, 5n * E18, 'd1', { blockNumber: 0x12n }),
      stick(HOLDER, ADAPTER.toLowerCase() as Address, 2n, 'd2'),
      unstick(HOLDER, 1n, 0n, 'd3'),
      stick(HOLDER, RECIPIENT, 7n * E18, 'd4', { blockNumber: 0x14n }),
    ]
    const moves = await terminalMoves(events, readers({ terminal: [payLog(RECIPIENT, 5n * E6, 5n * E18, tx('d1'))] }))

    expect(airdropRows(events, moves, feed)).toStrictEqual([
      row('d4', 'in', shares(7n * E18), { kind: 'gift', holder: HOLDER, payer: RECIPIENT }),
      row('d1', 'in', slop(5n * E6), { kind: 'gift', holder: RECIPIENT, payer: FUNDER }),
    ])
    expect(airdropEvents(events, feed)).toEqual([events[1], events[4]])
  })

  it("count a transfer's stake, which its sender paid for, with its Sticky token count", async () => {
    const events = [
      unstick(HOLDER, 10n * E18, 0n, 'd5', { logIndex: 1 }),
      stick(RECIPIENT, HOLDER, 10n * E18, 'd5', { logIndex: 2 }),
    ]

    expect(airdropRows(events, await terminalMoves(events, readers()), options)).toStrictEqual([
      row('d5', 'in', shares(10n * E18), { kind: 'gift', holder: RECIPIENT, payer: HOLDER }, { logIndex: 2 }),
    ])
  })

  it('are their sticks only: the streak a gift started stays on the Latest row', () => {
    const events = [
      streakStart(RECIPIENT, 'd6', { logIndex: 1 }),
      stick(RECIPIENT, FUNDER, 1n, 'd6', { logIndex: 2 }),
    ]

    expect(airdropRows(events, new Map(), options)).toStrictEqual([
      row('d6', 'in', shares(1n), { kind: 'gift', holder: RECIPIENT, payer: FUNDER }, { logIndex: 2 }),
    ])
    expect(feedRows(events, new Map(), options)).toStrictEqual([
      row(
        'd6',
        'in',
        shares(1n),
        { kind: 'gift', holder: RECIPIENT, payer: FUNDER, streak: 'started' },
        { logIndex: 2 },
      ),
    ])
  })
})

// Until Bendystraw indexes the hook's events, its pays and cash outs are the only indexed source of a feed: a stick is
// a pay, an unstick a cash out, and both amounts are in the rows themselves. These are the old client's
// indexedActivityItems and indexedAirdropItems, which showed the newest 40 events and the newest 40 airdrops.
describe("a feed built from Bendystraw's pays and cash outs", () => {
  const AUTO = `0x${'5'.repeat(40)}` as Address
  /** The old test's beneficiary of a pay that FUNDER made: FUNDER with its first digit changed. */
  const GIVEN = `0xc${'b'.repeat(39)}` as Address
  const USDC = { symbol: 'USDC', stSymbol: 'stUSDC', decimals: 6 }
  const feed: FeedOptions = { adapter: AUTO, tokens: () => USDC }
  const usdc = (value: bigint): FeedAmount => ({ value, decimals: 6, symbol: 'USDC' })
  const on84532 = { chainId: 84532, projectId: 37n }
  const at = (timestamp: number, logIndex = 1) => ({ ...on84532, timestamp, logIndex })
  /** The feed a home page shows for a chain's moves: the newest window of events, and of airdrops. */
  const homeFeed = (moves: IndexedMove[], forChain: FeedOptions = feed) => {
    const events = moveEvents(moves)
    const amounts = moveAmounts(moves)
    return {
      activity: feedRows(events.slice(-FEED_WINDOW), amounts, forChain),
      airdrops: airdropRows(airdropEvents(events, forChain).slice(-FEED_WINDOW), amounts, forChain),
    }
  }
  const at84532 = (
    short: string,
    timestamp: number,
    direction: FeedRow['direction'],
    amount: FeedAmount,
    line: FeedLine,
  ) => row(short, direction, amount, line, { chainId: 84532, projectId: 37n, timestamp, logIndex: 1 })

  it('lists sticks and unsticks with the underlying amounts, and a stick someone else paid for as an airdrop', () => {
    const pays = [
      indexedStick(HOLDER, HOLDER, 5n, 50n, tx('1'), at(10)),
      indexedStick(GIVEN, FUNDER, 1n, 10n, tx('2'), at(11)),
      indexedStick(FUNDER, FUNDER, 1n, 10n, tx('3'), at(12)),
    ]
    const cashOuts = [indexedCashOut(FUNDER, 1n, 10n, tx('4'), at(13))]

    const { activity, airdrops } = homeFeed([...pays, ...cashOuts])

    expect(activity).toHaveLength(4)
    // Amounts are the underlying tokens: what each pay brought in and each cash out reclaimed, not Sticky tokens.
    expect(activity[0]).toMatchObject({ amount: usdc(1n), direction: 'out', line: { kind: 'unstuck', holder: FUNDER } })
    expect(activity[3]).toMatchObject({ amount: usdc(5n), direction: 'in', line: { kind: 'stuck', holder: HOLDER } })
    expect(airdrops).toHaveLength(1)
    expect(airdrops[0]).toMatchObject({
      amount: usdc(1n),
      direction: 'in',
      line: { kind: 'gift', holder: GIVEN, payer: FUNDER },
    })
    expect(activity).toStrictEqual([
      at84532('4', 13, 'out', usdc(1n), { kind: 'unstuck', holder: FUNDER }),
      at84532('3', 12, 'in', usdc(1n), { kind: 'stuck', holder: FUNDER }),
      at84532('2', 11, 'in', usdc(1n), { kind: 'gift', holder: GIVEN, payer: FUNDER }),
      at84532('1', 10, 'in', usdc(5n), { kind: 'stuck', holder: HOLDER }),
    ])
    expect(airdrops).toStrictEqual([at84532('2', 11, 'in', usdc(1n), { kind: 'gift', holder: GIVEN, payer: FUNDER })])
  })

  it('reads a stick the auto-stick adapter paid as auto-stuck, and leaves it out of the airdrops', () => {
    const moves = [
      indexedStick(HOLDER, AUTO, 3n, 30n, tx('5'), at(20)),
      indexedStick(GIVEN, FUNDER, 1n, 10n, tx('6'), at(21)),
    ]

    const { activity, airdrops } = homeFeed(moves)

    expect(activity.map(({ line }) => line)).toEqual([
      { kind: 'gift', holder: GIVEN, payer: FUNDER },
      { kind: 'autoStuck', holder: HOLDER },
    ])
    expect(airdrops.map(({ line }) => line)).toEqual([{ kind: 'gift', holder: GIVEN, payer: FUNDER }])
    // Where a chain has no adapter, the same stick is a gift from whoever paid.
    expect(homeFeed(moves, { ...feed, adapter: null }).airdrops).toHaveLength(2)
  })

  it('shows the underlying token in its own decimals and symbol, for a stick and for an unstick', () => {
    const moves = [
      indexedStick(HOLDER, HOLDER, 1010n * E6, 1000n * E18, tx('7'), at(30)),
      indexedCashOut(HOLDER, 99n * E6, 100n * E18, tx('8'), at(31)),
    ]

    const { activity } = homeFeed(moves, options)

    expect(activity.map(({ amount }) => amount)).toEqual([slop(99n * E6), slop(1010n * E6)])
  })

  it('shows the newest window of events, and the newest window of airdrops, which reach back further', () => {
    // 50 gifts, then 10 sticks of a holder's own: the newest 40 events are the 10 and the newest 30 gifts, and the
    // newest 40 airdrops are the gifts alone.
    const gifts = Array.from({ length: 50 }, (_, n) => indexedStick(GIVEN, FUNDER, 1n, 10n, tx(`a${n}`), at(100 + n)))
    const own = Array.from({ length: 10 }, (_, n) => indexedStick(HOLDER, HOLDER, 1n, 10n, tx(`b${n}`), at(200 + n)))

    const { activity, airdrops } = homeFeed([...gifts, ...own])

    expect(FEED_WINDOW).toBe(40)
    expect(activity).toHaveLength(FEED_WINDOW)
    expect(activity.map(({ timestamp }) => timestamp)).toEqual([
      ...own.map(({ timestamp }) => timestamp).reverse(),
      ...gifts.slice(-30).map(({ timestamp }) => timestamp).reverse(),
    ])
    expect(airdrops).toHaveLength(FEED_WINDOW)
    const newestGifts = gifts.slice(-FEED_WINDOW).map(({ timestamp }) => timestamp)
    expect(airdrops.map(({ timestamp }) => timestamp)).toEqual(newestGifts.reverse())
  })

  it('leaves out the rows of a project it has no tokens for, as the old client did for another deployer\'s', () => {
    const moves = [
      indexedStick(HOLDER, HOLDER, 1n, 10n, tx('c1'), { ...at(40), projectId: 99n }),
      indexedStick(HOLDER, HOLDER, 2n, 20n, tx('c2'), at(41)),
    ]
    const tokens = (_chainId: number, projectId: bigint) => (projectId === 37n ? USDC : undefined)

    expect(homeFeed(moves, { ...feed, tokens }).activity.map(({ projectId }) => projectId)).toEqual([37n])
  })

  it('has no streak rows, and keeps a pay and a cash out of one holder in one transaction as two rows', () => {
    const moves = [
      indexedCashOut(HOLDER, 4n, 40n, tx('c3'), at(50, 3)),
      indexedStick(HOLDER, HOLDER, 5n, 50n, tx('c3'), at(50, 8)),
    ]

    const { activity } = homeFeed(moves)

    expect(activity.map(({ line, logIndex }) => [line.kind, logIndex])).toEqual([['stuck', 8], ['unstuck', 3]])
  })

  describe('moveEvents', () => {
    it('makes a stick of a pay, with its payer and its shares as the count, and an unstick of a cash out', () => {
      const pay = indexedStick(HOLDER, FUNDER, 5n, 50n, cased('d1'), { ...at(10), logIndex: 4 })
      const cashOut = indexedCashOut(RECIPIENT, 2n, 20n, cased('d2'), { ...at(11), logIndex: 6 })

      expect(moveEvents([pay, cashOut])).toStrictEqual([
        {
          kind: 'stick',
          chainId: 84532,
          projectId: 37n,
          holder: HOLDER,
          payer: FUNDER,
          count: 50n,
          txHash: tx('d1'),
          logIndex: 4,
          blockNumber: null,
          timestamp: 10,
        },
        {
          kind: 'unstick',
          chainId: 84532,
          projectId: 37n,
          holder: RECIPIENT,
          count: 20n,
          txHash: tx('d2'),
          logIndex: 6,
          blockNumber: null,
          timestamp: 11,
        },
      ])
    })

    it('keeps the order it was given, and is empty for no moves', () => {
      const moves = [
        indexedStick(HOLDER, HOLDER, 1n, 1n, tx('d3'), at(9)),
        indexedCashOut(HOLDER, 1n, 1n, tx('d4'), at(3)),
        indexedStick(HOLDER, HOLDER, 1n, 1n, tx('d5'), at(7)),
      ]

      expect(moveEvents(moves).map(({ txHash }) => txHash)).toEqual([tx('d3'), tx('d4'), tx('d5')])
      expect(moveEvents([])).toEqual([])
    })

    it('makes events that terminalMoves asks Bendystraw about, since they have no block', async () => {
      const moves = [indexedStick(HOLDER, HOLDER, 5n, 50n, tx('d6'), at(60))]
      const reads = readers({ moves })

      await terminalMoves(moveEvents(moves), reads)

      expect(reads.indexedMoves).toHaveBeenCalledWith(84532, [37n], undefined, 60)
      expect(reads.scan).not.toHaveBeenCalled()
    })
  })

  describe('moveAmounts', () => {
    it('gives each pay and cash out its amount under the key of the event moveEvents makes of it', () => {
      const moves = [
        indexedStick(HOLDER, FUNDER, 5n, 50n, cased('e1'), at(10)),
        indexedCashOut(HOLDER, 2n, 20n, cased('e2'), at(11)),
      ]

      const amounts = moveAmounts(moves)

      expect(amounts.size).toBe(2)
      const [stickEvent, unstickEvent] = moveEvents(moves)
      expect(amounts.get(moveKey({ ...stickEvent, kind: 'stick', count: 50n }))).toBe(5n)
      expect(amounts.get(moveKey({ ...unstickEvent, kind: 'unstick', count: 20n }))).toBe(2n)
    })

    it('is the map terminalMoves reads from Bendystraw for the same rows', async () => {
      const moves = [
        indexedStick(HOLDER, FUNDER, 5n, 50n, tx('e3'), at(10)),
        indexedCashOut(HOLDER, 2n, 20n, tx('e4'), at(11)),
      ]

      expect(await terminalMoves(moveEvents(moves), readers({ moves }))).toEqual(moveAmounts(moves))
    })
  })
})

describe('moveKey', () => {
  const base = { chainId: CHAIN, txHash: tx('a1'), kind: 'stick', projectId: 42n, holder: HOLDER, count: 5n } as const

  it('is the same for a transaction and a holder in any case', () => {
    const shouted = `0x${HOLDER.slice(2).toUpperCase()}` as Address
    expect(moveKey({ ...base, txHash: cased('a1'), holder: shouted })).toBe(moveKey(base))
  })

  it.each([
    ['chain', { chainId: 10 }],
    ['transaction', { txHash: tx('a2') }],
    ['kind', { kind: 'unstick' }],
    ['project', { projectId: 43n }],
    ['holder', { holder: RECIPIENT }],
    ['share count', { count: 6n }],
  ] as const)('is not the same when the %s is not', (_field, change) => {
    expect(moveKey({ ...base, ...change })).not.toBe(moveKey(base))
  })
})

describe('terminalMoves', () => {
  it("reads no amount from the terminal's fees or additions to a balance", async () => {
    // ProcessFee(projectId, token, amount indexed; wasHeld, beneficiary, caller) and AddToBalance(projectId indexed;
    // amount, returnedFees, memo, metadata, caller), in the unstick's own transaction.
    const fee = raw(
      ['0xb514e730b3f8ad3aa94b6857bcc5ff4a46954bdcf8c4b0346705b1d0ac7a4325', topic(42n), topic(HOLDER), topic(E6)],
      words(false, HOLDER, HOLDER),
      { address: TERMINAL, txHash: tx('g1') },
    )
    const added = raw(
      ['0x9ecaf7fc3dfffd6867c175d6e684b1f1e3aef019398ba8db2c1ffab4a09db253', topic(42n)],
      words(E6, 0n, 160n, 192n, HOLDER, 0n, 0n),
      { address: TERMINAL, txHash: tx('g1') },
    )

    const moves = await terminalMoves([unstick(HOLDER, 5n * E18, 0n, 'g1')], readers({ terminal: [fee, added] }))

    expect(moves.size).toBe(0)
  })

  it("reads Bendystraw's pays and cash outs for the events Bendystraw indexed, and scans nothing", async () => {
    const events = [
      stick(HOLDER, HOLDER, 1000n * E18, 'a1', { blockNumber: null, timestamp: 100 }),
      unstick(HOLDER, 100n * E18, 900n * E18, 'a3', { blockNumber: null, timestamp: 120 }),
      stick(RECIPIENT, FUNDER, 5n * E18, 'a2', { blockNumber: null, timestamp: 90 }),
      // A project is asked about once, however many of its events there are.
      stick(RECIPIENT, FUNDER, 1n, 'a4', { blockNumber: null, timestamp: 95 }),
    ]
    const reads = readers({
      moves: [
        indexedStick(HOLDER, HOLDER, 1010n * E6, 1000n * E18, cased('a1')),
        indexedCashOut(HOLDER, 99n * E6, 100n * E18, tx('a3')),
        indexedStick(RECIPIENT, FUNDER, 5n * E6, 5n * E18, tx('a2')),
        // A pay for another project, and one that no event here is for.
        indexedStick(HOLDER, HOLDER, 8n * E6, 1000n * E18, tx('a1'), { projectId: 43n }),
        indexedStick(HOLDER, HOLDER, 9n * E6, 999n * E18, tx('a1')),
      ],
    })
    const { signal } = new AbortController()

    const moves = await terminalMoves(events, { ...reads, signal })

    // The read starts at the time of the oldest event, the one at 90, so it reads no older pay or cash out.
    expect(reads.indexedMoves).toHaveBeenCalledTimes(1)
    expect(reads.indexedMoves).toHaveBeenCalledWith(CHAIN, [42n], signal, 90)
    expect(reads.scan).not.toHaveBeenCalled()
    expect(feedRows(events, moves, options).map(({ amount }) => amount)).toEqual([
      shares(1n),
      slop(5n * E6),
      slop(99n * E6),
      slop(1010n * E6),
    ])
  })

  it("starts Bendystraw's read at each chain's oldest indexed event, not at one a scan found", async () => {
    const events = [
      stick(HOLDER, HOLDER, 1n, 'a1', { chainId: 8453, blockNumber: null, timestamp: 500 }),
      stick(HOLDER, HOLDER, 1n, 'a2', { chainId: 8453, blockNumber: null, timestamp: 700 }),
      // Found by a scan, and older than both: the terminal is read for it, and it does not move the time back.
      stick(HOLDER, HOLDER, 1n, 'a3', { chainId: 8453, blockNumber: 900n, timestamp: 100 }),
      stick(HOLDER, HOLDER, 1n, 'a4', { chainId: 10, blockNumber: null, timestamp: 300 }),
    ]
    const reads = readers()

    await terminalMoves(events, reads)

    expect(reads.indexedMoves.mock.calls.map(([chainId, , , since]) => [chainId, since])).toEqual([
      [8453, 500],
      [10, 300],
    ])
  })

  it('asks Bendystraw about the events it indexed and the terminal, from its oldest block, for the rest', async () => {
    const events = [
      // Bendystraw's rows carry no block number and a scan's do: the scan starts at the oldest of the scan's own.
      stick(HOLDER, HOLDER, 1n * E18, 'a1', { blockNumber: null }),
      stick(HOLDER, HOLDER, 2n * E18, 'a2', { blockNumber: 900n }),
      unstick(HOLDER, 1n * E18, 1n * E18, 'a3', { blockNumber: 850n }),
      stick(RECIPIENT, RECIPIENT, 3n * E18, 'a4', { blockNumber: 1_000n, projectId: 44n }),
    ]
    const reads = readers({
      moves: [indexedStick(HOLDER, HOLDER, 11n * E6, 1n * E18, tx('a1'))],
      terminal: [
        payLog(HOLDER, 12n * E6, 2n * E18, tx('a2')),
        cashOutLog(HOLDER, 1n * E18, 10n * E6, tx('a3')),
        payLog(RECIPIENT, 13n * E6, 3n * E18, tx('a4'), 44n),
      ],
    })
    const { signal } = new AbortController()

    const moves = await terminalMoves(events, { ...reads, signal })

    expect(reads.indexedMoves).toHaveBeenCalledWith(CHAIN, [42n], signal, 100)
    expect(reads.scan).toHaveBeenCalledTimes(1)
    expect(reads.scan).toHaveBeenCalledWith(
      CHAIN,
      { address: TERMINAL, topics: [[PAY, CASH_OUT], null, null, [topic(42n), topic(44n)]], fromBlock: 850n },
      { signal },
    )
    expect(feedRows(events, moves, options).map(({ amount }) => amount?.value)).toEqual([
      13n * E6,
      10n * E6,
      12n * E6,
      11n * E6,
    ])
  })

  it('gives the events Bendystraw indexed Sticky token counts when it cannot answer, and scans for none', async () => {
    const events = [stick(HOLDER, HOLDER, 3n * E18, 'a1', { blockNumber: null })]
    const down = new Error('Bendystraw timed out')
    const reads = readers({ moves: down })

    expect(feedRows(events, await terminalMoves(events, reads), options)).toStrictEqual([
      row('a1', 'in', shares(3n * E18), { kind: 'stuck', holder: HOLDER }),
    ])
    expect(reads.scan).not.toHaveBeenCalled()
    expect(vi.mocked(console.warn).mock.calls).toEqual([[LABEL, { chainId: CHAIN }, down]])
  })

  it("reads each source on its own: one failing leaves the other's amounts", async () => {
    const events = [
      stick(HOLDER, HOLDER, 1n * E18, 'a1', { blockNumber: null }),
      stick(HOLDER, HOLDER, 2n * E18, 'a2', { blockNumber: 900n }),
    ]
    const indexed = [indexedStick(HOLDER, HOLDER, 11n * E6, 1n * E18, tx('a1'))]
    const scanned = [payLog(HOLDER, 12n * E6, 2n * E18, tx('a2'))]

    const noIndex = await terminalMoves(events, readers({ moves: new Error('down'), terminal: scanned }))
    const noChain = await terminalMoves(events, readers({ moves: indexed, terminal: new Error('429') }))

    expect([...noIndex.values()]).toEqual([12n * E6])
    expect([...noChain.values()]).toEqual([11n * E6])
  })

  it("reads one chain after another, and each chain's own terminal", async () => {
    const events = [
      stick(HOLDER, HOLDER, 1n, 'a1', { chainId: 8453, blockNumber: null }),
      stick(HOLDER, HOLDER, 1n, 'a2', { chainId: 10, blockNumber: 500n }),
      stick(HOLDER, HOLDER, 1n, 'a3', { chainId: 42161, blockNumber: null }),
    ]
    let running = 0
    let overlapped = false
    const slow = async () => {
      running += 1
      overlapped ||= running > 1
      await new Promise(resolve => setTimeout(resolve, 5))
      running -= 1
      return []
    }
    const order: string[] = []
    const reads: MoveReaders = {
      indexedMoves: async chainId => {
        order.push(`bendystraw ${chainId}`)
        return slow()
      },
      scan: async (chainId, { address, fromBlock }) => {
        order.push(`terminal ${chainId} ${address} from ${fromBlock}`)
        return slow()
      },
    }

    await terminalMoves(events, reads)

    expect(overlapped).toBe(false)
    expect(order).toEqual(['bendystraw 8453', `terminal 10 ${TERMINAL} from 500`, 'bendystraw 42161'])
  })

  it('reads nothing when no event moved shares', async () => {
    const events = [streakStart(HOLDER, 'a1'), streakEnd(HOLDER, 1n, 'a2')]
    const reads = readers()

    expect((await terminalMoves(events, reads)).size).toBe(0)
    expect((await terminalMoves([], reads)).size).toBe(0)
    expect(reads.scan).not.toHaveBeenCalled()
    expect(reads.indexedMoves).not.toHaveBeenCalled()
  })

  it("rejects with the caller's reason, and reads no more, once the caller has cancelled", async () => {
    const events = [
      stick(HOLDER, HOLDER, 1n, 'a1', { chainId: 8453, blockNumber: null }),
      stick(HOLDER, HOLDER, 1n, 'a2', { chainId: 10, blockNumber: null }),
    ]
    const reason = new Error('navigated away')

    // Cancelled before the call.
    const before = new AbortController()
    before.abort(reason)
    const first = readers()
    await expect(terminalMoves(events, { ...first, signal: before.signal })).rejects.toBe(reason)
    expect(first.indexedMoves).not.toHaveBeenCalled()

    // Cancelled while a read is under way: the failure it ends in is the cancel, not a reason to show counts.
    const during = new AbortController()
    const second = readers()
    second.indexedMoves.mockImplementation(async () => {
      during.abort(reason)
      throw new Error('aborted')
    })
    await expect(terminalMoves(events, { ...second, signal: during.signal })).rejects.toBe(reason)
    expect(second.indexedMoves).toHaveBeenCalledTimes(1)
    expect(console.warn).not.toHaveBeenCalled()

    // Cancelled while the terminal scan is under way.
    const scanning = new AbortController()
    const third = readers()
    third.scan.mockImplementation(async () => {
      scanning.abort(reason)
      throw new Error('aborted')
    })
    const tail = [stick(HOLDER, HOLDER, 1n, 'a1', { blockNumber: 5n })]
    await expect(terminalMoves(tail, { ...third, signal: scanning.signal })).rejects.toBe(reason)
    expect(console.warn).not.toHaveBeenCalled()
  })
})
