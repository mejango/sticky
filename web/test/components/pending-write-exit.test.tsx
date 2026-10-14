import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PendingWriteExit } from '@/components/ui/PendingWriteExit'
import type { PendingBridgeWrite } from '@/lib/sticky-bridge-journal'

const ADDRESS = `0x${'1'.repeat(40)}` as const
const HASH = `0x${'a'.repeat(64)}` as const
const pending = { id: 'p1', owner: ADDRESS, at: 1, request: { chainId: 10, address: ADDRESS, data: '0x1234', value: '0' } } as unknown as PendingBridgeWrite

let container: HTMLDivElement
let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
const button = (text: string) => [...container.querySelectorAll('button')].find(item => item.textContent === text)
const mount = async (props: Partial<Parameters<typeof PendingWriteExit>[0]>) => {
  await act(async () => root.render(<PendingWriteExit pending={pending} disabled={false} exit={async () => {}} {...props} />))
  await act(async () => { await Promise.resolve() })
}

describe('PendingWriteExit when adoption is refused or unreadable', () => {
  it.each([['refuses', async () => 'refused' as const], ['throws', async () => { throw new Error('rpc down') }]])('offers the one explicit check when adoption %s and nothing is held', async (_name, adopt) => {
    const exit = vi.fn(async () => {})
    await mount({ look: async () => null, adopt, exit })
    expect(container.textContent).toContain('cannot be confirmed from here')
    await act(async () => { button('I checked it. Review it again.')!.click() })
    expect(exit).toHaveBeenCalledOnce()
  })

  it('lets a settlement win over a refused adoption: nothing to check, the settlement is recorded', async () => {
    const settle = vi.fn(async () => true)
    await mount({ look: async () => ({ settled: { hash: HASH, result: 'success' as const } }), adopt: async () => 'refused' as const, settle })
    expect(settle).toHaveBeenCalledWith({ hash: HASH, result: 'success' })
    expect(button('I checked it. Review it again.')).toBeUndefined()
  })

  it('offers no check for a write whose success the journal already holds, even when recovery fails', async () => {
    const exit = vi.fn(async () => {})
    await mount({ pending: { ...pending, hash: HASH, settled: 'success' } as unknown as PendingBridgeWrite, look: async () => { throw new Error('rpc down') }, adopt: async () => 'refused' as const, exit, confirming: 'Your transfer went through. Its result is still confirming.' })
    expect(button('I checked it. Review it again.')).toBeUndefined()
    expect(container.textContent).not.toContain('cannot be confirmed from here')
    expect(container.textContent).toContain('Your transfer went through. Its result is still confirming.')
  })

  it('prefers the hold the SDK shows over the refused-adoption view', async () => {
    await mount({ look: async () => ({ exit: true, line: 'Held by the SDK.' }), adopt: async () => 'refused' as const })
    expect(container.textContent).toContain('Held by the SDK.')
    expect(container.textContent).not.toContain('cannot be confirmed from here')
  })
})
