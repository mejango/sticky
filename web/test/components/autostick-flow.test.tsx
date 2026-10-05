// @vitest-environment jsdom

import { QueryClient, QueryClientProvider, notifyManager, type QueryKey } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { getAddress, maxUint256, type Abi, type Address, type Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stickyAutoStickAbi } from '@/lib/sticky-abis'
import { stickyDeployment } from '@/lib/sticky-addresses'
import { AS_STATUS, type AutoStickState } from '@/lib/sticky-autostick'
import { clearViewAs, setViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import { EXTERNAL_WALLET_REQUIRED, WalletAuthContext } from '@/providers/WalletAuthContext'
import { stickyInfo } from '../home-fixtures'

// The auto-stick card's actions: turning auto-stick on, renewing its allowance, changing its settings, turning it off,
// repairing its permission, sticking ready rewards now and starting finished rounds unlocking. The reads and the engine
// are mocks: the builders, the reads and the engine have tests of their own (test/lib/sticky-builders.test.ts,
// sticky-autostick.test.ts, sticky-quotes.test.ts and test/transactions).

const CHAIN = 84532
const PROJECT = 12
const deployment = stickyDeployment(CHAIN)!
const ADAPTER = deployment.autoStick
const HOOK = deployment.hook
const ALICE = getAddress(`0x${'a1'.repeat(20)}`)
const CAROL = getAddress(`0x${'c4'.repeat(20)}`)
const ART = getAddress(`0x${'2'.repeat(40)}`)
const HASH = `0x${'c3'.repeat(32)}` as Hex
const DAY = 86_400
const WEEK = 604_800
const MONTH = 2_592_000
/** Project 12 on Base Sepolia sticks ART, of 6 decimals, for STICKYART. */
const INFO = stickyInfo(CHAIN, BigInt(PROJECT), { stakedToken: ART, symbol: 'ART', decimals: 6, stSymbol: 'STICKYART' })

/** Auto-stick off and never set up, trusting nothing and approved for nothing. */
const off = (extra: Partial<AutoStickState> = {}): AutoStickState => ({
  groupIds: [0n],
  status: AS_STATUS.DISABLED,
  collectable: 0n,
  allowance: 0n,
  nextCompoundAt: 0,
  minimum: 0n,
  cooldown: 0,
  lastCompoundedAt: 0,
  enabled: false,
  projectGranter: false,
  personallyTrusted: false,
  canBeginVesting: false,
  ...extra,
})
/** Auto-stick on, at least 1 ART once a week, trusted, with an unlimited allowance, and ready. */
const on = (extra: Partial<AutoStickState> = {}): AutoStickState =>
  off({
    status: AS_STATUS.READY,
    collectable: 500n,
    allowance: maxUint256,
    minimum: 1_000_000n,
    cooldown: WEEK,
    enabled: true,
    personallyTrusted: true,
    groupIds: [4000n, 4008n],
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
  vestable: vi.fn(),
  quote: vi.fn(),
  schedule: vi.fn(),
}))

vi.mock('@/hooks/useWallet', () => ({ useWallet: () => mocks.wallet }))
vi.mock('@/hooks/useSafeTx', async importOriginal => ({
  ...(await importOriginal<typeof import('@/hooks/useSafeTx')>()),
  useSafeTx: () => mocks.tx,
}))
vi.mock('@/lib/sticky-autostick', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-autostick')>()),
  readAutoStick: mocks.read,
  vestableRewardGroups: mocks.vestable,
}))
vi.mock('@/lib/sticky-quotes', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-quotes')>()),
  quoteStick: mocks.quote,
}))
vi.mock('@/lib/sticky-rewards', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-rewards')>()),
  readRewardSchedule: mocks.schedule,
}))

import { AutoStickFlow } from '@/components/project/flows/AutoStickFlow'

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

let host: HTMLDivElement
let root: Root
let client: QueryClient
/** The state the card shows, and what a review reads afresh. */
let shown: AutoStickState
let fresh: AutoStickState

