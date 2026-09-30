import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Persisted queries outlive the session in localStorage. Anything keyed to a
 * wallet must never go there: a later visitor on the same browser would see
 * the previous account's balances, allowances or holdings restored as if they
 * were their own.
 *
 * This scans the source rather than the runtime because the risk is a future
 * edit tagging the wrong query, and that should fail in CI, not in a browser.
 *
 * From juicebox-money's test/persist-scope.test.ts. Sticky tags a query with
 * `immutableQuery(...)` or `cachedQuery(...)` as well as `meta: PERSIST`, so
 * those count as tags here too, and a key is read to its closing bracket, so
 * an account after a nested array is still seen.
 */
const ACCOUNT_HINTS = ['address', 'holder', 'account', 'wallet']
const TAGS = [
  'meta: PERSIST',
  "persist: 'revalidate'",
  "persist: 'immutable'",
  'immutableQuery(',
  'cachedQuery(',
]

/** The source of query-persist.ts writes the tags themselves; it tags no query. */
const TAG_DEFINITIONS = join('src', 'lib', 'query-persist.ts')

function sourceFiles(dir = 'src'): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

/** The first `queryKey: [...]` of `text`, through its closing bracket, or null when it has none. */
function firstKey(text: string): string | null {
  const start = text.search(/queryKey:\s*\[/)
  if (start < 0) return null
  const open = text.indexOf('[', start)
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '[') depth += 1
    else if (text[index] === ']') {
      depth -= 1
      if (depth === 0) return text.slice(open, index + 1)
    }
  }
  return text.slice(open)
}

/** Each tagged query of `text` whose key names a wallet, as `file: key`. */
function offendersIn(file: string, text: string): string[] {
  const lines = text.split('\n')
  const offenders: string[] = []
  lines.forEach((line, index) => {
    if (!TAGS.some(tag => line.includes(tag))) return

    // The key is on a nearby line, so check the surrounding block.
    const window = lines.slice(Math.max(0, index - 6), index + 7).join('\n')
    const key = firstKey(window)
    if (key === null) return
    if (ACCOUNT_HINTS.some(hint => key.toLowerCase().includes(hint))) {
      offenders.push(`${file}: ${key}`)
    }
  })
  return offenders
}

describe('persisted query scope', () => {
  it('never persists a query keyed to a wallet', () => {
    const offenders = sourceFiles().flatMap(file => offendersIn(file, readFileSync(file, 'utf8')))

    expect(offenders).toEqual([])
  })

  it('finds the tagged queries at all, so the scan cannot silently pass', () => {
    const tagged = sourceFiles().filter(
      file => file !== TAG_DEFINITIONS && TAGS.some(tag => readFileSync(file, 'utf8').includes(tag)),
    )
    // The project metadata query is the first. Raise this floor as a task adds a persisted query, to about
    // a quarter of the files that have one, as juicebox-money's does.
    expect(tagged).toContain(join('src', 'hooks', 'useProjectMetadata.ts'))
    expect(tagged.length).toBeGreaterThanOrEqual(1)
  })
})

describe('the scan itself', () => {
  it.each([
    ['immutableQuery', "useQuery(immutableQuery({\n  queryKey: ['balance', walletAddress],\n  queryFn,\n}))"],
    ['cachedQuery', "useQuery(cachedQuery({\n  queryKey: ['positions', account],\n  queryFn,\n}))"],
    ['meta: PERSIST', "useQuery({\n  queryKey: ['stake', holder],\n  queryFn,\n  meta: PERSIST,\n})"],
    ["persist: 'revalidate'", "useQuery({\n  queryKey: ['x', address],\n  meta: { persist: 'revalidate' },\n})"],
    ["persist: 'immutable'", "useQuery({\n  queryKey: ['x', address],\n  meta: { persist: 'immutable' },\n})"],
    ['an account after a nested array', "useQuery(immutableQuery({\n  queryKey: ['x', [1, 2], [3], address],\n}))"],
    ['a key in any letter case', "useQuery(immutableQuery({\n  queryKey: ['Balance', userAddress],\n}))"],
  ])('flags a wallet-keyed query that is tagged with %s', (_tag, source) => {
    expect(offendersIn('x.ts', source)).toHaveLength(1)
  })

  it.each([
    ['a project key', "useQuery(immutableQuery({\n  queryKey: ['project-metadata', uri],\n}))"],
    ['a chain and token key', "useQuery(cachedQuery({\n  queryKey: ['project-uri', chainId, stakedToken],\n}))"],
    ['a wallet key that is not tagged', "useQuery({\n  queryKey: ['balance', address],\n  queryFn,\n})"],
    ['a tag with no array key', "useQuery(immutableQuery({\n  queryKey: keyFor(uri),\n}))"],
  ])('leaves %s alone', (_what, source) => {
    expect(offendersIn('x.ts', source)).toEqual([])
  })

  it('reads a key to its closing bracket', () => {
    expect(firstKey("queryKey: ['a', [1, 2], ['b']], queryFn")).toBe("['a', [1, 2], ['b']]")
    expect(firstKey('queryKey: keyFor(uri)')).toBeNull()
  })
})
