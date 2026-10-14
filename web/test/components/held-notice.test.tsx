import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { HELD_RELEASE_LABEL } from '@bananapus/nana-sdk-core/review'
import { getAddress } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { heldChain, heldWrite } from '../support/held-chain'

const chain = vi.hoisted(() => ({ current: undefined as undefined | { client: unknown } }))
vi.mock('wagmi', () => ({ usePublicClient: ({ chainId }: { chainId: number }) => (chainId === 84532 ? chain.current?.client : undefined) }))

import { HeldNotice } from '@/components/HeldNotice'

const ALICE = getAddress(`0x${'a'.repeat(40)}`)
const CALL = { to: getAddress(`0x${'b'.repeat(40)}`), data: '0x1234' as const }
let host: HTMLDivElement
let root: Root
beforeEach(() => { chain.current = heldChain(84532); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
const settle = async () => { for (let i = 0; i < 20; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }) }

describe('the app-wide notice of held writes', () => {
  it('shows nothing when nothing needs the user', async () => {
    await act(async () => root.render(<HeldNotice account={ALICE} />))
    await settle()
    expect(host.textContent).toBe('')
  })

  it('lists a write the SDK holds with its exit, and its release ends it', async () => {
    const client = (chain.current as ReturnType<typeof heldChain>).client
    await heldWrite({ chainId: 84532, account: ALICE, namespace: 'intent:test-notice', call: CALL, client })
    await act(async () => root.render(<HeldNotice account={ALICE} />))
    await settle()
    const release = [...host.querySelectorAll('button')].find(button => button.textContent === HELD_RELEASE_LABEL)
    expect(release).toBeDefined()
    await act(async () => release!.click())
    await settle()
    expect([...host.querySelectorAll('button')].some(button => button.textContent === HELD_RELEASE_LABEL)).toBe(false)
  })
})
