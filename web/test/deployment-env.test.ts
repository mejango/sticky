// @vitest-environment node

import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { centerWalletConfiguration } from '@/providers/wallet-config'
import { deploymentEnvErrors } from '../scripts/check-deployment-env.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Runs a script from `scripts/` with exactly this environment. One that starts a server is killed, not left to block the run. */
function run(script: string, args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [join(root, 'scripts', script), ...args], {
    // Next's types make NODE_ENV a required part of ProcessEnv, and these scripts do not read it.
    env: env as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 10_000,
    killSignal: 'SIGKILL',
  })
}

/** Runs `check-deployment-env.mjs <phase>` as the Dockerfile does. */
function check(env: Record<string, string>, phase = 'build') {
  const { status, stdout, stderr } = run('check-deployment-env.mjs', [phase], env)
  return { status, stdout, stderr, errors: stderr.split('\n').filter(line => line.startsWith('- ')) }
}

const complete = {
  NEXT_PUBLIC_SITE_URL: 'https://sticky.example',
  NEXT_PUBLIC_BENDYSTRAW_URL: 'https://bendystraw.example',
  NEXT_PUBLIC_TESTNET_BENDYSTRAW_URL: 'https://testnet.bendystraw.example',
  NEXT_PUBLIC_VERSION: 'abcdef1234567890',
}

const signa = {
  NEXT_PUBLIC_CENTER_WALLET_ENABLED: 'true',
  NEXT_PUBLIC_CENTER_WALLET_ISSUER: 'https://signa.center',
  NEXT_PUBLIC_CENTER_WALLET_AUDIENCE: 'https://api.signa.center',
  NEXT_PUBLIC_CENTER_WALLET_MANIFEST_ID: 'sticky-web',
  NEXT_PUBLIC_CENTER_WALLET_MANIFEST_REVISION: `0x${'1'.repeat(64)}`,
  NEXT_PUBLIC_CENTER_WALLET_MAXIMUM_NETWORK_FEE_WEI: '1000000000000000',
}

const optional = {
  NEXT_PUBLIC_JBCENTER_URL: 'https://dev.juicebox.center',
  ...signa,
  NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID: 'walletconnect-project',
}

const without = (name: string) =>
  Object.fromEntries(Object.entries(complete).filter(([key]) => key !== name))

type Settings = Record<string, string | undefined>

