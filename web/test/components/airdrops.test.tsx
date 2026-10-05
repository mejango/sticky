// Dates in reward copy are local; pin the zone so the expected dates hold on every machine.
process.env.TZ = 'UTC'

import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Address, Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HistoryTooLongError } from '@/lib/hook-logs'
import { installQueryPersistence } from '@/lib/query-persist'
import type { StickyEvent } from '@/lib/sticky-events'
import { clearViewAs, setViewAs } from '@/lib/viewAs'
import { HOLDER, TOKEN, stickyInfo } from '../home-fixtures'
import { memoryStorage } from '../memory-storage'
import { FakeObserver, siteClient } from '../panel-fixtures'

// The Airdrops tab: the viewer's rewards, their auto-stick and who they trust to stick for them. Every read is a mock;
// the reads have tests of their own (test/lib/sticky-rewards.test.ts and sticky-autostick.test.ts). The clock is
// fake, so the 15-second refresh happens only when a test moves it.

const mocks = vi.hoisted(() => ({
  project: vi.fn(),
  events: vi.fn(),
  funding: vi.fn(),
  rewards: vi.fn(),
  autoStick: vi.fn(),
  trusted: vi.fn(),
  ens: vi.fn(),
  address: undefined as string | undefined,
}))

vi.mock('@/lib/sticky-project', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-project')>()),
  readStickyProject: mocks.project,
}))
vi.mock('@/lib/sticky-events', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-events')>()),
  stickyEvents: mocks.events,
}))
vi.mock('@/lib/sticky-rewards', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-rewards')>()),
  discoverFunding: mocks.funding,
  readRewards: mocks.rewards,
}))
vi.mock('@/lib/sticky-autostick', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-autostick')>()),
  readAutoStick: mocks.autoStick,
  trustedSenders: mocks.trusted,
}))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: mocks.address }) }))
// What mainnet names an account: a production chain asks, a testnet does not.
vi.mock('@/lib/ens', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/ens')>()),
  lookupEnsName: mocks.ens,
}))
// The form for sticking for someone else has a test of its own (test/components/stick-flow.test.tsx); here it is marked.
vi.mock('@/components/project/flows/StickFlow', () => ({
  StickFlow: (props: { chainId: number; projectId: number; forSomeoneElse?: boolean }) => (
    <div data-stick-flow={JSON.stringify(props)} />
  ),
}))
vi.mock('@/components/project/flows/TrustFlow', () => ({
  TrustFlow: ({
    chainId,
    projectId,
    info,
    sender,
    onClose,
  }: {
    chainId: number
    projectId: number
    info: { stSymbol: string } | undefined
    sender: Address | null
    onClose: () => void
  }) => (
    <div data-flow="trust" data-chain={chainId} data-project={projectId} data-token={info?.stSymbol ?? ''} data-sender={sender ?? ''}>
      <button type="button" onClick={onClose}>
        Close trust
      </button>
    </div>
  ),
}))

// The airdrop's form has a test of its own (test/components/fund-flow.test.tsx); here it is marked, and it can say that
// an airdrop of the token at 0x99…99 went through.
vi.mock('@/components/project/flows/FundFlow', () => ({
  FundFlow: ({
    chainId,
    projectId,
    info,
    onClose,
    onFunded,
  }: {
    chainId: number
    projectId: number
    info: { stSymbol: string }
    onClose: () => void
    onFunded: (token: string) => void
  }) => (
    <div data-flow="fund" data-chain={chainId} data-project={projectId} data-token={info.stSymbol}>
      <button type="button" onClick={() => onFunded(`0x${'9'.repeat(40)}`)}>
        Funded
      </button>
      <button type="button" onClick={onClose}>
        Close airdrop
      </button>
    </div>
  ),
}))

// A pot's actions have a test of their own (test/components/claim-flow.test.tsx); here each is marked with what the tab
// gives it.
vi.mock('@/components/project/flows/ClaimFlow', () => ({
  ClaimFlow: ({
    chainId,
    projectId,
    info,
    card,
    groups,
    canStick,
  }: {
    chainId: number
    projectId: number
    info: { stSymbol: string }
    card: { groupId: bigint; token: string }
    groups: readonly bigint[]
    canStick: boolean
  }) => (
    <div
      data-flow="claim"
      data-chain={chainId}
      data-project={projectId}
      data-token={info.stSymbol}
      data-pot={`${card.groupId}:${card.token}`}
      data-groups={groups.join(',')}
      data-can-stick={String(canStick)}
    />
  ),
}))

// The auto-stick card's actions have a test of their own (test/components/autostick-flow.test.tsx); here they are marked
// with what the card gives them.
vi.mock('@/components/project/flows/AutoStickFlow', () => ({
  AutoStickFlow: ({
    chainId,
    projectId,
    info,
    state,
    groups,
  }: {
    chainId: number
    projectId: number
    info: { stSymbol: string }
    state: { enabled: boolean; status: number }
    groups: readonly bigint[]
  }) => (
    <div
      data-flow="autostick"
      data-chain={chainId}
      data-project={projectId}
      data-token={info.stSymbol}
      data-enabled={String(state.enabled)}
      data-status={state.status}
      data-groups={groups.join(',')}
    />
  ),
}))

import { AirdropsTab } from '@/components/project/AirdropsTab'
import { AS_STATUS, type AutoStickState } from '@/lib/sticky-autostick'
import { refreshAfterTrust } from '@/lib/sticky-refresh'
import { stickyDeployment } from '@/lib/sticky-addresses'
import { type FundedPot, type RewardCard, type RewardPot } from '@/lib/sticky-rewards'

const CHAIN = 8453
const NOW = 1_800_000_000
const WEEK = 604_800n
const VIEWER = `0x${'d'.repeat(40)}` as Address
const SENDER = `0x${'7'.repeat(40)}` as Address
const OTHER = `0x${'9'.repeat(40)}` as Address
/** An address as the page shows it without a name: its first six and last four characters. */
const short = (address: Address) => `${address.slice(0, 6)}…${address.slice(-4)}`
const TX = `0x${'e1'.repeat(32)}` as Hex

/** STICKYSLOPSHOP #23 on Base: SLOPSHOP has 6 decimals. */
const slopshop = () =>
  stickyInfo(CHAIN, 23n, { symbol: 'SLOPSHOP', name: 'Slop Shop', decimals: 6, stSymbol: 'STICKYSLOPSHOP', stName: 'Sticky Slop Shop' })

/** The Base Sepolia distributor's clock: round 0 started 2026-09-25 00:19:26 UTC and rounds are a week. */
const SCHEDULE = { roundDuration: WEEK, vestingRounds: 4n, start: 1_790_295_566n, round: 2n }
const startOf = (round: bigint) => SCHEDULE.start + WEEK * round

