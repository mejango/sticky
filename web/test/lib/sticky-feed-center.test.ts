import { encodeAbiParameters, parseAbiParameters, toHex, type Address, type Hex, type PublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScannedLog } from '@/lib/hook-logs'
import type { StickyEvent } from '@/lib/sticky-events'
import { feedRows, terminalMoves, type FeedOptions } from '@/lib/sticky-feed'
import type { IndexedMove } from '@/lib/sticky-indexed'
import { CHAIN, HOLDER, deployment, raw, topic, words } from './sticky-log-fixtures'

// The reads sticky-feed makes when a caller gives it none: Bendystraw's pays and cash outs, and Center through the
// log scanner, which runs for real here. Center is a fake client that answers from a list of logs.

const center = vi.hoisted(() => ({ client: vi.fn() }))
vi.mock('@/lib/jbcenter-rpc', () => ({ jbCenterPublicClient: center.client }))
const bendystraw = vi.hoisted(() => ({ moves: vi.fn() }))
vi.mock('@/lib/sticky-indexed', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-indexed')>()),
  indexedStickyMoves: bendystraw.moves,
}))

const TERMINAL = deployment.terminal
const PAY = '0x133161f1c9161488f777ab9a26aae91d47c0d9a3fafb398960f138db02c73797'
const CASH_OUT = '0xfaf1d4bf1b08470c7ed8c351c5065f51af70b36b237723173f898453b9724142'
const FUNDER = `0x${'b'.repeat(40)}` as Address
const E18 = 10n ** 18n
const E6 = 10n ** 6n
const TOKENS = { symbol: 'SLOPSHOP', stSymbol: 'STICKYSLOPSHOP', decimals: 6 }
const options: FeedOptions = { adapter: null, tokens: () => TOKENS }
const tx = (short: string) => `0x${short.padStart(64, '0')}` as Hex

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

function matches(entry: ScannedLog, { address, topics, fromBlock, toBlock }: Filter): boolean {
  const inRange = entry.blockNumber >= BigInt(fromBlock) && entry.blockNumber <= BigInt(toBlock)
  const topicsMatch = topics.every(
    (wanted, i) =>
      wanted === null || (Array.isArray(wanted) ? wanted.includes(entry.topics[i]!) : wanted === entry.topics[i]),
  )
  return entry.address.toLowerCase() === address.toLowerCase() && inRange && topicsMatch
}

/** Center, as the one client every chain read goes through. `requests` lists each eth_getLogs filter sent. */
function node(head: bigint, logs: ScannedLog[] = []) {
  const requests: Filter[] = []
  const client = {
    getBlockNumber: vi.fn(async () => head),
    request: vi.fn(async ({ method, params }: { method: string; params: [Filter] }, _options?: unknown) => {
      if (method !== 'eth_getLogs') throw new Error(`unexpected ${method}`)
      requests.push(params[0])
      return logs.filter(entry => matches(entry, params[0])).map(rpcLog)
    }),
  }
  center.client.mockReturnValue(client as unknown as PublicClient)
  return { ...client, requests }
}

const payLog = (beneficiary: Address, amount: bigint, count: bigint, short: string, block: bigint) =>
  raw([PAY, topic(1n), topic(1n), topic(42n)], words(FUNDER, beneficiary, amount, count, 224n, 256n, FUNDER, 0n, 0n), {
    address: TERMINAL,
    txHash: tx(short),
    blockNumber: block,
  })
const cashOutLog = (holder: Address, count: bigint, reclaim: bigint, short: string, block: bigint) =>
  raw([CASH_OUT, topic(1n), topic(1n), topic(42n)], words(holder, holder, count, 0n, reclaim, 224n, holder, 0n), {
    address: TERMINAL,
    txHash: tx(short),
    blockNumber: block,
  })

const stick = (count: bigint, short: string, blockNumber: bigint | null): StickyEvent => ({
  kind: 'stick',
  chainId: CHAIN,
  projectId: 42n,
  holder: HOLDER,
  payer: HOLDER,
  count,
  balance: count,
  txHash: tx(short),
  logIndex: 0,
  blockNumber,
  timestamp: 100,
})
const unstick = (count: bigint, short: string, blockNumber: bigint | null): StickyEvent => ({
  kind: 'unstick',
  chainId: CHAIN,
  projectId: 42n,
  holder: HOLDER,
  count,
  balance: 0n,
  txHash: tx(short),
  logIndex: 0,
  blockNumber,
  timestamp: 100,
})
const indexedStick = (amount: bigint, tokens: bigint, short: string): IndexedMove => ({
  kind: 'stick',
  chainId: CHAIN,
  projectId: 42n,
  txHash: tx(short),
  logIndex: 0,
  timestamp: 100,
  holder: HOLDER,
  payer: HOLDER,
  amount,
  tokens,
})

