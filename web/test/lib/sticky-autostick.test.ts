// @vitest-environment node

import { erc20Abi, toHex, type Address } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stickyAutoStickAbi, stickyDistributorAbi, stickyHookAbi, stickyTokenAbi } from '@/lib/sticky-abis'
import type { StickyEvent } from '@/lib/sticky-events'
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
  rewardChain,
  shape,
} from './sticky-reward-fixtures'

// The reads behind the Airdrops tab's auto-stick card and its list of who can stick for the holder, through the real
// Center reader against a fake Center (sticky-reward-fixtures.ts).

async function load() {
  vi.resetModules()
  return import('@/lib/sticky-autostick')
}

const DISTRIBUTOR = deployment.distributor
const HOOK = deployment.hook
const ADAPTER = deployment.autoStick
const INFO = { stToken: STICKY, stakedToken: STAKED }
type Chain = ReturnType<typeof rewardChain>

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

/** What the adapter reports for a holder who turned auto-stick on: at least 1 unit, once a day, never stuck yet. */
function stockAdapter(chain: Chain, { status = 0, collectable = 500n, enabled = true } = {}) {
  chain.stock(ADAPTER, stickyAutoStickAbi, 'statusOf', [status, collectable, 10n ** 30n, 0n])
  chain.stock(ADAPTER, stickyAutoStickAbi, 'configOf', [1n, 86_400, 0, enabled])
  chain.stock(HOOK, stickyHookAbi, 'isGranterOf', true)
  chain.stock(HOOK, stickyHookAbi, 'isTrustedSenderOf', true)
}

/** Rewards in the staked token: 300 in group 4000 and 200 in group 4008, none for everyone. */
function stockCollectable(chain: Chain) {
  chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'collectableFor', ([, groupId]) => (groupId === 4000n ? 300n : groupId === 4008n ? 200n : 0n), 4)
}

describe('AS_STATUS', () => {
  it('numbers the adapter\'s statuses as its enum does', async () => {
    const { AS_STATUS } = await load()
    expect(AS_STATUS).toEqual({
      READY: 0,
      DISABLED: 1,
      INVALID_PROJECT: 2,
      COOLDOWN: 3,
      BELOW_MINIMUM: 4,
      NOT_TRUSTED: 5,
      INSUFFICIENT_ALLOWANCE: 6,
      ZERO_ISSUANCE: 7,
    })
  })
})

describe('the groups holding staked-token rewards', () => {
  it('are those with something collectable, in the order given, and the adapter is asked about them alone', async () => {
    const chain = rewardChain()
    stockCollectable(chain)
    const { stakedRewardGroups } = await load()

    expect(await stakedRewardGroups(CHAIN, INFO, HOLDER, [0n, 4000n, 4008n])).toEqual({ groupIds: [4000n, 4008n], collectable: 500n })

    const reads = chain.reads()
    expect(reads.map(read => [read.target, read.functionName, read.args])).toEqual(
      [0n, 4000n, 4008n].map(groupId => [DISTRIBUTOR, 'collectableFor', [STICKY, groupId, BigInt(HOLDER), STAKED]]),
    )
  })

  it('fall back on group 0 when nothing is ready anywhere, so the adapter is never given an empty list', async () => {
    const chain = rewardChain()
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'collectableFor', 0n, 4)
    const { stakedRewardGroups } = await load()
    expect(await stakedRewardGroups(CHAIN, INFO, HOLDER, [0n, 4000n])).toEqual({ groupIds: [0n], collectable: 0n })
    expect(await stakedRewardGroups(CHAIN, INFO, HOLDER, [])).toEqual({ groupIds: [0n], collectable: 0n })
  })

  it('read a group the distributor reverts on as holding nothing, and say so', async () => {
    const chain = rewardChain()
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'collectableFor', ([, groupId]) => (groupId === 4000n ? REVERT : 300n), 4)
    const { stakedRewardGroups } = await load()
    expect(await stakedRewardGroups(CHAIN, INFO, HOLDER, [0n, 4000n])).toEqual({ groupIds: [0n], collectable: 300n })
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('collect'), { chainId: CHAIN, groupId: 4000n }, expect.any(Error))
  })

  it('do not read a refused request as no groups', async () => {
    const chain = rewardChain()
    stockCollectable(chain)
    chain.lose(() => true)
    const { stakedRewardGroups } = await load()
    await expect(stakedRewardGroups(CHAIN, INFO, HOLDER, [0n, 4000n])).rejects.toMatchObject({ functionName: 'aggregate3' })
  })
})

