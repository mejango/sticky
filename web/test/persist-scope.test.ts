import { readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Persisted queries outlive the session in localStorage. Anything keyed to a wallet must never go there: a later
 * visitor on the same browser would see the previous account's balances, allowances or holdings restored as if they
 * were their own.
 *
 * This reads the source rather than the runtime because the risk is a future edit tagging the wrong query, and that
 * should fail in CI, not in a browser.
 *
 * It began as juicebox-money's test/persist-scope.test.ts, which matches lines: it takes the first `queryKey: [` within
 * six lines of a tag, and passes quietly when it finds none. A long queryFn, a query next door, a key that a function
 * builds or a variable holds, a spelling it does not know: each gets past it. This parses each file instead. From every
 * tag (`meta: PERSIST`, `persist: 'immutable'`, `immutableQuery(...)`, `cachedQuery(...)`, in any quotes, spread or
 * import alias) it walks out to the object literal that has a `queryKey`, and reads that key. What it cannot read fails:
 * a key that is not an array literal, or has a spread in it, or a tag with no key to be found. ALLOWED excuses one key
 * in one file, with the reason it is safe, and does the same for a key with an account word in it that is about
 * something public.
 */

/** Words that say a key is about an account, matched anywhere in the key's text and in any letter case, so
 * `walletAddress`, `viewAsAccount` and `depositorOf` are all seen. */
const ACCOUNT_HINTS = [
  'address',
  'holder',
  'account',
  'wallet',
  'owner',
  'user',
  'viewer',
  'viewed',
  'viewas',
  'depositor',
  'sender',
  'spender',
  'payer',
  'beneficiary',
  'recipient',
  'staker',
  'signer',
]

/** What tags a query for the persister: the helpers of query-persist.ts, and the `persist` tier in a query's `meta`. */
const TAG_NAMES = ['PERSIST', 'immutableQuery', 'cachedQuery']
const PERSIST_TIERS = ['immutable', 'revalidate']

/** The source of query-persist.ts writes the tags themselves; it tags no query. */
const TAG_DEFINITIONS = join('src', 'lib', 'query-persist.ts')

type Allowed = { file: string; key: string; reason: string }

/** Persisted queries that the scan may not pass, and are safe: the file, the key as the scan reports it, and why. */
const ALLOWED: Allowed[] = []

type Persisted = {
  line: number
  /** The key's text, or for a tag with no key to be found the tag's own. */
  key: string
  readable: boolean
  /** The first account word in the key, when it has one. */
  hint: string | null
}

function sourceFiles(dir = 'src'): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

/** `x as const`, `(x)`, `x!` and `<T>x` are x. */
function unwrap(node: ts.Expression): ts.Expression {
  while (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    node = node.expression
  }
  return node
}

/** The names a file calls the helpers by: their own, and any it imports them as. */
function tagNames(source: ts.SourceFile): Set<string> {
  const names = new Set(TAG_NAMES)
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (!statement.moduleSpecifier.text.endsWith('query-persist')) continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      if (TAG_NAMES.includes((element.propertyName ?? element.name).text)) names.add(element.name.text)
    }
  }
  return names
}

/** Whether `node` uses a name, as against declaring it, importing it, or being a property called that. */
function isReference(node: ts.Identifier): boolean {
  const { parent } = node
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) {
    return false
  }
  if (
    ts.isVariableDeclaration(parent) ||
    ts.isFunctionDeclaration(parent) ||
    ts.isParameter(parent) ||
    ts.isBindingElement(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isMethodDeclaration(parent)
  ) {
    return parent.name !== node
  }
  return true
}

/** A `persist: 'immutable'` or `persist: 'revalidate'` in any quotes, or a `persist` whose tier is not a literal
 * (which is read as a tag: what cannot be read fails). `persist: false` and another word are not tags. */
function isPersistProperty(node: ts.Node): boolean {
  if (ts.isShorthandPropertyAssignment(node)) return node.name.text === 'persist'
  if (!ts.isPropertyAssignment(node)) return false
  if (!(ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) || node.name.text !== 'persist') return false
  const tier = unwrap(node.initializer)
  if (ts.isStringLiteral(tier) || ts.isNoSubstitutionTemplateLiteral(tier)) return PERSIST_TIERS.includes(tier.text)
  return !(
    tier.kind === ts.SyntaxKind.NullKeyword ||
    tier.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isIdentifier(tier) && tier.text === 'undefined')
  )
}