beforeEach(() => {
  for (const mock of [center.client, bendystraw.moves]) mock.mockReset()
  // Each test starts with nothing kept in this browser.
  localStorage.clear()
  // A read that fails tells the console why; sticky-feed.test.ts checks what it says.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('terminalMoves through Center', () => {
  it("scans the terminal for the shown projects' pays and cash outs, from the oldest block to the head", async () => {
    const chain = node(1_200n, [
      payLog(HOLDER, 1010n * E6, 1000n * E18, 'a1', 1_000n),
      cashOutLog(HOLDER, 100n * E18, 99n * E6, 'a2', 1_100n),
      // Before the scan starts, and another contract's.
      payLog(HOLDER, 5n * E6, 5n * E18, 'a0', 999n),
      { ...payLog(HOLDER, 6n * E6, 6n * E18, 'a3', 1_100n), address: HOLDER },
    ])
    const events = [stick(1000n * E18, 'a1', 1_000n), unstick(100n * E18, 'a2', 1_100n)]
    const { signal } = new AbortController()

    const moves = await terminalMoves(events, { signal })

    expect(bendystraw.moves).not.toHaveBeenCalled()
    expect(center.client).toHaveBeenCalledWith(CHAIN, signal)
    expect(chain.requests).toEqual([
      {
        address: TERMINAL,
        topics: [[PAY, CASH_OUT], null, null, [topic(42n)]],
        fromBlock: toHex(1_000n),
        toBlock: toHex(1_200n),
      },
    ])
    expect(chain.request.mock.calls[0][1]).toEqual({ signal })
    expect(chain.getBlockNumber).toHaveBeenCalledWith({ cacheTime: 0 })
    expect(feedRows(events, moves, options).map(({ amount }) => amount)).toEqual([
      { value: 99n * E6, decimals: 6, symbol: 'SLOPSHOP' },
      { value: 1010n * E6, decimals: 6, symbol: 'SLOPSHOP' },
    ])
  })

  it("asks Bendystraw for the projects' pays and cash outs, with the caller's signal, and not Center", async () => {
    bendystraw.moves.mockResolvedValue({
      rows: [indexedStick(1010n * E6, 1000n * E18, 'a1')],
      blocks: new Map([[CHAIN, 1n]]),
    })
    const events = [stick(1000n * E18, 'a1', null)]
    const { signal } = new AbortController()

    const moves = await terminalMoves(events, { signal })

    // From the time of the oldest event, 100 in these tests, so no older pay or cash out is read.
    expect(bendystraw.moves).toHaveBeenCalledWith(CHAIN, [42n], signal, 100)
    expect(center.client).not.toHaveBeenCalled()
    expect([...moves.values()]).toEqual([1010n * E6])
  })

  it('reads both for a list that has both', async () => {
    bendystraw.moves.mockResolvedValue({
      rows: [indexedStick(11n * E6, 1n * E18, 'a1')],
      blocks: new Map([[CHAIN, 1n]]),
    })
    const chain = node(2_000n, [payLog(HOLDER, 12n * E6, 2n * E18, 'a2', 1_900n)])
    const events = [stick(1n * E18, 'a1', null), stick(2n * E18, 'a2', 1_900n)]

    const moves = await terminalMoves(events)

    expect([...moves.values()]).toEqual([11n * E6, 12n * E6])
    expect(chain.requests).toEqual([
      {
        address: TERMINAL,
        topics: [[PAY, CASH_OUT], null, null, [topic(42n)]],
        fromBlock: toHex(1_900n),
        toBlock: toHex(2_000n),
      },
    ])
  })

  it('keeps Sticky token counts, and tells the console, when Center cannot answer', async () => {
    const failure = new Error('HTTP request failed.')
    const chain = node(1_200n)
    chain.request.mockRejectedValue(failure)
    const events = [stick(3n * E18, 'a1', 1_000n)]

    const rows = feedRows(events, await terminalMoves(events), options)

    expect(rows.map(({ amount }) => amount)).toEqual([{ value: 3n * E18, decimals: 18, symbol: 'STICKYSLOPSHOP' }])
    expect(vi.mocked(console.warn).mock.calls).toEqual([
      ['Could not read stick and unstick amounts; showing Sticky token counts.', { chainId: CHAIN }, failure],
    ])
  })

  it("stops with the caller's reason when the caller cancels while Center is asked for the head", async () => {
    const reason = new Error('navigated away')
    const chain = node(1_200n)
    chain.getBlockNumber.mockImplementation(() => new Promise<bigint>(() => {}))
    const controller = new AbortController()
    const pending = terminalMoves([stick(1n, 'a1', 1_000n)], { signal: controller.signal })

    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
    expect(chain.request).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
  })
})