/** Everyone's SLOPSHOP pot: 1 to collect, 3 vesting, 2 earned, and 10 funded this round of 30 in all. */
const underlying = (extra: Partial<RewardCard> = {}): RewardCard => ({
  groupId: 0n,
  token: TOKEN.toLowerCase() as Address,
  funded: 30_000_000n,
  meta: { symbol: 'SLOPSHOP', decimals: 6 },
  fundedThisRound: 10_000_000n,
  position: { collectable: 1_000_000n, vesting: 3_000_000n, earned: 2_000_000n, nextUnlockAt: startOf(3n), unlockedAt: startOf(6n) },
  schedule: SCHEDULE,
  ...extra,
})
const nothing = { collectable: 0n, vesting: 0n, earned: 0n, nextUnlockAt: null, unlockedAt: null }

/** Auto-stick on, at least 1 SLOPSHOP once a day, ready. */
const autoStickOn = (extra: Partial<AutoStickState> = {}): AutoStickState => ({
  groupIds: [0n],
  status: AS_STATUS.READY,
  collectable: 1_000_000n,
  allowance: 10n ** 30n,
  nextCompoundAt: 0,
  minimum: 1_000_000n,
  cooldown: 86_400,
  lastCompoundedAt: 0,
  enabled: true,
  projectGranter: false,
  personallyTrusted: true,
  canBeginVesting: false,
  ...extra,
})

const trust = (sender: Address, trusted = true): StickyEvent => ({
  kind: 'trust',
  chainId: CHAIN,
  projectId: 23n,
  holder: VIEWER,
  sender,
  trusted,
  txHash: TX,
  logIndex: 0,
  blockNumber: null,
  timestamp: NOW,
})

/** A pot the Fund logs show, last funded at block `at`. */
const fundedPot = (groupId: bigint, token: Address, funded: bigint, at = 1): FundedPot => ({ groupId, token, funded, fundedAt: BigInt(at) })

let host: HTMLDivElement
let root: Root
let client: QueryClient
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
beforeEach(() => {
  notifyManager.setScheduler(callback => queueMicrotask(callback))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.address = VIEWER
  mocks.project.mockReset().mockImplementation(async () => slopshop())
  mocks.events.mockReset().mockResolvedValue({ events: [], source: 'indexed', degraded: null })
  mocks.funding.mockReset().mockResolvedValue([])
  mocks.rewards.mockReset().mockResolvedValue([underlying()])
  mocks.autoStick.mockReset().mockResolvedValue(autoStickOn())
  mocks.trusted.mockReset().mockResolvedValue([])
  mocks.ens.mockReset().mockResolvedValue(null)
  client = newClient()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  client.clear()
  clearViewAs()
})

const settle = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))
/** The chain of reads behind the tab: the project, then the pots, then the cards. */
async function settled() {
  for (let round = 0; round < 5; round += 1) await settle()
}

async function renderTab(using = client) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={using}>
        <AirdropsTab chainId={CHAIN} projectId={23} />
      </QueryClientProvider>,
    ),
  )
  await settled()
}

const section = (id: string) => host.querySelector<HTMLElement>(`section[aria-labelledby="${id}"]`)
const rewards = () => section('rewards-title')!
const autoStick = () => section('autostick-title')
const trusted = () => section('trusted-title')!
const pots = () => [...rewards().querySelectorAll<HTMLElement>('li[data-reward]')]
const linesOf = (pot: HTMLElement) =>
  Object.fromEntries([...pot.querySelectorAll('dt')].map(term => [term.textContent, term.nextElementSibling?.textContent]))
const buttonsOf = (within: Element) => [...within.querySelectorAll('button')].map(button => button.textContent)
const buttonNamed = (within: Element, label: string) => [...within.querySelectorAll('button')].find(button => button.textContent === label)!

describe('sticking for someone else', () => {
  it('is the first card of the tab, with the form that sticks for someone else', async () => {
    await renderTab()

    const card = section('stick-for-title')!
    expect(card.querySelector('h2')?.textContent).toBe('Stick for someone else')
    expect(card.textContent).toContain('They must trust your wallet, unless you are a trusted sender.')
    expect(JSON.parse(card.querySelector<HTMLElement>('[data-stick-flow]')!.dataset.stickFlow!)).toEqual({
      chainId: CHAIN,
      projectId: 23,
      forSomeoneElse: true,
    })
    expect(host.querySelector('section')).toBe(card)
    expect(host.querySelectorAll('[data-stick-flow]')).toHaveLength(1)
  })
})

