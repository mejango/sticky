import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ALICE = '0x1111111111111111111111111111111111111111'
const CHECKSUMMED = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const STORAGE_KEY = 'jb-view-as-v1'

// The store keeps its state at module level, so every test starts from a fresh copy.
async function freshStore() {
  vi.resetModules()
  return import('@/lib/viewAs')
}

type Store = Awaited<ReturnType<typeof freshStore>>

// Renders a component that reads the store through its hook, the way the header will.
async function mountProbe(store: Store) {
  const seen: { value?: ReturnType<Store['useViewAs']> } = {}
  function Probe() {
    seen.value = store.useViewAs()
    return null
  }
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(createElement(Probe)))
  return { latest: () => seen.value!, unmount: () => act(async () => root.unmount()) }
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

describe('View as', () => {
  it('starts inactive, and reads nothing from a store it cannot parse', async () => {
    let store = await freshStore()
    expect(store.getViewAs()).toBeNull()

    window.localStorage.setItem(STORAGE_KEY, 'not an address')
    store = await freshStore()
    expect(store.getViewAs()).toBeNull()
  })

  it('remembers the account across page loads, in its checksummed form', async () => {
    const store = await freshStore()
    store.setViewAs(CHECKSUMMED.toLowerCase() as `0x${string}`)
    expect(store.getViewAs()).toBe(CHECKSUMMED)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(CHECKSUMMED)

    const reloaded = await freshStore()
    expect(reloaded.getViewAs()).toBe(CHECKSUMMED)

    reloaded.clearViewAs()
    expect(reloaded.getViewAs()).toBeNull()
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('keeps working in memory when storage refuses to write', async () => {
    const store = await freshStore()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    store.setViewAs(CHECKSUMMED as `0x${string}`)
    expect(store.getViewAs()).toBe(CHECKSUMMED)
  })

  it('is inert without a window (SSR) yet still tracks in memory', async () => {
    vi.stubGlobal('window', undefined)
    const store = await freshStore()

    expect(store.getViewAs()).toBeNull()
    store.setViewAs(ALICE)
    expect(store.getViewAs()).toBe(ALICE)
    store.clearViewAs()
    expect(store.getViewAs()).toBeNull()
  })

  it('refuses writes while it is active, and only then', async () => {
    const store = await freshStore()
    expect(() => store.assertNoViewAs()).not.toThrow()

    store.setViewAs(ALICE)
    expect(() => store.assertNoViewAs()).toThrow(store.VIEW_AS_WRITE_BLOCKED)
    // Two plain sentences: the site's copy puts no dash inside a sentence.
    expect(store.VIEW_AS_WRITE_BLOCKED).toBe("You're viewing the site as another account. Exit View as to transact.")

    store.clearViewAs()
    expect(() => store.assertNoViewAs()).not.toThrow()
  })

  it('notifies useViewAs subscribers', async () => {
    const store = await freshStore()
    const probe = await mountProbe(store)
    expect(probe.latest()).toMatchObject({ viewAs: null, isViewAs: false })

    await act(async () => probe.latest().setViewAs(ALICE))
    expect(probe.latest()).toMatchObject({ viewAs: ALICE, isViewAs: true })

    await act(async () => probe.latest().clearViewAs())
    expect(probe.latest()).toMatchObject({ viewAs: null, isViewAs: false })

    await probe.unmount()
  })

  it('follows a change made in another tab', async () => {
    const store = await freshStore()
    const probe = await mountProbe(store)
    expect(probe.latest().viewAs).toBeNull()

    window.localStorage.setItem(STORAGE_KEY, CHECKSUMMED)
    await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY })) })
    expect(probe.latest().viewAs).toBe(CHECKSUMMED)

    // Another key changing is not a reason to read the store again.
    window.localStorage.removeItem(STORAGE_KEY)
    await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: 'something-else' })) })
    expect(probe.latest().viewAs).toBe(CHECKSUMMED)

    await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY })) })
    expect(probe.latest().viewAs).toBeNull()

    await probe.unmount()
  })
})