describe('the groups with finished rounds to start vesting', () => {
  function stockRounds(chain: Chain) {
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'currentRound', 3n)
    // Only group 4008 has a round the holder has not resolved.
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'nextClaimRoundOf', ([, groupId]) => (groupId === 4008n ? 2n : 3n))
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'rewardRoundOf', [100n, 12, 0n, 0, 100n])
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'snapshotEpochOf', 20n)
    chain.stock(STICKY, stickyTokenAbi, 'PROJECT_ID', PROJECT)
    chain.stock(HOOK, stickyHookAbi, 'stakedBalanceThroughEpochOf', ([, , epoch]) => (epoch === 16n ? 40n : 10n))
  }

  it('are the ones a holder has a share of, of every group at once', async () => {
    const chain = rewardChain()
    stockRounds(chain)
    const { vestableRewardGroups } = await load()

    expect(await vestableRewardGroups(CHAIN, INFO, HOLDER, [0n, 4000n, 4008n])).toEqual([4008n])

    // The tokens asked about are the staked token's, for each group.
    const cursors = chain.reads().filter(read => read.functionName === 'nextClaimRoundOf')
    expect(cursors.map(read => [read.args[1], read.args[3]])).toEqual([[0n, STAKED], [4000n, STAKED], [4008n, STAKED]])
  })

  it('are none when every round is resolved', async () => {
    const chain = rewardChain()
    stockRounds(chain)
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'nextClaimRoundOf', 3n)
    const { vestableRewardGroups } = await load()
    expect(await vestableRewardGroups(CHAIN, INFO, HOLDER, [0n, 4008n])).toEqual([])
  })
})

