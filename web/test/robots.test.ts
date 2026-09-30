import { afterEach, describe, expect, it, vi } from 'vitest'
import robots from '@/app/robots'

describe('robots.txt', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('keeps every crawler out of a deployment that is not sticky.center', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://sticky-dev.up.railway.app')
    expect(robots().rules).toEqual([{ userAgent: '*', disallow: '/' }])
  })

  it('lets every crawler read the site, except the account pages', () => {
    expect(robots().rules).toEqual([{ userAgent: '*', allow: '/', disallow: ['/account/'] }])
  })

  // There is no sitemap to name: a line for a file that does not exist sends a crawler to a 404.
  it('names no sitemap', () => {
    expect(robots().sitemap).toBeUndefined()
  })
})
