import type { MetadataRoute } from 'next'

export default function robots(): MetadataRoute.Robots {
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
