// @vitest-environment jsdom

import { QueryClient, QueryClientProvider, notifyManager, type QueryKey } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { erc20Abi, getAddress, type Abi, type Address, type Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stickyAutoStickAbi, stickyDistributorAbi, stickyHookAbi } from '@/lib/sticky-abis'
import { stickyDeployment } from '@/lib/sticky-addresses'
import type { RewardCard } from '@/lib/sticky-rewards'
import { clearViewAs, setViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import { EXTERNAL_WALLET_REQUIRED, WalletAuthContext } from '@/providers/WalletAuthContext'
import { stickyInfo } from '../home-fixtures'

// A pot's actions: collecting what has unlocked, starting what finished rounds earned vesting, and claiming and sticking
// the staked token's rewards through the auto-stick adapter. The reads and the engine are mocks: the builders, the reads
// and the engine have tests of their own (test/lib/sticky-builders.test.ts, sticky-rewards.test.ts,
// sticky-autostick.test.ts, sticky-quotes.test.ts, preflight.test.ts and test/transactions).

const CHAIN = 84532
const PROJECT = 12
const deployment = stickyDeployment(CHAIN)!
const DISTRIBUTOR = deployment.distributor
const ADAPTER = deployment.autoStick
const HOOK = deployment.hook
const ALICE = getAddress(`0x${'a1'.repeat(20)}`)
const CAROL = getAddress(`0x${'c4'.repeat(20)}`)
const ART = getAddress(`0x${'2'.repeat(40)}`)
const USDC = getAddress(`0x${'6b'.repeat(20)}`)
const HASH = `0x${'c3'.repeat(32)}` as Hex
/** Project 12 on Base Sepolia sticks ART, of 6 decimals, for STICKYART. */
const INFO = stickyInfo(CHAIN, BigInt(PROJECT), { stakedToken: ART, symbol: 'ART', decimals: 6, stSymbol: 'STICKYART' })
const SCHEDULE = { roundDuration: 604_800n, vestingRounds: 4n, start: 1_790_295_566n, round: 2n }
const nothing = { collectable: 0n, vesting: 0n, earned: 0n, nextUnlockAt: null, unlockedAt: null }

/** Everyone's ART pot, with 0.5 ART to collect. */
const pot = (extra: Partial<RewardCard> = {}): RewardCard => ({
  groupId: 0n,
  token: ART.toLowerCase() as Address,
  funded: 10_000_000n,
  meta: { symbol: 'ART', decimals: 6 },
  fundedThisRound: 0n,
  position: { ...nothing, collectable: 500_000n },
  schedule: SCHEDULE,
  ...extra,
})

type Phase = 'idle' | 'review' | 'simulating' | 'signing' | 'pending' | 'success' | 'error'
type EngineState = {
  phase: Phase
  busy: boolean
  error: string | null
  hash: Hex | null
  receipt: { blockNumber: bigint } | null
  isSafe: boolean
  safeProposalHash: null
  safeNonceGuidance: null
  send: ReturnType<typeof vi.fn>
  reset: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => ({
  wallet: {} as { address: string | undefined; isConnected: boolean; isCenterWallet: boolean; openSignIn: ReturnType<typeof vi.fn> },
  requestSignIn: vi.fn(),
  tx: {} as EngineState,
  read: vi.fn(),
  vest: vi.fn(),
  groups: vi.fn(),
  quote: vi.fn(),
  preflight: vi.fn(),
}))

vi.mock('@/hooks/useWallet', () => ({ useWallet: () => mocks.wallet }))
vi.mock('@/hooks/useSafeTx', async importOriginal => ({
  ...(await importOriginal<typeof import('@/hooks/useSafeTx')>()),
  useSafeTx: () => mocks.tx,
}))
vi.mock('@/lib/sticky-rewards', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-rewards')>()),
  readAt: mocks.read,
  hasRewardsToVest: mocks.vest,
}))
vi.mock('@/lib/sticky-autostick', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-autostick')>()),
  stakedRewardGroups: mocks.groups,
}))
vi.mock('@/lib/sticky-quotes', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-quotes')>()),
  quoteStick: mocks.quote,
}))
vi.mock('@/lib/preflight', () => ({ preflight: mocks.preflight }))

import { ClaimFlow } from '@/components/project/flows/ClaimFlow'

