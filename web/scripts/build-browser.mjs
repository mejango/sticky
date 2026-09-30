import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { deterministicEnv, signaEnv } from './browser-env.mjs'

function onceExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

// The Playwright suite's two production builds, each in a dist directory of its
// own so neither replaces `npm run build`'s `.next`. Each starts from a clean
// directory: a server tree left from an earlier build would carry that build's
// caches, and the relay spec checks the cache stays empty.
for (const [name, env] of [
  ['deterministic', deterministicEnv],
  ['Signa', signaEnv],
]) {
  rmSync(env.NEXT_DIST_DIR, { force: true, recursive: true })
  const build = spawn('npm', ['run', 'build'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
  })
  const result = await onceExit(build)
  if (result.code !== 0) {
    throw new Error(
      `The ${name} browser build failed (${result.signal ?? result.code})`,
    )
  }
}
