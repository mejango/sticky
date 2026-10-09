import { afterEach, beforeEach, vi } from 'vitest'
import { browserWriteRecoveryModel } from './support/write-recovery'

function blockedNetworkConstructor(transport: string) {
  return class {
    constructor(url?: string | URL) {
      throw new Error(
        `Unexpected ${transport} connection in unit test: ${String(url ?? 'unknown URL')}`,
      )
    }
  }
}

beforeEach(() => {
  // Node 26 exposes an optional process-wide storage getter. Browser tests
  // must use jsdom's per-window storage, including when Node's getter is unset.
  const browser = (globalThis as typeof globalThis & { jsdom?: { window: Window } }).jsdom?.window
  if (browser) {
    vi.stubGlobal('localStorage', browser.localStorage)
    vi.stubGlobal('sessionStorage', browser.sessionStorage)
    browser.localStorage.clear()
  }
  const { locks } = browserWriteRecoveryModel()
  const navigator = globalThis.navigator ?? {}
  vi.stubGlobal('navigator', new Proxy(navigator, {
    get: (target, property) => property === 'locks' ? locks : Reflect.get(target, property, target),
  }))
  // Match the reference Vitest config's clearMocks policy for shared spies.
  vi.clearAllMocks()
  // React 19 requires test environments to opt into act() semantics
  // explicitly. Every renderer mutation in the component suites is wrapped
  // in act(), so advertise that contract and fail loudly if a future test is
  // not.
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'fetch',
    vi.fn(async input => {
      throw new Error(
        `Unexpected network request in unit test: ${String(input)}`,
      )
    }),
  )
  vi.stubGlobal('XMLHttpRequest', blockedNetworkConstructor('XMLHttpRequest'))
  vi.stubGlobal('WebSocket', blockedNetworkConstructor('WebSocket'))
  vi.stubGlobal('EventSource', blockedNetworkConstructor('EventSource'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
