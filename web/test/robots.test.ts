import { describe, expect, it } from 'vitest'
import robots from '@/app/robots'

describe('robots.txt', () => {
  it('lets every crawler read the site, except the account pages', () => {
    expect(robots().rules).toEqual([{ userAgent: '*', allow: '/', disallow: ['/account/'] }])
  })

  // There is no sitemap to name: a line for a file that does not exist sends a crawler to a 404.
  it('names no sitemap', () => {
    expect(robots().sitemap).toBeUndefined()
  })
})