describe('sending airdrop rewards', () => {
  const card = () => section('send-airdrops-title')!
  const recipe = () => Object.fromEntries(
    [...card().querySelectorAll('[data-split-recipe] dt')].map(term => [term.textContent, term.nextElementSibling?.textContent]),
  )
  async function typeWeeks(label: string, text: string) {
    const found = [...card().querySelectorAll('label')].find(each => each.textContent === label)!
    const input = document.getElementById(found.htmlFor) as HTMLInputElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('comes after sticking for someone else, and opens the airdrop\'s form from Send', async () => {
    await renderTab()
    expect(card().querySelector('h2')?.textContent).toBe('Send airdrop rewards')
    expect(card().textContent).toContain('Reward everyone stuck, or only stakes held for a minimum number of weeks.')
    expect(host.querySelectorAll('section')[1]).toBe(card())
    expect(card().querySelector('[data-flow="fund"]')).toBeNull()

    await act(async () => buttonNamed(card(), 'Send').click())
    const flow = card().querySelector<HTMLElement>('[data-flow="fund"]')!
    expect(flow.dataset).toMatchObject({ chain: String(CHAIN), project: '23', token: 'STICKYSLOPSHOP' })
    await act(async () => buttonNamed(flow, 'Close airdrop').click())
    expect(card().querySelector('[data-flow="fund"]')).toBeNull()
  })

  it('keeps Send closed until this visit has read the project', async () => {
    const read = Promise.withResolvers<ReturnType<typeof slopshop>>()
    mocks.project.mockReturnValue(read.promise)
    await renderTab()
    expect(buttonNamed(card(), 'Send').disabled).toBe(true)
    await act(async () => read.resolve(slopshop()))
    await settled()
    expect(buttonNamed(card(), 'Send').disabled).toBe(false)
  })

  it('looks for rewards in the token of an airdrop that went through, under every group, as a checked token is', async () => {
    mocks.funding.mockResolvedValue([fundedPot(4000n, TOKEN.toLowerCase() as Address, 5n)])
    await renderTab()
    await act(async () => buttonNamed(card(), 'Send').click())
    await act(async () => buttonNamed(card(), 'Funded').click())
    await settled()
    const rows = mocks.rewards.mock.calls.at(-1)![3].map((row: RewardPot) => `${row.groupId}:${row.token}`)
    expect(rows).toEqual([`4000:${TOKEN.toLowerCase()}`, `0:${TOKEN.toLowerCase()}`, `0:${OTHER}`, `4000:${OTHER}`])
  })

  it('gives the split that funds airdrops from a Juicebox project\'s payouts: the distributor, the Sticky token and the group', async () => {
    await renderTab()
    expect(card().querySelector('summary')?.textContent).toBe("Recurring rewards from a Juicebox project's splits")
    expect(recipe()).toEqual({
      'Split hook': `${stickyDeployment(CHAIN)!.distributor}Copy`,
      Beneficiary: `${slopshop().stToken}Copy`,
      'Project ID': '0 (reward group: everyone)',
    })
    expect(card().querySelector('button[aria-label="Copy split hook address"]')).not.toBeNull()
    expect(card().querySelector('button[aria-label="Copy beneficiary address"]')).not.toBeNull()

    await typeWeeks('Minimum stake age (weeks)', '4')
    await typeWeeks('Maximum stake age (weeks)', '8')
    expect(recipe()['Project ID']).toBe('4008 (reward group: staked 4–8 weeks)')
    await typeWeeks('Minimum stake age (weeks)', '9')
    expect(recipe()['Project ID']).toBe('None')
    expect(card().querySelector('[data-group-note]')?.textContent).toBe('The maximum stake age must be at least the minimum.')
  })
})

describe('the rewards', () => {
  it('shows the round, and a card for each pot with its group, its token and its lines', async () => {
    mocks.rewards.mockResolvedValue([
      underlying(),
      underlying({ groupId: 4008n, token: OTHER, meta: { symbol: 'ART', decimals: 18 }, funded: 5n * 10n ** 18n, fundedThisRound: 0n, position: nothing }),
    ])
    await renderTab()

    expect(rewards().querySelector('h2')?.textContent).toBe('Your rewards')
    expect(rewards().textContent).toContain(
      'Round 2 ends Oct 16, 12:19 AM. Your share then vests over 4 rounds, a quarter each week, starting when you collect.',
    )
    expect(pots().map(pot => pot.querySelector('b')?.textContent)).toEqual(['Everyone', 'Staked 4–8 weeks'])
    expect(pots().map(pot => pot.querySelector('span[title]')?.textContent)).toEqual(['SLOPSHOP', 'ART'])
    expect(linesOf(pots()[0])).toEqual({
      'Claimable now': '1 SLOPSHOP',
      Vesting: '3 SLOPSHOP. Next unlock Oct 16. All unlocked Nov 6.',
      'Earned, not vesting': 'About 2 SLOPSHOP from finished rounds. Collect to start vesting: a quarter unlocks Oct 16, all by Nov 6.',
      Funded: '10 SLOPSHOP this round, splits Oct 16. 30 SLOPSHOP in total.',
    })
    expect(linesOf(pots()[1])).toEqual({
      'Claimable now': '0 ART',
      Vesting: 'None',
      Funded: 'None this round. 5 ART in total.',
    })
    for (const text of pots().map(pot => pot.textContent ?? '')) expect(text).not.toMatch(/soon|—/)
  })

  it('reads the pots the distributor was funded for, and the staked token under every group, for the viewer', async () => {
    mocks.funding.mockResolvedValue([fundedPot(4000n, OTHER, 5n)])
    await renderTab()

    expect(mocks.funding).toHaveBeenCalledWith(CHAIN, slopshop().stToken, 23n, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    const [chainId, stToken, holder, rows, options] = mocks.rewards.mock.calls.at(-1)!
    expect([chainId, stToken, holder]).toEqual([CHAIN, slopshop().stToken, VIEWER])
    expect(rows.map((row: RewardPot) => `${row.groupId}:${row.token}`)).toEqual([
      `4000:${OTHER}`,
      `0:${TOKEN.toLowerCase()}`,
      `4000:${TOKEN.toLowerCase()}`,
    ])
    // The staked token's own symbol and decimals are the verified project's, and are not read.
    expect(options).toEqual({
      signal: expect.any(AbortSignal),
      known: new Map([[TOKEN.toLowerCase(), { symbol: 'SLOPSHOP', decimals: 6 }]]),
    })
  })

  it('reads the staked token\'s pots at once and every pot when the scan lands, keeping the cards on show meanwhile', async () => {
    const scan = Promise.withResolvers<FundedPot[]>()
    mocks.funding.mockReturnValue(scan.promise)
    await renderTab()

    expect(mocks.rewards).toHaveBeenCalledTimes(1)
    expect(mocks.rewards.mock.calls[0][3].map((row: RewardPot) => `${row.groupId}:${row.token}`)).toEqual([`0:${TOKEN.toLowerCase()}`])
    expect(pots()).toHaveLength(1)
    expect(rewards().textContent).toContain('Looking for more airdrops…')
    // The groups the adapter is asked about are the pots': auto-stick waits for them.
    expect(mocks.autoStick).not.toHaveBeenCalled()

    const everything = Promise.withResolvers<RewardCard[]>()
    mocks.rewards.mockReturnValue(everything.promise)
    await act(async () => scan.resolve([fundedPot(4000n, OTHER, 5n)]))
    await settled()
    expect(mocks.rewards).toHaveBeenCalledTimes(2)
    expect(mocks.rewards.mock.calls[1][3]).toHaveLength(3)
    expect(pots()).toHaveLength(1)
    expect(rewards().querySelector('.skeleton-shimmer')).toBeNull()
    expect(rewards().textContent).not.toContain('Looking for more airdrops…')
    expect(mocks.autoStick).toHaveBeenCalledTimes(1)

    await act(async () => everything.resolve([underlying(), underlying({ groupId: 4000n, token: OTHER, meta: { symbol: 'ART', decimals: 6 } })]))
    await settled()
    expect(pots().map(pot => pot.dataset.reward)).toEqual([`0:${TOKEN.toLowerCase()}`, `4000:${OTHER}`])
  })

  it('reads the account in View as', async () => {
    setViewAs(HOLDER)
    await renderTab()
    expect(mocks.rewards.mock.calls[0][2].toLowerCase()).toBe(HOLDER)
    expect(mocks.autoStick.mock.calls[0][2].toLowerCase()).toBe(HOLDER)
  })

  it('shows what was funded, and nothing to collect, with no account', async () => {
    mocks.address = undefined
    mocks.rewards.mockResolvedValue([underlying({ position: nothing })])
    await renderTab()

    expect(mocks.rewards.mock.calls[0][2]).toBeNull()
    expect(pots()).toHaveLength(1)
    expect(linesOf(pots()[0])['Claimable now']).toBe('0 SLOPSHOP')
    expect(buttonsOf(pots()[0])).toEqual([])
    expect(mocks.autoStick).not.toHaveBeenCalled()
  })

  it('shows a pot only when something is in it, and the staked token\'s under group 0 always', async () => {
    mocks.rewards.mockResolvedValue([
      underlying({ funded: 0n, fundedThisRound: 0n, position: nothing }),
      underlying({ groupId: 4000n, funded: 0n, fundedThisRound: 0n, position: nothing }),
      underlying({ groupId: 8000n, token: OTHER, funded: 0n, fundedThisRound: 0n, position: nothing }),
      underlying({ groupId: 0n, token: OTHER, funded: 0n, fundedThisRound: 0n, position: { ...nothing, earned: 1n } }),
      underlying({ groupId: 12000n, token: OTHER, funded: 1n, fundedThisRound: 0n, position: nothing }),
    ])
    await renderTab()
    expect(pots().map(pot => pot.dataset.reward)).toEqual([
      `0:${TOKEN.toLowerCase()}`,
      `0:${OTHER}`,
      `12000:${OTHER}`,
    ])
  })

  it('says there are no rewards when the staked token\'s pot could not be read', async () => {
    mocks.rewards.mockResolvedValue([])
    await renderTab()
    expect(pots()).toHaveLength(0)
    expect(rewards().textContent).toContain('No rewards yet.')
  })

  it('warns that stake-age rewards are lost to unsticking only when one is shown', async () => {
    await renderTab()
    expect(rewards().textContent).not.toContain('forfeit')

    mocks.rewards.mockResolvedValue([underlying(), underlying({ groupId: 4000n })])
    await act(async () => root.unmount())
    root = createRoot(host)
    client.clear()
    await renderTab()
    expect(rewards().textContent).toContain('Claim stake-age rewards before unsticking, or you forfeit them.')
  })

  it('renders a token\'s own name as text, however it is written', async () => {
    const hostile = '<img src=x onerror=alert(1)>'
    mocks.rewards.mockResolvedValue([underlying({ meta: { symbol: hostile, decimals: 6 } })])
    await renderTab()
    expect(rewards().querySelector('img')).toBeNull()
    expect(pots()[0].textContent).toContain(hostile)
    expect(linesOf(pots()[0])['Claimable now']).toBe(`1 ${hostile}`)
  })

  describe('offers', () => {
    /** What each shown pot's actions are given: whether the adapter can stick for the viewer, and the pots' groups. */
    const offers = async (cards: RewardCard[], state: AutoStickState | null = autoStickOn()) => {
      mocks.rewards.mockResolvedValue(cards)
      if (state) mocks.autoStick.mockResolvedValue(state)
      await renderTab()
      return pots().map(pot => pot.querySelector<HTMLElement>('[data-flow="claim"]')!.dataset)
    }

    it('each pot its own actions, with the project, its card and the groups of every pot', async () => {
      mocks.funding.mockResolvedValue([fundedPot(4000n, OTHER, 5n)])
      const [first, second] = await offers([underlying(), underlying({ groupId: 4000n, token: OTHER })])
      expect(first).toMatchObject({ chain: String(CHAIN), project: '23', token: 'STICKYSLOPSHOP', pot: `0:${TOKEN.toLowerCase()}`, groups: '0,4000' })
      expect(second).toMatchObject({ pot: `4000:${OTHER}`, groups: '0,4000' })
    })

    it('to claim and stick when the viewer trusts the adapter', async () => {
      expect((await offers([underlying()]))[0].canStick).toBe('true')
    })

    it('to claim and stick when the project granted the adapter, even if the holder does not trust it', async () => {
      expect((await offers([underlying()], autoStickOn({ projectGranter: true, personallyTrusted: false })))[0].canStick).toBe('true')
    })

    it('only to collect when the adapter cannot resolve the project, whoever trusts it', async () => {
      const state = autoStickOn({ status: AS_STATUS.INVALID_PROJECT, projectGranter: true, personallyTrusted: true })
      expect((await offers([underlying()], state))[0].canStick).toBe('false')
    })

    it('only to collect when the adapter cannot stick for the holder', async () => {
      expect((await offers([underlying()], autoStickOn({ projectGranter: false, personallyTrusted: false })))[0].canStick).toBe('false')
    })

    it('only to collect until the viewer\'s auto-stick has been read', async () => {
      mocks.autoStick.mockReturnValue(new Promise(() => {}))
      expect((await offers([underlying()], null))[0].canStick).toBe('false')
    })
  })
})

describe('the pots that are looked at', () => {
  /** `count` pots, each in a group and a token of its own, the last funded the newest. */
  const crowd = (count: number) =>
    Array.from({ length: count }, (_, at) =>
      fundedPot(BigInt(at + 1) * 1000n, `0x${(at + 1).toString(16).padStart(40, '0')}` as Address, 1n, at),
    )
  const said = () => [...rewards().querySelectorAll('p')].map(each => each.textContent).find(text => /^and \d+ more/.test(text ?? ''))

  it('are the newest 12 funded, and the staked token under group 0 and their groups, and the rest are counted', async () => {
    mocks.funding.mockResolvedValue(crowd(30))
    await renderTab()

    const rows = mocks.rewards.mock.calls.at(-1)![3] as RewardPot[]
    expect(rows).toHaveLength(12 + 13)
    expect(rows.slice(0, 12).map(row => row.groupId)).toEqual(Array.from({ length: 12 }, (_, at) => BigInt(19 + at) * 1000n))
    expect(said()).toBe('and 18 more airdrops')
  })

  it('give the same groups to auto-stick, so what it reads does not grow with what a project is funded with either', async () => {
    mocks.funding.mockResolvedValue(crowd(30))
    await renderTab()
    const { groups } = mocks.autoStick.mock.calls.at(-1)![3]
    expect(groups).toEqual([0n, ...Array.from({ length: 12 }, (_, at) => BigInt(19 + at) * 1000n)])
  })

  it('say one more airdrop in the singular, and nothing when none is left out', async () => {
    mocks.funding.mockResolvedValue(crowd(13))
    await renderTab()
    expect(said()).toBe('and 1 more airdrop')

    await act(async () => root.unmount())
    root = createRoot(host)
    client.clear()
    mocks.funding.mockResolvedValue(crowd(12))
    await renderTab()
    expect(said()).toBeUndefined()
  })
})

describe('the pots that could not be listed', () => {
  it('shows the staked token\'s, says the list is incomplete, tells the console, and reads the list again on Try again', async () => {
    const failure = new Error('over budget')
    mocks.funding.mockRejectedValueOnce(failure)
    await renderTab()

    expect(mocks.rewards.mock.calls[0][3].map((row: RewardPot) => `${row.groupId}:${row.token}`)).toEqual([`0:${TOKEN.toLowerCase()}`])
    expect(pots()).toHaveLength(1)
    const alert = rewards().querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('Could not list every airdrop.')
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('airdrops'), { chainId: CHAIN, projectId: 23 }, failure)

    mocks.funding.mockResolvedValue([fundedPot(4000n, OTHER, 5n)])
    await act(async () => buttonNamed(alert, 'Try again').click())
    await settled()
    expect(mocks.funding).toHaveBeenCalledTimes(2)
    expect(rewards().querySelector('[role="alert"]')).toBeNull()
    expect(mocks.rewards.mock.calls.at(-1)![3]).toHaveLength(3)
  })

  it('says a project is too old to list, without offering to try again, for a history no scan can reach', async () => {
    const failure = new HistoryTooLongError('This history spans 9000000 blocks, more than this RPC can scan in 1024 requests.')
    mocks.funding.mockRejectedValue(failure)
    await renderTab()

    expect(rewards().textContent).toContain('This project is too old to list every airdrop here.')
    expect(rewards().textContent).not.toContain('Could not list every airdrop.')
    expect(rewards().querySelector('[role="alert"]')).toBeNull()
    expect(buttonsOf(rewards()).includes('Try again')).toBe(false)
    // The staked token's pot and the check for another token are still there, and the console has been told.
    expect(pots()).toHaveLength(1)
    expect(rewards().querySelector('input')).not.toBeNull()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('airdrops'), { chainId: CHAIN, projectId: 23 }, failure)
    expect(mocks.funding).toHaveBeenCalledTimes(1)
  })

  it('tries once: a scan that cannot finish would only be sent again', async () => {
    mocks.funding.mockRejectedValue(new Error('over budget'))
    const retrying = new QueryClient() // the defaults retry a failed read three times
    await renderTab(retrying)
    await settle(30_000)
    expect(mocks.funding).toHaveBeenCalledTimes(1)
    retrying.clear()
  })
})