/** A complete environment with Signa on and valid, then `settings` applied. `undefined` removes a variable. */
function withSigna(settings: Settings = {}) {
  const env: Settings = { ...complete, ...signa, ...settings }
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) as Record<string, string>
}

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

  it('rejects a JB Center URL that is not HTTPS, when there is one', () => {
    for (const url of ['http://dev.juicebox.center', 'dev.juicebox.center']) {
      const result = check({ ...complete, NEXT_PUBLIC_JBCENTER_URL: url })
      expect(result.status).toBe(1)
      expect(result.errors).toEqual(['- NEXT_PUBLIC_JBCENTER_URL must be an absolute HTTPS URL'])
    }
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

// The app turns Signa on only when every one of these passes, and otherwise leaves it out without a
// word, so a build with a setting that fails must not get as far as an image.
describe('the Signa settings', () => {
  const ENABLED = 'NEXT_PUBLIC_CENTER_WALLET_ENABLED'
  const ISSUER = 'NEXT_PUBLIC_CENTER_WALLET_ISSUER'
  const AUDIENCE = 'NEXT_PUBLIC_CENTER_WALLET_AUDIENCE'
  const MANIFEST_ID = 'NEXT_PUBLIC_CENTER_WALLET_MANIFEST_ID'
  const MANIFEST_REVISION = 'NEXT_PUBLIC_CENTER_WALLET_MANIFEST_REVISION'
  const FEE = 'NEXT_PUBLIC_CENTER_WALLET_MAXIMUM_NETWORK_FEE_WEI'

  const refused: [string, Settings, string[]][] = [
    ['the flag as True', { [ENABLED]: 'True' }, [ENABLED]],
    ['the flag as TRUE', { [ENABLED]: 'TRUE' }, [ENABLED]],
    ['the flag as 1', { [ENABLED]: '1' }, [ENABLED]],
    ['the flag as yes', { [ENABLED]: 'yes' }, [ENABLED]],
    ['the flag with a space before true', { [ENABLED]: ' true' }, [ENABLED]],
    ['the flag with a space after true', { [ENABLED]: 'true ' }, [ENABLED]],
    ['a blank flag', { [ENABLED]: '  ' }, [ENABLED]],
    ['no manifest id', { [MANIFEST_ID]: undefined }, [MANIFEST_ID]],
    ['an empty manifest id', { [MANIFEST_ID]: '' }, [MANIFEST_ID]],
    ['a manifest id with a space', { [MANIFEST_ID]: 'sticky web' }, [MANIFEST_ID]],
    ['a manifest id of 129 characters', { [MANIFEST_ID]: 'x'.repeat(129) }, [MANIFEST_ID]],
    ['no manifest revision', { [MANIFEST_REVISION]: undefined }, [MANIFEST_REVISION]],
    ['a revision that is not hex', { [MANIFEST_REVISION]: 'sticky' }, [MANIFEST_REVISION]],
    ['a revision without 0x', { [MANIFEST_REVISION]: '1'.repeat(64) }, [MANIFEST_REVISION]],
    ['an uppercase revision', { [MANIFEST_REVISION]: `0x${'A'.repeat(64)}` }, [MANIFEST_REVISION]],
    ['a revision one digit short', { [MANIFEST_REVISION]: `0x${'1'.repeat(63)}` }, [MANIFEST_REVISION]],
    ['a revision of zero', { [MANIFEST_REVISION]: `0x${'0'.repeat(64)}` }, [MANIFEST_REVISION]],
    ['no fee', { [FEE]: undefined }, [FEE]],
    ['a fee of zero', { [FEE]: '0' }, [FEE]],
    ['a negative fee', { [FEE]: '-1' }, [FEE]],
    ['a fractional fee', { [FEE]: '1.5' }, [FEE]],
    ['a fee in scientific notation', { [FEE]: '1e18' }, [FEE]],
    ['a fee with a leading zero', { [FEE]: '01' }, [FEE]],
    ['a fee of 2^256', { [FEE]: String(2n ** 256n) }, [FEE]],
    ['a fee of 79 digits', { [FEE]: '9'.repeat(79) }, [FEE]],
    ['an issuer that is not a URL', { [ISSUER]: 'signa.center' }, [ISSUER]],
    ['an issuer over http that is not local', { [ISSUER]: 'http://signa.center' }, [ISSUER]],
    ['an issuer with a path', { [ISSUER]: 'https://signa.center/' }, [ISSUER]],
    ['an issuer with credentials', { [ISSUER]: 'https://user:secret@signa.center' }, [ISSUER]],
    ['an audience that is not a URL', { [AUDIENCE]: 'api.signa.center' }, [AUDIENCE]],
    ['an audience over http that is not local', { [AUDIENCE]: 'http://api.signa.center' }, [AUDIENCE]],
    ['another https issuer', { [ISSUER]: 'https://evil.example' }, [ISSUER, AUDIENCE]],
    ['another https audience', { [AUDIENCE]: 'https://evil.example' }, [ISSUER, AUDIENCE]],
    [
      'one origin for both',
      { [ISSUER]: 'http://localhost:4000', [AUDIENCE]: 'http://localhost:4000' },
      [ISSUER, AUDIENCE],
    ],
  ]

  it.each(refused)('refuses %s, and says which setting', (_case, settings, names) => {
    const result = check(withSigna(settings))
    expect(result.status).toBe(1)
    expect(result.errors).toHaveLength(1)
    for (const name of names) expect(result.errors[0]).toContain(name)
  })

  it.each([ENABLED, ISSUER, AUDIENCE, MANIFEST_ID, MANIFEST_REVISION, FEE, 'NEXT_PUBLIC_JBCENTER_URL'])(
    'never repeats the value it refuses for %s',
    name => {
      const secret = `do not echo ${name}`
      const result = check(withSigna({ [name]: secret }))
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(name)
      expect(result.stderr).not.toContain(secret)
    },
  )

  it.each([
    ['a local Signa over http', { [ISSUER]: 'http://localhost:4000', [AUDIENCE]: 'http://127.0.0.1:4001' }],
    ['the default issuer and audience', { [ISSUER]: '', [AUDIENCE]: '' }],
    ['no issuer and no audience', { [ISSUER]: undefined, [AUDIENCE]: undefined }],
    ['the largest fee, 2^256 - 1', { [FEE]: String(2n ** 256n - 1n) }],
    ['Signa switched off, with nothing else set', { [ENABLED]: 'false', [MANIFEST_ID]: undefined, [MANIFEST_REVISION]: undefined, [FEE]: undefined }],
    ['Signa switched off, with settings that would not pass', { [ENABLED]: 'false', [MANIFEST_REVISION]: 'sticky', [FEE]: '0' }],
    ['Signa left unset, with settings that would not pass', { [ENABLED]: undefined, [MANIFEST_REVISION]: 'sticky', [FEE]: '0' }],
  ] as [string, Settings][])('takes %s', (_case, settings) => {
    const result = check(withSigna(settings))
    expect(result).toMatchObject({ status: 0, stderr: '' })
  })
})

// The check cannot import the app's code, which the image does not hold, so it repeats the app's
// rules. This holds the two together: on every row, what the check lets through is what the app
// turns on, or what is plainly switched off.
describe('the Signa check and the app', () => {
  const ENABLED = 'NEXT_PUBLIC_CENTER_WALLET_ENABLED'
  const ISSUER = 'NEXT_PUBLIC_CENTER_WALLET_ISSUER'
  const AUDIENCE = 'NEXT_PUBLIC_CENTER_WALLET_AUDIENCE'
  const MANIFEST_ID = 'NEXT_PUBLIC_CENTER_WALLET_MANIFEST_ID'
  const MANIFEST_REVISION = 'NEXT_PUBLIC_CENTER_WALLET_MANIFEST_REVISION'
  const FEE = 'NEXT_PUBLIC_CENTER_WALLET_MAXIMUM_NETWORK_FEE_WEI'

  /** The check's verdict, and whether the app would switch Signa on, for the same settings. */
  function verdicts(settings: Settings) {
    const env = withSigna(settings)
    const config = centerWalletConfiguration({
      enabled: env[ENABLED],
      issuer: env[ISSUER],
      audience: env[AUDIENCE],
      manifestId: env[MANIFEST_ID],
      manifestRevision: env[MANIFEST_REVISION],
      maximumNetworkFee: env[FEE],
    })
    const switchedOff = [undefined, '', 'false'].includes(env[ENABLED])
    return { accepted: deploymentEnvErrors(env, 'build').length === 0, on: config !== null, switchedOff }
  }

  /** Every combination of the candidates for each setting, listing the ones on which the check and the app part ways. */
  function disagreements(candidates: Record<string, (string | undefined)[]>) {
    const names = Object.keys(candidates)
    const rows = names.reduce<Settings[]>(
      (partial, name) => partial.flatMap(row => candidates[name].map(value => ({ ...row, [name]: value }))),
      [{}],
    )
    const parted: Settings[] = []
    let on = 0
    for (const settings of rows) {
      const { accepted, on: enabled, switchedOff } = verdicts(settings)
      if (enabled) on += 1
      if (accepted !== (enabled || switchedOff)) parted.push(settings)
    }
    // A grid the app turns on for none of its rows, or for all of them, would prove nothing.
    expect(on).toBeGreaterThan(0)
    expect(on).toBeLessThan(rows.length)
    return parted
  }

  it('agree on every issuer and audience', () => {
    expect(
      disagreements({
        [ISSUER]: [
          undefined,
          '',
          'https://signa.center',
          'https://signa.center/',
          'http://signa.center',
          'https://evil.example',
          'https://api.signa.center',
          'http://localhost:4000',
          'http://127.0.0.1:4000',
          'http://[::1]:4000',
          'http://user:secret@localhost:4000',
          'ftp://localhost',
          'signa.center',
        ],
        [AUDIENCE]: [
          undefined,
          '',
          'https://api.signa.center',
          'https://api.signa.center/',
          'https://signa.center',
          'https://evil.example',
          'http://api.signa.center',
          'http://localhost:4001',
          'http://localhost:4000',
          'http://127.0.0.1:4001',
          'not a url',
        ],
      }),
    ).toEqual([])
  })

  it('agree on every manifest id, revision and fee', () => {
    expect(
      disagreements({
        [MANIFEST_ID]: [undefined, '', 'sticky-web', 'a:b_C-9', 'sticky web', 'x'.repeat(128), 'x'.repeat(129), 'ünï'],
        [MANIFEST_REVISION]: [
          undefined,
          '',
          `0x${'1'.repeat(64)}`,
          `0x${'0'.repeat(64)}`,
          `0x${'A'.repeat(64)}`,
          `0x${'a'.repeat(64)}`,
          `0x${'1'.repeat(63)}`,
          `0x${'1'.repeat(65)}`,
          `0X${'1'.repeat(64)}`,
          '1'.repeat(64),
          '0xzz',
        ],
        [FEE]: [
          undefined,
          '',
          '1',
          '1000000000000000',
          '0',
          '01',
          '-1',
          '+1',
          '1.5',
          '1e18',
          '0x10',
          ' 1',
          '1 ',
          String(2n ** 256n - 1n),
          String(2n ** 256n),
          '9'.repeat(78),
          '9'.repeat(79),
          'abc',
        ],
      }),
    ).toEqual([])
  })

  it('agree on every value of the flag, with settings that pass and settings that do not', () => {
    expect(
      disagreements({
        [ENABLED]: [undefined, '', 'false', 'true', 'True', 'TRUE', 'FALSE', '1', '0', 'yes', ' true', 'true ', '  '],
        [MANIFEST_REVISION]: [`0x${'1'.repeat(64)}`, 'sticky'],
        [FEE]: ['1', '0'],
      }),
    ).toEqual([])
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
    const { status, stderr } = run('start-production.mjs', [], env)
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

  it('stops with a Signa setting the app would leave out, before it loads the app', () => {
    const result = start(withSigna({ NEXT_PUBLIC_CENTER_WALLET_ENABLED: 'True' }))
    expect(result.status).not.toBe(0)
    expect(result.refused).toBe(true)
    expect(result.stderr).toContain('- NEXT_PUBLIC_CENTER_WALLET_ENABLED must be true or false')
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