/** The call that a tag names, when it is the callee: `immutableQuery(...)` or `persist.immutableQuery(...)`. */
function calleeOf(tag: ts.Node): ts.CallExpression | null {
  let callee = tag
  if (ts.isPropertyAccessExpression(callee.parent) && callee.parent.name === callee) callee = callee.parent
  return ts.isCallExpression(callee.parent) && callee.parent.expression === callee ? callee.parent : null
}

function keyProperty(object: ts.ObjectLiteralExpression): ts.ObjectLiteralElementLike | undefined {
  return object.properties.find(
    property =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === 'queryKey',
  )
}

/** The object literal that says which query a tag is on: the argument of an `immutableQuery({...})` when it has a
 * key, else the nearest object around the tag that does. */
function optionsFor(tag: ts.Node): ts.ObjectLiteralExpression | null {
  const argument = calleeOf(tag)?.arguments[0]
  const given = argument && unwrap(argument)
  if (given && ts.isObjectLiteralExpression(given) && keyProperty(given)) return given
  for (let node: ts.Node | undefined = tag.parent; node; node = node.parent) {
    if (ts.isObjectLiteralExpression(node) && keyProperty(node)) return node
  }
  return null
}

function persistedOf(tag: ts.Node, source: ts.SourceFile): Persisted {
  const line = source.getLineAndCharacterOfPosition(tag.getStart(source)).line + 1
  const options = optionsFor(tag)
  const property = options ? keyProperty(options) : undefined
  if (!property) {
    const anchor = ts.isPropertyAssignment(tag) || ts.isShorthandPropertyAssignment(tag) ? tag : (calleeOf(tag) ?? tag.parent)
    return { line, key: squash(anchor.getText(source)), readable: false, hint: null }
  }
  if (!ts.isPropertyAssignment(property)) return { line, key: 'queryKey', readable: false, hint: null }
  const value = unwrap(property.initializer)
  const key = squash(value.getText(source))
  if (!ts.isArrayLiteralExpression(value) || value.elements.some(ts.isSpreadElement)) {
    return { line, key, readable: false, hint: null }
  }
  return { line, key, readable: true, hint: ACCOUNT_HINTS.find(hint => key.toLowerCase().includes(hint)) ?? null }
}

