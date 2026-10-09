import { QueryClient } from '@tanstack/react-query'
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import * as queryPersist from '@/lib/query-persist'

/**
 * Persisted queries outlive the session in localStorage. Anything keyed to a wallet must never go there: a later
 * visitor on the same browser would see the previous account's balances, allowances or holdings restored as if they
 * were their own.
 *
 * This reads the source rather than the runtime because the risk is a future edit tagging the wrong query, and that
 * should fail in CI, not in a browser.
 *
 * It parses each file with the TypeScript compiler API. From every tag it walks out to the object literal that has a
 * `queryKey`, however far apart the two are, and reads that key. A tag is `meta: PERSIST`, `immutableQuery(...)` and
 * `cachedQuery(...)` (spread, called through an import alias or a namespace), and any `persist` property. The persister
 * writes every query whose `meta.persist` is truthy, whatever the type says of it, so a `persist` that is anything but
 * false, null, undefined or '' is a tag. What the scan cannot read fails: a key that is not an array literal, one with a
 * spread in it, or a tag with no key to be found. ALLOWED excuses one key in one file, with the reason it is safe, and
 * does the same for a key with an account word in it that is about something public. TAG_NAMES and NOT_TAGS list every
 * export of query-persist.ts, so a new helper fails a test until someone says whether it tags.
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
  'operator',
  'authority',
]

/** The helpers of query-persist.ts that tag a query for the persister. The other tag is a `persist` property. */
const TAG_NAMES = ['PERSIST', 'immutableQuery', 'cachedQuery']

/** The other exports of query-persist.ts. Each export is in one of the two lists, and the test that says so fails for
 * one that is in neither. */
const NOT_TAGS = ['deserializeState', 'installQueryPersistence', 'serializeState']

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

/** Files that the build reads as code: tsconfig's allowJs has `.js` and `.jsx` in it beside TypeScript. */
const isSource = (name: string) => /\.[cm]?[jt]sx?$/.test(name)

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  '.tsx': ts.ScriptKind.TSX,
  '.jsx': ts.ScriptKind.JSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
}

// All three architecture checks inspect the same source snapshot. Parse each
// distinct input once; synthetic scanner cases still get their own exact AST.
const parsed = new Map<string, ts.SourceFile>()
function sourceOf(file: string, text: string): ts.SourceFile {
  const key = `${file}\0${text}`
  const existing = parsed.get(key)
  if (existing) return existing
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, SCRIPT_KINDS[extname(file)] ?? ts.ScriptKind.TS)
  parsed.set(key, source)
  return source
}

function sourceFiles(dir = 'src'): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return isSource(entry.name) ? [full] : []
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

