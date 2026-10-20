import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

const ALICE = '0x1111111111111111111111111111111111111111'

const gate = vi.hoisted(() => {
  let open = () => {}
  const loaded = new Promise<void>(resolve => (open = resolve))
  return { loaded, open: () => open() }
})

vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ address: ALICE, isConnected: true, isCenterWallet: false, openSignIn: vi.fn() }),
}))
vi.mock('@/lib/viewAs', () => ({ useViewAs: () => ({ viewAs: null }) }))
vi.mock('@/providers/preload-center', () => ({ preloadSignIn: vi.fn() }))
// The menu's module loads only when the test says so: the window between the button and the menu is what is tested.
vi.mock('@/components/SignedInWallet', async () => {
  await gate.loaded
  return {
    SignedInWallet: ({ openOnLoad }: { openOnLoad: boolean }) =>
      createElement('p', { id: 'menu' }, openOnLoad ? 'open' : 'closed'),
  }
})

import { WalletButton } from '@/components/WalletButton'

describe('the account button while its menu loads', () => {
  it('opens the menu once loaded when pressed before', async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(WalletButton))
    })
    // The fallback is the same button, and it takes the press.
    const trigger = renderer.root.findByType('button')
    expect(trigger.props.title).toBe(ALICE)
    act(() => trigger.props.onClick())
    await act(async () => {
      gate.open()
      await gate.loaded
    })
    expect(renderer.root.findByProps({ id: 'menu' }).children).toEqual(['open'])
  })
})