describe('the check for another reward token', () => {
  const field = () => rewards().querySelector<HTMLInputElement>('input')!
  async function enter(text: string) {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(field(), text)
      field().dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => buttonNamed(rewards(), 'Check').click())
    await settled()
  }

  it('turns down text that is not an address', async () => {
    await renderTab()
    await enter('0x123')
    expect(rewards().querySelector('[role="alert"]')?.textContent).toBe('Enter a token address.')
    expect(mocks.rewards).toHaveBeenCalledTimes(1)
  })

  it('looks for rewards in the token under every group, and forgets the address it was given', async () => {
    mocks.funding.mockResolvedValue([fundedPot(4000n, OTHER, 5n)])
    await renderTab()
    const checked = `0x${'AB'.repeat(20)}`
    await enter(checked)

    expect(field().value).toBe('')
    expect(rewards().querySelector('[role="alert"]')).toBeNull()
    const rows = mocks.rewards.mock.calls.at(-1)![3].map((row: RewardPot) => `${row.groupId}:${row.token}`)
    expect(rows).toEqual([
      `4000:${OTHER}`,
      `0:${TOKEN.toLowerCase()}`,
      `0:${checked.toLowerCase()}`,
      `4000:${TOKEN.toLowerCase()}`,
      `4000:${checked.toLowerCase()}`,
    ])
    // A token already among them is not asked about twice.
    await enter(checked.toLowerCase())
    expect(mocks.rewards.mock.calls.at(-1)![3]).toHaveLength(5)
  })
})

