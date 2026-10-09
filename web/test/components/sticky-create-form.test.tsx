import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'
import type { LaunchPlan } from '@/lib/sticky-launch-plan'

const mocks = vi.hoisted(() => ({
  chainId: 84532,
  wallet: { address: undefined as Address | undefined, isCenterWallet: false },
  viewAs: null as Address | null, signIn: vi.fn(), blocker: vi.fn(), plan: vi.fn(), capability: vi.fn(),
  prepare: vi.fn(), working: vi.fn(), failed: vi.fn(),
}))
vi.mock('wagmi', () => ({ useChainId: () => mocks.chainId }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => mocks.wallet }))
vi.mock('@/lib/viewAs', () => ({ useViewAs: () => ({ viewAs: mocks.viewAs }) }))
vi.mock('@/providers/WalletAuthContext', () => ({ useWalletAuth: () => ({ requestSignIn: mocks.signIn }) }))
vi.mock('@/lib/sticky-launch-plan', () => ({ BONUS_PRESETS: ['0', '5', '10', '25'], launchChainBlocker: mocks.blocker, prepareStickyLaunch: mocks.plan }))
vi.mock('@/lib/sticky-listing', () => ({ listingCapability: mocks.capability }))

import { StickyCreateForm } from '@/components/create/StickyCreateForm'

