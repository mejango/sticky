// @vitest-environment node

import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { callsOf, sourcesUnder } from './source-gates'

/**
 * `inTurn` gives a read one of its query client's lanes (`in-turn.ts`), and a read never waits on another query in its
 * turn: if that query's read takes a lane too, every lane can be held by a read waiting on one that waits for a lane,
 * and none ever starts. So no read made in turn waits (`fetchQuery`, `ensureQueryData`, `prefetchQuery` and their
 * infinite kin) on a query whose read takes a lane, through however many functions of its file it calls or hands on, by
 * name or inline, nor on a query whose read this check cannot find in the file; and a read made in turn that is not one
 * of the file's cannot be looked into either: one that does any of these fails here. A query waited for out of turn,
 * before or beside the read in turn, is the way.
 */

const SRC = resolve('src')
const WAITS = new Set([
  'fetchQuery',
  'ensureQueryData',
  'prefetchQuery',
  'fetchInfiniteQuery',
  'prefetchInfiniteQuery',
  'ensureInfiniteQueryData',
])

type Wait = {
  line: number
  on: 'a query that takes a lane' | 'a query this check cannot find' | 'a read this check cannot find'
}

/** Each read made in turn in a source that waits on a query that takes a lane, or one this check cannot find. */
function waitsInTurn(fileName: string, text: string, source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)): Wait[] {
  // The file's functions by name: declared, or bound to a variable.
  const named = new Map<string, ts.Node>()
  const collect = (at: ts.Node) => {
    if (ts.isFunctionDeclaration(at) && at.name) named.set(at.name.text, at)
    if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name) && at.initializer) named.set(at.name.text, at.initializer)
    ts.forEachChild(at, collect)
  }
  collect(source)

  /** What an expression is: a function or value of the file it names, itself when it names none it has, or undefined
   * for a name the file does not have. */
  const resolved = (expression: ts.Node): ts.Node | undefined =>
    ts.isIdentifier(expression) ? named.get(expression.text) : expression

  /** The file's functions a call is handed by name, which it may call. */
  const handed = (call: ts.CallExpression): ts.Node[] =>
    call.arguments.flatMap(argument => {
      const fn = ts.isIdentifier(argument) ? named.get(argument.text) : undefined
      return fn && (ts.isFunctionLike(fn) || ts.isArrowFunction(fn)) ? [fn] : []
    })

  /** Whether `node` calls `inTurn`, itself or through the file's functions it calls or hands on. */
  const takesLane = (node: ts.Node, seen = new Set<ts.Node>()): boolean => {
    if (seen.has(node)) return false
    seen.add(node)
    let found = false
    const visit = (at: ts.Node) => {
      if (found) return
      if (ts.isCallExpression(at)) {
        const name = ts.isIdentifier(at.expression) ? at.expression.text : undefined
        const fn = name === undefined ? undefined : named.get(name)
        found = name === 'inTurn' || (fn !== undefined && takesLane(fn, seen)) || handed(at).some(each => takesLane(each, seen))
      }
      ts.forEachChild(at, visit)
    }
    visit(node)
    return found
  }

  /** What the query a wait names reads: an options object's `queryFn`, given inline, by name or in short; what an
   * options function of the file gives; or what an options value of the file holds. Undefined when it cannot be found. */
  const readOf = (options: ts.Node | undefined, seen = new Set<ts.Node>()): ts.Node | undefined => {
    if (!options || seen.has(options)) return undefined
    seen.add(options)
    if (ts.isObjectLiteralExpression(options)) {
      const queryFn = options.properties.find(property => property.name?.getText() === 'queryFn')
      if (queryFn && ts.isShorthandPropertyAssignment(queryFn)) return named.get('queryFn')
      return queryFn && ts.isPropertyAssignment(queryFn) ? resolved(queryFn.initializer) : undefined
    }
    if (ts.isCallExpression(options) && ts.isIdentifier(options.expression)) return named.get(options.expression.text)
    if (ts.isIdentifier(options)) return readOf(named.get(options.text), seen)
    return undefined
  }

  /** The waits on queries in `node`, itself or through the file's functions it calls or hands on. */
  const waitsIn = (node: ts.Node, seen = new Set<ts.Node>()): Wait['on'][] => {
    if (seen.has(node)) return []
    seen.add(node)
    const found: Wait['on'][] = []
    const visit = (at: ts.Node) => {
      if (ts.isCallExpression(at) && ts.isPropertyAccessExpression(at.expression) && WAITS.has(at.expression.name.text)) {
        const read = readOf(at.arguments[0])
        if (read === undefined) found.push('a query this check cannot find')
        else if (takesLane(read)) found.push('a query that takes a lane')
      } else if (ts.isCallExpression(at)) {
        const fn = ts.isIdentifier(at.expression) ? named.get(at.expression.text) : undefined
        for (const each of [...(fn ? [fn] : []), ...handed(at)]) found.push(...waitsIn(each, seen))
      }
      ts.forEachChild(at, visit)
    }
    visit(node)
    return found
  }

  return callsOf(source, 'inTurn').flatMap(call => {
    const line = source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1
    if (call.arguments[2] === undefined) return []
    const read = resolved(call.arguments[2])
    return read === undefined ? [{ line, on: 'a read this check cannot find' as const }] : waitsIn(read).map(on => ({ line, on }))
  })
}