/** Whether a property is called `text`: `text`, `'text'` or `['text']`. */
function isNamed(name: ts.PropertyName, text: string): boolean {
  if (ts.isComputedPropertyName(name)) {
    return (ts.isStringLiteral(name.expression) || ts.isNoSubstitutionTemplateLiteral(name.expression)) && name.expression.text === text
  }
  return (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === text
}

/** A `persist` property that turns persistence on. The persister writes any query whose `meta.persist` is truthy.
 * The scan passes only the falsy literals false, null, undefined and '' (in any quotes, or as an empty template
 * literal); anything else is a tag, including falsy values it does not evaluate, such as 0 or `void 0`. */
function isPersistProperty(node: ts.Node): boolean {
  if (ts.isShorthandPropertyAssignment(node)) return node.name.text === 'persist'
  if (!ts.isPropertyAssignment(node) || !isNamed(node.name, 'persist')) return false
  const tier = unwrap(node.initializer)
  if (ts.isStringLiteral(tier) || ts.isNoSubstitutionTemplateLiteral(tier)) return tier.text !== ''
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
      (ts.isPropertyAssignment(property) && isNamed(property.name, 'queryKey')) ||
      (ts.isShorthandPropertyAssignment(property) && property.name.text === 'queryKey'),
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
  const source = sourceOf(file, text)
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

/** The TanStack hooks that read a query straight into a render. A module that tags a query reads through
 * useKeptQuery and useKeptQueries instead, which render what the server rendered until the component has hydrated. */
const BARE_READS = new Set([
  'useQuery',
  'useQueries',
  'useSuspenseQuery',
  'useSuspenseQueries',
  'useInfiniteQuery',
  'useSuspenseInfiniteQuery',
])

/** What could read a file's tagged queries around the kept hooks: a bare TanStack read the file imports, or a value
 * it exports with a tag in it, which another module could read bare. An exported hook is the file's own read, and
 * the imports rule covers it. A file with no tag passes. */
function bareReads(file: string, text: string): string[] {
  const source = sourceOf(file, text)
  const names = tagNames(source)
  const holdsTag = (node: ts.Node): boolean =>
    (ts.isIdentifier(node) && names.has(node.text) && isReference(node)) ||
    isPersistProperty(node) ||
    (ts.forEachChild(node, holdsTag) ?? false)
  if (!holdsTag(source)) return []

  const found: string[] = []
  const declared = new Map<string, ts.Node>()
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) declared.set(declaration.name.getText(source), declaration)
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      declared.set(statement.name.text, statement)
    }
  }
  const exportsTag = (name: string, node: ts.Node | undefined) => {
    if (node && !/^use[A-Z]/.test(name) && holdsTag(node)) found.push(`${file}: exports ${name}, which holds a tag`)
  }
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== '@tanstack/react-query') continue
      const bindings = statement.importClause?.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) found.push(`${file}: imports all of @tanstack/react-query`)
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const name = (element.propertyName ?? element.name).text
          if (BARE_READS.has(name)) found.push(`${file}: imports ${name}`)
        }
      }
    } else if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause) {
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          exportsTag(element.name.text, declared.get((element.propertyName ?? element.name).text))
        }
      }
    } else if (ts.isExportAssignment(statement)) {
      exportsTag('default', statement.expression)
    } else if (ts.getModifiers(statement as ts.HasModifiers)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) exportsTag(declaration.name.getText(source), declaration)
      } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
        exportsTag(statement.name.text, statement)
      }
    }
  }
  return found
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

  it('knows every export of query-persist.ts as a tag or as not one', () => {
    expect(Object.keys(queryPersist).sort()).toEqual([...TAG_NAMES, ...NOT_TAGS].sort())
  })

  it('reads each tagged query through useKeptQuery or useKeptQueries', () => {
    expect(files.flatMap(file => bareReads(file, readFileSync(file, 'utf8')))).toEqual([])
  })

  it('finds the tagged queries at all, so the scan cannot silently pass', () => {
    const tagged = files.filter(file => persistedQueries(file, readFileSync(file, 'utf8')).length > 0)
    // The project metadata query, the home's chains and the project page's public facts remain persisted. Removing
    // the cross-pool siblings query removed Overview's only tag. Raise this floor as a task adds a persisted query,
    // to about a quarter of the files that have one.
    expect(tagged).toContain(join('src', 'hooks', 'useProjectMetadata.ts'))
    expect(tagged).toContain(join('src', 'hooks', 'useStickyHome.ts'))
    expect(tagged).toContain(join('src', 'hooks', 'useStickyProject.ts'))
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
  // Persisted queries that name an account, or whose key cannot be read, in the shapes they take. Each must fail, for
  // the reason it is given.
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
      'a tier that names none of the two the type lists',
      hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: 'none' } })"),
      'names',
    ],
    [
      'a tier in a template literal that names none of them',
      hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: `none` } })"),
      'names',
    ],
    [
      'a tier of session',
      hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: 'session' } })"),
      'names',
    ],
    [
      'a tier in another letter case',
      hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: 'Immutable' } })"),
      'names',
    ],
    [
      'a tier of true',
      hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: true } })"),
      'names',
    ],
    [
      'a tier under a computed name',
      hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { ['persist']: true } })"),
      'names',
    ],
    [
      'PERSIST spread into meta',
      hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { ...PERSIST } })"),
      'names',
    ],
    [
      'a key under a quoted name',
      hook("  return useQuery({ 'queryKey': ['balance', address], queryFn, meta: PERSIST })"),
      'names',
    ],
    [
      'a key under a computed name',
      hook("  return useQuery({ ['queryKey']: ['balance', address], queryFn, meta: PERSIST })"),
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
    'operator',
    'authority',
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

  it.each(['a.ts', 'a.tsx', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs', 'a.mts', 'a.cts'])('reads %s as source', name => {
    expect(isSource(name)).toBe(true)
  })

  it.each(['a.md', 'a.json', 'a.css', 'a.ts.map', 'ts', 'a.d'])('does not read %s', name => {
    expect(isSource(name)).toBe(false)
  })

  it.each(['x.js', 'x.mjs', 'x.cjs'])('finds a tag in %s, which has no types', file => {
    const source = `import { useQuery } from '@tanstack/react-query'
import { PERSIST } from '@/lib/query-persist'

export const useThing = () => useQuery({ queryKey: ['balance', address], queryFn, meta: PERSIST })
`
    expect(check(file, source).offenders).toHaveLength(1)
  })

  it('finds a tag in a jsx file, and in a js file that has jsx in it', () => {
    // The backtick in the text of the first element opens a template literal if the file is read as TypeScript, and
    // that swallows the query after it. Read as jsx, it is text.
    const source = `import { useQuery } from '@tanstack/react-query'
import { PERSIST } from '@/lib/query-persist'

export function Balance() {
  const note = <p>use \` to quote</p>
  const { data } = useQuery({ queryKey: ['balance', address], queryFn, meta: PERSIST })
  return <span>{String(data)}{note}</span>
}
`
    expect(check('x.jsx', source).offenders).toHaveLength(1)
    expect(check('x.js', source).offenders).toHaveLength(1)
    expect(check('x.tsx', source).offenders).toHaveLength(1)
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
    ['a tier that is false, on a wallet key', hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: false } })")],
    ['a tier that is empty, on a wallet key', hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: '' } })")],
    ['a tier that is an empty template literal, on a wallet key', hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: `` } })")],
    ['a tier that is null, on a wallet key', hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: null } })")],
    ['a tier that is undefined, on a wallet key', hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: undefined } })")],
    ['a tier that is false and cast, on a wallet key', hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: false as boolean } })")],
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

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: key => map.get(key) ?? null,
    key: index => [...map.keys()][index] ?? null,
    removeItem: key => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  } as Storage
}

