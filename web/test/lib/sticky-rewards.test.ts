// @vitest-environment node

// Dates in reward copy are local; pin the zone so the expected dates hold on every machine.
process.env.TZ = 'UTC'

import { erc20Abi, erc20Abi_bytes32, getAbiItem, numberToHex, pad, stringToHex, toEventSelector, type Address } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stickyDistributorAbi, stickyHookAbi, stickyTokenAbi } from '@/lib/sticky-abis'
import { raw, topic, words } from './sticky-log-fixtures'
import {
  CHAIN,
  HEAD,
  HOLDER,
  NOW,
  OTHER,
  PROJECT,
  REVERT,
  STAKED,
  STICKY,
  address,
  blockHex,
  deployment,
  returning,
  rewardChain,
  shape,
} from './sticky-reward-fixtures'

// The reads and the copy of a project's airdrop rewards, ported from the old client's actions.test.cjs. Every read goes
// through the real Center reader against a fake Center (sticky-reward-fixtures.ts), so what these pin down is the
// requests the page makes as well as what it makes of the answers.

const creation = vi.hoisted(() => ({ block: vi.fn() }))
vi.mock('@/lib/sticky-events', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-events')>()),
  projectCreationBlock: creation.block,
}))

// The Center reader is made once per chain, and viem caches the block number for a moment, so each test loads its own copy.
async function load() {
  vi.resetModules()
  return import('@/lib/sticky-rewards')
}

const DISTRIBUTOR = deployment.distributor
const HOOK = deployment.hook
const TOKEN = address('4')
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const HOSTILE = address('8')

/** A round's pot as `rewardRoundOf` returns it: the amount, the snapshot block, what was claimed, the claim deadline
 * (0 for none) and the stake that shares it. */
const round = (amount: bigint, snapshot: number, claimed: bigint, deadline: number, totalStake: bigint) => [
  amount,
  snapshot,
  claimed,
  deadline,
  totalStake,
]

/** The Base Sepolia distributor's clock: round 0 started 2026-09-25 00:19:26 UTC and rounds are a week. */
const CLOCK = { roundDuration: 604_800n, vestingRounds: 4n, start: 1_790_295_566n, round: 2n }

type Chain = ReturnType<typeof rewardChain>

function stockClock(chain: Chain, current = CLOCK.round) {
  chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'ROUND_DURATION', CLOCK.roundDuration)
  chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'VESTING_ROUNDS', CLOCK.vestingRounds)
  chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'STARTING_TIMESTAMP', CLOCK.start)
  chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'currentRound', current)
}

/** A token that names itself as a string, or as the bytes32 that MKR returns. */
function stockToken(chain: Chain, token: Address, symbol = 'ART', decimals = 6, as: 'string' | 'bytes32' = 'string') {
  if (as === 'string') chain.stock(token, erc20Abi, 'symbol', symbol)
  else chain.stock(token, erc20Abi_bytes32, 'symbol', stringToHex(symbol, { size: 32 }))
  chain.stock(token, erc20Abi, 'decimals', decimals)
}

const funded = (groupId: bigint, token: Address | string, amount = 0n) => ({
  groupId,
  token: token.toLowerCase() as Address,
  funded: amount,
})