describe('readAutoStick', () => {
  const read = async (chain: Chain, groups = [0n, 4000n, 4008n]) => {
    const { readAutoStick } = await load()
    return readAutoStick(CHAIN, PROJECT, HOLDER, { info: INFO, groups })
  }

  it('asks the adapter for its status, passing the groups holding staked-token rewards, and reads what the holder set', async () => {
    const chain = rewardChain()
    stockCollectable(chain)
    stockAdapter(chain)
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'currentRound', 3n)
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'nextClaimRoundOf', 3n)

    const state = await read(chain)

    expect(state).toEqual({
      groupIds: [4000n, 4008n],
      status: 0,
      collectable: 500n,
      allowance: 10n ** 30n,
      nextCompoundAt: 0,
      minimum: 1n,
      cooldown: 86_400,
      lastCompoundedAt: 0,
      enabled: true,
      projectGranter: true,
      personallyTrusted: true,
      canBeginVesting: false,
    })
    const status = chain.reads().find(each => each.functionName === 'statusOf')!
    expect(status.target).toBe(ADAPTER)
    expect(status.args).toEqual([PROJECT, HOLDER, [4000n, 4008n]])
    // The hook is asked whether the project granted the adapter, and whether this holder trusts it.
    expect(chain.reads().find(each => each.functionName === 'isGranterOf')!.args).toEqual([PROJECT, ADAPTER])
    expect(chain.reads().find(each => each.functionName === 'isTrustedSenderOf')!.args).toEqual([PROJECT, HOLDER, ADAPTER])
  })

  it('reads at one block, one request for each step', async () => {
    const chain = rewardChain()
    stockCollectable(chain)
    stockAdapter(chain)
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'currentRound', 3n)
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'nextClaimRoundOf', 3n)

    await read(chain)

    expect(shape(chain.requests)).toEqual([
      ['eth_getBlockByNumber', undefined, undefined],
      // What is collectable in each group.
      ['eth_call', blockHex, 3],
      // The status, the settings, and whether the project or the holder trusts the adapter.
      ['eth_call', blockHex, 4],
      // The distributor's current round, and where the holder stands in each of the three groups, to see whether some vest.
      ['eth_call', blockHex, 4],
    ])
  })

  it('offers to start unlocking only when a finished round holds a share', async () => {
    const chain = rewardChain()
    stockCollectable(chain)
    stockAdapter(chain)
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'currentRound', 3n)
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'nextClaimRoundOf', ([, groupId]) => (groupId === 4008n ? 2n : 3n))
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'rewardRoundOf', [100n, 12, 0n, 0, 100n])
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'snapshotEpochOf', 20n)
    chain.stock(STICKY, stickyTokenAbi, 'PROJECT_ID', PROJECT)
    chain.stock(HOOK, stickyHookAbi, 'stakedBalanceThroughEpochOf', ([, , epoch]) => (epoch === 16n ? 40n : 10n))

    expect((await read(chain)).canBeginVesting).toBe(true)
  })

  it('does not look for rounds to vest while auto-stick is off', async () => {
    const chain = rewardChain()
    stockCollectable(chain)
    stockAdapter(chain, { status: 1, enabled: false })
    const state = await read(chain)
    expect(state).toMatchObject({ enabled: false, status: 1, canBeginVesting: false })
    expect(chain.reads().map(each => each.functionName)).not.toContain('currentRound')
  })

  it('keeps the rest of the state when what to vest cannot be read, and tells the console', async () => {
    const chain = rewardChain()
    stockCollectable(chain)
    stockAdapter(chain)
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'currentRound', 5_000n)
    chain.stock(DISTRIBUTOR, stickyDistributorAbi, 'nextClaimRoundOf', 0n)
    const state = await read(chain)
    expect(state).toMatchObject({ enabled: true, status: 0, canBeginVesting: false })
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('unlocking'), { chainId: CHAIN, projectId: PROJECT }, expect.any(Error))
  })

  it('reports an invalid project as it is, for the card to close on', async () => {
    const chain = rewardChain()
    stockCollectable(chain)
    chain.stock(ADAPTER, stickyAutoStickAbi, 'statusOf', [2, 0n, 0n, 0n])
    chain.stock(ADAPTER, stickyAutoStickAbi, 'configOf', [0n, 0, 0, false])
    chain.stock(HOOK, stickyHookAbi, 'isGranterOf', false)
    chain.stock(HOOK, stickyHookAbi, 'isTrustedSenderOf', false)
    expect(await read(chain)).toMatchObject({ status: 2, enabled: false, projectGranter: false, personallyTrusted: false })
  })

  it('fails when the adapter cannot say its status', async () => {
    const chain = rewardChain()
    stockCollectable(chain)
    stockAdapter(chain)
    chain.stock(ADAPTER, stickyAutoStickAbi, 'statusOf', REVERT)
    await expect(read(chain)).rejects.toThrow(/could not be read/)
  })

  it('reads a refused request as an error', async () => {
    const chain = rewardChain()
    stockCollectable(chain)
    stockAdapter(chain)
    chain.lose(reads => reads.some(each => each.functionName === 'statusOf'))
    await expect(read(chain)).rejects.toMatchObject({ functionName: 'aggregate3' })
  })
})

describe('asStatusLine', () => {
  const info = { symbol: 'ART', decimals: 6 }
  const state = { collectable: 1_500_000n, minimum: 2_000_000n, nextCompoundAt: NOW + 90_000 }

  it('says what holds auto-stick back, in the old client\'s words', async () => {
    const { AS_STATUS, asStatusLine } = await load()
    const line = (status: number) => asStatusLine({ ...state, status }, info, NOW)
    expect(line(AS_STATUS.READY)).toBe('Ready to auto-stick')
    expect(line(AS_STATUS.COOLDOWN)).toBe('Next auto-stick in 1d 1h')
    expect(line(AS_STATUS.BELOW_MINIMUM)).toBe('1.5 ART ready | minimum 2')
    expect(line(AS_STATUS.NOT_TRUSTED)).toBe('Permission removed | repair setup')
    expect(line(AS_STATUS.INSUFFICIENT_ALLOWANCE)).toBe('Allowance exhausted | renew')
    expect(line(AS_STATUS.DISABLED)).toBe('')
    expect(line(AS_STATUS.INVALID_PROJECT)).toBe('')
  })

  it('displays the appended zero-issuance status without treating it as ready', async () => {
    const { AS_STATUS, asStatusLine } = await load()
    const line = asStatusLine({ ...state, status: AS_STATUS.ZERO_ISSUANCE }, info, NOW)
    expect(line).toMatch(/too small/)
    expect(line).not.toBe(asStatusLine({ ...state, status: AS_STATUS.READY }, info, NOW))
  })

  it('does not count down past the time it is ready', async () => {
    const { AS_STATUS, asStatusLine } = await load()
    expect(asStatusLine({ ...state, status: AS_STATUS.COOLDOWN, nextCompoundAt: NOW - 5 }, info, NOW)).toBe('Next auto-stick in 0d')
  })
})