describe('the reads behind the rewards', () => {
  it('wait for this visit\'s read of the project, and show placeholders until they land', async () => {
    const read = Promise.withResolvers<ReturnType<typeof slopshop>>()
    mocks.project.mockReturnValue(read.promise)
    await renderTab()
    expect(mocks.funding).not.toHaveBeenCalled()
    expect(mocks.rewards).not.toHaveBeenCalled()
    expect(mocks.autoStick).not.toHaveBeenCalled()
    expect(rewards().querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(rewards().querySelector('.skeleton-shimmer')).not.toBeNull()

    await act(async () => read.resolve(slopshop()))
    await settled()
    expect(pots()).toHaveLength(1)
    expect(rewards().querySelector('[aria-busy="true"]')).toBeNull()
  })

  it('do not rest on a copy of the project the browser kept: they wait for this visit\'s read of it', async () => {
    const storage = memoryStorage()
    // An earlier visit read the project, and the browser kept it.
    const earlier = newClient()
    const stop = installQueryPersistence(earlier, storage)
    await renderTab(earlier)
    await settle(1_000)
    stop()
    await act(async () => root.unmount())
    root = createRoot(host)
    vi.clearAllMocks()

    // This visit, moments later: the project's read has not answered yet, so nothing is read on the kept copy's word.
    const read = Promise.withResolvers<ReturnType<typeof slopshop>>()
    mocks.project.mockReset().mockReturnValue(read.promise)
    const now = newClient()
    installQueryPersistence(now, storage)
    await renderTab(now)
    expect(mocks.funding).not.toHaveBeenCalled()
    expect(mocks.rewards).not.toHaveBeenCalled()
    expect(mocks.autoStick).not.toHaveBeenCalled()
    expect(rewards().querySelector('.skeleton-shimmer')).not.toBeNull()

    await act(async () => read.resolve(slopshop()))
    await settled()
    expect(mocks.funding).toHaveBeenCalledTimes(1)
    expect(mocks.rewards).toHaveBeenCalledTimes(1)
    expect(pots()).toHaveLength(1)
    now.clear()
  })

  it('say the rewards could not be read, tell the console why, and read them again on Try again', async () => {
    const failure = new Error('429')
    mocks.rewards.mockRejectedValueOnce(failure)
    await renderTab()

    const alert = rewards().querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('Could not read the rewards.')
    expect(pots()).toHaveLength(0)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('rewards'), { chainId: CHAIN, projectId: 23 }, failure)

    await act(async () => buttonNamed(alert, 'Try again').click())
    await settled()
    expect(rewards().querySelector('[role="alert"]')).toBeNull()
    expect(pots()).toHaveLength(1)
  })

  it('say the project could not be read when it cannot, and read it again on Try again', async () => {
    mocks.project.mockRejectedValueOnce(new Error('not a Sticky token'))
    await renderTab()
    const alert = rewards().querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('Could not read this Sticky token.')
    await act(async () => buttonNamed(alert, 'Try again').click())
    await settled()
    expect(pots()).toHaveLength(1)
  })

  it('read the cards again every 15 seconds, and not while the tab is hidden', async () => {
    await renderTab()
    expect(mocks.rewards).toHaveBeenCalledTimes(1)
    expect(mocks.autoStick).toHaveBeenCalledTimes(1)

    await settle(15_000)
    expect(mocks.rewards).toHaveBeenCalledTimes(2)
    expect(mocks.autoStick).toHaveBeenCalledTimes(2)

    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await settle(45_000)
    expect(mocks.rewards).toHaveBeenCalledTimes(2)
    expect(mocks.autoStick).toHaveBeenCalledTimes(2)

    hidden.mockReturnValue(false)
    state.mockReturnValue('visible')
    await settle(15_000)
    expect(mocks.rewards).toHaveBeenCalledTimes(3)
    expect(mocks.autoStick).toHaveBeenCalledTimes(3)
  })

  it('keep the cards they showed, and tell the console, when a refresh fails', async () => {
    await renderTab()
    const failure = new Error('429')
    mocks.rewards.mockRejectedValue(failure)
    await settle(15_000)
    expect(pots()).toHaveLength(1)
    expect(rewards().querySelector('[role="alert"]')).toBeNull()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('rewards'), { chainId: CHAIN, projectId: 23 }, failure)
  })

  it('never show one project\'s cards under another', async () => {
    await renderTab()
    mocks.rewards.mockResolvedValue([underlying({ meta: { symbol: 'OTHERTOKEN', decimals: 6 } })])
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <AirdropsTab chainId={CHAIN} projectId={24} />
        </QueryClientProvider>,
      ),
    )
    await settled()
    expect(pots().map(pot => pot.querySelector('span[title]')?.textContent)).toEqual(['OTHERTOKEN'])
  })

  it('never show one account\'s rewards, auto-stick or trusted senders under another', async () => {
    const mine = (holder: Address) => holder.toLowerCase() === VIEWER.toLowerCase()
    mocks.events.mockResolvedValue({ events: [trust(SENDER), { ...trust(SENDER), holder: HOLDER }], source: 'indexed', degraded: null })
    mocks.rewards.mockImplementation(async (_chain, _token, holder: Address) =>
      mine(holder) ? [underlying({ meta: { symbol: 'MINE', decimals: 6 } })] : new Promise(() => {}),
    )
    mocks.autoStick.mockImplementation(async (_chain, _project, holder: Address) => (mine(holder) ? autoStickOn() : new Promise(() => {})))
    mocks.trusted.mockImplementation(async (_events, { holder }: { holder: Address }) => (mine(holder) ? [SENDER] : new Promise(() => {})))
    await renderTab()
    expect(pots().map(pot => pot.textContent)).toEqual([expect.stringContaining('MINE')])
    expect(autoStick()).not.toBeNull()
    expect(trusted().textContent).toContain(short(SENDER))

    // Another account is in View as, and its reads have not landed.
    await act(async () => setViewAs(HOLDER))
    await settled()
    expect(pots()).toHaveLength(0)
    expect(rewards().querySelector('.skeleton-shimmer')).not.toBeNull()
    expect(host.textContent).not.toContain('MINE')
    expect(host.querySelector('section[aria-busy="true"]')).not.toBeNull()
    expect(trusted().textContent).not.toContain(short(SENDER))
    expect(trusted().querySelector('.skeleton-shimmer')).not.toBeNull()
  })

  it('keep nothing of an account or of what it has, in the browser', async () => {
    const storage = memoryStorage()
    const stop = installQueryPersistence(client, storage)
    mocks.trusted.mockResolvedValue([SENDER])
    mocks.events.mockResolvedValue({ events: [trust(SENDER)], source: 'indexed', degraded: null })
    await renderTab()
    await settle(1_000)
    stop()
    expect(rewards().querySelector('li')).not.toBeNull()
    expect(trusted().textContent).toContain(short(SENDER))
    const kept = storage.getItem('sticky:query-cache:v1') ?? ''
    expect(kept.toLowerCase()).not.toContain(VIEWER.toLowerCase())
    expect(kept.toLowerCase()).not.toContain(SENDER.toLowerCase())
    expect(kept).not.toContain('sticky-rewards')
    expect(kept).not.toContain('sticky-autostick')
    expect(kept).not.toContain('sticky-trusted')
  })
})