const engine = (): EngineState => {
  const state: EngineState = {
    phase: 'idle',
    busy: false,
    error: null,
    hash: null,
    receipt: null,
    isSafe: false,
    safeProposalHash: null,
    safeNonceGuidance: null,
    send: vi.fn(async () => {
      state.phase = 'pending'
      state.busy = true
      state.error = null
      state.hash = null
      state.receipt = null
      return HASH
    }),
    reset: vi.fn(() => {
      state.phase = 'idle'
      state.busy = false
      state.error = null
      state.hash = null
      state.receipt = null
    }),
  }
  return state
}

/** What the chain says, by the function a read asks: what a pot holds to collect, and the adapter's standing. */
type World = { collectable: bigint; granter: boolean; trusted: boolean; allowance: bigint }
let chain: World
const answer = (result: unknown) => ({ status: 'success', result })

let host: HTMLDivElement
let root: Root
let client: QueryClient

beforeEach(() => {
  notifyManager.setScheduler(callback => queueMicrotask(callback))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.wallet = { address: ALICE, isConnected: true, isCenterWallet: false, openSignIn: vi.fn() }
  mocks.requestSignIn.mockReset().mockResolvedValue(undefined)
  mocks.tx = engine()
  chain = { collectable: 500_000n, granter: false, trusted: true, allowance: 0n }
  mocks.read.mockReset().mockImplementation(async (_chain: number, calls: { functionName: string }[]) =>
    calls.map(({ functionName }) =>
      answer(
        functionName === 'collectableFor'
          ? chain.collectable
          : functionName === 'isGranterOf'
            ? chain.granter
            : functionName === 'isTrustedSenderOf'
              ? chain.trusted
              : chain.allowance,
      ),
    ),
  )
  mocks.vest.mockReset().mockResolvedValue(true)
  mocks.groups.mockReset().mockImplementation(async () => ({ groupIds: [0n, 4000n], collectable: 700_000n }))
  mocks.quote.mockReset().mockResolvedValue(690_000_000_000_000_000n)
  mocks.preflight.mockReset().mockResolvedValue(undefined)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  client.clear()
  clearViewAs()
  vi.useRealTimers()
})

const settle = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))
async function settled() {
  for (let round = 0; round < 5; round += 1) await settle()
}

/** What the pot shows and the flow is given: the card, whether the adapter can stick for the holder, and the groups. */
let shown: { card: RewardCard; canStick: boolean; groups: bigint[] }
beforeEach(() => {
  shown = { card: pot(), canStick: true, groups: [0n, 4000n] }
})
async function render(next: Partial<typeof shown> = {}) {
  shown = { ...shown, ...next }
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <WalletAuthContext.Provider value={{ requestSignIn: mocks.requestSignIn }}>
          <ClaimFlow chainId={CHAIN} projectId={PROJECT} info={INFO} card={shown.card} groups={shown.groups} canStick={shown.canStick} />
        </WalletAuthContext.Provider>
      </QueryClientProvider>,
    ),
  )
  await settled()
}

const confirm = () => document.querySelector<HTMLElement>('section[data-tx-confirm]')
const buttonsOf = (within: ParentNode) => [...within.querySelectorAll('button')].map(button => button.textContent)
const buttonIn = (within: ParentNode | null, name: string) =>
  [...(within?.querySelectorAll('button') ?? [])].find(each => each.textContent === name) as HTMLButtonElement | undefined
const press = async (within: ParentNode | null, name: string) => {
  const button = buttonIn(within, name)
  if (!button) throw new Error(`no ${name} button`)
  await act(async () => button.click())
  await settled()
}
const errorText = () => host.querySelector('p.wrap-anywhere')?.textContent ?? null
const steps = () =>
  [...(confirm()?.querySelectorAll('ol li') ?? [])].map(item => item.textContent!.replace(/^(?:\d+|✓)Step \d+ of \d+: /, ''))
const primary = () => confirm()!.querySelector<HTMLButtonElement>('footer button.btn-primary')!
const rowsOf = () =>
  Object.fromEntries(
    [...confirm()!.querySelectorAll('.grid > span')].reduce<string[][]>((pairs, cell, at) => {
      if (at % 2 === 0) pairs.push([cell.textContent ?? ''])
      else pairs[pairs.length - 1].push(cell.textContent ?? '')
      return pairs
    }, []),
  )