const OWNER = `0x${'1'.repeat(40)}` as Address
const TOKEN = `0x${'2'.repeat(40)}` as Address
const PLAN = { id: 'prepared-launch' } as LaunchPlan
let container: HTMLDivElement
let root: Root
let busy: boolean
beforeEach(() => {
  mocks.chainId = 84532
  mocks.wallet = { address: OWNER, isCenterWallet: false }
  mocks.viewAs = null
  mocks.blocker.mockReturnValue('')
  mocks.plan.mockResolvedValue(PLAN)
  mocks.capability.mockResolvedValue('self-paid')
  mocks.prepare.mockResolvedValue(undefined)
  mocks.signIn.mockResolvedValue(undefined)
  busy = false
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
async function render() {
  await act(async () => root.render(<StickyCreateForm environment="testnet" busy={busy}
    prepare={mocks.prepare} working={mocks.working} failed={mocks.failed} />))
}
function field<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(prefix: string): T {
  const label = [...container.querySelectorAll('label')].find(item => item.textContent?.startsWith(prefix))
  const found = label?.querySelector('input,select,textarea')
  if (!found) throw new Error(`Missing field: ${prefix}`)
  return found as T
}
async function fill(prefix: string, value: string) {
  const control = field(prefix)
  await act(async () => {
    const prototype = control instanceof HTMLInputElement ? HTMLInputElement.prototype
      : control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value)
    control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}
async function submit() {
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
}

describe('Sticky create form boundaries', () => {
  it('defaults to a supported connected chain and changes the one selected home without accumulating chains', async () => {
    await render()
    expect(field<HTMLInputElement>('Base Sepolia').checked).toBe(true)
    await act(async () => field<HTMLInputElement>('Arbitrum Sepolia').click())
    expect(container.querySelectorAll('input[name="home-chain"]:checked')).toHaveLength(1)
    expect(field<HTMLInputElement>('Base Sepolia').checked).toBe(false)
    await fill('Token address', TOKEN)
    await submit()
    expect(mocks.plan).toHaveBeenLastCalledWith(expect.objectContaining({ chainIds: [421614] }), OWNER)
    await fill('Networks', 'production')
    expect(field<HTMLInputElement>('Ethereum').checked).toBe(true)
    await submit()
    expect(mocks.plan).toHaveBeenLastCalledWith(expect.objectContaining({ chainIds: [1] }), OWNER)
  })

  it('ignores unsupported or unavailable wallet chains and blocks creation if no home is available', async () => {
    mocks.chainId = 999
    await render()
    expect(field<HTMLInputElement>('Sepolia').checked).toBe(true)
    await fill('Networks', 'production')
    mocks.blocker.mockReturnValue('not deployed')
    await fill('Networks', 'testnet')
    expect(container.querySelectorAll('input[name="home-chain"]:checked')).toHaveLength(0)
    expect([...container.querySelectorAll('button')].find(item => item.textContent === 'Prepare launch')?.disabled).toBe(true)
    await submit()
    expect(mocks.plan).not.toHaveBeenCalled()
  })

  it.each(['sponsored', 'self-paid', 'unavailable'] as const)('prepares the saved plan only after determining %s capability', async capability => {
    let answer!: (value: typeof capability) => void
    mocks.capability.mockReturnValueOnce(new Promise<typeof capability>(resolve => { answer = resolve }))
    await render()
    await fill('Token address', TOKEN)
    await submit()
    expect(mocks.plan).toHaveBeenCalledOnce()
    expect(mocks.capability).toHaveBeenCalledExactlyOnceWith(PLAN)
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.working).toHaveBeenLastCalledWith(true)
    await act(async () => answer(capability))
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(PLAN, capability)
    expect(mocks.working.mock.calls).toEqual([[true], [false]])
    expect(mocks.failed).not.toHaveBeenCalled()
  })

  it('passes the chosen economics and exactly one configured home chain to the owning planner', async () => {
    mocks.blocker.mockImplementation(id => id === 11155420 ? 'no auto-stick helper' : '')
    await render()
    expect(container.textContent).toContain('depends on the share of total supply being unstuck')
    expect(container.textContent).toContain('Granters can stick tokens for any holder without that holder’s permission')
    expect(container.textContent).toContain('These permissions cannot be revoked')
    const blocked = field<HTMLInputElement>('OP Sepolia')
    expect(blocked.disabled).toBe(true)
    expect(blocked.checked).toBe(false)
    await fill('Token address', 'base-sepolia:5')
    await fill('Name (optional)', 'My Sticky')
    await fill('Symbol (optional)', 'MST')
    await fill('Stickiness bonus', 'custom')
    await fill('Custom bonus', '3.05')
    await fill('Permanent granters', OWNER)
    await act(async () => field<HTMLInputElement>('Lock transfers').click())
    await submit()
    expect(mocks.plan).toHaveBeenCalledExactlyOnceWith({ tokenInput: 'base-sepolia:5', name: 'My Sticky', symbol: 'MST',
      bonusChoice: 'custom', customBonus: '3.05', trustedSenders: OWNER, soulbound: true,
      chainIds: [84532], environment: 'testnet' }, OWNER)
    await fill('Networks', 'production')
    await submit()
    expect(mocks.plan).toHaveBeenLastCalledWith(expect.objectContaining({ chainIds: [1], environment: 'production' }), OWNER)
  })

  it('shows validation failures without proceeding to listing and always releases the busy state', async () => {
    const error = new Error('Token differs on Base')
    mocks.plan.mockRejectedValueOnce(error)
    await render()
    await fill('Token address', TOKEN)
    await submit()
    expect(mocks.failed).toHaveBeenCalledExactlyOnceWith(error)
    expect(mocks.capability).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.working.mock.calls).toEqual([[true], [false]])
  })

  it('blocks View as, busy, disconnected and Center-wallet submissions at the handler', async () => {
    await render()
    await fill('Token address', TOKEN)
    mocks.viewAs = OWNER
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Exit View as to create a token.')
    await submit()
    mocks.viewAs = null
    busy = true
    await render()
    expect(container.querySelector('fieldset')?.disabled).toBe(true)
    await submit()
    busy = false
    for (const wallet of [{ address: undefined, isCenterWallet: false }, { address: OWNER, isCenterWallet: true }]) {
      mocks.wallet = wallet
      await render()
      await submit()
      const connect = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Connect an external wallet')!
      await act(async () => connect.click())
      expect(mocks.signIn).toHaveBeenLastCalledWith({ walletsOnly: true })
    }
    expect(mocks.plan).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.working).not.toHaveBeenCalled()
  })
})
