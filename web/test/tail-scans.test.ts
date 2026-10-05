// @vitest-environment node

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * A tail is a scan past the block Bendystraw is indexed through, and it starts at `scanFrom`. Behind an indexer far
 * behind the head, as one replaying its history is, a tail can be more than a scan may read, and `tailOrNull` makes
 * the read fall back as it does when Bendystraw cannot answer instead of failing. So every call of `scanFrom` in the
 * site's source must be written in a function that also calls `tailOrNull`: a new tail that skips the rule fails here.
 */

const SRC = resolve('src')

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return sourcesUnder(full)
    return /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

/** The calls of the function `name` under `node`. */
function callsOf(node: ts.Node, name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = []
  const visit = (at: ts.Node) => {
    if (ts.isCallExpression(at) && ts.isIdentifier(at.expression) && at.expression.text === name) found.push(at)
    ts.forEachChild(at, visit)
  }
  visit(node)
  return found
}

/** The function a call is written in: the nearest function declaration or method, or function bound to a variable,
 * past any function written inline as an argument, as the read handed to `tailOrNull` is. */
function writtenIn(node: ts.Node): ts.Node | undefined {
  for (let at = node.parent; at; at = at.parent) {
    if (ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) return at
    if ((ts.isArrowFunction(at) || ts.isFunctionExpression(at)) && ts.isVariableDeclaration(at.parent)) return at
  }
  return undefined
}

/** Each call of `scanFrom` in a source, by line, and whether the function it is written in calls `tailOrNull`. */
function tails(fileName: string, text: string): { line: number; guarded: boolean }[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
  return callsOf(source, 'scanFrom').map(call => {
    const owner = writtenIn(call)
    return {
      line: source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1,
      guarded: owner !== undefined && callsOf(owner, 'tailOrNull').length > 0,
    }
  })
}

describe('a tail past the block Bendystraw is indexed through', () => {
  it('goes through tailOrNull in the function that starts it at scanFrom, in every source file', () => {
    const found = sourcesUnder(SRC).flatMap(file =>
      tails(file, readFileSync(file, 'utf8')).map(tail => ({ file: relative(SRC, file), ...tail })),
    )
    // The tails the site reads: the hook's history, a holder's events, a chain's projects, a project's holders, the
    // home's Latest, the account's positions, the chart's two histories and the airdrop funding. A floor, so a check
    // that found none would not pass.
    expect(found.length).toBeGreaterThanOrEqual(8)
    expect(found.filter(tail => !tail.guarded)).toEqual([])
  })

  it('is told apart from a tail that skips the rule, whatever function the rule is followed in', () => {
    const bare = 'async function reader() { const fromBlock = scanFrom(asOf, deployment); return scan(fromBlock) }'
    const inline = 'async function reader() { return tailOrNull(() => scan(scanFrom(asOf, deployment)), LABEL, {}) }'
    const bound = 'const history = async () => tailOrNull(() => scan({ fromBlock: scanFrom(asOf, deployment) }), LABEL, {})'
    const elsewhere = 'function guard() { return tailOrNull(read, LABEL, {}) }\nfunction reader() { return scan(scanFrom(asOf, deployment)) }'
    expect(tails('bare.ts', bare)).toEqual([{ line: 1, guarded: false }])
    expect(tails('inline.ts', inline)).toEqual([{ line: 1, guarded: true }])
    expect(tails('bound.ts', bound)).toEqual([{ line: 1, guarded: true }])
    expect(tails('elsewhere.ts', elsewhere)).toEqual([{ line: 2, guarded: false }])
  })
})