type Sent = { chainId: number; address: Address; abi: Abi; functionName: string; args: readonly unknown[] }
const sent = (at: number) => mocks.tx.send.mock.calls[at] as [Sent, { reviewedAccount: Address; simulationBlockNumber?: bigint; reverify?: () => Promise<unknown> }]
async function confirmed(block: bigint) {
  mocks.tx.phase = 'success'
  mocks.tx.busy = false
  mocks.tx.hash = HASH
  mocks.tx.receipt = { blockNumber: block }
  await render()
}

describe('the actions', () => {
  it('"Collect only" appears for the underlying token, beside Claim & stick, when the adapter can stick', async () => {
    await render()
    expect(buttonsOf(host)).toEqual(['Claim & stick', 'Collect only'])
  })

  it.each([
    ['another token', { token: USDC.toLowerCase() as Address }, true, ['Collect']],
    ['the staked token, when the adapter cannot stick for the holder', {}, false, ['Collect']],
    ['what finished rounds earned', { position: { ...nothing, earned: 5n } }, true, ['Start vesting']],
    ['a pot with nothing to collect or vest', { position: { ...nothing, vesting: 5n } }, true, []],
  ])('offer to collect, or start vesting, for %s', async (_name, card, canStick, buttons) => {
    await render({ card: pot(card as Partial<RewardCard>), canStick })
    expect(buttonsOf(host)).toEqual(buttons)
  })
})

describe('collecting', () => {
  it('wallet-action:collect-rewards-or-start-vesting normal reward collection is one transaction because the distributor already starts vesting', async () => {
    await render({ card: pot({ token: USDC.toLowerCase() as Address, meta: { symbol: 'USDC', decimals: 6 } }) })
    await press(host, 'Collect')
    expect(mocks.read).toHaveBeenCalledWith(
      CHAIN,
      [{ address: DISTRIBUTOR, abi: stickyDistributorAbi, functionName: 'collectableFor', args: [INFO.stToken, 0n, BigInt(ALICE), USDC.toLowerCase()] }],
      undefined,
      expect.any(AbortSignal),
    )
    expect(steps()).toEqual(['Collect unlocked rewards'])
    expect(rowsOf()).toMatchObject({ Ready: '0.5 USDC', Who: 'Everyone', On: 'Base Sepolia' })
    expect(rowsOf().Forfeit).toBeUndefined()
    // It is tried against the chain first, as the holder will send it.
    const [tried, account] = mocks.preflight.mock.calls[0]
    expect(account).toBe(ALICE)
    expect(tried).toMatchObject({ address: DISTRIBUTOR, functionName: 'collectVestedRewards' })

    await press(confirm(), 'Confirm & collect')
    const [request, options] = sent(0)
    expect(request).toMatchObject({
      chainId: CHAIN,
      address: DISTRIBUTOR,
      functionName: 'collectVestedRewards',
      args: [INFO.stToken, 0n, [BigInt(ALICE)], [USDC.toLowerCase()], ALICE],
    })
    expect(request).toBe(tried)
    expect(options.reviewedAccount).toBe(ALICE)
    expect(mocks.tx.send).toHaveBeenCalledOnce()
  })

  it('wallet-action:collect-rewards-or-start-vesting starts vesting with the same call when nothing has unlocked, after asking whether finished rounds earned any', async () => {
    chain.collectable = 0n
    await render({ card: pot({ position: { ...nothing, earned: 5n } }) })
    await press(host, 'Start vesting')
    expect(mocks.vest).toHaveBeenCalledWith(CHAIN, INFO.stToken, ALICE, ART.toLowerCase(), 0n, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(steps()).toEqual(['Start unlocking eligible rewards'])
    expect(rowsOf().Ready).toBe('0 ART')
    await press(confirm(), 'Confirm & start vesting')
    expect(sent(0)[0]).toMatchObject({ functionName: 'collectVestedRewards', args: [INFO.stToken, 0n, [BigInt(ALICE)], [ART.toLowerCase()], ALICE] })
  })

  it('vesting-only claims refuse a verified empty allocation', async () => {
    chain.collectable = 0n
    mocks.vest.mockResolvedValue(false)
    await render({ card: pot({ position: { ...nothing, earned: 5n } }) })
    await press(host, 'Start vesting')
    expect(errorText()).toBe('There are no rewards to unlock or collect yet.')
    expect(confirm()).toBeNull()
    expect(mocks.preflight).not.toHaveBeenCalled()
    expect(mocks.tx.send).not.toHaveBeenCalled()
  })

  it('per-group claims collect from that group and warn that exiting forfeits a stake-age allocation', async () => {
    await render({ card: pot({ groupId: 4008n }), canStick: false })
    await press(host, 'Collect')
    expect(mocks.read.mock.calls[0][1][0].args).toEqual([INFO.stToken, 4008n, BigInt(ALICE), ART.toLowerCase()])
    expect(rowsOf()).toMatchObject({
      Who: 'Staked 4–8 weeks',
      Forfeit: 'Stake-age rewards pay only stake you still hold. Unstick before claiming and they stay in the pot.',
    })
    await press(confirm(), 'Confirm & collect')
    expect(sent(0)[0].args[1]).toBe(4008n)
  })

  it('refuses a collect the chain would refuse, in its words, and opens no review', async () => {
    mocks.preflight.mockRejectedValue(new Error('The distributor would refuse this: JBDistributor_NoAccess'))
    await render()
    await press(host, 'Collect only')
    expect(errorText()).toBe('The distributor would refuse this: JBDistributor_NoAccess.')
    expect(confirm()).toBeNull()
  })

  it('says it went through, links it, and reads the holder\'s rewards, auto-stick and wallet again', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await render()
    await press(host, 'Collect only')
    await press(confirm(), 'Confirm & collect')
    await confirmed(10n)
    expect(confirm()!.textContent).toContain('Rewards collected')
    expect(confirm()!.querySelector('a')?.getAttribute('href')).toBe(`https://sepolia.basescan.org/tx/${HASH}`)
    expect(invalidate.mock.calls.map(([filters]) => filters!.queryKey as QueryKey)).toEqual([
      ['sticky-position', CHAIN, PROJECT],
      ['sticky-rewards', CHAIN, PROJECT],
      ['sticky-autostick', CHAIN, PROJECT],
    ])
    await press(confirm(), 'Done')
    expect(confirm()).toBeNull()
  })
})

