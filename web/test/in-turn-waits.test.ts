// @vitest-environment node

import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { callsOf, sourcesUnder } from './source-gates'

/**
 * `inTurn` gives a read one of its query client's lanes (`in-turn.ts`), and a read never waits on another query in its
 * turn: if that query's read takes a lane too, every lane can be held by a read waiting on one that waits for a lane,
 * and none ever starts. So no read made in turn waits (`fetchQuery`, `ensureQueryData`) on a query whose read takes a
 * lane, through however many functions of its file, nor on a query whose read this check cannot find in the file: one
 * that does fails here. A query waited for out of turn, before or beside the read in turn, is the way.
 */

const SRC = resolve('src')
const WAITS = new Set(['fetchQuery', 'ensureQueryData'])

type Wait = { line: number; on: 'a query that takes a lane' | 'a query this check cannot find' }

/** Each read made in turn in a source that waits on a query that takes a lane, or one this check cannot find. */
function waitsInTurn(fileName: string, text: string): Wait[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
  // The file's functions by name: declared, or bound to a variable.
  const named = new Map<string, ts.Node>()
  const collect = (at: ts.Node) => {
    if (ts.isFunctionDeclaration(at) && at.name) named.set(at.name.text, at)
    if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name) && at.initializer) named.set(at.name.text, at.initializer)
    ts.forEachChild(at, collect)
  }
  collect(source)

  /** Whether `node` calls `inTurn`, itself or through the file's functions it calls. */
  const takesLane = (node: ts.Node, seen = new Set<ts.Node>()): boolean => {
    if (seen.has(node)) return false
    seen.add(node)
    let found = false
    const visit = (at: ts.Node) => {
      if (found) return
      if (ts.isCallExpression(at) && ts.isIdentifier(at.expression)) {
        const name = at.expression.text
        const fn = named.get(name)
        found = name === 'inTurn' || (fn !== undefined && takesLane(fn, seen))
      }
      ts.forEachChild(at, visit)
    }
    visit(node)
    return found
  }

  /** What the query a wait names reads: an options object's `queryFn`, or what an options function of the file gives. */
  const readOf = (options: ts.Expression | undefined): ts.Node | undefined => {
    if (options && ts.isObjectLiteralExpression(options)) {
      const queryFn = options.properties.find(property => property.name && ts.isIdentifier(property.name) && property.name.text === 'queryFn')
      return queryFn && ts.isPropertyAssignment(queryFn) ? queryFn.initializer : undefined
    }
    if (options && ts.isCallExpression(options) && ts.isIdentifier(options.expression)) return named.get(options.expression.text)
    return undefined
  }

  /** The waits on queries in `node`, itself or through the file's functions it calls. */
  const waitsIn = (node: ts.Node, seen = new Set<ts.Node>()): Wait['on'][] => {
    if (seen.has(node)) return []
    seen.add(node)
    const found: Wait['on'][] = []
    const visit = (at: ts.Node) => {
      if (ts.isCallExpression(at) && ts.isPropertyAccessExpression(at.expression) && WAITS.has(at.expression.name.text)) {
        const read = readOf(at.arguments[0])
        if (read === undefined) found.push('a query this check cannot find')
        else if (takesLane(read)) found.push('a query that takes a lane')
      } else if (ts.isCallExpression(at) && ts.isIdentifier(at.expression)) {
        const fn = named.get(at.expression.text)
        if (fn) found.push(...waitsIn(fn, seen))
      }
      ts.forEachChild(at, visit)
    }
    visit(node)
    return found
  }

  return callsOf(source, 'inTurn').flatMap(call => {
    const read = call.arguments[2]
    const line = source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1
    return read ? waitsIn(read).map(on => ({ line, on })) : []
  })
}

describe('a read made in turn', () => {
  it('waits on no query that takes a lane, in every source file', () => {
    const files = sourcesUnder(SRC)
    const turns = files.flatMap(file => callsOf(ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true), 'inTurn'))
    // The reads made in turn: the project's history, its holders' and Latest's scans, the balance flows, the Chains
    // search, the airdrop funding, the account's positions and activity, and the home's chains. A floor, so a check
    // that found none would not pass.
    expect(turns.length).toBeGreaterThanOrEqual(9)
    const found = files.flatMap(file =>
      waitsInTurn(file, readFileSync(file, 'utf8')).map(wait => ({ file: relative(SRC, file), ...wait })),
    )
    expect(found).toEqual([])
  })

  it('is told apart from one that waits on a query taking a lane, through any function of its file', () => {
    const lane = 'const laneOptions = client => queryOptions({ queryKey, queryFn: ({ signal }) => inTurn(client, signal, read) })\n'
    const direct = `${lane}const q = ({ signal }) => inTurn(client, signal, () => client.fetchQuery(laneOptions(client)))`
    const helper = `${lane}function indexOf(client) { return client.fetchQuery(laneOptions(client)) }\nconst q = ({ signal }) => inTurn(client, signal, async () => indexOf(client))`
    const inline = 'const q = ({ signal }) => inTurn(client, signal, () => client.ensureQueryData({ queryKey, queryFn: ({ signal }) => inTurn(client, signal, read) }))'
    const unknown = 'const q = ({ signal }) => inTurn(client, signal, () => client.fetchQuery(options))'
    const free = 'const q = ({ signal }) => inTurn(client, signal, () => client.fetchQuery({ queryKey, queryFn: () => index() }))'
    const before = `${lane}const q = async ({ signal }) => { await client.fetchQuery(laneOptions(client)); return inTurn(client, signal, read) }`
    expect(waitsInTurn('direct.ts', direct)).toEqual([{ line: 2, on: 'a query that takes a lane' }])
    expect(waitsInTurn('helper.ts', helper)).toEqual([{ line: 3, on: 'a query that takes a lane' }])
    expect(waitsInTurn('inline.ts', inline)).toEqual([{ line: 1, on: 'a query that takes a lane' }])
    expect(waitsInTurn('unknown.ts', unknown)).toEqual([{ line: 1, on: 'a query this check cannot find' }])
    expect(waitsInTurn('free.ts', free)).toEqual([])
    expect(waitsInTurn('before.ts', before)).toEqual([])
  })
})