beforeEach(() => {
  notifyManager.setScheduler(callback => queueMicrotask(callback))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.wallet = { address: ALICE, isConnected: true, isCenterWallet: false, openSignIn: vi.fn() }
  mocks.requestSignIn.mockReset().mockResolvedValue(undefined)
  mocks.tx = engine()
  shown = off()
  fresh = off()
  mocks.read.mockReset().mockImplementation(async () => fresh)
  mocks.vestable.mockReset().mockResolvedValue([4008n])
  mocks.quote.mockReset().mockResolvedValue(490_000_000_000_000n)
  mocks.schedule.mockReset().mockResolvedValue({ roundDuration: 604_800n, vestingRounds: 4n, start: 1_790_295_566n, round: 2n })
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

/** The card's actions for `state`, which a review also reads afresh unless a test says otherwise. */
async function render(state: AutoStickState = shown, { same = true } = {}) {
  shown = state
  if (same) fresh = state
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <WalletAuthContext.Provider value={{ requestSignIn: mocks.requestSignIn }}>
          <AutoStickFlow chainId={CHAIN} projectId={PROJECT} info={INFO} state={shown} groups={[0n, 4000n, 4008n]} />
        </WalletAuthContext.Provider>
      </QueryClientProvider>,
    ),
  )
  await settled()
}
const rerender = () => render(shown, { same: false })