describe('a review whose pot changes under it', () => {
  it('stays open, and says it went through, when its pot has nothing more to offer once its step lands', async () => {
    chain.collectable = 0n
    await render({ card: pot({ position: { ...nothing, earned: 5n } }) })
    await press(host, 'Start vesting')
    await press(confirm(), 'Confirm & start vesting')
    // The pot is read again: what was earned is vesting now, and the pot offers nothing.
    shown = { ...shown, card: pot({ position: { ...nothing, vesting: 5n, nextUnlockAt: 1n } }) }
    await confirmed(10n)
    expect(confirm()!.textContent).toContain('Unlocking started')
    expect(confirm()!.textContent).toContain('All transactions confirmed.')
    await press(confirm(), 'Done')
    expect(confirm()).toBeNull()
    expect(host.querySelectorAll('button')).toHaveLength(0)
  })

  it('tells the card while its review is open, so the card keeps its pot listed', async () => {
    const reviewing = vi.fn()
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ClaimFlow chainId={CHAIN} projectId={PROJECT} info={INFO} card={pot()} groups={[0n]} canStick onReviewing={reviewing} />
        </QueryClientProvider>,
      ),
    )
    await settled()
    expect(reviewing).toHaveBeenLastCalledWith(false)
    await press(host, 'Collect only')
    expect(reviewing).toHaveBeenLastCalledWith(true)
    await press(confirm(), 'Cancel')
    expect(reviewing).toHaveBeenLastCalledWith(false)
  })
})

