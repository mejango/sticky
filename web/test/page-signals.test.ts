// @vitest-environment node

import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { callsOf, sourcesUnder } from './source-gates'

/**
 * A read that knows its page's signal asks Center through the page's reader, `jbCenterPublicClient(chainId, signal)`,
 * whose every request goes with the signal: when the page is left, what it has in flight stops and what waits for one
 * of Center's slots is never sent. The one exception is a read viem can share with another page's: a `readContract`,
 * which it batches into one Multicall3 request with the other reads of its block, and a receipt or a block by its
 * number, which it shares while one is under way. One page's signal would split those requests, or stop another
 * page's read with it, so they stay on the chain's shared reader. (The head is shared by `freshHead`.) So every call of
 * `jbCenterPublicClient` written where a `signal` is in scope passes it, unless its reader is used for those alone, and
 * each such reader is named in the list below.
 */

const SRC = resolve('src')

/** Whether `fn` binds the name `signal`, as a parameter or a variable of its own, outside any function written in it. */
function bindsSignal(fn: ts.SignatureDeclaration): boolean {
  let found = false
  const visit = (at: ts.Node) => {
    if (found || (at !== fn && ts.isFunctionLike(at))) return
    if ((ts.isParameter(at) || ts.isVariableDeclaration(at) || ts.isBindingElement(at)) && ts.isIdentifier(at.name)) {
      found = at.name.text === 'signal'
    }
    ts.forEachChild(at, visit)
  }
  visit(fn)
  return found
}

/** The reads viem can share with another page's. */
const SHARED = new Set(['readContract', 'getTransactionReceipt', 'getBlock by number'])

/** What a use of a reader is: the read it makes, a block by its number told from one by its tag or hash, or `other`. */
function useOf(use: ts.Node): string {
  const access = use.parent
  if (!ts.isPropertyAccessExpression(access) || access.expression !== use) return 'other'
  const call = access.parent
  if (!ts.isCallExpression(call) || call.expression !== access) return 'other'
  const method = access.name.text
  if (method !== 'getBlock') return method
  const [options] = call.arguments
  const names = options && ts.isObjectLiteralExpression(options) ? options.properties.map(property => property.name?.getText()) : []
  return names.includes('blockNumber') && !names.includes('blockTag') && !names.includes('blockHash') ? 'getBlock by number' : 'getBlock'
}

/** Whether an argument gives nothing: `undefined`, `void` anything or `null`. */
const nothing = (argument: ts.Expression | undefined) =>
  argument === undefined ||
  (ts.isIdentifier(argument) && argument.text === 'undefined') ||
  ts.isVoidExpression(argument) ||
  argument.kind === ts.SyntaxKind.NullKeyword