describe('the reads when the tab is shown again', () => {
  const counts = () => [mocks.rewards.mock.calls.length, mocks.autoStick.mock.calls.length, mocks.trusted.mock.calls.length]

  it('read the viewer\'s again as soon as the browser tab is shown again, whatever the site\'s defaults', async () => {
    const site = siteClient()
    await renderTab(site)
    expect(counts()).toEqual([1, 1, 1])

    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })))
    await settled()
    expect(counts()).toEqual([1, 1, 1])

    state.mockReturnValue('visible')
    await act(async () => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })))
    await settled()
    expect(counts()).toEqual([2, 2, 2])
    // The pots the scan found are not scanned for again: they are the project's, not the viewer's.
    expect(mocks.funding).toHaveBeenCalledTimes(1)
    site.clear()
  })
})

describe('a panel that is hidden', () => {
  const counts = () => [mocks.rewards.mock.calls.length, mocks.autoStick.mock.calls.length, mocks.trusted.mock.calls.length]

  beforeEach(() => {
    FakeObserver.all = []
    vi.stubGlobal('IntersectionObserver', FakeObserver)
  })

  it('is watched by its own element, which the tabs hide and show, with a margin around the screen', async () => {
    await renderTab()
    expect(FakeObserver.all).toHaveLength(1)
    expect(FakeObserver.all[0].options).toEqual({ rootMargin: '600px 0px' })
    expect(FakeObserver.all[0].element).toBe(host.firstElementChild)
    expect(host.firstElementChild?.contains(rewards())).toBe(true)
  })

  it('reads nothing of the viewer\'s, and shows what it had, and reads at once and then every 15 seconds when it is shown', async () => {
    await renderTab()
    expect(counts()).toEqual([1, 1, 1])

    await act(async () => FakeObserver.tell(false))
    await settle(60_000)
    expect(counts()).toEqual([1, 1, 1])
    expect(pots()).toHaveLength(1)

    await act(async () => FakeObserver.tell(true))
    await settled()
    expect(counts()).toEqual([2, 2, 2])
    await settle(15_000)
    expect(counts()).toEqual([3, 3, 3])
  })

  it('is not read when the browser tab is shown again while it is hidden, and is when it is shown', async () => {
    const site = siteClient()
    await renderTab(site)
    await act(async () => FakeObserver.tell(false))

    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })))
    state.mockReturnValue('visible')
    await act(async () => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })))
    await settled()
    expect(counts()).toEqual([1, 1, 1])

    await act(async () => FakeObserver.tell(true))
    await settled()
    expect(counts()).toEqual([2, 2, 2])
    site.clear()
  })

  it('still finds the pots, once, while it is hidden: the scan is the project\'s and is not the viewer\'s to repeat', async () => {
    const scan = Promise.withResolvers<FundedPot[]>()
    mocks.funding.mockReturnValue(scan.promise)
    await renderTab()
    await act(async () => FakeObserver.tell(false))
    await act(async () => scan.resolve([fundedPot(4000n, OTHER, 5n)]))
    await settled()
    expect(mocks.funding).toHaveBeenCalledTimes(1)

    await act(async () => FakeObserver.tell(true))
    await settled()
    expect(mocks.funding).toHaveBeenCalledTimes(1)
    expect((mocks.rewards.mock.calls.at(-1)![3] as RewardPot[]).some(row => row.groupId === 4000n)).toBe(true)
  })

  it('stops watching when the tab is closed', async () => {
    await renderTab()
    expect(FakeObserver.all).toHaveLength(1)
    await act(async () => root.unmount())
    expect(FakeObserver.all).toHaveLength(0)
    root = createRoot(host)
  })
})