describe('claiming and sticking', () => {
  it('wallet-action:approve-the-staked-token-for-a-claim-and-stick wallet-action:trust-the-auto-stick-adapter wallet-action:claim-and-stick-rewards claim-and-stick adds missing holder trust before the atomic claim', async () => {
    chain.trusted = false
    await render()
    await press(host, 'Claim & stick')
    expect(mocks.groups).toHaveBeenCalledWith(CHAIN, INFO, ALICE, [0n, 4000n], expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(mocks.read).toHaveBeenCalledWith(
      CHAIN,
      [
        { address: HOOK, abi: stickyHookAbi, functionName: 'isGranterOf', args: [12n, ADAPTER] },
        { address: HOOK, abi: stickyHookAbi, functionName: 'isTrustedSenderOf', args: [12n, ALICE, ADAPTER] },
        { address: ART, abi: erc20Abi, functionName: 'allowance', args: [ALICE, ADAPTER] },
      ],
      undefined,
      expect.any(AbortSignal),
    )
    expect(steps()).toEqual([
      'Allow the auto-stick contract to move this claim of 0.7 ART',
      'Allow the auto-stick contract to stick ART for you',
      'Claim & stick',
    ])
    expect(primary().textContent).toBe('Confirm & approve')

    await press(confirm(), 'Confirm & approve')
    expect(sent(0)[0]).toMatchObject({ address: ART, functionName: 'approve', args: [ADAPTER, 700_000n] })
    await confirmed(10n)
    expect(primary().textContent).toBe('Confirm & trust')
    await press(confirm(), 'Confirm & trust')
    expect(sent(1)[0]).toMatchObject({ address: HOOK, functionName: 'setTrustedSenderFor', args: [12n, ADAPTER, true] })
    expect(sent(1)[1].simulationBlockNumber).toBe(10n)
    await confirmed(11n)
    expect(primary().textContent).toBe('Confirm & stick')
    await press(confirm(), 'Confirm & stick')
    expect(sent(2)[0]).toMatchObject({ address: ADAPTER, abi: stickyAutoStickAbi, functionName: 'stickRewardsFor', args: [12n, [0n, 4000n]] })
    expect(sent(2)[1]).toMatchObject({ reviewedAccount: ALICE, simulationBlockNumber: 11n })
  })

  it('wallet-action:claim-and-stick-rewards auto-stick status, compounding, and vesting pass the groups holding underlying rewards', async () => {
    mocks.groups.mockResolvedValue({ groupIds: [4000n, 4008n], collectable: 500n })
    chain.allowance = 500n
    await render({ groups: [0n, 4000n, 4008n] })
    await press(host, 'Claim & stick')
    expect(mocks.groups.mock.calls[0][3]).toEqual([0n, 4000n, 4008n])
    expect(steps()).toEqual(['Claim & stick'])
    expect(rowsOf().Claim).toBe('0.0005 ART')
    await press(confirm(), 'Confirm & stick')
    expect(sent(0)[0].args).toEqual([12n, [4000n, 4008n]])
  })

  it('The mint estimate shows only when the adapter can already pay', async () => {
    await render()
    await press(host, 'Claim & stick')
    expect(mocks.quote).toHaveBeenCalledWith(CHAIN, 12n, ART, 700_000n, ADAPTER, ALICE, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(rowsOf()['Estimated Sticky tokens']).toBe('0.69 STICKYART')

    await act(async () => root.unmount())
    root = createRoot(host)
    mocks.quote.mockClear()
    chain.trusted = false
    await render()
    await press(host, 'Claim & stick')
    expect(mocks.quote).not.toHaveBeenCalled()
    expect(rowsOf()['Estimated Sticky tokens']).toBe('Quoted on chain after your trust step')
  })

  it('takes a project that made the adapter a granter as letting it pay, with no trust step', async () => {
    chain.trusted = false
    chain.granter = true
    await render()
    await press(host, 'Claim & stick')
    expect(steps()).toEqual(['Allow the auto-stick contract to move this claim of 0.7 ART', 'Claim & stick'])
    expect(mocks.quote).toHaveBeenCalled()
  })

  it('claim-and-stick supports more than 18 decimals and discloses a changing backing-price estimate', async () => {
    const big = stickyInfo(CHAIN, BigInt(PROJECT), { stakedToken: ART, symbol: 'ART', decimals: 24, stSymbol: 'STICKYART' })
    mocks.groups.mockResolvedValue({ groupIds: [0n], collectable: 1_000_000n })
    mocks.quote.mockResolvedValue(777n)
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ClaimFlow chainId={CHAIN} projectId={PROJECT} info={big} card={pot({ meta: { symbol: 'ART', decimals: 24 } })} groups={[0n]} canStick />
        </QueryClientProvider>,
      ),
    )
    await settled()
    await press(host, 'Claim & stick')
    expect(rowsOf()).toMatchObject({
      Claim: '0.000000000000000001 ART',
      'Estimated Sticky tokens': '0.000000000000000777 STICKYART',
      Rate: 'Current backing price at execution, which can change before confirmation.',
    })
  })

  it('manual and automatic compounding reject a zero canonical mint for any token precision', async () => {
    mocks.quote.mockRejectedValue(new Error('this amount is too small or cannot be priced precisely enough at the current backing price'))
    await render()
    await press(host, 'Claim & stick')
    expect(errorText()).toBe('This amount is too small or cannot be priced precisely enough at the current backing price.')
    expect(confirm()).toBeNull()
    // A price the terminal gives is an answer, which the console need not be told of.
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('refuses when nothing is claimable, before it reads anything more', async () => {
    mocks.groups.mockResolvedValue({ groupIds: [0n], collectable: 0n })
    await render()
    await press(host, 'Claim & stick')
    expect(errorText()).toBe('Nothing is claimable yet. Rewards unlock a round after you collect them.')
    expect(mocks.read).not.toHaveBeenCalled()
    expect(confirm()).toBeNull()
  })

  it('reads the claim again before each step, and stops one whose rewards changed', async () => {
    await render()
    await press(host, 'Claim & stick')
    await press(confirm(), 'Confirm & approve')
    const { reverify } = sent(0)[1]
    mocks.groups.mockClear()
    await expect(reverify!()).resolves.toBeUndefined()
    expect(mocks.groups).toHaveBeenCalledWith(CHAIN, INFO, ALICE, [0n, 4000n])
    mocks.groups.mockResolvedValue({ groupIds: [0n, 4000n], collectable: 900_000n })
    await expect(reverify!()).rejects.toThrow('Your claimable rewards changed. Review again.')

    // A claim that cannot be read stops the step, and the console hears why.
    const cause = new Error('429')
    mocks.groups.mockRejectedValue(new Error('what you can collect could not be read.', { cause }))
    await expect(reverify!()).rejects.toThrow('What you can collect could not be read.')
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('claim'), { chainId: CHAIN, projectId: PROJECT }, expect.objectContaining({ cause }))
  })

  it('says it went through, and reads again what a stick and a trust change', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    chain.allowance = 10n ** 30n
    await render()
    await press(host, 'Claim & stick')
    await press(confirm(), 'Confirm & stick')
    await confirmed(10n)
    expect(confirm()!.textContent).toContain('Rewards claimed and stuck')
    const keys = invalidate.mock.calls.map(([filters]) => filters!.queryKey as QueryKey)
    expect(keys).toEqual(
      expect.arrayContaining([
        ['sticky-project', CHAIN, PROJECT, 'info'],
        ['sticky-position', CHAIN, PROJECT],
        ['sticky-rewards', CHAIN, PROJECT],
        ['sticky-autostick', CHAIN, PROJECT],
        ['sticky-trusted', CHAIN, PROJECT],
      ]),
    )
  })
})

