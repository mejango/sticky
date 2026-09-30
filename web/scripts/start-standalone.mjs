import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const dist = resolve(process.env.NEXT_DIST_DIR || '.next')
const standalone = join(dist, 'standalone')
const server = join(standalone, 'server.js')

if (!existsSync(server)) {
  throw new Error('Missing standalone build. Run npm run build first.')
}

// Next's local standalone tree omits static/public assets because production
// images copy them beside server.js as separate layers. Recreate that exact
// runtime layout for local and Playwright runs without `next start` semantics.
// The server reads its build from its own copy of the dist directory, at the
// same path inside the tree.
const served = join(standalone, relative(process.cwd(), dist))
mkdirSync(served, { recursive: true })
cpSync(join(dist, 'static'), join(served, 'static'), {
  recursive: true,
  force: true,
})
cpSync(resolve('public'), join(standalone, 'public'), {
  recursive: true,
  force: true,
})

process.chdir(standalone)
await import(pathToFileURL(server).href)
