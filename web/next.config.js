/** @type {import('next').NextConfig} */
const { PHASE_DEVELOPMENT_SERVER } = require('next/constants')

// The app may be framed only by Safe.
const securityHeaders = [
  {
    key: 'Content-Security-Policy',
    value: 'frame-ancestors https://app.safe.global https://app.5afe.dev',
  },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=()',
  },
]

// The Signa sign-in frames /center/callback from Sticky's own origin, so the
// page has its own policy and the site-wide set skips it. A browser enforces
// every frame-ancestors policy on a response, and Safe's origins do not include
// Sticky.
const centerCallbackHeaders = [
  { key: 'Cache-Control', value: 'no-store' },
  { key: 'Referrer-Policy', value: 'strict-origin' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
]

module.exports = phase => ({
  // Emit a self-contained server tree for the production OCI image. Keep
  // tracing rooted here because the repository root also has a lockfile.
  output: 'standalone',
  outputFileTracingRoot: __dirname,
  // The git SHA is set at build and run time by the Dockerfile. Next appends it
  // to asset URLs and navigation requests, and hard-navigates a tab whose
  // deployment differs from the server's instead of failing on stale chunks.
  deploymentId: process.env.NEXT_PUBLIC_VERSION,
  // Keep development and production artifacts separate. Running `next build`
  // while the dev server is active otherwise leaves their webpack chunks
  // mixed together and causes intermittent MODULE_NOT_FOUND errors.
  distDir:
    process.env.NEXT_DIST_DIR ||
    (phase === PHASE_DEVELOPMENT_SERVER ? '.next-dev' : '.next'),
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    // Preserve the SDK's ergonomic barrels while compiling client routes from
    // the narrow v6 modules they actually use.
    optimizePackageImports: ['@bananapus/nana-sdk-core'],
    // Keep Next's caches in memory. Its fetch cache writes one file per entry
    // to .next/cache/fetch-cache and never removes one, so a client that varies
    // the variables of a Bendystraw relay request would fill the disk, while
    // memory is bounded by cacheMaxMemorySize. Next also turns its image
    // optimizer's disk cache off with this, so an image is optimized again on
    // each request that reaches the server.
    isrFlushToDisk: false,
  },
  // `page.browsertest.tsx` files are routes ONLY in the deterministic browser
  // build the Playwright suite compiles. They never reach a production image:
  // without the extra extension Next does not treat the file as a route at
  // all, so nothing is emitted and nothing is reachable.
  pageExtensions:
    process.env.NEXT_PUBLIC_DETERMINISTIC_BROWSER === 'true'
      ? ['tsx', 'ts', 'jsx', 'js', 'browsertest.tsx']
      : ['tsx', 'ts', 'jsx', 'js'],
  images: {
    // Project media is content-addressed (IPFS), so optimized variants can be
    // cached aggressively. Bundled artwork uses hashed static imports and is
    // served immutable independently of this TTL.
    minimumCacheTTL: 60 * 60 * 24 * 365,
    remotePatterns: [
      { protocol: 'https', hostname: 'juicebox.center', pathname: '/ipfs/**' },
    ],
  },
  async headers() {
    return [
      { source: '/((?!center/callback).*)', headers: securityHeaders },
      { source: '/center/callback', headers: centerCallbackHeaders },
      {
        source: '/manifest.json',
        headers: [{ key: 'Access-Control-Allow-Origin', value: '*' }],
      },
      // Next serves public/ files with max-age=0, and link-preview proxies
      // (Discord's included) won't hold onto uncacheable media — the embed
      // keeps its blurhash placeholder and never shows the image. These are
      // stable brand assets; a day of cache is safe and correct.
      {
        source: '/assets/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=86400, stale-while-revalidate=604800',
          },
        ],
      },
    ]
  },
  // One origin for the app, so wallet sign-in and framing allowlists name only
  // sticky.center.
  async redirects() {
    return [
      {
        source: '/:path*',
        has: [{ type: 'host', value: 'www.sticky.center' }],
        destination: 'https://sticky.center/:path*',
        permanent: true,
      },
    ]
  },
})
