import type { MetadataRoute } from 'next'
import { isProductionSite } from '@/lib/jbcenter-config'

export default function robots(): MetadataRoute.Robots {
  // Staging and local builds are copies of sticky.center: crawlers read none of them.
  if (!isProductionSite()) return { rules: [{ userAgent: '*', disallow: '/' }] }
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // One thin page per wallet address is unbounded crawl space with nothing to rank.
        disallow: ['/account/'],
      },
    ],
  }
}
