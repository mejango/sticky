import { createRequire } from 'node:module'
import type { NextConfig } from 'next'
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from 'next/constants'
import { getRedirectUrl, unstable_getResponseFromNextConfig } from 'next/experimental/testing/server'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const createConfig = require('../next.config.js') as (phase: string) => NextConfig
const nextConfig = createConfig(PHASE_PRODUCTION_BUILD)
const headerRoutes = async () => (await nextConfig.headers?.()) ?? []

const SAFE_FRAMING = 'frame-ancestors https://app.safe.global https://app.5afe.dev'
const CALLBACK_FRAMING = "frame-ancestors 'self'"

// Runs a request through each header entry on its own, with Next's own matcher,
// and lists the entries that set a Content-Security-Policy for that path.
async function policiesFor(path: string) {
  const matching: { source: string; policy: string }[] = []
  for (const route of await headerRoutes()) {
    const response = await unstable_getResponseFromNextConfig({
      url: `https://sticky.center${path}`,
      nextConfig: { headers: async () => [route] },
    })
    const policy = response.headers.get('content-security-policy')
    if (policy) matching.push({ source: route.source, policy })
  }
  return matching
}

describe('next config', () => {
  it('builds a standalone server and sends the callback page its own headers', async () => {
    expect(nextConfig.output).toBe('standalone')
    const callback = (await headerRoutes()).find(entry => entry.source === '/center/callback')
    expect(callback?.headers).toContainEqual({ key: 'Cache-Control', value: 'no-store' })
    expect(callback?.headers).toContainEqual({ key: 'Referrer-Policy', value: 'strict-origin' })
    expect(callback?.headers).toContainEqual({ key: 'Content-Security-Policy', value: CALLBACK_FRAMING })
    expect(callback?.headers).toContainEqual({ key: 'X-Content-Type-Options', value: 'nosniff' })
  })

  it('gives the callback page one frame-ancestors policy, its own, so Sticky can frame it', async () => {
    for (const path of ['/center/callback', '/center/callback/', '/center/callback?code=abc&state=xyz']) {
      expect(await policiesFor(path)).toEqual([{ source: '/center/callback', policy: CALLBACK_FRAMING }])
    }
  })

  it('skips the site-wide headers for the callback page alone, not for every path that starts with its name', async () => {
    for (const path of ['/center/callback/x', '/center/callback/x/y', '/center/callbackfoo', '/center/callback-x', '/center', '/center/']) {
      const policies = await policiesFor(path)
      expect(policies.map(({ policy }) => policy)).toEqual([SAFE_FRAMING])
      expect(policies[0].source).not.toBe('/center/callback')
    }
  })

  it('lets only Safe frame every other page', async () => {
    const paths = ['/', '/base:23', '/@jango', '/account/0x0000000000000000000000000000000000000001', '/api/healthz']
    for (const path of paths) {
      const policies = await policiesFor(path)
      expect(policies.map(({ policy }) => policy)).toEqual([SAFE_FRAMING])
      expect(policies[0].source).not.toBe('/center/callback')
    }
  })

  it('sends www.sticky.center to the bare domain with a permanent redirect', async () => {
    const www = await unstable_getResponseFromNextConfig({
      url: 'https://www.sticky.center/base:23',
      nextConfig: createConfig,
    })
    expect(www.status).toBe(308)
    expect(getRedirectUrl(www)).toBe('https://sticky.center/base:23')
    const bare = await unstable_getResponseFromNextConfig({
      url: 'https://sticky.center/base:23',
      nextConfig: createConfig,
    })
    expect(bare.status).toBe(200)
  })

  it('keeps the cache of the Bendystraw relay in memory, where a client that varies its requests cannot fill the disk', () => {
    const { configSchema } = require('next/dist/server/config-schema') as typeof import('next/dist/server/config-schema')
    for (const phase of [PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER]) {
      const config = createConfig(phase)
      expect(config.experimental?.isrFlushToDisk).toBe(false)
      // A key that Next's schema does not know does nothing, so this catches a typo, or a Next that renames the option.
      expect(configSchema.safeParse(config).success).toBe(true)
    }
    expect(configSchema.safeParse({ experimental: { isrFlushToDisc: false } }).success).toBe(false)
  })

  it('serves images as they are, so the server resizes none and keeps no image cache', () => {
    expect(nextConfig.images).toEqual({ unoptimized: true })
  })

  it('keeps dev and production builds apart', () => {
    vi.stubEnv('NEXT_DIST_DIR', '')
    expect(createConfig(PHASE_PRODUCTION_BUILD).distDir).toBe('.next')
    expect(createConfig(PHASE_DEVELOPMENT_SERVER).distDir).toBe('.next-dev')
  })
})