/** Where the reader a call gives is used: the call itself, or every mention of the variable it is kept in. */
function usesOf(call: ts.CallExpression): ts.Node[] {
  const kept = call.parent
  if (!ts.isVariableDeclaration(kept) || !ts.isIdentifier(kept.name)) return [call]
  const name = kept.name.text
  const uses: ts.Node[] = []
  let scope: ts.Node = kept
  while (scope.parent && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent
  const visit = (at: ts.Node) => {
    if (ts.isIdentifier(at) && at.text === name && at !== kept.name) uses.push(at)
    ts.forEachChild(at, visit)
  }
  visit(scope)
  return uses
}

/** Each call of `jbCenterPublicClient` in a source, by line: whether a signal is in scope, whether one is passed, what
 * the reader is used for, and whether that is shared reads alone. */
function readers(
  fileName: string,
  text: string,
): { line: number; signalled: boolean; passed: boolean; uses: string[]; shares: boolean }[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
  return callsOf(source, 'jbCenterPublicClient').map(call => {
    let signalled = false
    for (let at = call.parent; at && !signalled; at = at.parent) signalled = ts.isFunctionLike(at) && bindsSignal(at)
    const uses = usesOf(call).map(useOf)
    return {
      line: source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1,
      signalled,
      passed: !nothing(call.arguments[1]),
      uses,
      shares: uses.every(use => SHARED.has(use)),
    }
  })
}

describe('a read that knows its page\'s signal', () => {
  it('asks Center through the page\'s reader unless viem can share it with another page\'s, in every source file', () => {
    const found = sourcesUnder(SRC).flatMap(file =>
      readers(file, readFileSync(file, 'utf8')).map(reader => ({ file: relative(SRC, file), ...reader })),
    )
    // The page's own reads: its scans, its pinned block, its Multicall3 reads of projects, holders, positions, airdrops
    // and siblings, a quote's preview and a preflight. A floor, so a check that found none would not pass.
    expect(found.filter(reader => reader.passed).length).toBeGreaterThanOrEqual(12)
    expect(found.filter(reader => reader.signalled && !reader.passed && !reader.shares)).toEqual([])
    // The shared reads made where a signal is in scope, each named here: one more is a choice made in this list.
    expect(found.filter(reader => reader.signalled && !reader.passed).map(({ file, uses }) => `${file}: ${uses.join(', ')}`).sort()).toEqual([
      'lib/sticky-events.ts: getBlock by number',
      'lib/sticky-events.ts: getTransactionReceipt',
      'lib/sticky-events.ts: readContract',
      'lib/sticky-events.ts: readContract',
      'lib/sticky-metadata.ts: readContract',
      'lib/sticky-metadata.ts: readContract, readContract',
      'lib/sticky-tranches.ts: readContract, readContract',
    ])
  })

  it('is told apart from one that drops the signal, wherever the signal is bound and however the reader is kept', () => {
    const read = (body: string) => readers('read.ts', `async function read(chainId, { signal }) { ${body} }`)[0]
    expect(read('return jbCenterPublicClient(chainId).getBlock()')).toMatchObject({ signalled: true, passed: false, shares: false })
    expect(read('return jbCenterPublicClient(chainId, signal).multicall({ contracts })')).toMatchObject({ passed: true })
    expect(read('const client = jbCenterPublicClient(chainId)\n return client.multicall({ contracts })')).toMatchObject({ shares: false })
    expect(read('const client = jbCenterPublicClient(chainId)\n return scanLogs(client, query, { signal })')).toMatchObject({ shares: false })
    expect(read('const client = jbCenterPublicClient(chainId)\n return [client.readContract(a), client.readContract(b)]')).toMatchObject({ shares: true })
    expect(read('return jbCenterPublicClient(chainId).getBlock({ blockNumber })')).toMatchObject({ shares: true })
    expect(read('return jbCenterPublicClient(chainId).getTransactionReceipt({ hash })')).toMatchObject({ shares: true })
    // A block named by its tag or its hash is not one viem shares, and `undefined` is no signal.
    expect(read("return jbCenterPublicClient(chainId).getBlock({ blockTag: 'latest' })")).toMatchObject({ shares: false })
    expect(read('return jbCenterPublicClient(chainId).getBlock({ blockHash })')).toMatchObject({ shares: false })
    expect(read('return jbCenterPublicClient(chainId, undefined).multicall({ contracts })')).toMatchObject({ passed: false })
    expect(read('return jbCenterPublicClient(chainId, void 0).multicall({ contracts })')).toMatchObject({ passed: false })
    const outer = 'function read(chainId, opts) { const { signal } = opts\n const ask = () => jbCenterPublicClient(chainId).multicall(c)\n return ask() }'
    expect(readers('outer.ts', outer)).toEqual([{ line: 2, signalled: true, passed: false, uses: ['multicall'], shares: false }])
    const none = 'function verify(chainId) { const later = signal => signal\n return jbCenterPublicClient(chainId).multicall(c) }'
    expect(readers('none.ts', none)).toEqual([{ line: 2, signalled: false, passed: false, uses: ['multicall'], shares: false }])
  })
})
