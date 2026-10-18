// @vitest-environment node
import { createRequire } from 'node:module'
import { expect, it, vi } from 'vitest'

const config = createRequire(import.meta.url)('../next.config.js')

it('keeps historical deployment fixtures out of production builds', () => {
  vi.stubEnv('STICKY_HISTORICAL_BROWSER_FIXTURE', '')
  expect(config('phase-production-build').webpack).toBeUndefined()
  vi.stubEnv('STICKY_HISTORICAL_BROWSER_FIXTURE', 'true')
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://sticky.center')
  vi.stubEnv('NEXT_DIST_DIR', '.next-browser')
  expect(() => config('phase-production-build')).toThrow('restricted')
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'http://127.0.0.1:8793')
  vi.stubEnv('NEXT_DIST_DIR', '.next')
  expect(() => config('phase-production-build')).toThrow('restricted')
})

it.each(['.next-browser', '.next-signa'])('isolates the historical recording in %s', dist => {
  vi.stubEnv('STICKY_HISTORICAL_BROWSER_FIXTURE', 'true')
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'http://127.0.0.1:8793')
  vi.stubEnv('NEXT_DIST_DIR', dist)
  const webpack = { resolve: { alias: {} as Record<string, string> } }
  config('phase-production-build').webpack(webpack)
  expect(webpack.resolve.alias['@/lib/sticky-deployments.json$']).toMatch(/test\/fixtures\/historical-sticky-deployments.json$/)
})
