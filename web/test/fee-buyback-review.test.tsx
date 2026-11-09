// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { useFeeBuybackReview } from '@bananapus/nana-sdk-core/review/react'
import { FeeBuybackNotice } from '../src/components/FeeBuybackNotice'

type Review = ReturnType<typeof useFeeBuybackReview>
const fee = { key: 'base:6', projectId: 6n, received: 9429n * 10n ** 18n, route: 'fallback' as const }
const review = (state: Partial<Review>): Review => ({
  enabled: true, status: 'fallback', result: { status: 'fallback', fees: [fee], checkedAt: Date.now() }, busy: false, settled: true,
  waiting: false, autoRefresh: true, confirmLabel: undefined, confirm: vi.fn(async () => true), retry: vi.fn(), wait: vi.fn(), ...state,
} as Review)
let root: Root, host: HTMLDivElement
afterEach(() => { act(() => root.unmount()); host.remove() })
async function render(shown: Review) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<FeeBuybackNotice review={shown} />))
}
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent === label)

// The fee return machine is the SDK's (useFeeBuybackReview); Sticky renders its state.
describe('fee return notice', () => {
  it('shows a fallback with its amount and lets the person wait', async () => {
    const shown = review({})
    await render(shown)
    expect(host.textContent).toContain('9,429')
    expect(host.textContent).toContain('Checking new blocks automatically')
    await act(async () => button('Wait for better rate')!.click())
    expect(shown.wait).toHaveBeenCalledOnce()
  })
  it('shows a pending first check as checking, never as unavailable', async () => {
    await render(review({ status: 'checking', busy: true, settled: false, result: { status: 'unknown', fees: [] } }))
    expect(host.textContent).toContain('Checking fee return…')
    expect(host.textContent).not.toContain('unavailable')
    expect(button('Retry now')).toBeUndefined()
  })
  it('offers retry when the return is unknown and blocks are not watched', async () => {
    const shown = review({ status: 'unknown', autoRefresh: false, result: { status: 'unknown', fees: [] } })
    await render(shown)
    expect(host.textContent).toContain('Automatic checks unavailable. Retry now.')
    await act(async () => button('Retry now')!.click())
    expect(shown.retry).toHaveBeenCalledOnce()
  })
  it('shows nothing when no call pays a fee', async () => {
    await render(review({ enabled: false, status: 'none', result: { status: 'none', fees: [] } }))
    expect(host.textContent).toBe('')
  })
})
