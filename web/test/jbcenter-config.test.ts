import { describe, expect, it, vi } from 'vitest'
import { JBCENTER_DEFAULT_URL } from '@bananapus/nana-sdk-core/jbcenter'
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
})

describe('Sticky JB Center deployment origins', () => {
  it('uses Sticky production origin for production without borrowing another application identity', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
    vi.stubEnv('NEXT_PUBLIC_JBCENTER_URL', '')
    expect(jbCenterAppOrigin()).toBe('https://sticky.center')
    expect(jbCenterBaseUrl()).toBe(JBCENTER_DEFAULT_URL)
  })

  it('maps supported local and staging origins to development Center', () => {
    vi.stubEnv('NEXT_PUBLIC_JBCENTER_URL', '')
    for (const origin of ['http://127.0.0.1:8788', 'https://sticky-dev.up.railway.app', 'https://dev.sticky.center']) {
      expect(jbCenterAppOrigin(origin)).toBe(origin)
      expect(jbCenterBaseUrl(origin)).toBe('https://dev.juicebox.center')
    }
  })

  it('uses the default npm development port when no explicit site URL is set', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
    vi.stubEnv('NEXT_PUBLIC_JBCENTER_URL', '')
    expect(jbCenterAppOrigin()).toBe('http://127.0.0.1:8788')
    expect(jbCenterBaseUrl()).toBe('https://dev.juicebox.center')
  })

  it('respects an explicitly configured endpoint without altering the real app origin', () => {
    vi.stubEnv('NEXT_PUBLIC_JBCENTER_URL', 'https://center.example')
    expect(jbCenterBaseUrl('https://sticky.center/path')).toBe('https://center.example')
    expect(jbCenterAppOrigin('https://sticky.center/path')).toBe('https://sticky.center')
  })

  it.each([
    ['unset', undefined],
    ['empty, as `.env.example` leaves it', ''],
    ['only whitespace, which the deployment check reads as unset', ' \t\n '],
  ])('falls back to the default Center when NEXT_PUBLIC_JBCENTER_URL is %s', (_name, value) => {
    vi.stubEnv('NEXT_PUBLIC_JBCENTER_URL', value)
    expect(jbCenterBaseUrl('https://sticky.center')).toBe(JBCENTER_DEFAULT_URL)
    expect(jbCenterBaseUrl('https://dev.sticky.center')).toBe('https://dev.juicebox.center')
  })

  it('takes a configured endpoint without the whitespace around it, as the deployment check does', () => {
    vi.stubEnv('NEXT_PUBLIC_JBCENTER_URL', ' \thttps://center.example\n ')
    expect(jbCenterBaseUrl('https://sticky.center')).toBe('https://center.example')
  })
})
