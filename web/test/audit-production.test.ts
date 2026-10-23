import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const script = readFileSync(resolve(process.cwd(), 'scripts/audit-production.mjs'), 'utf8')
const ZOD = 'https://github.com/advisories/GHSA-mrhx-c7xc-m3w5'
const zodNodes = ['node_modules/zod', 'node_modules/@reown/appkit-wallet/node_modules/zod']
const packages = {
  'node_modules/@coinbase/cdp-sdk': { version: '1.57.1', dependencies: { zod: '^3.25.76' } },
  'node_modules/@reown/appkit-wallet': { version: '1.8.19', dependencies: { zod: '3.22.4' } },
  'node_modules/zod': { version: '3.25.76' },
  'node_modules/@reown/appkit-wallet/node_modules/zod': { version: '3.22.4' },
}
const severityNames = ['info', 'low', 'moderate', 'high', 'critical']
type Finding = { severity: string; via: unknown[]; nodes?: string[] }
const directories: string[] = []

const zod = (nodes: string[] | null = zodNodes, severity = 'high'): Finding =>
  ({ severity, via: [{ severity, url: ZOD }], ...(nodes ? { nodes } : {}) })
const findings = (finding = zod()): Record<string, Finding> => ({
  zod: finding,
  '@reown/appkit-wallet': { severity: 'high', via: ['zod'] },
  '@coinbase/cdp-sdk': { severity: 'high', via: ['zod'] },
})

/** Run the real script in a temporary project with a stub npm, so no registry request is possible. */
function audit(vulnerabilities: Record<string, Finding>, lockfilePackages: Record<string, unknown> = packages, status = 1) {
  const directory = mkdtempSync(join(tmpdir(), 'audit-production-'))
  directories.push(directory)
  mkdirSync(join(directory, 'bin'))
  const payload = { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: {
    ...Object.fromEntries(severityNames.map(severity => [severity,
      Object.values(vulnerabilities).filter(finding => finding.severity === severity).length])),
    total: Object.keys(vulnerabilities).length,
  } } }
  writeFileSync(join(directory, 'bin/npm'),
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(payload))});\nprocess.exit(${status});\n`)
  chmodSync(join(directory, 'bin/npm'), 0o755)
  writeFileSync(join(directory, 'audit-production.mjs'), script)
  writeFileSync(join(directory, 'package-lock.json'), JSON.stringify({ packages: { '': {}, ...lockfilePackages } }))
  const result = spawnSync(process.execPath, [join(directory, 'audit-production.mjs')], {
    cwd: directory, env: { ...process.env, PATH: join(directory, 'bin') }, encoding: 'utf8', timeout: 10_000,
  })
  if (result.error) throw result.error
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('production audit gate', () => {
  it('accepts a clean audit', () => {
    expect(audit({}, packages, 0).status).toBe(0)
  })

  it('accepts zod reached only through @reown/appkit-wallet and @coinbase/cdp-sdk', () => {
    const result = audit(findings())
    expect(result.status).toBe(0)
    expect(result.output).toContain('GHSA-mrhx-c7xc-m3w5')
  })

  it('rejects a zod copy another production package depends on', () => {
    const result = audit(findings(), { ...packages, 'node_modules/other': { version: '1.0.0', dependencies: { zod: '^3' } } })
    expect(result.status).toBe(1)
    expect(result.output).toContain('zod: high')
  })

  it('accepts a copy that only a development package or an optional peer also reaches', () => {
    expect(audit(findings(), {
      ...packages,
      'node_modules/knip': { version: '6.0.0', dev: true, dependencies: { zod: '^3' } },
      'node_modules/abitype': { version: '1.2.4', peerDependencies: { zod: '^3' }, peerDependenciesMeta: { zod: { optional: true } } },
    }).status).toBe(0)
  })

  it.each([
    ['reports no installed copy', zod(null)],
    ['reports a copy nothing depends on', zod(['node_modules/orphan/node_modules/zod'])],
    ['is rated at another severity', zod(zodNodes, 'critical')],
  ])('rejects a zod finding that %s', (_name, finding) => {
    const result = audit(findings(finding))
    expect(result.status).toBe(1)
    expect(result.output).toContain('Unexpected production vulnerabilities')
  })

  it('rejects any other advisory', () => {
    const other = { severity: 'high', via: [{ severity: 'high', url: 'https://github.com/advisories/GHSA-0000-0000-0000' }] }
    const result = audit({ ...findings(), other })
    expect(result.status).toBe(1)
    expect(result.output).toContain('other: high')
  })
})