describe('the terminal history terminalMoves keeps in the browser', () => {
  const key = (projectId: bigint) => `sticky.history.v1:${CHAIN}:${TERMINAL.toLowerCase()}:${projectId}:feed`
  const kept = (projectId: bigint) =>
    JSON.parse(localStorage.getItem(key(projectId)) ?? 'null') as { from: string; through: string; all: { data: Hex; blockNumber: Hex }[] } | null
  /** A pay of project `projectId`, with a memo and metadata as long as the payer likes. */
  const memoPay = (amount: bigint, count: bigint, short: string, block: bigint, memo: string, metadata: Hex, projectId = 42n) =>
    raw(
      [PAY, topic(1n), topic(1n), topic(projectId)],
      encodeAbiParameters(parseAbiParameters('address, address, uint256, uint256, string, bytes, address'), [
        FUNDER,
        HOLDER,
        amount,
        count,
        memo,
        metadata,
        FUNDER,
      ]),
      { address: TERMINAL, txHash: tx(short), blockNumber: block },
    )
  const of = (projectId: bigint, event: StickyEvent): StickyEvent => ({ ...event, projectId })
  const amountsOf = (moves: Map<string, bigint>) => [...moves.values()]

  it('scans only the blocks after what it kept on the next refresh, where it scanned the whole window before', async () => {
    // A project three days old on Base: its oldest shown event is 131,000 blocks below the head, 263 windows of 500.
    const pays = [payLog(HOLDER, 10n * E6, 10n * E18, 'a1', 1_000n), payLog(HOLDER, 20n * E6, 20n * E18, 'a2', 100_000n)]
    const events = [stick(10n * E18, 'a1', 1_000n), stick(20n * E18, 'a2', 100_000n)]
    const first = node(132_000n, pays)
    expect(amountsOf(await terminalMoves(events))).toEqual([10n * E6, 20n * E6])
    expect(first.requests).toHaveLength(263)

    // A stick lands, and the page refreshes Latest: the history kept through 64 blocks below the last head is not
    // asked for again, and the new stick's amount is found.
    const landed = payLog(HOLDER, 5n * E6, 5n * E18, 'a3', 132_010n)
    const refresh = node(132_012n, [...pays, landed])
    const shown = [...events, stick(5n * E18, 'a3', 132_010n)]
    expect(amountsOf(await terminalMoves(shown))).toEqual([10n * E6, 20n * E6, 5n * E6])
    expect(refresh.requests).toEqual([
      {
        address: TERMINAL,
        topics: [[PAY, CASH_OUT], null, null, [topic(42n)]],
        fromBlock: toHex(132_000n - 64n + 1n),
        toBlock: toHex(132_012n),
      },
    ])

    // The refreshes 4 and 12 seconds later each ask for the blocks since the last one's buried block, once more.
    const again = node(132_018n, [...pays, landed])
    expect(amountsOf(await terminalMoves(shown))).toEqual([10n * E6, 20n * E6, 5n * E6])
    expect(again.requests.map(({ fromBlock, toBlock }) => [fromBlock, toBlock])).toEqual([
      [toHex(132_012n - 64n + 1n), toHex(132_018n)],
    ])
  })

  it('scans from the shown events on a return visit long after, not from where the kept history ended', async () => {
    // A visit kept the terminal's history through block 1,136.
    node(1_200n, [payLog(HOLDER, 10n * E6, 10n * E18, 'a1', 1_000n)])
    await terminalMoves([stick(10n * E18, 'a1', 1_000n)])

    // A week later, with Bendystraw back, the only events a scan found are the newest, just below the head.
    const later = node(303_000n, [payLog(HOLDER, 10n * E6, 10n * E18, 'a1', 1_000n), payLog(HOLDER, 3n * E6, 3n * E18, 'b2', 302_950n)])
    expect(amountsOf(await terminalMoves([stick(3n * E18, 'b2', 302_950n)]))).toContain(3n * E6)
    expect(later.requests.map(({ fromBlock, toBlock }) => [fromBlock, toBlock])).toEqual([[toHex(302_950n), toHex(303_000n)]])
    expect(kept(42n)).toMatchObject({ from: '302950', through: String(303_000 - 64) })
  })

  it('keeps its history from the oldest event the feed shows, and drops what is older as the feed moves on', async () => {
    const pays = [payLog(HOLDER, 10n * E6, 10n * E18, 'a1', 1_000n), payLog(HOLDER, 20n * E6, 20n * E18, 'a2', 1_100n)]
    node(1_300n, pays)
    await terminalMoves([stick(10n * E18, 'a1', 1_000n), stick(20n * E18, 'a2', 1_100n)])
    expect(kept(42n)).toMatchObject({ from: '1000', through: String(1_300 - 64) })
    expect(kept(42n)!.all.map(log => BigInt(log.blockNumber))).toEqual([1_000n, 1_100n])

    // A newer stick pushes the oldest out of the feed: the history starts at the oldest event the feed shows now.
    const landed = payLog(HOLDER, 5n * E6, 5n * E18, 'a3', 1_250n)
    const refresh = node(1_400n, [...pays, landed])
    const moves = await terminalMoves([stick(20n * E18, 'a2', 1_100n), stick(5n * E18, 'a3', 1_250n)])
    expect(amountsOf(moves)).toEqual(expect.arrayContaining([20n * E6, 5n * E6]))
    expect(refresh.requests.map(({ fromBlock }) => fromBlock)).toEqual([toHex(1_300n - 64n + 1n)])
    expect(kept(42n)).toMatchObject({ from: '1100', through: String(1_400 - 64) })
    expect(kept(42n)!.all.map(log => BigInt(log.blockNumber))).toEqual([1_100n, 1_250n])
  })

  it('keeps what a reorg cannot replace, 64 blocks below the head, and only that, with the block it scanned from', async () => {
    node(1_200n, [payLog(HOLDER, 10n * E6, 10n * E18, 'a1', 1_000n), payLog(HOLDER, 20n * E6, 20n * E18, 'a2', 1_150n)])
    await terminalMoves([stick(10n * E18, 'a1', 1_000n), stick(20n * E18, 'a2', 1_150n)])

    const history = kept(42n)!
    expect(history).toMatchObject({ from: '1000', through: String(1_200 - 64) })
    // The pay at 1,150 is within 64 blocks of the head: it is read, and not kept.
    expect(history.all.map(log => BigInt(log.blockNumber))).toEqual([1_000n])
  })

  it('keeps each project under a key of its own, which one scan of them all writes, and no key for the set', async () => {
    const pays = [payLog(HOLDER, 10n * E6, 10n * E18, 'a1', 1_000n), { ...payLog(HOLDER, 7n * E6, 7n * E18, 'b1', 1_010n), topics: [PAY, topic(1n), topic(1n), topic(43n)] as ScannedLog['topics'] }]
    const events = [stick(10n * E18, 'a1', 1_000n), of(43n, stick(7n * E18, 'b1', 1_010n))]
    const chain = node(1_200n, pays)

    const moves = await terminalMoves(events)

    expect(chain.requests).toHaveLength(1)
    expect(chain.requests[0].topics).toEqual([[PAY, CASH_OUT], null, null, [topic(42n), topic(43n)]])
    expect(amountsOf(moves)).toEqual([10n * E6, 7n * E6])
    expect(localStorage.length).toBe(2)
    expect(kept(42n)!.all).toHaveLength(1)
    expect(kept(43n)!.all).toHaveLength(1)

    // The project's own page later reads the history the two-project scan kept, and asks only for the blocks after it.
    const page = node(1_300n, pays)
    expect(amountsOf(await terminalMoves([of(43n, stick(7n * E18, 'b1', 1_010n))]))).toEqual([7n * E6])
    expect(page.requests.map(({ fromBlock }) => fromBlock)).toEqual([toHex(1_200n - 64n + 1n)])
  })

  it("scans from the oldest shown event again when that is older than what it kept began at", async () => {
    const pays = [payLog(HOLDER, 10n * E6, 10n * E18, 'a1', 1_000n), payLog(HOLDER, 20n * E6, 20n * E18, 'a2', 1_100n)]
    node(1_300n, pays)
    await terminalMoves([stick(20n * E18, 'a2', 1_100n)])
    expect(kept(42n)).toMatchObject({ from: '1100' })

    // Another page shows an older stick of the project: the kept history lacks it, so the scan starts there.
    const older = node(1_300n, pays)
    expect(amountsOf(await terminalMoves([stick(10n * E18, 'a1', 1_000n), stick(20n * E18, 'a2', 1_100n)]))).toEqual([
      10n * E6,
      20n * E6,
    ])
    expect(older.requests.map(({ fromBlock }) => fromBlock)).toEqual([toHex(1_000n)])
    expect(kept(42n)).toMatchObject({ from: '1000' })
  })

  it("keeps a pay without its memo and metadata, and reads the pay's amount from what it kept", async () => {
    // Anyone may pay a project with a memo as long as they like.
    const memo = 'x'.repeat(300_000)
    const pay = memoPay(10n * E6, 10n * E18, 'a1', 1_000n, memo, `0x${'ab'.repeat(1_000)}`)
    node(1_200n, [pay])
    expect(amountsOf(await terminalMoves([stick(10n * E18, 'a1', 1_000n)]))).toEqual([10n * E6])

    const history = localStorage.getItem(key(42n))!
    expect(history.length).toBeLessThan(2_000)
    const [log] = kept(42n)!.all
    expect(log.data).toBe(
      encodeAbiParameters(parseAbiParameters('address, address, uint256, uint256, string, bytes, address'), [
        FUNDER,
        HOLDER,
        10n * E6,
        10n * E18,
        '',
        '0x',
        FUNDER,
      ]),
    )

    // The next refresh finds the amount in what was kept, and does not ask for its block again.
    const refresh = node(1_300n, [pay])
    expect(amountsOf(await terminalMoves([stick(10n * E18, 'a1', 1_000n)]))).toEqual([10n * E6])
    expect(refresh.requests.map(({ fromBlock }) => fromBlock)).toEqual([toHex(1_200n - 64n + 1n)])
  })

  it('keeps a cash out without its metadata, and reads what it paid from what it kept', async () => {
    const cashOut = raw(
      [CASH_OUT, topic(1n), topic(1n), topic(42n)],
      encodeAbiParameters(parseAbiParameters('address, address, uint256, uint256, uint256, bytes, address'), [
        HOLDER,
        HOLDER,
        5n * E18,
        0n,
        4n * E6,
        `0x${'cd'.repeat(50_000)}`,
        HOLDER,
      ]),
      { address: TERMINAL, txHash: tx('c1'), blockNumber: 1_000n },
    )
    node(1_200n, [cashOut])
    await terminalMoves([unstick(5n * E18, 'c1', 1_000n)])
    expect(localStorage.getItem(key(42n))!.length).toBeLessThan(2_000)

    node(1_300n, [cashOut])
    expect(amountsOf(await terminalMoves([unstick(5n * E18, 'c1', 1_000n)]))).toEqual([4n * E6])
  })

  it('keeps no history longer than the hook history may be, 400,000 characters, and still answers', async () => {
    const short = (at: number) => (0x100 + at).toString(16)
    const pays = (count: number) =>
      Array.from({ length: count }, (_, at) => payLog(HOLDER, BigInt(at + 1), BigInt(at + 1), short(at), 1_000n + BigInt(at)))
    const sticks = (count: number) => Array.from({ length: count }, (_, at) => stick(BigInt(at + 1), short(at), 1_000n + BigInt(at)))

    // Three hundred pays fit.
    node(2_000n, pays(300))
    expect((await terminalMoves(sticks(300))).size).toBe(300)
    expect(localStorage.getItem(key(42n))!.length).toBeLessThanOrEqual(400_000)

    // Four hundred do not, even without their memos: none of it is kept, and the amounts are all read.
    localStorage.clear()
    node(2_000n, pays(400))
    expect((await terminalMoves(sticks(400))).size).toBe(400)
    expect(localStorage.getItem(key(42n))).toBeNull()
  })

  it('keeps nothing when the scan fails, and what it had kept stays as it was', async () => {
    const pays = [payLog(HOLDER, 10n * E6, 10n * E18, 'a1', 1_000n)]
    node(1_200n, pays)
    await terminalMoves([stick(10n * E18, 'a1', 1_000n)])
    const before = localStorage.getItem(key(42n))

    const failing = node(1_400n, pays)
    failing.request.mockRejectedValue(new Error('HTTP request failed.'))
    await terminalMoves([stick(10n * E18, 'a1', 1_000n)])
    expect(localStorage.getItem(key(42n))).toBe(before)
  })
})
