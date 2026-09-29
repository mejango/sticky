import { describe, expect, it, vi } from 'vitest'
import { jbCenterAppOrigin, jbCenterBaseUrl } from '@/lib/jbcenter-config'

describe('JB Center environment', () => {
  it('reads dev Center from the local server and dev.sticky.center', () => {
    expect(jbCenterBaseUrl('http://127.0.0.1:8788')).toBe('https://dev.juicebox.center')
    expect(jbCenterBaseUrl('https://dev.sticky.center')).toBe('https://dev.juicebox.center')
  })

  it('reads dev Center from the staging origin', () => {
    expect(jbCenterBaseUrl('https://sticky-dev.up.railway.app')).toBe('https://dev.juicebox.center')
    expect(jbCenterAppOrigin('https://sticky-dev.up.railway.app/base:23')).toBe(
      'https://sticky-dev.up.railway.app',
    )
  })

  it('reads production Center from sticky.center', () => {
    expect(jbCenterBaseUrl('https://sticky.center')).toBe('https://juicebox.center')
    expect(jbCenterAppOrigin('https://sticky.center/base:23')).toBe('https://sticky.center')
  })

  it('does not treat other local ports, hosts or schemes as dev clients', () => {
    for (const origin of [
      'http://localhost:8788',
      'http://127.0.0.1:3000',
      'https://127.0.0.1:8788',
      'http://dev.sticky.center',
      'https://www.sticky.center',
    ]) {
      expect(jbCenterBaseUrl(origin)).toBe('https://juicebox.center')
    }
  })

  it('takes the site from NEXT_PUBLIC_SITE_URL, and its own Center from NEXT_PUBLIC_JBCENTER_URL', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://dev.sticky.center')
    expect(jbCenterBaseUrl()).toBe('https://dev.juicebox.center')
    expect(jbCenterAppOrigin()).toBe('https://dev.sticky.center')

    vi.stubEnv('NEXT_PUBLIC_JBCENTER_URL', 'https://center.example')
    expect(jbCenterBaseUrl()).toBe('https://center.example')
    expect(jbCenterAppOrigin()).toBe('https://dev.sticky.center')
  })

  it('names the local server in development and sticky.center everywhere else when no site is set', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
    vi.stubEnv('NODE_ENV', 'development')
    expect(jbCenterAppOrigin()).toBe('http://127.0.0.1:8788')
    expect(jbCenterBaseUrl()).toBe('https://dev.juicebox.center')

    vi.stubEnv('NODE_ENV', 'production')
    expect(jbCenterAppOrigin()).toBe('https://sticky.center')
    expect(jbCenterBaseUrl()).toBe('https://juicebox.center')
  })
})