describe('a read made in turn', () => {
  it('waits on no query that takes a lane, in every source file', () => {
    const files = sourcesUnder(SRC).map(file => {
      const text = readFileSync(file, 'utf8')
      return { file, text, source: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true) }
    })
    const turns = files.flatMap(({ source }) => callsOf(source, 'inTurn'))
    // The reads made in turn: the project's history, its holders' and Latest's scans, the balance flows, the Chains
    // search, the airdrop funding, the account's positions and activity, and the home's chains. A floor, so a check
    // that found none would not pass.
    expect(turns.length).toBeGreaterThanOrEqual(9)
    const found = files.flatMap(({ file, text, source }) =>
      waitsInTurn(file, text, source).map(wait => ({ file: relative(SRC, file), ...wait })),
    )
    expect(found).toEqual([])
  }, 30_000)

  it('is told apart from one that waits on a query taking a lane, through any function of its file', () => {
    // Line 1 is a read of no query; line 2 the options of a query whose read takes a lane.
    const lane = 'const read = () => scan()\nconst laneOptions = client => queryOptions({ queryKey, queryFn: ({ signal }) => inTurn(client, signal, read) })\n'
    const direct = `${lane}const q = ({ signal }) => inTurn(client, signal, () => client.fetchQuery(laneOptions(client)))`
    const helper = `${lane}function indexOf(client) { return client.fetchQuery(laneOptions(client)) }\nconst q = ({ signal }) => inTurn(client, signal, async () => indexOf(client))`
    const inline = `${lane}const q = ({ signal }) => inTurn(client, signal, () => client.ensureQueryData({ queryKey, queryFn: ({ signal }) => inTurn(client, signal, read) }))`
    const unknown = `${lane}const q = ({ signal }) => inTurn(client, signal, () => client.fetchQuery(options))`
    const free = `${lane}const q = ({ signal }) => inTurn(client, signal, () => client.fetchQuery({ queryKey, queryFn: () => index() }))`
    const before = `${lane}const q = async ({ signal }) => { await client.fetchQuery(laneOptions(client)); return inTurn(client, signal, read) }`
    expect(waitsInTurn('direct.ts', direct)).toEqual([{ line: 3, on: 'a query that takes a lane' }])
    expect(waitsInTurn('helper.ts', helper)).toEqual([{ line: 4, on: 'a query that takes a lane' }])
    expect(waitsInTurn('inline.ts', inline)).toEqual([{ line: 3, on: 'a query that takes a lane' }])
    expect(waitsInTurn('unknown.ts', unknown)).toEqual([{ line: 3, on: 'a query this check cannot find' }])
    expect(waitsInTurn('free.ts', free)).toEqual([])
    expect(waitsInTurn('before.ts', before)).toEqual([])

    // The read made in turn given by name, a function of the file.
    const byName = `${lane}async function waits() { return client.fetchQuery(laneOptions(client)) }\nconst q = ({ signal }) => inTurn(client, signal, waits)`
    expect(waitsInTurn('by-name.ts', byName)).toEqual([{ line: 4, on: 'a query that takes a lane' }])
    // The query's read given by name, as a property or in short.
    const laneRead = 'const laneRead = ({ signal }) => inTurn(client, signal, read)\n'
    const property = `${lane}${laneRead}const q = ({ signal }) => inTurn(client, signal, () => client.fetchQuery({ queryKey, queryFn: laneRead }))`
    const short = `${lane}const queryFn = ({ signal }) => inTurn(client, signal, read)\nconst q = ({ signal }) => inTurn(client, signal, () => client.fetchQuery({ queryKey, queryFn }))`
    expect(waitsInTurn('property.ts', property)).toEqual([{ line: 4, on: 'a query that takes a lane' }])
    expect(waitsInTurn('short.ts', short)).toEqual([{ line: 4, on: 'a query that takes a lane' }])
    // A prefetch waits as a fetch does, and so does each way of asking for an infinite query.
    for (const wait of ['prefetchQuery', 'fetchInfiniteQuery', 'prefetchInfiniteQuery', 'ensureInfiniteQueryData']) {
      const asked = `${lane}const q = ({ signal }) => inTurn(client, signal, async () => { await client.${wait}(laneOptions(client)) })`
      expect(waitsInTurn(`${wait}.ts`, asked)).toEqual([{ line: 3, on: 'a query that takes a lane' }])
    }
    // A read in turn that is not one of the file's cannot be looked into.
    const handed = `${lane}const q = ({ signal }, given) => inTurn(client, signal, given)`
    expect(waitsInTurn('handed.ts', handed)).toEqual([{ line: 3, on: 'a read this check cannot find' }])
  })
})