describe('trustedSenders', () => {
  const SENDER = address('5')
  const SECOND = address('6')
  const THIRD = address('7')
  let logIndex = 0
  const trust = (sender: Address, trusted: boolean, extra: Partial<StickyEvent> = {}): StickyEvent => {
    logIndex += 1
    return {
      kind: 'trust',
      chainId: CHAIN,
      projectId: PROJECT,
      holder: HOLDER.toLowerCase() as Address,
      sender: sender.toLowerCase() as Address,
      trusted,
      txHash: `0x${logIndex.toString(16).padStart(64, '0')}`,
      logIndex,
      blockNumber: null,
      timestamp: 1_000 + logIndex,
      ...extra,
    }
  }
  const reads = { chainId: CHAIN, projectId: PROJECT, holder: HOLDER }

  /** The hook says who trusts whom now, whatever the events say. */
  function stockTrust(chain: Chain, trusted: Address[]) {
    const yes = new Set(trusted.map(each => each.toLowerCase()))
    chain.stock(HOOK, stickyHookAbi, 'isTrustedSenderOf', ([, , sender]) => yes.has(String(sender).toLowerCase()))
  }

  it('never lists the auto-stick adapter, however it came to be trusted, and never asks the hook about it', async () => {
    const chain = rewardChain()
    stockTrust(chain, [ADAPTER, SENDER])
    const { trustedSenders } = await load()

    expect(await trustedSenders([trust(ADAPTER, true), trust(SENDER, true)], reads)).toEqual([SENDER.toLowerCase()])
    expect(chain.reads().map(read => read.args[2])).toEqual([SENDER.toLowerCase()])

    // Nor is it listed when the adapter is the only sender there is: no read is made at all.
    const quiet = rewardChain()
    stockTrust(quiet, [ADAPTER])
    expect(await trustedSenders([trust(ADAPTER, true)], reads)).toEqual([])
    expect(quiet.requests).toEqual([])
  })

  it('lists the senders the hook says the holder trusts now, not those the events last said they did', async () => {
    const chain = rewardChain()
    // SENDER trusted and untrusted since; SECOND was untrusted and trusted again; THIRD is trusted and nothing revoked it.
    stockTrust(chain, [SECOND, THIRD])
    const { trustedSenders } = await load()

    const events = [trust(SENDER, true), trust(SECOND, true), trust(SECOND, false), trust(SENDER, false), trust(THIRD, true), trust(SECOND, true)]
    expect(await trustedSenders(events, reads)).toEqual([SECOND.toLowerCase(), THIRD.toLowerCase()])
    // Each sender is asked about once, in the order the events first named it, in one request.
    expect(chain.reads().map(read => [read.target, read.args])).toEqual(
      [SENDER, SECOND, THIRD].map(sender => [HOOK, [PROJECT, HOLDER, sender.toLowerCase()]]),
    )
    expect(chain.requests).toHaveLength(1)
  })

  it('leaves out the trust of other holders, other projects, other chains and the other events of a project', async () => {
    const chain = rewardChain()
    stockTrust(chain, [SENDER, SECOND])
    const { trustedSenders } = await load()

    const events: StickyEvent[] = [
      trust(SENDER, true),
      trust(SECOND, true, { holder: OTHER.toLowerCase() as Address }),
      trust(SECOND, true, { projectId: PROJECT + 1n }),
      trust(SECOND, true, { chainId: 8453 }),
      { ...trust(SECOND, true), kind: 'granter' },
      { ...trust(SECOND, true), kind: 'stick', payer: HOLDER, count: 1n, balance: 1n },
    ]
    expect(await trustedSenders(events, reads)).toEqual([SENDER.toLowerCase()])
    expect(chain.reads().map(read => read.args[2])).toEqual([SENDER.toLowerCase()])
  })

  it('matches the holder however its address is written', async () => {
    const chain = rewardChain()
    stockTrust(chain, [SENDER])
    const { trustedSenders } = await load()
    // The events keep addresses in lowercase; a wallet gives its account checksummed.
    const holder = address('a')
    expect(holder).not.toBe(holder.toLowerCase())
    const events = [trust(SENDER, true, { holder: holder.toLowerCase() as Address })]
    expect(await trustedSenders(events, { ...reads, holder })).toEqual([SENDER.toLowerCase()])
  })

  it('lists nobody, and reads nothing, when no sender was ever named', async () => {
    const chain = rewardChain()
    const { trustedSenders } = await load()
    expect(await trustedSenders([], reads)).toEqual([])
    expect(chain.requests).toEqual([])
  })

  it('does not read a refused request as nobody trusted', async () => {
    const chain = rewardChain()
    stockTrust(chain, [SENDER])
    chain.lose(() => true)
    const { trustedSenders } = await load()
    await expect(trustedSenders([trust(SENDER, true)], reads)).rejects.toMatchObject({ functionName: 'aggregate3' })
  })
})

