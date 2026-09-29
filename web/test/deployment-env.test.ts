// @vitest-environment node

import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { deploymentEnvErrors } from '../scripts/check-deployment-env.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const script = join(root, 'scripts', 'check-deployment-env.mjs')

/** Runs `check-deployment-env.mjs <phase>` as the Dockerfile does, with exactly this environment. */
function check(env: Record<string, string>, phase = 'build') {
  const { status, stdout, stderr } = spawnSync(process.execPath, [script, phase], {
    // Next's types make NODE_ENV a required part of ProcessEnv, and the check does not read it.
    env: env as NodeJS.ProcessEnv,
    encoding: 'utf8',
  })
  return { status, stdout, stderr, errors: stderr.split('\n').filter(line => line.startsWith('- ')) }
}

const complete = {
  NEXT_PUBLIC_SITE_URL: 'https://sticky.example',
  NEXT_PUBLIC_BENDYSTRAW_URL: 'https://bendystraw.example',
  NEXT_PUBLIC_TESTNET_BENDYSTRAW_URL: 'https://testnet.bendystraw.example',
  NEXT_PUBLIC_VERSION: 'abcdef1234567890',
}

const optional = {
  NEXT_PUBLIC_JBCENTER_URL: 'https://dev.juicebox.center',
  NEXT_PUBLIC_CENTER_WALLET_ENABLED: 'true',
  NEXT_PUBLIC_CENTER_WALLET_ISSUER: 'https://signa.center',
  NEXT_PUBLIC_CENTER_WALLET_AUDIENCE: 'https://api.signa.center',
  NEXT_PUBLIC_CENTER_WALLET_MANIFEST_ID: 'sticky-web',
  NEXT_PUBLIC_CENTER_WALLET_MANIFEST_REVISION: `0x${'1'.repeat(64)}`,
  NEXT_PUBLIC_CENTER_WALLET_MAXIMUM_NETWORK_FEE_WEI: '1000000000000000',
  NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID: 'walletconnect-project',
}

const without = (name: string) =>
  Object.fromEntries(Object.entries(complete).filter(([key]) => key !== name))

describe('check-deployment-env.mjs build', () => {
  it('accepts a complete set', () => {
    const result = check(complete)
    expect(result).toMatchObject({
      status: 0,
      stdout: 'Deployment build configuration is valid.\n',
      stderr: '',
    })
  })

  it('needs no Signa, WalletConnect or JB Center value, and takes them when they are set', () => {
    expect(check(complete).status).toBe(0)
    expect(check({ ...complete, ...optional }).status).toBe(0)
  })

  it('takes the empty values that a build argument nobody set leaves behind', () => {
    const empty = Object.fromEntries(Object.keys(optional).map(name => [name, '']))
    const unset = {
      NEXT_PUBLIC_DETERMINISTIC_BROWSER: '',
      NEXT_PUBLIC_BROWSER_FIXTURE_ORIGIN: '',
      BROWSER_BUILD_FIXTURE_ORIGIN: '',
    }
    expect(check({ ...complete, ...empty, ...unset }).status).toBe(0)
  })

  it.each([
    'NEXT_PUBLIC_SITE_URL',
    'NEXT_PUBLIC_BENDYSTRAW_URL',
    'NEXT_PUBLIC_TESTNET_BENDYSTRAW_URL',
    'NEXT_PUBLIC_VERSION',
  ])('rejects a missing %s', name => {
    const result = check(without(name))
    expect(result.status).toBe(1)
    expect(result.errors).toEqual([expect.stringContaining(name)])
  })

  it.each([
    ['a site URL that is not HTTPS', { NEXT_PUBLIC_SITE_URL: 'http://sticky.example' }],
    ['a site URL that is not a URL', { NEXT_PUBLIC_SITE_URL: 'sticky.example' }],
    ['a blank Bendystraw URL', { NEXT_PUBLIC_BENDYSTRAW_URL: '  ' }],
    ['a version too short to name a commit', { NEXT_PUBLIC_VERSION: 'abc123' }],
    ['the placeholder version', { NEXT_PUBLIC_VERSION: 'unknown' }],
  ])('rejects %s', (_case, override) => {
    const result = check({ ...complete, ...override })
    expect(result.status).toBe(1)
    expect(result.errors).toHaveLength(1)
  })

  it('rejects the deterministic browser build', () => {
    const result = check({ ...complete, NEXT_PUBLIC_DETERMINISTIC_BROWSER: 'true' })
    expect(result.status).toBe(1)
    expect(result.errors).toEqual(['- deterministic browser mode cannot be deployed'])
  })

  it.each(['NEXT_PUBLIC_BROWSER_FIXTURE_ORIGIN', 'BROWSER_BUILD_FIXTURE_ORIGIN'])(
    'rejects %s, which points the site at a test fixture',
    name => {
      const result = check({ ...complete, [name]: 'http://127.0.0.1:4399' })
      expect(result.status).toBe(1)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toMatch(/fixture origin cannot be deployed$/)
    },
  )

  it('reports every problem at once, and never repeats a value it was given', () => {
    const secret = 'do-not-echo-this-value'
    const result = check({
      ...without('NEXT_PUBLIC_VERSION'),
      NEXT_PUBLIC_BENDYSTRAW_URL: secret,
      BROWSER_BUILD_FIXTURE_ORIGIN: secret,
    })
    expect(result.status).toBe(1)
    expect(result.errors).toHaveLength(3)
    expect(result.stderr).not.toContain(secret)
  })

  it('refuses a phase it does not know', () => {
    const result = check(complete, 'deploy')
    expect(result.status).toBe(1)
    expect(result.errors).toEqual(['- unknown validation phase: deploy'])
  })
})

