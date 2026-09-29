import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureCenterCallback, centerReturnPath, clearCenterCallbackUrl } from '@/providers/center-callback'
describe('Center callback containment', () => {
  it('removes all callback data before the SDK or page controller runs, including malformed callbacks', () => {
    const replace = vi.fn(), url = 'https://sticky.center/center/callback?code=secret&state=state&iss=https%3A%2F%2Fwallet.juicebox.center#bad'
    expect(captureCenterCallback({ href: url, replace })).toEqual({ url })
    expect(replace).toHaveBeenCalledExactlyOnceWith('/center/callback')
  })
  it('leaves ordinary navigation intact and fails closed when history cannot be cleared', () => {
    const replace = vi.fn()
    expect(captureCenterCallback({ href: 'https://sticky.center/base:23', replace })).toBeNull()
    expect(replace).not.toHaveBeenCalled()
    expect(() => captureCenterCallback({ href: 'https://sticky.center/center/callback?code=x', replace: () => { throw Error('blocked') } })).toThrow()
  })
  it('restores only a bounded local page path without callback secrets or external redirects', () => {
    const account = '/account/0x1111111111111111111111111111111111111111'
    for (const path of ['/', '/base:23', '/@jango', '/@sub.jango', account, `${account}/`, '/@jos%C3%A9.eth', '/' + 'a'.repeat(1023)])
      expect(centerReturnPath(path)).toBe(path)
    for (const path of ['', 'base:23', '//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', '#/x"><script>',
      '/center/callback', '/base:23?code=x', '/%2f%2fevil', '/%2F', '/a%5Cb', '/%zz', '/a#secret', '/a//b', '/a//', '/' + 'a'.repeat(1024)])
      expect(() => centerReturnPath(path), path).toThrow('The original Sticky page is unavailable.')
    expect(() => centerReturnPath(undefined as unknown as string)).toThrow()
  })
  it('checks a hostile path in linear time', () => {
    expect(() => centerReturnPath('/' + 'a'.repeat(1000) + '!')).toThrow()
  })
})

describe('the module clears the address bar as it loads', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    window.history.replaceState(null, '', '/')
  })
  it('scrubs a callback URL and hands the original to the page controller', async () => {
    window.history.replaceState(null, '', '/center/callback?code=secret&state=state#frag')
    const original = window.location.href
    vi.resetModules()
    const { capturedCenterCallback } = await import('@/providers/center-callback')
    expect(window.location.href).toBe(`${window.location.origin}/center/callback`)
    expect(capturedCenterCallback()).toEqual({ url: original })
  })
  it('leaves every other page alone', async () => {
    window.history.replaceState(null, '', '/base:23?x=1')
    vi.resetModules()
    const { capturedCenterCallback } = await import('@/providers/center-callback')
    expect(capturedCenterCallback()).toBeNull()
    expect(window.location.pathname + window.location.search).toBe('/base:23?x=1')
  })
  it('refuses to go on when the callback could not be cleared', async () => {
    window.history.replaceState(null, '', '/center/callback?code=secret')
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => { throw new Error('blocked') })
    vi.resetModules()
    const { capturedCenterCallback } = await import('@/providers/center-callback')
    expect(() => capturedCenterCallback()).toThrow('The wallet callback could not be cleared safely.')
  })
  it('clears it again once the router has written it back, and only on the callback page', () => {
    window.history.replaceState(null, '', '/center/callback?code=secret&state=state#frag')
    clearCenterCallbackUrl()
    expect(window.location.href).toBe(`${window.location.origin}/center/callback`)

    window.history.replaceState(null, '', '/base:23?x=1#tokens')
    const replaceState = vi.spyOn(window.history, 'replaceState')
    clearCenterCallbackUrl()
    expect(replaceState).not.toHaveBeenCalled()
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/base:23?x=1#tokens')
  })
  it('leaves an address bar that is already clean alone', () => {
    window.history.replaceState(null, '', '/center/callback')
    const replaceState = vi.spyOn(window.history, 'replaceState')
    clearCenterCallbackUrl()
    expect(replaceState).not.toHaveBeenCalled()
  })
  it('runs before any wallet code: it is the first import of the provider tree', () => {
    const source = readFileSync(join('src', 'providers', 'Providers.tsx'), 'utf8')
    expect(source.split('\n').find(line => line.startsWith('import '))).toBe("import './center-callback'")
  })
})
