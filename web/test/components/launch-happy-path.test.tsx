// The normal path of a launch: open, one launch press (its decoded review) and Finish. These are main's clicks and lines; the
// SDK's saved-attempt recovery adds no step, notice or wait to it.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LaunchPlan } from '@/lib/sticky-launch-plan'
import type { StickyLaunchSession } from '@/lib/sticky-launch-session'
import { openStickyLaunch } from '@/lib/sticky-launch-events'

type FormProps = { environment: string; prepare: (plan: LaunchPlan, capability: 'sponsored' | 'self-paid' | 'unavailable') => Promise<void> }
const mocks = vi.hoisted(() => ({
  queryClient: {}, refreshHome: vi.fn(), make: vi.fn(), load: vi.fn(), prepare: vi.fn(), run: vi.fn(), refresh: vi.fn(),
  selfPay: vi.fn(), list: vi.fn(), clear: vi.fn(), addHash: vi.fn(), retry: vi.fn(), attempt: vi.fn(), record: vi.fn(), exited: vi.fn(),
  changed: null as null | ((session: StickyLaunchSession | null) => void),
  plan: null as LaunchPlan | null, capability: 'self-paid' as 'sponsored' | 'self-paid' | 'unavailable',
}))
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => mocks.queryClient }))
vi.mock('@/hooks/useStickyHome', () => ({ refreshStickyHome: mocks.refreshHome }))
vi.mock('@/lib/sticky-launch-adapter', () => ({ createBrowserStickyLaunchController: mocks.make }))
vi.mock('next/dynamic', async () => {
  // The SDK's recovery is the real one; the create form is a fixture.
  const { LaunchRecovery } = await import('@/components/create/LaunchRecovery')
  return { default: (loader: () => unknown) => String(loader).includes('LaunchRecovery') ? LaunchRecovery : function FakeCreateForm(props: FormProps) {
    return <div data-create-form={props.environment}><button type="button" onClick={() => void props.prepare(mocks.plan!, mocks.capability)}>Prepare fixture</button></div>
  } }
})
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }))

import { StickyLaunchHost } from '@/components/create/StickyLaunchHost'

const ADDRESS = `0x${'1'.repeat(40)}` as const
const HASH = `0x${'a'.repeat(64)}` as const
const controller = { load: mocks.load, prepare: mocks.prepare, run: mocks.run, refresh: mocks.refresh,
  selfPay: mocks.selfPay, list: mocks.list, clear: mocks.clear, addHash: mocks.addHash, retry: mocks.retry, attempt: mocks.attempt, record: mocks.record, exited: mocks.exited }
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
  for (const fn of [mocks.run, mocks.refresh, mocks.selfPay, mocks.list, mocks.clear, mocks.addHash, mocks.retry, mocks.record, mocks.exited]) fn.mockResolvedValue(undefined)
  mocks.attempt.mockReturnValue(null)
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

const notices = () => [...container.querySelectorAll('[role="status"],[role="alert"]')].map(item => item.textContent).filter(Boolean)

describe('the normal launch path adds no click, notice or wait', () => {
  it('launch, its one review, then Finish, with no notice on the way', async () => {
    let clicks = 0
    const press = async (text: string) => { clicks += 1; await click(text) }
    const done = saved({ direct: { started: true, hash: HASH }, candidates: { 84532: [HASH] },
      results: { 84532: { hash: HASH, projectId: '7', token: ADDRESS } }, proven: { 84532: { hash: HASH, projectId: '7', token: ADDRESS } } })
    // Vitest can hand a second concurrent first import of a mocked module the real one: the result lands after the saved launch's import.
    mocks.run.mockImplementationOnce(async () => { await vi.dynamicImportSettled(); mocks.changed?.(done) })
    mocks.clear.mockImplementationOnce(async () => mocks.changed?.(null))
    await mount()
    await show()
    const seen: string[][] = []
    await press('Prepare fixture')
    await act(async () => { await vi.dynamicImportSettled() })
    seen.push(notices())
    expect(container.textContent).toContain('Open Sticky token')
    await press('Finish')
    seen.push(notices())
    expect(clicks).toBe(2)
    expect(mocks.run).toHaveBeenCalledOnce()
    expect(mocks.clear).toHaveBeenCalledOnce()
    // The saved launch, its result and Finish each refresh the home once.
    await vi.waitFor(() => expect(mocks.refreshHome).toHaveBeenCalledTimes(3))
    expect(seen).toEqual([[], []])
  })
})