beforeEach(() => {
  creation.block.mockReset().mockResolvedValue(HEAD - 900n)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('reward groups', () => {
  it('encode and label stake-age windows exactly like the distributor', async () => {
    const r = await load()
    expect(r.groupIdFromWeeks('', '')).toBe(0n)
    expect(r.groupIdFromWeeks('0', '')).toBe(0n)
    expect(r.groupIdFromWeeks('4', '')).toBe(4000n)
    expect(r.groupIdFromWeeks('4', '0')).toBe(4000n)
    expect(r.groupIdFromWeeks('4', '8')).toBe(4008n)
    expect(r.groupIdFromWeeks('520', '520')).toBe(520520n)
    expect(() => r.groupIdFromWeeks('521', '')).toThrow(/520 weeks/)
    expect(() => r.groupIdFromWeeks('0', '4')).toThrow(/minimum of at least 1/)
    expect(() => r.groupIdFromWeeks('8', '4')).toThrow(/at least the minimum/)
    expect(() => r.groupIdFromWeeks('4.5', '')).toThrow(/whole number/)
    expect(() => r.groupIdFromWeeks('-1', '')).toThrow(/whole number/)
    for (const id of [0n, 1000n, 4000n, 4008n, 520000n, 520520n]) expect(r.isValidGroupId(id), String(id)).toBe(true)
    for (const id of [4n, 999n, 8004n, 521000n, 4521n, 1000000n]) expect(r.isValidGroupId(id), String(id)).toBe(false)
    expect(r.groupLabel(0n)).toBe('Everyone')
    expect(r.groupLabel(4000n)).toBe('Staked 4+ weeks')
    expect(r.groupLabel(4008n)).toBe('Staked 4–8 weeks')
    expect(r.groupSentence(0n)).toMatch(/Everyone holding at the round's snapshot/)
    expect(r.groupSentence(1000n)).toMatch(/at least 1 week old/)
    expect(r.groupSentence(4008n)).toMatch(/between 4 weeks and 8 weeks old[\s\S]*forfeit their share/)
    expect(r.groupNote('4', '8').groupId).toBe(4008n)
    expect(r.groupNote('8', '4').text).toMatch(/at least the minimum/)
    expect(r.groupNote('8', '4').groupId).toBeNull()
  })

  it('decode to the windows the SDK decodes them to', async () => {
    const { decodeStickyGroupId } = await import('@bananapus/nana-sdk-core/v6')
    const r = await load()
    for (const id of [1000n, 4000n, 4008n, 520520n]) {
      const { minWeeks, maxWeeks } = r.decodeGroupId(id)
      expect(decodeStickyGroupId(id)).toEqual({ kind: 'tenure', minWeeks: Number(minWeeks), maxWeeks: Number(maxWeeks) })
    }
  })

  it('put a tenure group\'s stake in the epochs its window leaves at the round\'s snapshot', async () => {
    const r = await load()
    // 4 to 8 weeks old at epoch 20: the stake added in epochs 12 through 16.
    expect(r.tenureWindow(4008n, 20n)).toEqual({ hi: 16n, lo: 12n })
    expect(r.tenureWindow(4008n, 10n)).toEqual({ hi: 6n, lo: 2n })
    // A snapshot younger than the maximum age reaches back to the first epoch, and so does a group with no maximum.
    expect(r.tenureWindow(4008n, 6n)).toEqual({ hi: 2n, lo: 0n })
    expect(r.tenureWindow(4000n, 20n)).toEqual({ hi: 16n, lo: 0n })
    expect(r.tenureWindow(4000n, 4n)).toEqual({ hi: 0n, lo: 0n })
    // A snapshot younger than the minimum age has no eligible stake.
    expect(r.tenureWindow(4000n, 3n)).toBeNull()
    expect(r.tenureWindow(30000n, 20n)).toBeNull()
  })
})

describe('reward copy', () => {
  const schedule = { ...CLOCK }
  const meta = { decimals: 6, symbol: 'ART' }
  const idle = { collectable: 0n, vesting: 0n, earned: 0n, nextUnlockAt: null, unlockedAt: null }

  it('states the round end, the next unlock, the last unlock, and funding by date', async () => {
    const r = await load()
    expect(r.roundSentence(schedule)).toBe(
      `Round 2 ends ${r.dateTimeLabel(r.roundStartOf(schedule, 3n))}. ` +
        'Your share then vests over 4 rounds, a quarter each week, starting when you collect.',
    )
    const card = {
      position: {
        collectable: 1_000_000n,
        vesting: 3_000_000n,
        earned: 2_000_000n,
        nextUnlockAt: r.roundStartOf(schedule, 3n),
        unlockedAt: r.roundStartOf(schedule, 6n),
      },
      meta,
      funded: 30_000_000n,
      fundedThisRound: 10_000_000n,
      schedule,
    }
    const lines = Object.fromEntries(r.rewardLines(card))
    expect(lines['Claimable now']).toBe('1 ART')
    expect(r.dateLabel(r.roundStartOf(schedule, 3n))).toBe('Oct 16')
    expect(r.dateLabel(r.roundStartOf(schedule, 6n))).toBe('Nov 6')
    expect(lines.Vesting).toBe('3 ART. Next unlock Oct 16. All unlocked Nov 6.')
    expect(lines['Earned, not vesting']).toBe(
      'About 2 ART from finished rounds. Collect to start vesting: a quarter unlocks Oct 16, all by Nov 6.',
    )
    expect(lines.Funded).toBe('10 ART this round, splits Oct 16. 30 ART in total.')
    for (const text of Object.values(lines)) expect(text).not.toMatch(/soon|—/)

    const quiet = Object.fromEntries(r.rewardLines({ ...card, position: idle, funded: 0n, fundedThisRound: 0n }))
    expect(quiet.Vesting).toBe('None')
    expect(quiet['Earned, not vesting']).toBeUndefined()
    expect(quiet.Funded).toBe('None this round. 0 ART in total.')
    for (const text of Object.values(quiet)) expect(text).not.toMatch(/soon|—/)
  })

  it('names the last unlock only when it is later than the next, and a schedule that is not weekly or in quarters by its numbers', async () => {
    const r = await load()
    const next = r.roundStartOf(schedule, 3n)
    const vesting = { ...idle, vesting: 5_000_000n, nextUnlockAt: next, unlockedAt: next }
    const one = Object.fromEntries(r.rewardLines({ position: vesting, meta, funded: 0n, fundedThisRound: 0n, schedule }))
    expect(one.Vesting).toBe('5 ART. Next unlock Oct 16.')

    const daily = { ...schedule, roundDuration: 86_400n, vestingRounds: 3n }
    expect(r.roundSentence(daily)).toMatch(/vests over 3 rounds, a 1\/3 each 1d 0h, starting when you collect\.$/)
    const earned = Object.fromEntries(
      r.rewardLines({ position: { ...idle, earned: 1_000_000n }, meta, funded: 0n, fundedThisRound: 0n, schedule: daily }),
    )
    expect(earned['Earned, not vesting']).toMatch(/a share unlocks [A-Z][a-z]{2} \d+, all by [A-Z][a-z]{2} \d+\.$/)
  })
})

describe('the Fund logs', () => {
  const FUND = '0x171d1972970e548ead487a3a60cfbdfffd130a21513e44dfcd8778965935ddf2'
  const fund = (groupId: bigint, token: string, amount: bigint, at: number) =>
    raw([FUND, topic(STICKY), topic(groupId), topic(token)], words(1n, amount, HOLDER), {
      address: DISTRIBUTOR,
      blockNumber: HEAD - 500n + BigInt(at),
    })

  it('are what the old client scanned for: the SDK\'s Fund event has the topic it hard-coded', () => {
    expect(toEventSelector(getAbiItem({ abi: stickyDistributorAbi, name: 'Fund' }) as never)).toBe(FUND)
  })

  it('give one pot per group and token with the lifetime amount, the first funded first, scanned from the project\'s creation block', async () => {
    const chain = rewardChain([fund(4000n, OTHER, 5n, 1), fund(0n, NATIVE, 2n, 2), fund(4000n, OTHER, 6n, 3)])
    const r = await load()

    expect(await r.discoverFunding(CHAIN, STICKY, PROJECT)).toEqual([
      funded(4000n, OTHER, 11n),
      funded(0n, NATIVE, 2n),
    ])

    expect(creation.block).toHaveBeenCalledWith(CHAIN, PROJECT, expect.objectContaining({}))
    const [scan] = chain.requests.filter(request => request.method === 'eth_getLogs')
    expect(scan.block).toMatchObject({
      address: DISTRIBUTOR,
      topics: [FUND, pad(STICKY.toLowerCase() as Address, { size: 32 })],
      fromBlock: `0x${(HEAD - 900n).toString(16)}`,
    })
  })

  it('are scanned from the deployer\'s block, before which no project exists, when the project\'s creation cannot be found', async () => {
    const chain = rewardChain([fund(0n, TOKEN, 3n, 1)])
    creation.block.mockResolvedValue(null)
    const r = await load()

    expect(await r.discoverFunding(CHAIN, STICKY, PROJECT)).toEqual([funded(0n, TOKEN, 3n)])
    const [scan] = chain.requests.filter(request => request.method === 'eth_getLogs')
    expect(scan.block).toMatchObject({ fromBlock: `0x${deployment.fromBlock.toString(16)}` })
  })

  it('give no pots for a project nobody has funded', async () => {
    rewardChain()
    const r = await load()
    expect(await r.discoverFunding(CHAIN, STICKY, PROJECT)).toEqual([])
  })

  it('ignore the funding of another Sticky token', async () => {
    const other = raw([FUND, topic(address('7')), topic(0n), topic(TOKEN)], words(1n, 5n, HOLDER), {
      address: DISTRIBUTOR,
      blockNumber: HEAD - 400n,
    })
    rewardChain([other, fund(0n, TOKEN, 3n, 1)])
    const r = await load()
    expect(await r.discoverFunding(CHAIN, STICKY, PROJECT)).toEqual([funded(0n, TOKEN, 3n)])
  })

  it('reject rather than give part of the list when the project is too old to scan', async () => {
    rewardChain()
    const r = await load()
    creation.block.mockResolvedValue(1n)
    await expect(r.discoverFunding(CHAIN, STICKY, PROJECT)).rejects.toThrow(/more than this RPC can scan/)
  })

  it('show the underlying token under group 0 and every funded group, and tokens checked by hand under each', async () => {
    const r = await load()
    const pots = [funded(4000n, OTHER, 11n), funded(0n, NATIVE, 2n)]

    const { groups, rows } = r.rewardRows(TOKEN, pots)
    expect(groups).toEqual([0n, 4000n])
    expect(rows.map(row => `${row.groupId}:${row.token}:${row.funded}`)).toEqual([
      `4000:${OTHER.toLowerCase()}:11`,
      `0:${NATIVE}:2`,
      `0:${TOKEN.toLowerCase()}:0`,
      `4000:${TOKEN.toLowerCase()}:0`,
    ])

    const checked = r.rewardRows(TOKEN, pots, [address('5'), TOKEN.toUpperCase().replace('0X', '0x') as Address])
    expect(checked.groups).toEqual([0n, 4000n])
    expect(checked.rows.map(row => `${row.groupId}:${row.token}`)).toEqual([
      `4000:${OTHER.toLowerCase()}`,
      `0:${NATIVE}`,
      `0:${TOKEN.toLowerCase()}`,
      `0:${address('5').toLowerCase()}`,
      `4000:${TOKEN.toLowerCase()}`,
      `4000:${address('5').toLowerCase()}`,
    ])
    // With nothing funded, group 0 is still there for the underlying token.
    expect(r.rewardRows(TOKEN, []).rows).toEqual([funded(0n, TOKEN)])
  })
})

describe('what a holder has earned in finished rounds', () => {
  const stockHolder = (chain: Chain, { current = 3n, cursor = 0n } = {}) => {
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'currentRound', current)
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'nextClaimRoundOf', cursor)
  }
  const pot = (groupId = 0n) => [{ groupId, token: TOKEN }]

  it('sums each finished round pro-rata, capped at what the pot still holds', async () => {
    const chain = rewardChain()
    stockHolder(chain)
    // round 0: 1000 pot, 25% of the stake; round 1: 1000 pot but 950 already claimed; round 2: expired.
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'rewardRoundOf', ([, , , at]) =>
      at === 0n
        ? round(1000n, 12, 0n, 0, 100n)
        : at === 1n
          ? round(1000n, 13, 950n, 0, 100n)
          : round(1000n, 14, 0n, NOW - 100, 100n),
    )
    chain.stock(STICKY, stickyTokenAbi, 'getPastVotes', 25n)
    const r = await load()

    expect(await r.earnedRewardsOf(CHAIN, STICKY, HOLDER, pot())).toEqual([250n + 50n])
    // The head block and its time, then the round and the holder's first unresolved one, the three rounds' pots, and
    // the votes at the two snapshots that are still open.
    expect(shape(chain.requests)).toEqual([
      ['eth_getBlockByNumber', undefined, undefined],
      ['eth_call', blockHex, 2],
      ['eth_call', blockHex, 3],
      ['eth_call', blockHex, 2],
    ])
  })

  it('leaves out the current round and an expired one, and weighs the rest by the votes at their snapshot', async () => {
    const chain = rewardChain()
    stockHolder(chain, { cursor: 1n })
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'rewardRoundOf', ([, , , at]) =>
      at === 1n ? round(100n, 12, 0n, NOW - 100, 100n) : round(100n, 13, 0n, 0, 100n),
    )
    chain.stock(STICKY, stickyTokenAbi, 'getPastVotes', 1n)
    const r = await load()

    expect(await r.hasRewardsToVest(CHAIN, STICKY, HOLDER, TOKEN)).toBe(true)

    const reads = chain.reads()
    expect(reads.filter(read => read.functionName === 'rewardRoundOf').map(read => read.args[3])).toEqual([1n, 2n])
    expect(reads.filter(read => read.functionName === 'getPastVotes')).toEqual([
      { target: STICKY, functionName: 'getPastVotes', args: [HOLDER, 13n] },
    ])
  })

  it('finds nothing to vest for a holder with no share, or one who has resolved every finished round', async () => {
    const chain = rewardChain()
    stockHolder(chain, { cursor: 1n })
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'rewardRoundOf', round(100n, 13, 0n, 0, 100n))
    chain.stock(STICKY, stickyTokenAbi, 'getPastVotes', 0n)
    const r = await load()
    expect(await r.hasRewardsToVest(CHAIN, STICKY, HOLDER, TOKEN)).toBe(false)

    const caughtUp = rewardChain()
    stockHolder(caughtUp, { current: 3n, cursor: 3n })
    expect(await r.hasRewardsToVest(CHAIN, STICKY, HOLDER, TOKEN)).toBe(false)
    expect(caughtUp.reads().map(read => read.functionName)).toEqual(['currentRound', 'nextClaimRoundOf'])
  })

  it('for a stake-age group weighs the live in-window stake from the hook, not the votes', async () => {
    const chain = rewardChain()
    stockHolder(chain, { cursor: 2n })
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'rewardRoundOf', round(100n, 12, 0n, 0, 100n))
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'snapshotEpochOf', 20n)
    chain.stock(STICKY, stickyTokenAbi, 'PROJECT_ID', PROJECT)
    chain.stock(HOOK, stickyHookAbi, 'stakedBalanceThroughEpochOf', ([, , epoch]) => (epoch === 16n ? 40n : 10n))
    const r = await load()

    expect(await r.hasRewardsToVest(CHAIN, STICKY, HOLDER, TOKEN, 4008n)).toBe(true)

    const reads = chain.reads()
    expect(reads.find(read => read.functionName === 'nextClaimRoundOf')!.args).toEqual([STICKY, 4008n, BigInt(HOLDER), TOKEN])
    // 4 to 8 weeks old at epoch 20 is the stake added through epoch 16 less the stake added through epoch 11.
    expect(reads.filter(read => read.functionName === 'stakedBalanceThroughEpochOf').map(read => [read.target, read.args])).toEqual([
      [HOOK, [PROJECT, HOLDER, 16n]],
      [HOOK, [PROJECT, HOLDER, 11n]],
    ])
    expect(reads.some(read => read.functionName === 'getPastVotes')).toBe(false)
    expect(await r.earnedRewardsOf(CHAIN, STICKY, HOLDER, pot(4008n))).toEqual([30n])
  })

  it('counts no stake in a stake-age group when the round\'s snapshot is younger than its minimum age', async () => {
    const chain = rewardChain()
    stockHolder(chain, { cursor: 2n })
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'rewardRoundOf', round(100n, 12, 0n, 0, 100n))
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'snapshotEpochOf', 20n)
    chain.stock(STICKY, stickyTokenAbi, 'PROJECT_ID', PROJECT)
    const r = await load()

    expect(await r.hasRewardsToVest(CHAIN, STICKY, HOLDER, TOKEN, 30000n)).toBe(false)
    expect(chain.reads().some(read => read.functionName === 'stakedBalanceThroughEpochOf')).toBe(false)
  })

  it('starts a window at the first epoch when the snapshot is younger than the group\'s maximum age', async () => {
    const chain = rewardChain()
    stockHolder(chain, { cursor: 2n })
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'rewardRoundOf', round(100n, 12, 0n, 0, 100n))
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'snapshotEpochOf', 10n)
    chain.stock(STICKY, stickyTokenAbi, 'PROJECT_ID', PROJECT)
    chain.stock(HOOK, stickyHookAbi, 'stakedBalanceThroughEpochOf', 5n)
    const r = await load()

    expect(await r.earnedRewardsOf(CHAIN, STICKY, HOLDER, pot(4020n))).toEqual([5n])
    expect(chain.reads().filter(read => read.functionName === 'stakedBalanceThroughEpochOf').map(read => read.args[2])).toEqual([6n])
  })

  it('reads rounds 16 at a time, and stops after the first 16 when one holds a share and that is all the caller asked', async () => {
    const chain = rewardChain()
    stockHolder(chain, { current: 20n, cursor: 0n })
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'rewardRoundOf', round(100n, 12, 0n, 0, 100n))
    chain.stock(STICKY, stickyTokenAbi, 'getPastVotes', 1n)
    const r = await load()

    await r.hasRewardsToVest(CHAIN, STICKY, HOLDER, TOKEN)
    const rounds = chain.reads().filter(read => read.functionName === 'rewardRoundOf')
    expect(rounds.map(read => read.args[3])).toEqual(Array.from({ length: 16 }, (_, at) => BigInt(at)))

    // Asked for the whole sum, it goes on to the last four rounds.
    expect(await r.earnedRewardsOf(CHAIN, STICKY, HOLDER, pot())).toEqual([20n])
  })

  it('reads every pot of a holder together, and asks for one snapshot\'s votes once', async () => {
    const chain = rewardChain()
    stockHolder(chain, { cursor: 0n })
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'rewardRoundOf', round(100n, 12, 0n, 0, 100n))
    chain.stock(STICKY, stickyTokenAbi, 'getPastVotes', 10n)
    const r = await load()

    const pots = [{ groupId: 0n, token: TOKEN }, { groupId: 0n, token: STAKED }]
    expect(await r.earnedRewardsOf(CHAIN, STICKY, HOLDER, pots)).toEqual([30n, 30n])
    expect(shape(chain.requests)).toEqual([
      ['eth_getBlockByNumber', undefined, undefined],
      ['eth_call', blockHex, 3],
      // Rounds 0, 1 and 2 of each pot, and then the one snapshot.
      ['eth_call', blockHex, 6],
      ['eth_call', blockHex, 1],
    ])
  })

  it('refuses a history of more than 4,096 unresolved rounds instead of reading it', async () => {
    const chain = rewardChain()
    stockHolder(chain, { current: 5_000n, cursor: 0n })
    const r = await load()
    await expect(r.earnedRewardsOf(CHAIN, STICKY, HOLDER, pot())).rejects.toThrow(/too large to check/)
    expect(chain.reads().filter(read => read.functionName === 'rewardRoundOf')).toHaveLength(0)
  })

  it('does not read a refused request as no reward', async () => {
    const chain = rewardChain()
    stockHolder(chain, { cursor: 0n })
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'rewardRoundOf', round(100n, 13, 0n, 0, 100n))
    chain.lose(reads => reads.some(read => read.functionName === 'rewardRoundOf'))
    const r = await load()
    await expect(r.hasRewardsToVest(CHAIN, STICKY, HOLDER, TOKEN)).rejects.toMatchObject({ functionName: 'aggregate3' })
  })
})