const card = () => host.querySelector<HTMLElement>('[data-autostick-actions]')!
const modal = () => document.querySelector('dialog')
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
const field = (label: string) => {
  const found = [...(modal()?.querySelectorAll('label') ?? [])].find(each => each.textContent === label)
  return found ? (document.getElementById(found.htmlFor) as HTMLInputElement) : null
}
async function type(label: string, text: string) {
  const input = field(label)!
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const pressed = (within: ParentNode | null) =>
  [...(within?.querySelectorAll('button[aria-pressed="true"]') ?? [])].map(button => button.textContent)
const errorText = () => document.querySelector('p.wrap-anywhere')?.textContent ?? null
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
const sent = (at: number) => mocks.tx.send.mock.calls[at] as [Sent, { reviewedAccount: Address; simulationBlockNumber?: bigint }]
const calls = () => mocks.tx.send.mock.calls.map(([request]) => [(request as Sent).address, (request as Sent).functionName, (request as Sent).args])
async function confirmed(block: bigint) {
  mocks.tx.phase = 'success'
  mocks.tx.busy = false
  mocks.tx.hash = HASH
  mocks.tx.receipt = { blockNumber: block }
  await rerender()
}
/** Sends every step of the open review, each confirmed in a block of its own. */
async function sendAll() {
  for (let block = 10n; confirm() && !confirm()!.textContent!.includes('All transactions confirmed.'); block += 1n) {
    await act(async () => primary().click())
    await settled()
    await confirmed(block)
  }
}

describe('the actions', () => {
  it('offer to turn it on while it is off', async () => {
    await render(off())
    expect(buttonsOf(card())).toEqual(['Turn on auto-stick'])
  })

  it('offer to turn it off, stick ready rewards now and change its settings while it is on and ready', async () => {
    await render(on())
    expect(buttonsOf(card())).toEqual(['Turn off auto-stick', 'Stick ready rewards now', 'Settings'])
  })

  it.each([
    [AS_STATUS.NOT_TRUSTED, ['Turn off auto-stick', 'Repair permission', 'Settings']],
    [AS_STATUS.INSUFFICIENT_ALLOWANCE, ['Turn off auto-stick', 'Renew allowance', 'Settings']],
    [AS_STATUS.COOLDOWN, ['Turn off auto-stick', 'Settings']],
    [AS_STATUS.BELOW_MINIMUM, ['Turn off auto-stick', 'Settings']],
  ])('offer for status %i only what can help', async (status, buttons) => {
    await render(on({ status }))
    expect(buttonsOf(card())).toEqual(buttons)
  })

  it('auto-stick displays the appended zero-issuance status without treating it as ready', async () => {
    await render(on({ status: AS_STATUS.ZERO_ISSUANCE }))
    expect(buttonsOf(card())).toEqual(['Turn off auto-stick', 'Settings'])
  })

  it('offer to start unlocking finished rounds when there are some', async () => {
    await render(on({ canBeginVesting: true }))
    expect(buttonsOf(card())).toEqual(['Turn off auto-stick', 'Stick ready rewards now', 'Start unlocking', 'Settings'])
  })
})

describe('turning it on', () => {
  it('Dialog choices: DAY, WEEK and MONTH, and UNLIMITED or CUSTOM CAP', async () => {
    await render(off())
    await press(card(), 'Turn on auto-stick')
    expect(modal()!.querySelector('h2')?.textContent).toBe('Turn on auto-stick')
    expect(modal()!.textContent).toContain('Rewards unlock over 4 rounds, about 25% every 7d 0h, all of it 28d 0h after unlocking starts.')
    expect(field('Minimum ART per auto-stick')!.value).toBe('1')
    expect(buttonsOf(modal()!.querySelector('[data-choices="cooldown"]')!)).toEqual(['DAY', 'WEEK', 'MONTH'])
    expect(buttonsOf(modal()!.querySelector('[data-choices="allowance"]')!)).toEqual(['UNLIMITED', 'CUSTOM CAP'])
    expect(pressed(modal())).toEqual(['WEEK', 'UNLIMITED'])
    expect(modal()!.textContent).toContain('Auto-stick can only pull rewards it just delivered to you, and only to stick them.')
    expect(field('Allowance cap (ART)')).toBeNull()

    await press(modal(), 'DAY')
    await press(modal(), 'CUSTOM CAP')
    expect(pressed(modal())).toEqual(['DAY', 'CUSTOM CAP'])
    expect(field('Allowance cap (ART)')).not.toBeNull()
  })

  it('wallet-action:approve-the-auto-stick-adapter-s-allowance wallet-action:trust-the-auto-stick-adapter wallet-action:turn-on-auto-stick turns it on: an unlimited allowance, the trust, and the settings last, one press each', async () => {
    await render(off())
    await press(card(), 'Turn on auto-stick')
    await type('Minimum ART per auto-stick', '2.5')
    await press(modal(), 'MONTH')
    await press(modal(), 'Turn on auto-stick')
    expect(mocks.read).toHaveBeenCalledWith(CHAIN, 12n, ALICE, expect.objectContaining({ info: INFO, groups: [0n, 4000n, 4008n], signal: expect.any(AbortSignal) }))
    expect(steps()).toEqual([
      'Allow the auto-stick contract to move eligible ART rewards',
      'Allow the auto-stick contract to stick ART for you',
      'Turn on auto-stick',
    ])
    expect(rowsOf()).toMatchObject({ 'Auto-stick when': 'at least 2.5 ART is ready', 'At most': 'once every 30d 0h', Allowance: 'Unlimited' })
    expect(primary().textContent).toBe('Confirm & approve')
    await sendAll()
    expect(calls()).toEqual([
      [ART, 'approve', [ADAPTER, maxUint256]],
      [HOOK, 'setTrustedSenderFor', [12n, ADAPTER, true]],
      [ADAPTER, 'setConfigFor', [12n, true, 2_500_000n, MONTH]],
    ])
    expect(sent(2)[1]).toMatchObject({ reviewedAccount: ALICE, simulationBlockNumber: 11n })
    expect(confirm()!.textContent).toContain('Auto-stick is on')
  })

  it('wallet-action:turn-off-auto-stick wallet-action:approve-the-auto-stick-adapter-s-allowance wallet-action:turn-on-auto-stick auto-stick renewal disables old settings before increasing allowance, then enables new settings last', async () => {
    await render(on({ status: AS_STATUS.INSUFFICIENT_ALLOWANCE, allowance: 3n }))
    await press(card(), 'Renew allowance')
    expect(modal()!.querySelector('h2')?.textContent).toBe('Turn on auto-stick')
    // The settings it has are where the form starts.
    expect(field('Minimum ART per auto-stick')!.value).toBe('1')
    expect(pressed(modal())).toEqual(['WEEK', 'UNLIMITED'])
    await press(modal(), 'CUSTOM CAP')
    await type('Allowance cap (ART)', '50')
    await press(modal(), 'Turn on auto-stick')
    expect(steps()).toEqual([
      'Turn off auto-stick',
      'Reset ART allowance',
      'Allow the auto-stick contract to move eligible ART rewards',
      'Turn on auto-stick',
    ])
    expect(rowsOf().Allowance).toBe('50 ART')
    expect(primary().textContent).toBe('Confirm & turn off')
    await sendAll()
    expect(calls()).toEqual([
      [ADAPTER, 'setConfigFor', [12n, false, 1_000_000n, WEEK]],
      [ART, 'approve', [ADAPTER, 0n]],
      [ART, 'approve', [ADAPTER, 50_000_000n]],
      [ADAPTER, 'setConfigFor', [12n, true, 1_000_000n, WEEK]],
    ])
  })

  it('Limits: a minimum above 2^128 - 1 is refused, and so are a minimum and a cap of nothing', async () => {
    await render(off())
    await press(card(), 'Turn on auto-stick')
    await type('Minimum ART per auto-stick', String(1n << 128n))
    await press(modal(), 'Turn on auto-stick')
    expect(errorText()).toBe('The auto-stick minimum must fit in uint128 and be greater than zero.')
    expect(confirm()).toBeNull()

    await type('Minimum ART per auto-stick', '0')
    await press(modal(), 'Turn on auto-stick')
    expect(errorText()).toBe('Enter an amount greater than zero.')

    await type('Minimum ART per auto-stick', '1')
    await press(modal(), 'CUSTOM CAP')
    await type('Allowance cap (ART)', '0')
    await press(modal(), 'Turn on auto-stick')
    expect(errorText()).toBe('Set an allowance cap, or choose unlimited.')
    expect(mocks.tx.send).not.toHaveBeenCalled()
  })

  it('takes a cooldown the adapter keeps that no preset names, and refuses one outside its bounds', async () => {
    fresh = off({ minimum: 1_000_000n, cooldown: 3 * DAY })
    await render(fresh)
    await press(card(), 'Turn on auto-stick')
    expect(pressed(modal()!.querySelector('[data-choices="cooldown"]'))).toEqual([])
    await press(modal(), 'Turn on auto-stick')
    expect(steps().at(-1)).toBe('Turn on auto-stick')
    await sendAll()
    expect(calls().at(-1)).toEqual([ADAPTER, 'setConfigFor', [12n, true, 1_000_000n, 3 * DAY]])
  })

  it('closes its form with nothing sent', async () => {
    await render(off())
    await press(card(), 'Turn on auto-stick')
    await act(async () => modal()!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click())
    await settled()
    expect(modal()).toBeNull()
    expect(mocks.read).not.toHaveBeenCalled()
  })
})

describe('the other actions', () => {
  it('wallet-action:change-auto-stick-settings Settings: a single setConfigFor', async () => {
    await render(on())
    await press(card(), 'Settings')
    expect(modal()!.querySelector('h2')?.textContent).toBe('Auto-stick settings')
    expect(modal()!.querySelector('[data-choices="allowance"]')).toBeNull()
    await type('Minimum ART per auto-stick', '3')
    await press(modal(), 'DAY')
    await press(modal(), 'Save settings')
    expect(steps()).toEqual(['Save auto-stick settings'])
    await sendAll()
    expect(calls()).toEqual([[ADAPTER, 'setConfigFor', [12n, true, 3_000_000n, DAY]]])
    expect(confirm()!.textContent).toContain('Auto-stick settings saved')
  })

  it('wallet-action:turn-off-auto-stick wallet-action:take-back-the-auto-stick-adapter-s-trust wallet-action:take-back-the-auto-stick-adapter-s-allowance Turn off: the disable calls from asDisableTxs', async () => {
    await render(on({ allowance: 9n }))
    await press(card(), 'Turn off auto-stick')
    expect(steps()).toEqual([
      'Turn off auto-stick',
      'Stop the auto-stick contract from sticking ART for you',
      "Remove the auto-stick contract's ART allowance",
    ])
    expect(primary().textContent).toBe('Confirm & turn off')
    await sendAll()
    expect(calls()).toEqual([
      [ADAPTER, 'setConfigFor', [12n, false, 1_000_000n, WEEK]],
      [HOOK, 'setTrustedSenderFor', [12n, ADAPTER, false]],
      [ART, 'approve', [ADAPTER, 0n]],
    ])
    expect(confirm()!.textContent).toContain('Auto-stick is off')
  })

  it('refuses to turn off an auto-stick that is off already', async () => {
    fresh = off()
    await render(on(), { same: false })
    await press(card(), 'Turn off auto-stick')
    expect(errorText()).toBe('Auto-stick is off already.')
    expect(confirm()).toBeNull()
  })

  it('wallet-action:trust-the-auto-stick-adapter Repair: setTrustedSenderFor(adapter, true) when trust is missing', async () => {
    await render(on({ status: AS_STATUS.NOT_TRUSTED, personallyTrusted: false }))
    await press(card(), 'Repair permission')
    expect(steps()).toEqual(['Allow the auto-stick contract to stick ART for you'])
    expect(primary().textContent).toBe('Confirm & trust')
    await sendAll()
    expect(calls()).toEqual([[HOOK, 'setTrustedSenderFor', [12n, ADAPTER, true]]])
    expect(confirm()!.textContent).toContain('Auto-stick permission restored')
  })

  it('Repair: when the allowance is short, it reopens renew instead', async () => {
    fresh = on({ status: AS_STATUS.INSUFFICIENT_ALLOWANCE, personallyTrusted: false, allowance: 0n })
    await render(on({ status: AS_STATUS.NOT_TRUSTED, personallyTrusted: false }), { same: false })
    await press(card(), 'Repair permission')
    expect(confirm()).toBeNull()
    expect(modal()!.querySelector('h2')?.textContent).toBe('Turn on auto-stick')
  })

  it('wallet-action:stick-ready-rewards-now auto-stick status, compounding, and vesting pass the groups holding underlying rewards: Stick now is adapter.compoundFor(id, holder, groupIds)', async () => {
    await render(on())
    await press(card(), 'Stick ready rewards now')
    expect(mocks.quote).toHaveBeenCalledWith(CHAIN, 12n, ART, 500n, ADAPTER, ALICE, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(steps()).toEqual(['Stick ready rewards now'])
    expect(rowsOf()).toMatchObject({
      Stick: '0.0005 ART of unlocked rewards',
      'Estimated Sticky tokens': '0.00049 STICKYART',
      Issuance: 'Priced at the backing when it runs. A mint of zero tokens reverts.',
    })
    await sendAll()
    expect(calls()).toEqual([[ADAPTER, 'compoundFor', [12n, ALICE, [4000n, 4008n]]]])
    expect(sent(0)[0].abi).toBe(stickyAutoStickAbi)
  })

  it('manual and automatic compounding reject a zero canonical mint for any token precision', async () => {
    mocks.quote.mockRejectedValue(new Error('this amount is too small or cannot be priced precisely enough at the current backing price'))
    await render(on())
    await press(card(), 'Stick ready rewards now')
    expect(errorText()).toBe('This amount is too small or cannot be priced precisely enough at the current backing price.')
    expect(confirm()).toBeNull()
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('refuses to stick now when auto-stick is no longer ready', async () => {
    fresh = on({ status: AS_STATUS.COOLDOWN })
    await render(on(), { same: false })
    await press(card(), 'Stick ready rewards now')
    expect(errorText()).toBe('Auto-stick is not ready. Its settings or rewards changed.')
    expect(mocks.quote).not.toHaveBeenCalled()
  })

  it('wallet-action:start-unlocking-rewards Start unlocking: adapter.beginVestingFor(id, holder, groupIds)', async () => {
    await render(on({ canBeginVesting: true }))
    await press(card(), 'Start unlocking')
    expect(mocks.vestable).toHaveBeenCalledWith(CHAIN, INFO, ALICE, [0n, 4000n, 4008n], expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(steps()).toEqual(['Start unlocking'])
    expect(rowsOf().Effect).toBe('Starts the unlock schedule for your ART rewards. No tokens move.')
    await sendAll()
    expect(calls()).toEqual([[ADAPTER, 'beginVestingFor', [12n, ALICE, [4008n]]]])
    expect(confirm()!.textContent).toContain('Unlocking started')
  })

  it('refuses to start unlocking with no new rounds, or with auto-stick off', async () => {
    mocks.vestable.mockResolvedValue([])
    await render(on({ canBeginVesting: true }))
    await press(card(), 'Start unlocking')
    expect(errorText()).toBe('There are no new reward rounds to unlock.')

    fresh = off()
    await rerender()
    await press(card(), 'Start unlocking')
    expect(errorText()).toBe('Turn on auto-stick before starting automatic reward unlocking.')
  })

  it('reads again what auto-stick changed once a change confirms, and what a stick changed after Stick now', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const keys = () => invalidate.mock.calls.map(([filters]) => filters!.queryKey as QueryKey)
    await render(on())
    await press(card(), 'Settings')
    await press(modal(), 'Save settings')
    await sendAll()
    expect(keys()).toEqual([
      ['sticky-autostick', CHAIN, PROJECT],
      ['sticky-trusted', CHAIN, PROJECT],
    ])

    invalidate.mockClear()
    await act(async () => root.unmount())
    root = createRoot(host)
    await render(on())
    await press(card(), 'Stick ready rewards now')
    await sendAll()
    expect(keys()).toEqual(expect.arrayContaining([['sticky-project', CHAIN, PROJECT, 'info'], ['sticky-position', CHAIN, PROJECT]]))
  })

  it('reads auto-stick again when a review closes after a step went through, so the card says where it stands', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await render(on({ allowance: 9n }))
    await press(card(), 'Turn off auto-stick')
    await act(async () => primary().click())
    await settled()
    await confirmed(10n)
    expect(invalidate).not.toHaveBeenCalled()
    await press(confirm(), 'Close')
    expect(invalidate.mock.calls.map(([filters]) => filters!.queryKey as QueryKey)).toEqual([
      ['sticky-autostick', CHAIN, PROJECT],
      ['sticky-trusted', CHAIN, PROJECT],
    ])
  })
})

describe('leftover permissions', () => {
  it('are offered for removal when auto-stick is off but the adapter is still trusted or still has an allowance', async () => {
    await render(off({ personallyTrusted: true }))
    expect(buttonsOf(card())).toEqual(['Turn on auto-stick', 'Remove leftover permissions'])
    await render(off({ allowance: 1n }))
    expect(buttonsOf(card())).toEqual(['Turn on auto-stick', 'Remove leftover permissions'])
    // Nothing left, or auto-stick on: nothing to offer.
    await render(off({ projectGranter: true }))
    expect(buttonsOf(card())).toEqual(['Turn on auto-stick'])
    await render(on())
    expect(buttonsOf(card())).not.toContain('Remove leftover permissions')
  })

  it('wallet-action:take-back-the-auto-stick-adapter-s-trust wallet-action:take-back-the-auto-stick-adapter-s-allowance are removed with the disable calls, less turning off an adapter that is off', async () => {
    await render(off({ minimum: 1_000_000n, cooldown: WEEK, personallyTrusted: true, allowance: 100n }))
    await press(card(), 'Remove leftover permissions')
    expect(mocks.read).toHaveBeenCalledWith(CHAIN, 12n, ALICE, expect.objectContaining({ info: INFO, groups: [0n, 4000n, 4008n] }))
    expect(steps()).toEqual(['Stop the auto-stick contract from sticking ART for you', "Remove the auto-stick contract's ART allowance"])
    expect(rowsOf().Effect).toBe('The auto-stick contract can no longer stick for you or move your ART.')
    expect(primary().textContent).toBe('Confirm & remove permission')
    await sendAll()
    expect(calls()).toEqual([
      [HOOK, 'setTrustedSenderFor', [12n, ADAPTER, false]],
      [ART, 'approve', [ADAPTER, 0n]],
    ])
    expect(sent(1)[1].reviewedAccount).toBe(ALICE)
    expect(confirm()!.textContent).toContain('Permissions removed')
  })

  it('say what is taken back when only one of them is left', async () => {
    await render(off({ allowance: 5n }))
    await press(card(), 'Remove leftover permissions')
    expect(steps()).toEqual(["Remove the auto-stick contract's ART allowance"])
    expect(rowsOf().Effect).toBe('The auto-stick contract can no longer move your ART.')
    expect(primary().textContent).toBe('Confirm & remove allowance')

    await act(async () => root.unmount())
    root = createRoot(host)
    await render(off({ personallyTrusted: true }))
    await press(card(), 'Remove leftover permissions')
    expect(rowsOf().Effect).toBe('The auto-stick contract can no longer stick for you.')
  })

  it('are refused when the chain says auto-stick is on again, or has nothing left', async () => {
    fresh = on()
    await render(off({ personallyTrusted: true }), { same: false })
    await press(card(), 'Remove leftover permissions')
    expect(errorText()).toBe('Auto-stick is on. Turn it off instead.')

    fresh = off()
    await rerender()
    await press(card(), 'Remove leftover permissions')
    expect(errorText()).toBe('Auto-stick has no permissions left to remove.')
    expect(confirm()).toBeNull()
  })

  it('read auto-stick again once they are removed', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await render(off({ personallyTrusted: true }))
    await press(card(), 'Remove leftover permissions')
    await sendAll()
    expect(invalidate.mock.calls.map(([filters]) => filters!.queryKey as QueryKey)).toEqual([
      ['sticky-autostick', CHAIN, PROJECT],
      ['sticky-trusted', CHAIN, PROJECT],
    ])
  })
})

describe('a wallet that cannot send', () => {
  it('is refused, for Signa, when a review starts, and "Connect a wallet" opens the external wallets', async () => {
    mocks.wallet = { ...mocks.wallet, isCenterWallet: true }
    await render(on())
    await press(card(), 'Turn off auto-stick')
    expect(errorText()).toBe(`${EXTERNAL_WALLET_REQUIRED} Connect a wallet`)
    expect(mocks.read).not.toHaveBeenCalled()
    await press(card().parentElement, 'Connect a wallet')
    expect(mocks.requestSignIn).toHaveBeenCalledWith({ walletsOnly: true })
  })

  it('is refused in View as when a review starts, and when its form is saved', async () => {
    setViewAs(CAROL)
    await render(on())
    await press(card(), 'Stick ready rewards now')
    expect(errorText()).toBe(VIEW_AS_WRITE_BLOCKED)

    await press(card(), 'Settings')
    await press(modal(), 'Save settings')
    expect(errorText()).toBe(VIEW_AS_WRITE_BLOCKED)
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('names the account that reviewed the change on every step, whichever account is connected by then', async () => {
    await render(on())
    await press(card(), 'Turn off auto-stick')
    mocks.wallet = { ...mocks.wallet, address: CAROL }
    await rerender()
    await act(async () => primary().click())
    await settled()
    expect(sent(0)[1].reviewedAccount).toBe(ALICE)
  })
})