describe('readAutoStickStanding', () => {
  it("reads whether auto-stick is on, the holder's trust in the adapter and their allowance, in one request at the block asked", async () => {
    const chain = rewardChain()
    chain.stock(ADAPTER, stickyAutoStickAbi, 'configOf', [1n, 86_400, 0, true])
    chain.stock(HOOK, stickyHookAbi, 'isTrustedSenderOf', false)
    chain.stock(STAKED, erc20Abi, 'allowance', 7n)
    const { readAutoStickStanding } = await load()
    expect(await readAutoStickStanding(CHAIN, PROJECT, HOLDER, { stakedToken: STAKED, block: HEAD - 1n })).toEqual({
      enabled: true,
      personallyTrusted: false,
      allowance: 7n,
    })
    expect(shape(chain.requests)).toEqual([['eth_call', toHex(HEAD - 1n), 3]])
    expect(chain.reads().map(({ target, functionName, args }) => [target, functionName, args])).toEqual([
      [ADAPTER, 'configOf', [PROJECT, HOLDER]],
      [HOOK, 'isTrustedSenderOf', [PROJECT, HOLDER, ADAPTER]],
      [STAKED, 'allowance', [HOLDER, ADAPTER]],
    ])
  })

  it('names what it could not read, and keeps the cause', async () => {
    const chain = rewardChain()
    chain.stock(ADAPTER, stickyAutoStickAbi, 'configOf', REVERT)
    chain.stock(HOOK, stickyHookAbi, 'isTrustedSenderOf', true)
    chain.stock(STAKED, erc20Abi, 'allowance', 7n)
    const { readAutoStickStanding } = await load()
    const failed = await readAutoStickStanding(CHAIN, PROJECT, HOLDER, { stakedToken: STAKED }).catch((error: Error) => error)
    expect(failed).toMatchObject({ message: "the holder's auto-stick settings could not be read." })
    expect((failed as Error).cause).toBeInstanceOf(Error)
  })
})

describe('hasLeftovers', () => {
  it('says an auto-stick that is off still has what the holder gave it: their trust or an allowance, and nothing else', async () => {
    const { hasLeftovers } = await load()
    const off = { enabled: false, personallyTrusted: false, allowance: 0n }
    expect(hasLeftovers(off)).toBe(false)
    expect(hasLeftovers({ ...off, personallyTrusted: true })).toBe(true)
    expect(hasLeftovers({ ...off, allowance: 1n })).toBe(true)
    // While it is on, they are in use.
    expect(hasLeftovers({ enabled: true, personallyTrusted: true, allowance: 1n })).toBe(false)
  })
})