/** The keys of the queries that the real persister writes to the browser's storage once `queries` have settled in one
 * client, each as its text. */
async function persistedKeys(queries: { queryKey: unknown[]; meta?: Record<string, unknown> }[]): Promise<string[]> {
  vi.useFakeTimers()
  try {
    const storage = memoryStorage()
    const client = new QueryClient()
    const stop = queryPersist.installQueryPersistence(client, storage)
    for (const query of queries) await client.fetchQuery({ ...query, queryFn: async () => 1 })
    await vi.advanceTimersByTimeAsync(1_500)
    stop()
    const stored = storage.getItem('sticky:query-cache:v1')
    if (stored === null) return []
    return (JSON.parse(stored) as { queries: { queryKey: unknown[] }[] }).queries.map(query => JSON.stringify(query.queryKey))
  } finally {
    vi.useRealTimers()
  }
}

const PROBE = ['balance', '0x1111111111111111111111111111111111111111']

/** A query tagged with the real PERSIST. It settles beside the probe, so the persister always has a write to make. */
const COMPANION = ['companion']

/** Whether the real persister writes a wallet-keyed query with `meta: { persist: value }`: whether the query itself is
 * in what it stores. The companion is always written, so the write happens whatever the tier is, and the tier alone
 * decides whether the probe is in it. */
