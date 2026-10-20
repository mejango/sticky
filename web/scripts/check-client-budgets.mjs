// Route budget gate: starts the built app, fetches each route's HTML and gzips
// every script it references (script tags and the chunk list the page's flight
// data hands the client), leaving out nomodule polyfills that modern browsers
// skip. Next's per-route manifests are not used: they attribute a client module
// shared by a layout and a page to whichever entry merged last, so they
// over-count some routes and miss leaks into others.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { referencedChunks } from './lib/referenced-chunks.mjs'

const KIB = 1024
const dist = resolve(process.env.NEXT_DIST_DIR || '.next')

// First-load JavaScript, gzip. Measured on a clean production build with the
// pinned Node and npm; ratchet down when a change makes a route smaller.
const budgets = {
  '/': 356 * KIB,
  '/base:23': 481 * KIB,
  '/account/0x0000000000000000000000000000000000000001': 347 * KIB,
  '/center/callback': 313 * KIB,
  '/zz-not-a-route': 315 * KIB,
}

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })
}

async function main() {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const server = spawn(process.execPath, ['scripts/start-standalone.mjs'], {
    env: { ...process.env, PORT: String(port), HOSTNAME: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  const exited = new Promise(done => server.once('exit', done))
  let failed = false
  try {
    let up = false
    for (let attempt = 0; attempt < 120 && !up; attempt++) {
      if (server.exitCode !== null) throw new Error('The standalone server exited. Run npm run build first.')
      up = await fetch(`${origin}/api/healthz`).then(r => r.ok, () => false)
      if (!up) await new Promise(done => setTimeout(done, 500))
    }
    if (!up) throw new Error('The standalone server did not start.')
    const rows = []
    const report = {}
    for (const [route, ceiling] of Object.entries(budgets)) {
      const response = await fetch(origin + route)
      const html = await response.text()
      if (response.status !== 200 && response.status !== 404) throw new Error(`${route} answered ${response.status}`)
      const files = referencedChunks(html)
      if (files.length === 0) throw new Error(`${route} references no scripts`)
      let total = 0
      const sizes = []
      for (const file of files) {
        const path = join(dist, file)
        if (!existsSync(path)) throw new Error(`${route} references ${file}, which the build did not emit`)
        const size = gzipSync(readFileSync(path)).byteLength
        total += size
        sizes.push([file, size])
      }
      report[route] = { total, files: sizes }
      const over = total > ceiling
      failed ||= over
      rows.push(`${over ? 'OVER' : 'ok  '} ${route.padEnd(56)} ${(total / KIB).toFixed(1).padStart(7)} / ${(ceiling / KIB).toFixed(0)} KiB  ${files.length} files`)
    }
    console.log(rows.join('\n'))
    // `--json <file>` keeps each route's files and sizes, for comparing builds.
    const json = process.argv.indexOf('--json')
    if (json > 0) writeFileSync(process.argv[json + 1], JSON.stringify(report, null, 1))
  } finally {
    server.kill()
    await exited
  }
  if (failed) {
    console.error('A route is over its first-load budget.')
    process.exit(1)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
