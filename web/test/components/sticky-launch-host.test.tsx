import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LaunchPlan } from '@/lib/sticky-launch-plan'
import { STICKY_LAUNCH_KEY, type StickyLaunchSession } from '@/lib/sticky-launch-session'
import { openStickyLaunch } from '@/lib/sticky-launch-events'

type FormProps = { environment: string; prepare: (plan: LaunchPlan, capability: 'sponsored' | 'self-paid' | 'unavailable') => Promise<void> }
const mocks = vi.hoisted(() => ({
  queryClient: {}, refreshHome: vi.fn(), make: vi.fn(), load: vi.fn(), prepare: vi.fn(), run: vi.fn(), refresh: vi.fn(),
  selfPay: vi.fn(), list: vi.fn(), clear: vi.fn(), addHash: vi.fn(), retry: vi.fn(),
  changed: null as null | ((session: StickyLaunchSession | null) => void),
  plan: null as LaunchPlan | null, capability: 'self-paid' as 'sponsored' | 'self-paid' | 'unavailable',
}))
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => mocks.queryClient }))
vi.mock('@/hooks/useStickyHome', () => ({ refreshStickyHome: mocks.refreshHome }))
vi.mock('@/lib/sticky-launch-adapter', () => ({ createBrowserStickyLaunchController: mocks.make }))
vi.mock('next/dynamic', () => ({ default: () => function FakeCreateForm(props: FormProps) {
  return <div data-create-form={props.environment}><button type="button" onClick={() => void props.prepare(mocks.plan!, mocks.capability)}>Prepare fixture</button></div>
} }))
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }))

import { StickyLaunchHost } from '@/components/create/StickyLaunchHost'

const ADDRESS = `0x${'1'.repeat(40)}` as const
const HASH = `0x${'a'.repeat(64)}` as const
const controller = { load: mocks.load, prepare: mocks.prepare, run: mocks.run, refresh: mocks.refresh,
  selfPay: mocks.selfPay, list: mocks.list, clear: mocks.clear, addHash: mocks.addHash, retry: mocks.retry }
function saved(overrides: Partial<StickyLaunchSession> = {}): StickyLaunchSession {
  return { version: 1, plan: mocks.plan!, mode: 'direct', published: false, candidates: { 84532: [] }, results: {},
    listing: { state: 'pending', recorded: {} }, ...overrides }
}
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  localStorage.clear()
  mocks.changed = null
  mocks.capability = 'self-paid'
  mocks.plan = { id: 'launch-one', owner: ADDRESS, token: ADDRESS, name: 'Sticky Art', symbol: 'STICKYART', tokenName: 'Art',
    tokenSymbol: 'ART', tokenDecimals: 18, cashOutTaxRate: '1000', soulbound: false, projectUri: 'data:,launch', environment: 'testnet',
    targets: [{ chainId: 84532, deployer: ADDRESS, controller: ADDRESS, projects: ADDRESS,
      call: { chain: 84532, target: ADDRESS, data: '0x1234', value: '0' } }] }
  mocks.load.mockReturnValue(null)
  mocks.make.mockImplementation(({ changed }: { changed: typeof mocks.changed }) => { mocks.changed = changed; return controller })
  mocks.prepare.mockImplementation(async (_plan: LaunchPlan, capability: 'sponsored' | 'self-paid' | 'unavailable') => {
    mocks.changed?.(saved({ mode: capability === 'sponsored' ? 'center' : 'direct' }))
  })
  for (const fn of [mocks.run, mocks.refresh, mocks.selfPay, mocks.list, mocks.clear, mocks.addHash, mocks.retry]) fn.mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  localStorage.clear()
})
async function mount() {
  await act(async () => root.render(<StickyLaunchHost />))
  await act(async () => { await vi.dynamicImportSettled() })
}
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)
async function click(text: string) {
  const item = button(text)
  if (!item) throw new Error(`Missing button: ${text}`)
  await act(async () => item.click())
  await act(async () => { await vi.dynamicImportSettled() })
}
async function show() { await act(async () => openStickyLaunch('testnet')) }

