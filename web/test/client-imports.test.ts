import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * ENSIP-15 name normalization (viem's `normalize`, about 26.5 KB gzipped) is for the server. It is in
 * `project-handles.ts`, and `sticky-handles.ts` resolves the `/@name` route with it. If a module a client component
 * imports, however deep, imports either, the browser loads it on every page. A build shows that once; this keeps it
 * shown. Something a client needs from a handle module belongs in a small module of its own, as the route readers
 * are in `project-route.ts`.
 */

const SERVER_ONLY = ['src/lib/project-handles.ts', 'src/lib/sticky-handles.ts']
const SRC = resolve('src')

type Sources = Map<string, string>

function readSources(dir = SRC): Sources {
  const sources: Sources = new Map()
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      for (const [file, text] of readSources(full)) sources.set(file, text)
    } else if (/\.tsx?$/.test(entry.name)) {
      sources.set(full, readFileSync(full, 'utf8'))
    }
  }
  return sources
}

/** Modules loaded on the client's account: those that start with the 'use client' directive. */
const clientRoots = (sources: Sources) =>
  [...sources].filter(([, text]) => /^\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*['"]use client['"]/.test(text)).map(([file]) => file)

// `import x from 'y'`, `import 'y'`, `export { x } from 'y'` and `import('y')`. A type-only import leaves no code.
const IMPORT =
  /(?:^|[\s;{}])(?:import|export)\s+(?!type\b)(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g

/** The source files that `file` imports, whichever way the import is written. */
function importsOf(file: string, sources: Sources, root: string): string[] {
  const found: string[] = []
  for (const match of sources.get(file)!.matchAll(IMPORT)) {
    const specifier = match[1] ?? match[2]
    const base = specifier.startsWith('@/')
      ? join(root, specifier.slice(2))
      : specifier.startsWith('.')
        ? join(dirname(file), specifier)
        : null
    if (base === null) continue
    const target = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')].find(
      candidate => sources.has(candidate),
    )
    if (target) found.push(target)
  }
  return found
}

/** Every source file that `start` reaches, `start` included. */
function reachableFrom(start: string, sources: Sources, root: string): Set<string> {
  const seen = new Set<string>()
  const pending = [start]
  while (pending.length) {
    const file = pending.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    pending.push(...importsOf(file, sources, root))
  }
  return seen
}

/** Each client module that reaches a server-only module, with the server-only module it reaches. */
function violations(sources: Sources, root: string, serverOnly: string[]): string[] {
  const forbidden = new Set(serverOnly.map(file => join(root, '..', file)))
  return clientRoots(sources).flatMap(client =>
    [...reachableFrom(client, sources, root)].filter(file => forbidden.has(file)).map(file => `${client} -> ${file}`),
  )
}

describe('the browser never loads name normalization', () => {
  const sources = readSources()

  it('reaches no server-only handle module from any client component', () => {
    expect(violations(sources, SRC, SERVER_ONLY)).toEqual([])
  })

  it('imports viem\'s normalize in project-handles.ts and nowhere else', () => {
    const importers = [...sources]
      .filter(([, text]) => /import\s*\{[^}]*\bnormalize\b[^}]*\}\s*from\s*['"]viem\/ens['"]/.test(text))
      .map(([file]) => file)
    expect(importers).toEqual([join(SRC, 'lib', 'project-handles.ts')])
  })

  it('sees the client modules that the header loads on every page, and what they load', () => {
    const wallet = join(SRC, 'components', 'WalletButton.tsx')
    const provider = join(SRC, 'providers', 'ProjectRouteContext.tsx')
    expect(clientRoots(sources)).toEqual(expect.arrayContaining([wallet, provider]))
    const reached = reachableFrom(wallet, sources, SRC)
    expect(reached.has(join(SRC, 'lib', 'project-route.ts'))).toBe(true)
    expect(reached.has(join(SRC, 'lib', 'sticky-format.ts'))).toBe(true)
    expect(reachableFrom(provider, sources, SRC).has(join(SRC, 'lib', 'project-route.ts'))).toBe(true)
  })
})

describe('shared client rules have one SDK owner', () => {
  const sources = readSources()
  const namedImport = /\b(?:import|export)\s*\{([^{}]*)\}\s*from\s*['"]([^'"]+)['"]/g
  const imports = [...sources.values()].flatMap(text => [...text.matchAll(namedImport)].flatMap(([, members, owner]) =>
    members.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').split(',').map(member =>
      `${owner}:${member.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]}`,
    ),
  ))

  it.each([
    ['jbcenter', 'createPacedJBCenterLimiter'],
    ['review', 'submitReviewedContractWrite'],
    ['review', 'transactionMessage'],
    ['safe-service', 'readSafeAppExecution'],
    ['safe-service', 'heldCall'],
    ['safe-service', 'watchSafeProposal'],
  ])('consumes %s/%s from its shared owner', (owner, symbol) => {
    expect(imports).toContain(`@bananapus/nana-sdk-core/${owner}:${symbol}`)
  })

  it('has no local copies of pacing, stamped-call or Safe-proof rules', () => {
    const duplicate = /\b(?:const|let|function)\s+(RPC_START_INTERVAL_MS|STAMPED_CALLS|readSafeAppExecution|safeTransactionRunsCalls|heldCall|stampedDeadline|transactionMessage)\b/
    expect([...sources].filter(([, text]) => duplicate.test(text)).map(([file]) => file)).toEqual([])
  })
})

describe('the scan itself', () => {
  const root = '/app/src'
  const files = (entries: Record<string, string>): Sources =>
    new Map(Object.entries(entries).map(([name, text]) => [join(root, name), text]))
  const handles = ['src/lib/project-handles.ts']

  it.each([
    ['imports it', "'use client'\nimport { normalizeProjectHandle } from '@/lib/project-handles'\n"],
    ['imports it by a relative path', "'use client'\nimport { x } from '../lib/project-handles'\n"],
    ['re-exports from it', "'use client'\nexport { x } from '@/lib/project-handles'\n"],
    ['imports it for its effects', "'use client'\nimport '@/lib/project-handles'\n"],
    ['imports it over several lines', "'use client'\nimport {\n  a,\n  b,\n} from '@/lib/project-handles'\n"],
    ['loads it lazily', "'use client'\nconst load = () => import('@/lib/project-handles')\n"],
    ['imports it after a comment', "// a header\n/* and more */\n'use client'\nimport { x } from '@/lib/project-handles'\n"],
  ])('finds a client component that %s', (_how, text) => {
    const sources = files({ 'components/A.tsx': text, 'lib/project-handles.ts': 'export const x = 1\n' })
    expect(violations(sources, root, handles)).toEqual([`${root}/components/A.tsx -> ${root}/lib/project-handles.ts`])
  })

  it('finds a server-only module that a client component reaches through others', () => {
    const sources = files({
      'components/A.tsx': "'use client'\nimport { b } from '@/lib/b'\n",
      'lib/b.ts': "import { c } from './c'\nexport const b = c\n",
      'lib/c.ts': "import { x } from '@/lib/project-handles'\nexport const c = x\n",
      'lib/project-handles.ts': 'export const x = 1\n',
    })
    expect(violations(sources, root, handles)).toEqual([`${root}/components/A.tsx -> ${root}/lib/project-handles.ts`])
  })

  it('leaves alone a server module that imports it, a type-only import, and a client module that does not', () => {
    const sources = files({
      'app/page.tsx': "import { x } from '@/lib/project-handles'\nexport default x\n",
      'components/A.tsx': "'use client'\nimport type { T } from '@/lib/project-handles'\nimport { y } from '@/lib/y'\n",
      'lib/y.ts': "import { z } from 'viem/ens'\nexport const y = z\n",
      'lib/project-handles.ts': 'export const x = 1\nexport type T = number\n',
    })
    expect(violations(sources, root, handles)).toEqual([])
  })

  it('takes a file as a client module only when the directive comes first', () => {
    const sources = files({
      'components/A.tsx': "import { x } from '@/lib/project-handles'\n'use client'\n",
      'lib/project-handles.ts': 'export const x = 1\n',
    })
    expect(clientRoots(sources)).toEqual([])
  })
})