describe('the reward tokens', () => {
  const stockPot = (chain: Chain) => {
    stockClock(chain)
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'rewardRoundOf', round(0n, 0, 0n, 0, 0n))
  }

  it('need valid decimals, and a token without them is left out where its neighbours stay', async () => {
    const chain = rewardChain()
    stockPot(chain)
    stockToken(chain, STAKED, 'ART', 6)
    chain.stock(TOKEN, erc20Abi, 'symbol', 'BAD')
    chain.stock(TOKEN, erc20Abi, 'decimals', REVERT)
    const r = await load()

    const cards = await r.readRewards(CHAIN, STICKY, null, [funded(0n, STAKED), funded(0n, TOKEN)])

    expect(cards.map(card => [card.token, card.meta])).toEqual([[STAKED.toLowerCase(), { symbol: 'ART', decimals: 6 }]])
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('reward token'),
      { chainId: CHAIN, token: TOKEN.toLowerCase() },
      expect.any(Error),
    )
  })

  it('never take more than 255 as decimals', async () => {
    const chain = rewardChain()
    stockPot(chain)
    chain.stock(TOKEN, erc20Abi, 'symbol', 'BIG')
    chain.stock(TOKEN, erc20Abi, 'decimals', returning(numberToHex(256, { size: 32 })))
    stockToken(chain, STAKED, 'OK', 255)
    const r = await load()
    const cards = await r.readRewards(CHAIN, STICKY, null, [funded(0n, TOKEN), funded(0n, STAKED)])
    expect(cards.map(card => card.meta)).toEqual([{ symbol: 'OK', decimals: 255 }])
  })

  it('call the native token ETH with 18 decimals without asking anything of it', async () => {
    const chain = rewardChain()
    stockPot(chain)
    const r = await load()
    const cards = await r.readRewards(CHAIN, STICKY, null, [funded(0n, NATIVE)])
    expect(cards.map(card => card.meta)).toEqual([{ symbol: 'ETH', decimals: 18 }])
    expect(chain.reads().some(read => read.functionName === 'symbol')).toBe(false)
  })

  it('read a bytes32 symbol, as MKR has, and name a token that has none by its short address', async () => {
    const chain = rewardChain()
    stockPot(chain)
    stockToken(chain, STAKED, 'MKR', 18, 'bytes32')
    chain.stock(TOKEN, erc20Abi, 'symbol', REVERT)
    chain.stock(TOKEN, erc20Abi, 'decimals', 6)
    const r = await load()
    const cards = await r.readRewards(CHAIN, STICKY, null, [funded(0n, STAKED), funded(0n, TOKEN)])
    const short = `${TOKEN.toLowerCase().slice(0, 6)}…${TOKEN.toLowerCase().slice(-4)}`
    expect(cards.map(card => card.meta)).toEqual([
      { symbol: 'MKR', decimals: 18 },
      { symbol: short, decimals: 6 },
    ])
  })

  it('keep 256 characters of a symbol and no more, as a project\'s own tokens are kept', async () => {
    const chain = rewardChain()
    stockPot(chain)
    stockToken(chain, TOKEN, 'A'.repeat(300))
    const r = await load()
    const [card] = await r.readRewards(CHAIN, STICKY, null, [funded(0n, TOKEN)])
    expect(card.meta.symbol).toBe('A'.repeat(256))
  })

  it('ask for the tokens of all the pots at once, each token once, and never for the native token', async () => {
    const chain = rewardChain()
    stockPot(chain)
    stockToken(chain, STAKED)
    stockToken(chain, TOKEN)
    const r = await load()

    await r.readRewards(CHAIN, STICKY, null, [
      funded(0n, STAKED),
      funded(4000n, STAKED),
      funded(0n, TOKEN),
      funded(4000n, NATIVE),
    ])

    const asked = chain.requests.filter(request => request.reads?.some(read => read.functionName === 'symbol'))
    expect(asked).toHaveLength(1)
    // Each token is asked for its symbol as a string, its decimals, and its symbol as a bytes32.
    expect(asked[0].reads!.map(read => [read.target, read.functionName])).toEqual([
      [STAKED, 'symbol'],
      [STAKED, 'decimals'],
      [STAKED, 'symbol'],
      [TOKEN, 'symbol'],
      [TOKEN, 'decimals'],
      [TOKEN, 'symbol'],
    ])
  })

  describe('when one of them keeps a request from being answered', () => {
    const stockAll = (chain: Chain) => {
      stockPot(chain)
      stockToken(chain, STAKED)
      stockToken(chain, TOKEN, 'GOOD')
      stockToken(chain, HOSTILE, 'EVIL')
      chain.lose(reads => reads.some(read => read.target === HOSTILE))
    }

    it('reads the others one at a time and leaves it out, so one hostile token cannot fail the card', async () => {
      const chain = rewardChain()
      stockAll(chain)
      const r = await load()

      const cards = await r.readRewards(CHAIN, STICKY, null, [funded(0n, STAKED), funded(0n, HOSTILE), funded(0n, TOKEN)])

      expect(cards.map(card => card.meta.symbol)).toEqual(['ART', 'GOOD'])
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('reward token'),
        { chainId: CHAIN, token: HOSTILE.toLowerCase() },
        expect.anything(),
      )
      // The request for all three is lost, Center is asked afresh for its head, and then each token is asked alone.
      const asked = chain.requests
        .filter(request => request.method === 'eth_blockNumber' || request.reads?.some(read => read.functionName === 'symbol'))
        .map(request => (request.reads ? [...new Set(request.reads.map(read => read.target))] : request.method))
      expect(asked[0]).toEqual([STAKED, HOSTILE, TOKEN])
      expect(asked.slice(1)).toContain('eth_blockNumber')
      for (const token of [STAKED, HOSTILE, TOKEN]) expect(asked.slice(1)).toContainEqual([token])
    })

    it('fails the read when Center itself cannot answer, since that says nothing about the token', async () => {
      const chain = rewardChain()
      stockAll(chain)
      chain.takeDown()
      const r = await load()
      await expect(r.readRewards(CHAIN, STICKY, null, [funded(0n, STAKED), funded(0n, HOSTILE)])).rejects.toMatchObject({
        functionName: 'aggregate3',
      })
    })
  })
})

