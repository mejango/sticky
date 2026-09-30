import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const runtime = vi.hoisted(() => ({ create: vi.fn(), config: null as { issuer: string; audience: string } | null }))
vi.mock('@bananapus/nana-sdk-connect/core', () => ({ createCenterWalletClient: runtime.create }))
vi.mock('@/providers/wallet-config', () => ({ get CENTER_WALLET_CONFIG() { return runtime.config } }))
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); runtime.create.mockReturnValue({ client: true })
  runtime.config = { issuer: 'https://my.juicebox.center', audience: 'https://juicebox.center' }
  const values = new Map<string, string>()
  vi.stubGlobal('window', { location: { origin: 'https://sticky-dev.up.railway.app', pathname: '/base:23' },
    sessionStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } })
})
afterEach(() => vi.unstubAllGlobals())
describe('Center runtime', () => {
  it('builds one wallet client for this origin with the exact callback', async () => {
    const { centerWalletClient } = await import('@/providers/center-runtime')
    expect(centerWalletClient()).toBe(centerWalletClient())
    expect(runtime.create).toHaveBeenCalledExactlyOnceWith({ issuer: 'https://my.juicebox.center', audience: 'https://juicebox.center', callbackUri: 'https://sticky-dev.up.railway.app/center/callback' })
  })
  it('refuses to build a wallet client on a site that has no Signa configuration', async () => {
    runtime.config = null
    const { centerWalletClient } = await import('@/providers/center-runtime')
    expect(() => centerWalletClient()).toThrow('Signa sign-in is not configured for this site.')
    expect(runtime.create).not.toHaveBeenCalled()
  })
  it('preserves the original page before a passkey launch and refuses when it cannot', async () => {
    const { saveCenterReturnPath, originalCenterPage } = await import('@/providers/center-runtime')
    expect(originalCenterPage()).toBe('/')
    saveCenterReturnPath()
    expect(originalCenterPage()).toBe('/base:23')
    window.sessionStorage.setItem = () => { throw Error('full') }
    expect(() => saveCenterReturnPath()).toThrow('full')
    window.location.pathname = '/center/callback'
    window.sessionStorage.setItem = () => {}
    expect(() => saveCenterReturnPath()).toThrow()
  })
  it("returns to any of Sticky's own pages, and only to a page it saved itself", async () => {
    const { saveCenterReturnPath, originalCenterPage } = await import('@/providers/center-runtime')
    for (const pathname of ['/@jango', '/account/0x1111111111111111111111111111111111111111', '/']) {
      window.location.pathname = pathname
      saveCenterReturnPath()
      expect(originalCenterPage()).toBe(pathname)
    }
    // Whatever else sits under the key, from another script or an older page, is not a place to send the tab.
    window.sessionStorage.setItem('sticky:center:return:v2', '//evil.example')
    expect(() => originalCenterPage()).toThrow('The original Sticky page is unavailable.')
    window.sessionStorage.setItem('sticky:center:return:v2', '#/project/12')
    expect(() => originalCenterPage()).toThrow('The original Sticky page is unavailable.')
  })
})