describe('starting the server', () => {
  const fixture = { BROWSER_BUILD_FIXTURE_ORIGIN: 'http://127.0.0.1:4399' }

  it('checks the build rules again, and nothing else at run time', () => {
    expect(deploymentEnvErrors({ ...complete, ...fixture }, 'all')).toEqual([
      'browser build fixture origin cannot be deployed',
    ])
    expect(deploymentEnvErrors({ ...complete, ...optional }, 'all')).toEqual([])
    expect(deploymentEnvErrors({ ...complete, ...fixture }, 'runtime')).toEqual([])
  })

  /** Runs the container's start script. It stops on an invalid environment before it loads the app. */
  function start(env: Record<string, string>) {
    const { status, stderr } = spawnSync(process.execPath, [join(root, 'scripts', 'start-production.mjs')], {
      env: env as NodeJS.ProcessEnv,
      encoding: 'utf8',
    })
    return { status, stderr, refused: stderr.includes('Invalid all deployment configuration') }
  }

  // The server reads this variable when it runs, so the container is where it has to be stopped.
  it('stops with a fixture origin set, before it loads the app', () => {
    const result = start({ ...complete, ...fixture })
    expect(result.status).not.toBe(0)
    expect(result.refused).toBe(true)
    expect(result.stderr).toContain('- browser build fixture origin cannot be deployed')
    expect(result.stderr).not.toContain('server.js')
  })

  it('takes the revision from Railway when no version is set, and stops when it has neither', () => {
    // The app is not there to load, so a start that gets past the check fails on that, not on the configuration.
    expect(start({ ...without('NEXT_PUBLIC_VERSION'), RAILWAY_GIT_COMMIT_SHA: '0123456789abcdef' }).refused).toBe(false)
    const noRevision: Record<string, string>[] = [{}, { RAILWAY_GIT_COMMIT_SHA: '  ' }]
    for (const railway of noRevision) {
      const result = start({ ...without('NEXT_PUBLIC_VERSION'), ...railway })
      expect(result.refused).toBe(true)
      expect(result.stderr).toContain('- NEXT_PUBLIC_VERSION is required')
    }
  })
})

describe('the Dockerfile', () => {
  // A test build sets these. The check above rejects them, so the image must never pass them on.
  const testOnly = new Set(['NEXT_PUBLIC_DETERMINISTIC_BROWSER', 'NEXT_PUBLIC_BROWSER_FIXTURE_ORIGIN'])

  /** Every NEXT_PUBLIC_ variable the app reads. Next inlines it when it builds, so the image must have it then. */
  function publicVariablesRead() {
    const sources = readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' })
      .filter(path => /\.(ts|tsx|js)$/.test(path))
      .map(path => join(root, 'src', path))
    const names = new Set<string>()
    for (const path of [...sources, join(root, 'next.config.js')]) {
      for (const [, name] of readFileSync(path, 'utf8').matchAll(/process\.env\.(NEXT_PUBLIC_\w+)/g)) {
        names.add(name)
      }
    }
    return [...names].filter(name => !testOnly.has(name)).sort()
  }

  const stage = (name: string) =>
    readFileSync(join(root, 'Dockerfile'), 'utf8')
      .split(/^FROM /m)
      .find(part => new RegExp(` AS ${name}\\n`).test(part)) ?? ''

  it.each(['builder', 'runner'])(
    'takes every public variable the app reads as a build argument, and sets it, in the %s stage',
    name => {
      const text = stage(name)
      const args = [...text.matchAll(/^ARG (NEXT_PUBLIC_\w+)\s*$/gm)].map(match => match[1])
      expect(args.sort()).toEqual(publicVariablesRead())
      for (const arg of args) {
        expect(text).toMatch(new RegExp(`\\b${arg}=\\$\\{?${arg}\\b`))
      }
    },
  )
})