describe('a wallet that cannot send', () => {
  it('is refused, for Signa, when a review starts, and "Connect a wallet" opens the external wallets', async () => {
    mocks.wallet = { ...mocks.wallet, isCenterWallet: true }
    await render()
    await press(host, 'Claim & stick')
    expect(errorText()).toBe(`${EXTERNAL_WALLET_REQUIRED} Connect a wallet`)
    expect(mocks.groups).not.toHaveBeenCalled()
    await press(host, 'Connect a wallet')
    expect(mocks.requestSignIn).toHaveBeenCalledWith({ walletsOnly: true })
  })

  it('is refused in View as when a review starts', async () => {
    setViewAs(CAROL)
    await render()
    await press(host, 'Collect only')
    expect(errorText()).toBe(VIEW_AS_WRITE_BLOCKED)
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('asks to sign in when nobody is', async () => {
    mocks.wallet = { address: undefined, isConnected: false, isCenterWallet: false, openSignIn: vi.fn() }
    await render()
    await press(host, 'Collect only')
    expect(mocks.wallet.openSignIn).toHaveBeenCalledOnce()
    expect(confirm()).toBeNull()
  })

  it('names the account that reviewed the claim on every step, whichever account is connected by then', async () => {
    await render()
    await press(host, 'Collect only')
    mocks.wallet = { ...mocks.wallet, address: CAROL }
    await render()
    await press(confirm(), 'Confirm & collect')
    expect(sent(0)[1].reviewedAccount).toBe(ALICE)
  })
})