describe('auto-stick', () => {
  const state = () => autoStick()!.querySelector('[data-autostick-state]')!.textContent
  /** What the card gives its actions. */
  const actions = () => autoStick()!.querySelector<HTMLElement>('[data-flow="autostick"]')!.dataset

  it('says it is off, and offers to turn it on', async () => {
    mocks.autoStick.mockResolvedValue(autoStickOn({ enabled: false, status: AS_STATUS.DISABLED, minimum: 0n, cooldown: 0 }))
    await renderTab()
    expect(autoStick()!.querySelector('h2')?.textContent).toBe('Auto-stick SLOPSHOP rewards')
    expect(autoStick()!.textContent).toContain('Stick your SLOPSHOP rewards into STICKYSLOPSHOP as they unlock.')
    expect(state()).toBe('OffUnlocked SLOPSHOP rewards stay claimable until you collect them.')
    expect(actions()).toMatchObject({ chain: String(CHAIN), project: '23', token: 'STICKYSLOPSHOP', enabled: 'false' })
  })

  it('says what it does while on, when it last did it, and what holds it back', async () => {
    mocks.autoStick.mockResolvedValue(autoStickOn({ lastCompoundedAt: Math.floor(Date.now() / 1000) - 7_200 }))
    await renderTab()
    expect(state()).toBe(
      'OnUnlocked SLOPSHOP rewards auto-stick when at least 1 SLOPSHOP is ready, at most once every 1d 0h.Last auto-stick: 2h agoReady to auto-stick',
    )
    expect(actions()).toMatchObject({ enabled: 'true', status: String(AS_STATUS.READY) })
  })

  it.each([
    [AS_STATUS.COOLDOWN, { nextCompoundAt: Math.floor(Date.now() / 1000) + 91_000 }, 'Next auto-stick in 1d 1h'],
    [AS_STATUS.BELOW_MINIMUM, { collectable: 500_000n }, '0.5 SLOPSHOP ready | minimum 1'],
    [AS_STATUS.NOT_TRUSTED, {}, 'Permission removed | repair setup'],
    [AS_STATUS.INSUFFICIENT_ALLOWANCE, {}, 'Allowance exhausted | renew'],
    [AS_STATUS.ZERO_ISSUANCE, {}, 'Wait for more rewards: the current amount is too small to mint a Sticky token unit'],
  ])('for status %i says "%s", and gives its actions the state that says what they offer', async (status, extra, line) => {
    mocks.autoStick.mockResolvedValue(autoStickOn({ status, ...extra }))
    await renderTab()
    expect(state()).toContain(line)
    expect(actions()).toMatchObject({ status: String(status) })
  })

  it('gives its actions the groups the pots are in', async () => {
    mocks.funding.mockResolvedValue([fundedPot(4008n, OTHER, 5n), fundedPot(4000n, OTHER, 5n)])
    await renderTab()
    expect(actions().groups).toBe('0,4000,4008')
  })

  it('reads the viewer\'s auto-stick for the groups the pots are in', async () => {
    mocks.funding.mockResolvedValue([fundedPot(4008n, OTHER, 5n), fundedPot(4000n, OTHER, 5n)])
    await renderTab()
    expect(mocks.autoStick).toHaveBeenCalledTimes(1)
    expect(mocks.autoStick).toHaveBeenCalledWith(CHAIN, 23n, VIEWER, {
      info: slopshop(),
      groups: [0n, 4000n, 4008n],
      signal: expect.any(AbortSignal),
    })
  })

  it('closes the card, and tells the console, for a project the adapter cannot resolve: it fails closed', async () => {
    mocks.autoStick.mockResolvedValue(autoStickOn({ status: AS_STATUS.INVALID_PROJECT, enabled: false }))
    await renderTab()
    expect(autoStick()).toBeNull()
    expect(host.textContent).not.toContain('Auto-stick')
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('misconfigured'), { chainId: CHAIN, projectId: 23 })
    // The other cards are as they were.
    expect(pots()).toHaveLength(1)
    expect(trusted()).not.toBeNull()
  })

  it('is left out with no account, and nothing is read for it', async () => {
    mocks.address = undefined
    await renderTab()
    expect(autoStick()).toBeNull()
    expect(mocks.autoStick).not.toHaveBeenCalled()
  })

  it('draws a placeholder while it is read, and says so when it cannot be', async () => {
    const read = Promise.withResolvers<AutoStickState>()
    mocks.autoStick.mockReturnValue(read.promise)
    await renderTab()
    expect(host.querySelector('section[aria-busy="true"] .skeleton-shimmer')).not.toBeNull()

    const failure = new Error('429')
    await act(async () => read.reject(failure))
    await settled()
    const alert = host.querySelector('section [role="alert"]')!
    expect(alert.textContent).toContain('Could not read auto-stick.')
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('auto-stick'), { chainId: CHAIN, projectId: 23 }, failure)

    mocks.autoStick.mockResolvedValue(autoStickOn())
    await act(async () => buttonNamed(alert, 'Try again').click())
    await settled()
    expect(autoStick()!.querySelector('h2')?.textContent).toBe('Auto-stick SLOPSHOP rewards')
  })

  it('keeps the state it showed, and tells the console, when a refresh fails', async () => {
    await renderTab()
    const failure = new Error('429')
    mocks.autoStick.mockRejectedValue(failure)
    await settle(15_000)
    expect(autoStick()!.querySelector('h2')?.textContent).toBe('Auto-stick SLOPSHOP rewards')
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('auto-stick'), { chainId: CHAIN, projectId: 23 }, failure)
  })
})

