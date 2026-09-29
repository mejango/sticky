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

    // Optional, so not checked: NEXT_PUBLIC_JBCENTER_URL, the Signa set
    // (NEXT_PUBLIC_CENTER_WALLET_*) and NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID.
    // Without them the site derives the JB Center URL from its own origin,
    // offers no Signa sign-in and hides the WalletConnect option.

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
