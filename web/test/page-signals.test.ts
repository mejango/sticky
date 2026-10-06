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
 * `jbCenterPublicClient` written where a `signal` is in scope passes it, unless its reader is used for those alone.
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

/** Whether a use of a reader is a read viem can share with another page's. */
function shared(use: ts.Node): boolean {
  const access = use.parent
  if (!ts.isPropertyAccessExpression(access) || access.expression !== use) return false
  const call = access.parent
  if (!ts.isCallExpression(call) || call.expression !== access) return false
  const method = access.name.text
  return method === 'readContract' || method === 'getTransactionReceipt' || (method === 'getBlock' && call.arguments.length > 0)
}

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

/** Each call of `jbCenterPublicClient` in a source, by line: whether a signal is in scope, whether it is passed, and
 * whether the reader is used for shared reads alone. */
function readers(fileName: string, text: string): { line: number; signalled: boolean; passed: boolean; shares: boolean }[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
  return callsOf(source, 'jbCenterPublicClient').map(call => {
    let signalled = false
    for (let at = call.parent; at && !signalled; at = at.parent) signalled = ts.isFunctionLike(at) && bindsSignal(at)
    return {
      line: source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1,
      signalled,
      passed: call.arguments.length > 1,
      shares: usesOf(call).every(shared),
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
    const outer = 'function read(chainId, opts) { const { signal } = opts\n const ask = () => jbCenterPublicClient(chainId).multicall(c)\n return ask() }'
    expect(readers('outer.ts', outer)).toEqual([{ line: 2, signalled: true, passed: false, shares: false }])
    const none = 'function verify(chainId) { const later = signal => signal\n return jbCenterPublicClient(chainId).multicall(c) }'
    expect(readers('none.ts', none)).toEqual([{ line: 2, signalled: false, passed: false, shares: false }])
  })
})