describe('readRewards', () => {
  /** A holder in a group 4008 pot of TOKEN: 10 unlocked and 40 claimed, so 30 vesting, 7 earned in round 1, and 10 ART
   * funded in round 2, the current one. */
  function stockStanding(chain: Chain) {
    stockClock(chain, 2n)
    stockToken(chain, TOKEN, 'ART', 6)
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'collectableFor', 10n, 4)
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'claimedFor', 40n, 4)
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'latestVestedIndexOf', 1n)
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'nextClaimRoundOf', 1n)
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'vestingDataOf', ([, , , , index]) =>
      index === 1n ? [5n, 20n, 0n] : index === 2n ? [6n, 20n, 0n] : REVERT,
    )
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'rewardRoundOf', ([, , , at]) =>
      at === 1n ? round(100n, 12, 0n, 0, 100n) : round(10_000_000n, 30, 0n, 0, 100n),
    )
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'snapshotEpochOf', 20n)
    chain.stock(STICKY, stickyTokenAbi, 'PROJECT_ID', PROJECT)
    chain.stock(STICKY, stickyTokenAbi, 'getPastVotes', 7n)
    chain.stock(HOOK, stickyHookAbi, 'stakedBalanceThroughEpochOf', ([, , epoch]) => (epoch === 16n ? 17n : 10n))
  }

  it('reads claimable, vesting, what is earned, and the vesting entries that set the last unlock, at one block', async () => {
    const chain = rewardChain()
    stockStanding(chain)
    const r = await load()

    const cards = await r.readRewards(CHAIN, STICKY, HOLDER, [funded(4008n, TOKEN, 30_000_000n)])

    expect(cards).toEqual([
      {
        groupId: 4008n,
        token: TOKEN.toLowerCase(),
        funded: 30_000_000n,
        meta: { symbol: 'ART', decimals: 6 },
        fundedThisRound: 10_000_000n,
        position: {
          collectable: 10n,
          vesting: 30n,
          earned: 7n,
          nextUnlockAt: r.roundStartOf(CLOCK, 3n),
          unlockedAt: r.roundStartOf(CLOCK, 6n),
        },
        schedule: CLOCK,
      },
    ])
    // The first request finds the head block, and every other reads that block.
    expect(chain.requests[0].method).toBe('eth_getBlockByNumber')
    expect(new Set(chain.requests.slice(1).map(request => request.block))).toEqual(new Set([blockHex]))
  })

  it('asks for every pot together at each step, however many there are', async () => {
    const chain = rewardChain()
    stockStanding(chain)
    stockToken(chain, STAKED, 'STK', 18)
    const r = await load()

    await r.readRewards(CHAIN, STICKY, HOLDER, [
      funded(4008n, TOKEN, 1n),
      funded(4008n, STAKED, 1n),
      funded(4008n, NATIVE, 1n),
    ])

    expect(shape(chain.requests)).toEqual([
      ['eth_getBlockByNumber', undefined, undefined],
      // The distributor's clock and its current round.
      ['eth_call', blockHex, 4],
      // The two tokens' symbols and decimals: the native token is ETH.
      ['eth_call', blockHex, 6],
      // For each of three pots: what was funded this round, and what the holder can collect, has claimed, has vested
      // last and has yet to resolve.
      ['eth_call', blockHex, 15],
      // The 32 vesting entries a pot with some vesting can have, from its latest.
      ['eth_call', blockHex, 96],
      // Round 1, which each pot has yet to resolve.
      ['eth_call', blockHex, 3],
      // The epoch of its snapshot and the token's project, and then the hook's stake through the two epochs its window has.
      ['eth_call', blockHex, 2],
      ['eth_call', blockHex, 2],
    ])
  })

  it('reads nothing of a holder\'s when there is none, and shows each pot as nothing collectable', async () => {
    const chain = rewardChain()
    stockClock(chain, 2n)
    stockToken(chain, TOKEN)
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'rewardRoundOf', round(5_000_000n, 30, 0n, 0, 100n))
    const r = await load()

    const [card] = await r.readRewards(CHAIN, STICKY, null, [funded(0n, TOKEN, 9_000_000n)])

    expect(card.position).toEqual({ collectable: 0n, vesting: 0n, earned: 0n, nextUnlockAt: null, unlockedAt: null })
    expect(card.fundedThisRound).toBe(5_000_000n)
    expect(chain.reads().map(read => read.functionName)).not.toContain('collectableFor')
  })

  it('does not go on to read entries or rounds for a pot with nothing vesting and nothing to resolve', async () => {
    const chain = rewardChain()
    stockClock(chain, 2n)
    stockToken(chain, TOKEN)
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'collectableFor', 8n, 4)
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'claimedFor', 8n, 4)
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'latestVestedIndexOf', 0n)
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'nextClaimRoundOf', 2n)
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'rewardRoundOf', round(0n, 0, 0n, 0, 0n))
    const r = await load()

    const [card] = await r.readRewards(CHAIN, STICKY, HOLDER, [funded(0n, TOKEN)])

    expect(card.position).toEqual({ collectable: 8n, vesting: 0n, earned: 0n, nextUnlockAt: null, unlockedAt: null })
    expect(chain.reads().map(read => read.functionName)).not.toContain('vestingDataOf')
  })

  it('names a last unlock only from a vesting entry that releases after the round the schedule is in', async () => {
    const chain = rewardChain()
    stockStanding(chain)
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'vestingDataOf', ([, , , , index]) => (index === 1n ? [2n, 20n, 0n] : REVERT))
    const r = await load()

    const [card] = await r.readRewards(CHAIN, STICKY, HOLDER, [funded(0n, TOKEN)])

    expect(card.position.nextUnlockAt).toBe(r.roundStartOf(CLOCK, 3n))
    expect(card.position.unlockedAt).toBeNull()
  })

  it('reads a reverting vesting entry as the end of them, and a refused request as an error', async () => {
    const chain = rewardChain()
    stockStanding(chain)
    chain.lose(reads => reads.some(read => read.functionName === 'vestingDataOf'))
    const r = await load()
    await expect(r.readRewards(CHAIN, STICKY, HOLDER, [funded(0n, TOKEN)])).rejects.toMatchObject({ functionName: 'aggregate3' })
  })

  it('fails when the distributor cannot say what a holder can collect, and never shows it as zero', async () => {
    const chain = rewardChain()
    stockStanding(chain)
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'collectableFor', REVERT, 4)
    const r = await load()
    await expect(r.readRewards(CHAIN, STICKY, HOLDER, [funded(0n, TOKEN)])).rejects.toThrow(/could not be read/)
  })

  it('stops when its caller does', async () => {
    const chain = rewardChain()
    stockStanding(chain)
    const r = await load()
    const controller = new AbortController()
    const read = r.readRewards(CHAIN, STICKY, HOLDER, [funded(0n, TOKEN)], { signal: controller.signal })
    controller.abort(new Error('gone'))
    await expect(read).rejects.toThrow('gone')
  })
})

describe('the clock of a round', () => {
  it('starts round r at the start plus r rounds', async () => {
    const r = await load()
    expect(r.roundStartOf(CLOCK, 0n)).toBe(CLOCK.start)
    expect(r.roundStartOf(CLOCK, 3n)).toBe(CLOCK.start + 3n * CLOCK.roundDuration)
  })

  it('is read with the current round in one request at the block it found', async () => {
    const chain = rewardChain()
    stockClock(chain, 7n)
    const r = await load()
    expect(await r.readRewardSchedule(CHAIN)).toEqual({ ...CLOCK, round: 7n })
    expect(shape(chain.requests)).toEqual([
      ['eth_getBlockByNumber', undefined, undefined],
      ['eth_call', blockHex, 4],
    ])
  })

  it('rejects a distributor whose round schedule is empty', async () => {
    const chain = rewardChain()
    stockClock(chain)
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'ROUND_DURATION', 0n)
    const r = await load()
    await expect(r.readRewardSchedule(CHAIN)).rejects.toThrow(/invalid round schedule/)
  })
})