describe('global Sticky launch host', () => {
  it('checks finalized failure on explicit retry and requires a separate reviewed launch action afterward', async () => {
    const pending = saved({ direct: { started: true, hash: HASH } })
    localStorage.setItem(STICKY_LAUNCH_KEY, JSON.stringify(pending))
    mocks.load.mockReturnValue(pending)
    mocks.retry.mockImplementationOnce(async () => mocks.changed?.(saved({ directAttempts: [pending.direct!] })))
    await mount()
    await show()
    expect(button('Continue launch')).toBeUndefined()
    await click('Check failed transaction for retry')
    expect(mocks.retry).toHaveBeenCalledOnce()
    expect(mocks.run).not.toHaveBeenCalled()
    expect(button('Continue launch')).toBeDefined()
    await click('Continue launch')
    expect(mocks.run).toHaveBeenCalledOnce()
  })
  it('keeps a create click made before the lazy dialog host mounts', async () => {
    openStickyLaunch('testnet')
    await mount()
    expect(container.querySelector('[data-create-form]')?.getAttribute('data-create-form')).toBe('testnet')
    expect(mocks.run).not.toHaveBeenCalled()
  })
  it('opens create from the event and prepares before a separate explicit launch action', async () => {
    await mount()
    expect(container.querySelector('dialog')).toBeNull()
    expect(mocks.make).not.toHaveBeenCalled()
    await show()
    expect(container.querySelector('[data-create-form]')?.getAttribute('data-create-form')).toBe('testnet')
    expect(mocks.run).not.toHaveBeenCalled()
    await click('Prepare fixture')
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(mocks.plan, 'self-paid')
    expect(container.querySelector('[data-create-form]')).toBeNull()
    expect(mocks.run).not.toHaveBeenCalled()
    await click('Continue launch')
    expect(mocks.run).toHaveBeenCalledOnce()
  })

  it('shows the sponsored action only after preparation chooses sponsorship', async () => {
    mocks.capability = 'sponsored'
    await mount()
    await show()
    await click('Prepare fixture')
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(mocks.plan, 'sponsored')
    expect(button('Request sponsored launch')).toBeDefined()
    expect(button('Continue launch')).toBeUndefined()
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('restores the pending session on open instead of starting a new form or wallet action', async () => {
    localStorage.setItem(STICKY_LAUNCH_KEY, 'saved')
    mocks.load.mockReturnValue(saved({ direct: { started: true, hash: HASH } }))
    await mount()
    expect(container.textContent).toContain('Resume launch')
    await show()
    expect(container.querySelector('[data-create-form]')).toBeNull()
    expect(container.textContent).toContain('Waiting for verified deployment')
    expect(button('Continue launch')).toBeUndefined()
    expect(button('Discard unsubmitted launch')).toBeUndefined()
    expect(mocks.run).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
  })

  it('keeps create blocked while lazy recovery initialization is pending', async () => {
    localStorage.setItem(STICKY_LAUNCH_KEY, 'saved')
    mocks.load.mockReturnValue(saved({ direct: { started: true, hash: HASH } }))
    let release!: (value: typeof controller) => void
    const pending = new Promise<typeof controller>(resolve => { release = resolve })
    mocks.make.mockImplementationOnce(({ changed }: { changed: typeof mocks.changed }) => { mocks.changed = changed; return pending })
    await mount()
    await show()
    try {
      expect(container.querySelector('[data-create-form]')).toBeNull()
      expect(mocks.prepare).not.toHaveBeenCalled()
    } finally { await act(async () => release(controller)) }
    expect(container.textContent).toContain('Waiting for verified deployment')
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('blocks a corrupt saved record and never offers to discard a published unknown launch', async () => {
    localStorage.setItem(STICKY_LAUNCH_KEY, '{bad')
    mocks.load.mockImplementationOnce(() => { throw new Error('The saved launch is unreadable.') })
    await mount()
    await show()
    expect(container.querySelector('[data-create-form]')).toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('unreadable')
    expect(container.textContent).toContain('A new launch is blocked')
    expect(mocks.run).not.toHaveBeenCalled()
    expect(mocks.clear).not.toHaveBeenCalled()
    mocks.load.mockReturnValue(saved({ mode: 'relayr', published: true }))
    await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: STICKY_LAUNCH_KEY })))
    expect(container.textContent).toContain('Waiting for verified deployment')
    expect(button('Discard unsubmitted launch')).toBeUndefined()
    expect(mocks.clear).not.toHaveBeenCalled()
  })

  it('polls read-only recovery every 12 seconds and pauses while the document is hidden', async () => {
    vi.useFakeTimers()
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    localStorage.setItem(STICKY_LAUNCH_KEY, 'saved')
    mocks.load.mockReturnValue(saved({ published: true }))
    await mount()
    expect(mocks.refresh).toHaveBeenCalledOnce()
    await act(async () => { await vi.advanceTimersByTimeAsync(11_999) })
    expect(mocks.refresh).toHaveBeenCalledOnce()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(mocks.refresh).toHaveBeenCalledTimes(2)
    hidden.mockReturnValue(true)
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(36_000) })
    expect(mocks.refresh).toHaveBeenCalledTimes(2)
    hidden.mockReturnValue(false)
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(mocks.refresh).toHaveBeenCalledTimes(3)
    expect(mocks.run).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
  })
})
