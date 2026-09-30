import { pathToFileURL } from 'node:url'

const BUILD_PHASES = new Set(['build', 'all'])

function required(errors, env, name, minLength = 1) {
  if ((env[name] ?? '').trim().length < minLength) {
    errors.push(`${name} is required`)
  }
}

function httpsUrl(errors, env, name, optional = false) {
  const value = env[name]?.trim()
  if (!value && optional) return
  try {
    if (!value || new URL(value).protocol !== 'https:') throw new Error()
  } catch {
    errors.push(`${name} must be an absolute HTTPS URL`)
  }
}

// Signa sign-in is optional. The app turns it on only when the flag is exactly
// "true" and every setting below passes: these are the rules of
// centerWalletConfiguration in src/providers/wallet-config.ts. Otherwise the app
// leaves Signa out without a word, so a build that meant to have it must stop
// here. The image holds no src/, so the rules are repeated, and
// test/deployment-env.test.ts holds the two to the same verdict. The messages
// name a setting and never give its value.
const SIGNA = {
  enabled: 'NEXT_PUBLIC_CENTER_WALLET_ENABLED',
  issuer: 'NEXT_PUBLIC_CENTER_WALLET_ISSUER',
  audience: 'NEXT_PUBLIC_CENTER_WALLET_AUDIENCE',
  manifestId: 'NEXT_PUBLIC_CENTER_WALLET_MANIFEST_ID',
  manifestRevision: 'NEXT_PUBLIC_CENTER_WALLET_MANIFEST_REVISION',
  maximumNetworkFee: 'NEXT_PUBLIC_CENTER_WALLET_MAXIMUM_NETWORK_FEE_WEI',
}
const SIGNA_ISSUER = 'https://signa.center'
const SIGNA_AUDIENCE = 'https://api.signa.center'
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]']

function signaOrigin(value) {
  try {
    const url = new URL(value)
    return (
      url.origin === value &&
      !url.username &&
      !url.password &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && LOCAL_HOSTS.includes(url.hostname)))
    )
  } catch {
    return false
  }
}

function signaErrors(errors, env) {
  const enabled = env[SIGNA.enabled] ?? ''
  if (enabled === '' || enabled === 'false') return
  if (enabled !== 'true') {
    errors.push(`${SIGNA.enabled} must be true or false`)
    return
  }

  const issuer = env[SIGNA.issuer] || SIGNA_ISSUER
  const audience = env[SIGNA.audience] || SIGNA_AUDIENCE
  const issuerIsOrigin = signaOrigin(issuer)
  const audienceIsOrigin = signaOrigin(audience)
  if (!issuerIsOrigin) {
    errors.push(
      `${SIGNA.issuer} must be an https origin, or an http origin on localhost`,
    )
  }
  if (!audienceIsOrigin) {
    errors.push(
      `${SIGNA.audience} must be an https origin, or an http origin on localhost`,
    )
  }
  if (issuerIsOrigin && audienceIsOrigin) {
    if (
      new URL(issuer).protocol === 'https:' &&
      (issuer !== SIGNA_ISSUER || audience !== SIGNA_AUDIENCE)
    ) {
      errors.push(
        `${SIGNA.issuer} and ${SIGNA.audience} must be ${SIGNA_ISSUER} and ${SIGNA_AUDIENCE} when the issuer is https`,
      )
    }
    if (issuer === audience) {
      errors.push(`${SIGNA.issuer} and ${SIGNA.audience} must differ`)
    }
  }

  const manifestId = env[SIGNA.manifestId]
  if (!manifestId || !/^[a-zA-Z0-9:_-]{1,128}$/.test(manifestId)) {
    errors.push(
      `${SIGNA.manifestId} must be 1 to 128 letters, digits, colons, underscores or hyphens`,
    )
  }
  const manifestRevision = env[SIGNA.manifestRevision]
  if (
    !manifestRevision ||
    !/^0x[0-9a-f]{64}$/.test(manifestRevision) ||
    BigInt(manifestRevision) === 0n
  ) {
    errors.push(
      `${SIGNA.manifestRevision} must be a nonzero 32-byte value in lowercase hex, starting 0x`,
    )
  }
  const maximumNetworkFee = env[SIGNA.maximumNetworkFee]
  if (
    !maximumNetworkFee ||
    !/^[1-9][0-9]{0,77}$/.test(maximumNetworkFee) ||
    BigInt(maximumNetworkFee) >= 2n ** 256n
  ) {
    errors.push(
      `${SIGNA.maximumNetworkFee} must be a whole number of wei from 1 to 2^256 - 1`,
    )
  }
}

export function deploymentEnvErrors(env, phase = 'all') {
  if (!BUILD_PHASES.has(phase) && phase !== 'runtime') {
    return [`unknown validation phase: ${phase}`]
  }

  const errors = []
  if (BUILD_PHASES.has(phase)) {
    httpsUrl(errors, env, 'NEXT_PUBLIC_SITE_URL')
    httpsUrl(errors, env, 'NEXT_PUBLIC_BENDYSTRAW_URL')
    httpsUrl(errors, env, 'NEXT_PUBLIC_TESTNET_BENDYSTRAW_URL')
    required(errors, env, 'NEXT_PUBLIC_VERSION', 7)
    if (env.NEXT_PUBLIC_VERSION === 'unknown') {
      errors.push('NEXT_PUBLIC_VERSION must identify the built revision')
    }

    // Optional, and checked only when set: NEXT_PUBLIC_JBCENTER_URL, without
    // which the site derives the JB Center URL from its own origin, and the
    // Signa set (NEXT_PUBLIC_CENTER_WALLET_*). NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID
    // is not checked: empty, it hides the WalletConnect option.
    httpsUrl(errors, env, 'NEXT_PUBLIC_JBCENTER_URL', true)
    signaErrors(errors, env)

    if (env.NEXT_PUBLIC_DETERMINISTIC_BROWSER === 'true') {
      errors.push('deterministic browser mode cannot be deployed')
    }
    if (env.NEXT_PUBLIC_BROWSER_FIXTURE_ORIGIN) {
      errors.push('browser fixture origin cannot be deployed')
    }
    // The server reads this one at run time, and it points both Bendystraw
    // indexers at the fixture.
    if (env.BROWSER_BUILD_FIXTURE_ORIGIN) {
      errors.push('browser build fixture origin cannot be deployed')
    }
  }

  return errors
}

export function assertDeploymentEnv(env, phase = 'all') {
  const errors = deploymentEnvErrors(env, phase)
  if (errors.length) {
    throw new Error(
      `Invalid ${phase} deployment configuration:\n${errors
        .map(error => `- ${error}`)
        .join('\n')}`,
    )
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const phase = process.argv[2] ?? 'all'
  try {
    assertDeploymentEnv(process.env, phase)
    process.stdout.write(`Deployment ${phase} configuration is valid.\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`)
    process.exitCode = 1
  }
}