async function persisterWrites(value: unknown): Promise<boolean> {
  const written = await persistedKeys([
    { queryKey: PROBE, meta: { persist: value } },
    { queryKey: COMPANION, meta: queryPersist.PERSIST },
  ])
  expect(written, 'the companion is written').toContain(JSON.stringify(COMPANION))
  return written.includes(JSON.stringify(PROBE))
}

describe('the kept-read rule itself', () => {
  const TAGGED = "import { PERSIST } from '@/lib/query-persist'\nconst projectOptions = { queryKey: ['project'], meta: PERSIST }"

  it.each([
    ['a bare useQuery', `import { useQuery } from '@tanstack/react-query'\n${TAGGED}`, 'imports useQuery'],
    ['a renamed useQueries', `import { useQueries as read } from '@tanstack/react-query'\n${TAGGED}`, 'imports useQueries'],
    ['all of TanStack', `import * as query from '@tanstack/react-query'\n${TAGGED}`, 'imports all of @tanstack/react-query'],
    [
      'exported tagged options',
      `${TAGGED}\nexport const holderOptions = () => ({ queryKey: ['holders'], meta: PERSIST })`,
      'exports holderOptions, which holds a tag',
    ],
    [
      'tagged options exported by name',
      `${TAGGED}\nexport { projectOptions as options }`,
      'exports options, which holds a tag',
    ],
  ])('fails a tagged module with %s', (_, text, reason) => {
    expect(bareReads('src/hooks/useThing.ts', text)).toEqual([`src/hooks/useThing.ts: ${reason}`])
  })

  it('passes a tagged module that reads through the kept hooks, and an untagged one that reads bare', () => {
    const kept = `import { queryOptions } from '@tanstack/react-query'
import { useKeptQuery } from '@/hooks/useKeptQuery'
${TAGGED}
export function useProject() {
  return useKeptQuery(queryOptions({ ...projectOptions, queryFn }))
}`
    expect(bareReads('src/hooks/useProject.ts', kept)).toEqual([])
    expect(bareReads('src/hooks/usePosition.ts', "import { useQuery } from '@tanstack/react-query'")).toEqual([])
  })
})

describe('a persist tier', () => {
  // The persister writes any query whose `meta.persist` is truthy, whatever the type says of it, so the scan tags
  // every `persist` that is not false, null, undefined or ''. Each row is the tier as it is written, and its value.
  const TIERS: [string, unknown][] = [
    ["'immutable'", 'immutable'],
    ["'revalidate'", 'revalidate'],
    ["'none'", 'none'],
    ["'session'", 'session'],
    ["'Immutable'", 'Immutable'],
    ["'false'", 'false'],
    ['true', true],
    ['1', 1],
    ['{}', {}],
    ['false', false],
    ["''", ''],
    ['null', null],
    ['undefined', undefined],
    ['0', 0],
  ]
  const OFF = ["false", "''", 'null', 'undefined']

  it.each(TIERS)('%s: the scan tags every one that the persister writes, and none of the four that leave a query off', async (literal, value) => {
    const written = await persisterWrites(value)
    const { offenders } = check('x.ts', hook(`  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: ${literal} } })`))
    // The persister's rule: a truthy tier is written.
    expect(written).toBe(Boolean(value))
    // Nothing it writes gets past the scan. (0 is not written and is tagged all the same: a tier that is not a
    // literal false, null, undefined or '' is read as on.)
    expect(offenders.length > 0 || !written).toBe(true)
    if (OFF.includes(literal)) expect(offenders).toEqual([])
  })
})

describe('an untagged query', () => {
  it('is left out of what the persister writes for the tagged query beside it', async () => {
    const tagged = ['project', 1, 2]
    const written = await persistedKeys([{ queryKey: ['balance', '0xabc'] }, { queryKey: tagged, meta: { persist: 'revalidate' } }])
    expect(written).toEqual([JSON.stringify(tagged)])
  })
})
