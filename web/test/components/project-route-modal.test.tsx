// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import { ProjectRouteBoundary, ProjectRouteProvider } from '@/providers/ProjectRouteContext'
import { ModalShell } from '@/components/ui/ModalShell'
import { replaceProjectTabHash } from '@/components/project/Tabs'
import { topLayerDialogs } from '../dialog-shim'
vi.mock('next/navigation', () => ({ useRouter: () => router }))
const router = { refresh: vi.fn() }

it('releases native modal blocking for failed-proof Retry and preserves same-project form state on recovery', async () => {
  vi.useFakeTimers()
  window.history.replaceState({}, '', '/@design.juicebox')
  const route = () => ({ chainId: 8453 as const, projectId: 7, handle: 'design.juicebox', checkedAt: Date.now(), serverNow: Date.now() })
  vi.mocked(fetch).mockImplementation(async () => Response.json(route()))
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const dismiss = vi.fn()
  const client = new QueryClient()
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><ProjectRouteProvider>
      <ProjectRouteBoundary snapshot={route()}><ModalShell title="Review" onClose={dismiss}><input defaultValue="draft" /></ModalShell></ProjectRouteBoundary>
    </ProjectRouteProvider></QueryClientProvider>))
    const dialog = host.querySelector('dialog')!
    const input = host.querySelector('input')!
    input.value = 'preserved draft'
    expect(dialog.open).toBe(true)
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 503 }))
    await act(async () => vi.advanceTimersByTime(5_001))
    await act(async () => replaceProjectTabHash('#owners'))
    expect(dialog.open).toBe(false)
    expect(topLayerDialogs()).toHaveLength(0)
    expect(document.body.style.overflow).not.toBe('hidden')
    expect(dismiss).not.toHaveBeenCalled()
    const retry = [...host.querySelectorAll('button')].find(button => button.textContent === 'Try again')!
    expect(retry.closest('[hidden]')).toBeNull()
    vi.mocked(fetch).mockImplementation(async () => Response.json(route()))
    await act(async () => retry.click())
    expect(host.querySelector('dialog')).toBe(dialog)
    expect(dialog.open).toBe(true)
    expect(input.value).toBe('preserved draft')
    expect(dismiss).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); client.clear(); host.remove() }
})