/** Every persist tag of a file, with the key it is on. */
function persistedQueries(file: string, text: string): Persisted[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    extname(file) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const names = tagNames(source)
  const found: Persisted[] = []
  const visit = (node: ts.Node) => {
    if ((ts.isIdentifier(node) && names.has(node.text) && isReference(node)) || isPersistProperty(node)) {
      found.push(persistedOf(node, source))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** What is wrong with the persisted queries of a file, as `file:line: key ...`, and which exceptions it used. */
function check(file: string, text: string, allowed: Allowed[] = ALLOWED) {
  const offenders: string[] = []
  const used = new Set<Allowed>()
  for (const persisted of persistedQueries(file, text)) {
    if (persisted.readable && persisted.hint === null) continue
    const excuse = allowed.find(entry => entry.file === file && entry.key === persisted.key)
    if (excuse) {
      used.add(excuse)
      continue
    }
    const key = persisted.key.length > 100 ? `${persisted.key.slice(0, 97)}...` : persisted.key
    offenders.push(
      `${file}:${persisted.line}: ${key} ${persisted.readable ? `names ${persisted.hint}` : 'cannot be read'}`,
    )
  }
  return { offenders, used }
}

describe('persisted query scope', () => {
  const files = sourceFiles().filter(file => file !== TAG_DEFINITIONS)
  const results = files.map(file => check(file, readFileSync(file, 'utf8')))

  it('never persists a query keyed to an account, or one whose key cannot be read', () => {
    expect(results.flatMap(result => result.offenders)).toEqual([])
  })

  it('lists only exceptions that are still needed, each with its reason', () => {
    const used = new Set(results.flatMap(result => [...result.used]))
    expect(ALLOWED.filter(entry => !used.has(entry))).toEqual([])
    expect(ALLOWED.filter(entry => entry.reason.trim().length < 20)).toEqual([])
  })

  it('finds the tagged queries at all, so the scan cannot silently pass', () => {
    const tagged = files.filter(file => persistedQueries(file, readFileSync(file, 'utf8')).length > 0)
    // The project metadata query is the first. Raise this floor as a task adds a persisted query, to about a quarter
    // of the files that have one, as juicebox-money's does.
    expect(tagged).toContain(join('src', 'hooks', 'useProjectMetadata.ts'))
    expect(tagged.length).toBeGreaterThanOrEqual(1)
  })

})

const IMPORTS = [
  "import { queryOptions, useQueries, useQuery } from '@tanstack/react-query'",
  "import { PERSIST, cachedQuery, immutableQuery } from '@/lib/query-persist'",
].join('\n')

/** A module with `body` in a hook, so that a fixture is only the query. */
const hook = (body: string) => `${IMPORTS}\n\nexport function useThing() {\n${body}\n}\n`

describe('the scan itself', () => {
  // Queries that put an account's data on disk, in the shapes that juicebox-money's line scan misses.
  const MISSED: [string, string, 'names' | 'cannot be read'][] = [
    [
      'a long queryFn between the key and the tag (the shape of the metadata hook)',
      hook(`  return useQuery({
    queryKey: ['positions', holder],
    queryFn: async ({ signal }) => {
      const first = await read(1, signal)
      const second = await read(2, signal)
      const third = await read(3, signal)
      const fourth = await read(4, signal)
      const fifth = await read(5, signal)
      return [first, second, third, fourth, fifth]
    },
    enabled: found !== null,
    ...(found !== null ? immutableQuery({}) : {}),
  })`),
      'names',
    ],
    [
      'a wallet-keyed query within six lines after a project-keyed one',
      hook(`  const project = useQuery({ queryKey: ['project', chainId], queryFn, meta: PERSIST })
  const balance = useQuery({ queryKey: ['balance', walletAddress], queryFn, meta: PERSIST })
  return [project, balance]`),
      'names',
    ],
    [
      'a key that a function builds, with an account in its arguments',
      hook('  return useQuery({ queryKey: balanceKey(chainId, address), queryFn, meta: PERSIST })'),
      'cannot be read',
    ],
    [
      'a key that a function builds, whatever is in its arguments',
      hook('  return useQuery({ queryKey: positionsKey(chainId, who), queryFn, meta: PERSIST })'),
      'cannot be read',
    ],
    [
      'a key that is a variable',
      hook(`  const key = ['balance', address]
  return useQuery({ queryKey: key, queryFn, meta: PERSIST })`),
      'cannot be read',
    ],
    [
      'a shorthand key',
      hook(`  const queryKey = ['balance']
  return useQuery({ queryKey, queryFn, meta: PERSIST })`),
      'cannot be read',
    ],
    [
      'a key with a spread in it',
      hook("  return useQuery({ queryKey: [...base, chainId], queryFn, meta: PERSIST })"),
      'cannot be read',
    ],
    [
      'a key eight lines after the tag',
      hook(`  return useQuery({
    meta: PERSIST,
    staleTime: 1,
    gcTime: 2,
    retry: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    networkMode: 'always',
    queryKey: ['balance', address],
    queryFn,
  })`),
      'names',
    ],
    [
      'a tier in double quotes',
      hook('  return useQuery({ queryKey: [\'balance\', address], queryFn, meta: { persist: "immutable" } })'),
      'names',
    ],
    [
      'a tier in a template literal',
      hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: `revalidate` } })"),
      'names',
    ],
    [
      'a tier that is not a literal',
      hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: tier } })"),
      'names',
    ],
    [
      'PERSIST spread into meta',
      hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { ...PERSIST } })"),
      'names',
    ],
    [
      'a key that ends in as const',
      hook("  return useQuery({ queryKey: ['balance', address] as const, queryFn, meta: PERSIST })"),
      'names',
    ],
    [
      'a template literal in the key',
      hook('  return useQuery({ queryKey: [`stake-${address}`], queryFn, meta: PERSIST })'),
      'names',
    ],
    [
      'cachedQuery around the options',
      hook("  return useQuery(cachedQuery({ queryKey: ['x', wallet], queryFn }))"),
      'names',
    ],
    [
      'immutableQuery around options that are somewhere else',
      hook('  return useQuery(immutableQuery(options))'),
      'cannot be read',
    ],
    [
      'a key in useQueries, whichever query it is in',
      hook(`  return useQueries({
    queries: ids.map(id => ({ queryKey: ['stake', id, holder], queryFn, meta: PERSIST })),
  })`),
      'names',
    ],
    [
      'a key in queryOptions',
      hook("  return queryOptions({ queryKey: ['x', address], queryFn, meta: PERSIST })"),
      'names',
    ],
    [
      'defaults set for a wallet-keyed query',
      hook("  queryClient.setQueryDefaults(['balance', address], { meta: PERSIST })"),
      'cannot be read',
    ],
    [
      'a helper imported under another name',
      `import { useQuery } from '@tanstack/react-query'
import { immutableQuery as forever } from '@/lib/query-persist'

export const useThing = () => useQuery(forever({ queryKey: ['x', address], queryFn }))
`,
      'names',
    ],
    [
      'a helper reached through a namespace',
      `import { useQuery } from '@tanstack/react-query'
import * as persist from '@/lib/query-persist'

export const useThing = () => useQuery({ queryKey: ['x', address], queryFn, meta: persist.PERSIST })
`,
      'names',
    ],
  ]

  it.each(MISSED)('fails %s', (_what, source, why) => {
    const { offenders } = check('x.ts', source)
    expect(offenders).toHaveLength(1)
    expect(offenders[0]).toContain(why)
  })

  it.each([
    'address',
    'holder',
    'account',
    'wallet',
    'owner',
    'user',
    'viewer',
    'viewed',
    'viewAs',
    'depositor',
    'sender',
    'spender',
    'payer',
    'beneficiary',
    'recipient',
    'staker',
    'signer',
  ])('fails a key that has %s in it, in any letter case, whatever the rest of it says', word => {
    for (const spelled of [word, word.toUpperCase(), `${word}Of`, `current${word[0].toUpperCase()}${word.slice(1)}`]) {
      const source = hook(`  return useQuery({ queryKey: ['stake', ${spelled}], queryFn, meta: PERSIST })`)
      expect(check('x.ts', source).offenders, spelled).toHaveLength(1)
    }
  })

  it('says which key, where, and why', () => {
    const named = hook(`  const a = useQuery({ queryKey: ['project', chainId], queryFn, meta: PERSIST })
  const b = useQuery({ queryKey: ['balance', walletAddress], queryFn, meta: PERSIST })
  return [a, b]`)
    expect(check('x.ts', named).offenders).toEqual(["x.ts:6: ['balance', walletAddress] names address"])
    const built = hook('  return useQuery({ queryKey: positionsKey(chainId, who), queryFn, meta: PERSIST })')
    expect(check('x.ts', built).offenders).toEqual(['x.ts:5: positionsKey(chainId, who) cannot be read'])
    const elsewhere = hook('  return useQuery(immutableQuery(options))')
    expect(check('x.ts', elsewhere).offenders).toEqual(['x.ts:5: immutableQuery(options) cannot be read'])
  })

  it('reads a tag in a component file', () => {
    const source = `import { useQuery } from '@tanstack/react-query'
import { PERSIST } from '@/lib/query-persist'

export function Balance() {
  const { data } = useQuery({ queryKey: ['balance', address], queryFn, meta: PERSIST })
  return <span>{String(data)}</span>
}
`
    expect(check('x.tsx', source).offenders).toHaveLength(1)
  })

  const LEGIT: [string, string][] = [
    [
      'the shape of the metadata hook',
      hook(`  return useQuery({
    queryKey: ['project-metadata', 'v1', found],
    queryFn: async ({ signal }) => {
      const first = await read(1, signal)
      const second = await read(2, signal)
      const third = await read(3, signal)
      const fourth = await read(4, signal)
      const fifth = await read(5, signal)
      return [first, second, third, fourth, fifth]
    },
    enabled: found !== null,
    ...(found !== null ? immutableQuery({}) : {}),
  })`),
    ],
    ['a project key tagged meta: PERSIST', hook("  return useQuery({ queryKey: ['project', chainId, projectId], queryFn, meta: PERSIST })")],
    ['a project key in cachedQuery', hook("  return useQuery(cachedQuery({ queryKey: ['home', network], queryFn }))")],
    ['a project key that ends in as const', hook("  return useQuery({ queryKey: ['project', chainId] as const, queryFn, meta: PERSIST })")],
    [
      'a project key in each query of useQueries',
      hook(`  return useQueries({
    queries: ids.map(id => ({ queryKey: ['stickyProject', chainId, id], queryFn, meta: PERSIST })),
  })`),
    ],
    [
      'a wallet-keyed query that is not tagged, beside one that is',
      hook(`  const project = useQuery({ queryKey: ['project', chainId], queryFn, meta: PERSIST })
  const balance = useQuery({ queryKey: ['balance', walletAddress], queryFn })
  return [project, balance]`),
    ],
    ['a tier that is not one', hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: 'none' } })")],
    ['a tier that is off', hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: false } })")],
    ['a tier in a template literal that is not one', hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: `none` } })")],
    [
      'a tag in a comment and in a string',
      hook(`  // meta: PERSIST would put this on disk, and this key names a wallet: ['balance', address]
  const note = "immutableQuery({ queryKey: ['balance', address] })"
  return useQuery({ queryKey: ['project', note], queryFn })`),
    ],
    [
      'the helpers imported and not used',
      `import { PERSIST, cachedQuery, immutableQuery } from '@/lib/query-persist'\n\nexport const unused = 1\n`,
    ],
  ]

  it.each(LEGIT)('passes %s', (_what, source) => {
    expect(check('x.ts', source).offenders).toEqual([])
  })

  it('passes the real metadata hook, and sees its tag', () => {
    const file = join('src', 'hooks', 'useProjectMetadata.ts')
    const text = readFileSync(file, 'utf8')
    expect(persistedQueries(file, text)).toHaveLength(1)
    expect(check(file, text).offenders).toEqual([])
  })

  describe('an exception', () => {
    const source = hook('  return useQuery({ queryKey: positionsKey(chainId, who), queryFn, meta: PERSIST })')
    const entry: Allowed = {
      file: 'x.ts',
      key: 'positionsKey(chainId, who)',
      reason: 'The builder takes a chain and a project, which are public.',
    }

    it('excuses that key in that file, and is reported as used', () => {
      const excused = check('x.ts', source, [entry])
      expect(excused.offenders).toEqual([])
      expect([...excused.used]).toEqual([entry])
    })

    it('does not excuse the same key in another file, or another key in that file', () => {
      expect(check('y.ts', source, [entry]).offenders).toHaveLength(1)
      expect(check('x.ts', source, [{ ...entry, key: 'positionsKey(chainId)' }]).offenders).toHaveLength(1)
      expect(check('x.ts', source, [{ ...entry, key: 'positionsKey(chainId, who)' }, { ...entry, file: 'y.ts' }]).used.size).toBe(1)
    })

    it('excuses a key with an account word in it, and only that key', () => {
      const listed = hook(`  const a = useQuery({ queryKey: ['owners', chainId], queryFn, meta: PERSIST })
  const b = useQuery({ queryKey: ['owners', chainId, address], queryFn, meta: PERSIST })
  return [a, b]`)
      const allowed = [{ file: 'x.ts', key: "['owners', chainId]", reason: 'The project controllers, which are public.' }]
      expect(check('x.ts', listed, []).offenders).toHaveLength(2)
      expect(check('x.ts', listed, allowed).offenders).toHaveLength(1)
      expect(check('x.ts', listed, allowed).offenders[0]).toContain('address')
    })

    it('matches a key by its text, with each run of white space as one space', () => {
      const laidOut = hook(`  return useQuery({
    queryKey: positionsKey(chainId,
      who),
    queryFn,
    meta: PERSIST,
  })`)
      expect(check('x.ts', laidOut, [entry]).offenders).toEqual([])
    })
  })
})