describe('who can stick for the viewer', () => {
  const rows = () => [...trusted().querySelectorAll('li')]

  it('lists the senders the hook says they trust, each with an Untrust button, and a Trust button', async () => {
    const events = [trust(SENDER), trust(OTHER)]
    mocks.events.mockResolvedValue({ events, source: 'indexed', degraded: null })
    mocks.trusted.mockResolvedValue([SENDER, OTHER])
    await renderTab()

    expect(trusted().querySelector('h2')?.textContent).toBe('Who can stick for you')
    expect(trusted().textContent).toContain('Addresses you trust can stick tokens for you.')
    expect(rows().map(row => row.querySelector('span')?.textContent)).toEqual([short(SENDER), short(OTHER)])
    expect(rows().map(row => buttonsOf(row))).toEqual([['Untrust'], ['Untrust']])
    expect([...trusted().querySelectorAll('button')].every(button => !button.disabled)).toBe(true)
    expect(buttonsOf(trusted()).at(-1)).toBe('Trust')
    expect(mocks.trusted).toHaveBeenCalledWith(events, { chainId: CHAIN, projectId: 23n, holder: VIEWER, signal: expect.any(AbortSignal) })
    expect(trusted().querySelector('[data-flow="trust"]')).toBeNull()
  })

  it('names each sender as the rest of the page does: by its name on a production chain, else its short address', async () => {
    const LOWER = `0x${'ab'.repeat(20)}` as Address
    mocks.events.mockResolvedValue({ events: [trust(SENDER), trust(LOWER)], source: 'indexed', degraded: null })
    // The hook's list holds addresses in lowercase.
    mocks.trusted.mockResolvedValue([SENDER, LOWER])
    mocks.ens.mockImplementation(async (address: string) => (address.toLowerCase() === SENDER.toLowerCase() ? 'sender.eth' : null))
    await renderTab()
    await settled()

    const labels = rows().map(row => row.querySelector('span[title]')!)
    expect(labels.map(label => label.textContent)).toEqual(['sender.eth', '0xabab…abab'])
    // The whole address is there on hover, and nowhere in the row's text.
    expect(labels.map(label => label.getAttribute('title'))).toEqual([SENDER, LOWER])
    expect(rows().every(row => !row.textContent!.includes(LOWER))).toBe(true)
    expect(mocks.ens).toHaveBeenCalledWith(SENDER, CHAIN)

    // A testnet asks mainnet for no names.
    mocks.ens.mockClear()
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <AirdropsTab chainId={84532} projectId={23} />
        </QueryClientProvider>,
      ),
    )
    await settled()
    expect(rows().map(row => row.querySelector('span[title]')!.textContent)).toEqual([short(SENDER), '0xabab…abab'])
    expect(mocks.ens).not.toHaveBeenCalled()
  })

  it('opens the trust flow for a new sender from Trust, and shows the list again when it closes', async () => {
    await renderTab()
    await act(async () => buttonNamed(trusted(), 'Trust').click())
    const flow = trusted().querySelector('[data-flow="trust"]')!
    expect(flow.getAttribute('data-chain')).toBe(String(CHAIN))
    expect(flow.getAttribute('data-project')).toBe('23')
    // The project the page has read, which the confirmation names.
    expect(flow.getAttribute('data-token')).toBe('STICKYSLOPSHOP')
    expect(flow.getAttribute('data-sender')).toBe('')

    await act(async () => buttonNamed(flow as HTMLElement, 'Close trust').click())
    expect(trusted().querySelector('[data-flow="trust"]')).toBeNull()
  })

  it('opens the trust flow for that sender from a row\'s Untrust', async () => {
    mocks.events.mockResolvedValue({ events: [trust(SENDER), trust(OTHER)], source: 'indexed', degraded: null })
    mocks.trusted.mockResolvedValue([SENDER, OTHER])
    await renderTab()
    await act(async () => buttonNamed(rows()[1], 'Untrust').click())
    const flow = trusted().querySelector('[data-flow="trust"]')!
    expect(flow.getAttribute('data-sender')).toBe(OTHER)
    expect(trusted().querySelectorAll('[data-flow="trust"]')).toHaveLength(1)
  })

  it('reads again, after a change of trust, who is trusted and the auto-stick, and not the rewards or the airdrops scan', async () => {
    mocks.events.mockResolvedValue({ events: [trust(SENDER)], source: 'indexed', degraded: null })
    mocks.trusted.mockResolvedValue([SENDER])
    await renderTab()
    const reads = [mocks.events, mocks.trusted, mocks.autoStick]
    const before = reads.map(read => read.mock.calls.length)
    const untouched = [mocks.rewards, mocks.funding, mocks.project].map(read => read.mock.calls.length)

    await act(async () => refreshAfterTrust(client, CHAIN, 23))
    await settled()
    reads.forEach((read, at) => expect(read.mock.calls.length).toBeGreaterThan(before[at]))
    expect([mocks.rewards, mocks.funding, mocks.project].map(read => read.mock.calls.length)).toEqual(untouched)
  })

  it('opens the trust flow with no account too: the flow asks them to sign in', async () => {
    mocks.address = undefined
    await renderTab()
    await act(async () => buttonNamed(trusted(), 'Trust').click())
    expect(trusted().querySelector('[data-flow="trust"]')).not.toBeNull()
  })

  it('says none yet when nobody is trusted', async () => {
    mocks.events.mockResolvedValue({ events: [trust(SENDER, false)], source: 'indexed', degraded: null })
    await renderTab()
    expect(rows()).toHaveLength(0)
    expect(trusted().textContent).toContain('None yet')
    expect(trusted().textContent).toContain("Only you and the project's trusted senders can stick for you.")
  })

  it('shows no list, and reads none, with no account', async () => {
    mocks.address = undefined
    await renderTab()
    expect(trusted().querySelector('h2')?.textContent).toBe('Who can stick for you')
    expect(rows()).toHaveLength(0)
    expect(trusted().textContent).not.toContain('None yet')
    expect(mocks.trusted).not.toHaveBeenCalled()
  })

  it('reads the confirmations again every 15 seconds, and again at once when the senders the events name change', async () => {
    mocks.events.mockResolvedValue({ events: [trust(SENDER)], source: 'indexed', degraded: null })
    mocks.trusted.mockResolvedValue([SENDER])
    await renderTab()
    expect(mocks.trusted).toHaveBeenCalledTimes(1)
    await settle(15_000)
    expect(mocks.trusted).toHaveBeenCalledTimes(2)

    mocks.events.mockResolvedValue({ events: [trust(SENDER), trust(OTHER)], source: 'indexed', degraded: null })
    await act(async () => void (await client.invalidateQueries({ queryKey: ['sticky-project', CHAIN, 23, 'events'] })))
    await settled()
    expect(mocks.trusted.mock.calls.at(-1)![0]).toHaveLength(2)
  })

  it('says it could not be read, and reads it again on Try again', async () => {
    mocks.trusted.mockRejectedValueOnce(new Error('429'))
    await renderTab()
    const alert = trusted().querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('Could not read who can stick for you.')
    mocks.trusted.mockResolvedValue([])
    await act(async () => buttonNamed(alert, 'Try again').click())
    await settled()
    expect(trusted().querySelector('[role="alert"]')).toBeNull()
    expect(trusted().textContent).toContain('None yet')
  })

  it('says so when the events it lists from could not be read, and reads them again on Try again', async () => {
    mocks.events.mockRejectedValueOnce(new Error('429'))
    await renderTab()
    const alert = trusted().querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('Could not read who can stick for you.')
    expect(mocks.trusted).not.toHaveBeenCalled()
    await act(async () => buttonNamed(alert, 'Try again').click())
    await settled()
    expect(trusted().textContent).toContain('None yet')
  })
})
