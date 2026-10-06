// @vitest-environment node

import { readFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
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
 *
 * The signal has to get there, too: a read that knows it gives it to every read it calls that takes one, and no read
 * that a page's read calls gives its own reads none (`undefined`, or nothing at all) for want of one. Those two are
 * checked with the source's types, so they follow a signal through any module, as an argument or an option.
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

/** Where a call's callee takes a signal: the argument of a parameter named `signal`, or the options of a parameter
 * whose type has a `signal` field; null when it takes none. */
type Slot = { index: number; options: boolean }

function slotOf(checker: ts.TypeChecker, call: ts.CallExpression): Slot | null {
  const parameters = checker.getResolvedSignature(call)?.parameters ?? []
  for (const [index, parameter] of parameters.entries()) {
    const declared = parameter.valueDeclaration
    if (declared && ts.isParameter(declared) && declared.dotDotDotToken) continue
    if (parameter.name === 'signal') return { index, options: false }
    const type = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(parameter, call))
    if (checker.getPropertyOfType(type, 'signal')) return { index, options: true }
  }
  return null
}

/** Whether a call gives its callee a signal: the argument, or the options' `signal`, is there and is not nothing.
 * Options that are not written out here, or are spread from others, are taken to carry one. */
function gives(call: ts.CallExpression, { index, options }: Slot): boolean {
  const argument = call.arguments[index]
  if (!options || nothing(argument)) return !nothing(argument)
  if (!ts.isObjectLiteralExpression(argument!)) return true
  const field = argument.properties.find(property => property.name?.getText() === 'signal')
  if (field) return ts.isShorthandPropertyAssignment(field) || (ts.isPropertyAssignment(field) && !nothing(field.initializer))
  return argument.properties.some(ts.isSpreadAssignment)
}

/** Whether a signal is in scope where `node` is written. */
const signalled = (node: ts.Node) => {
  for (let at = node.parent; at; at = at.parent) if (ts.isFunctionLike(at) && bindsSignal(at)) return true
  return false
}

/** Where `node` is written, as `file:line`. */
const placeOf = (node: ts.Node) => {
  const source = node.getSourceFile()
  return `${relative(SRC, source.fileName)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`
}

/**
 * The calls in `sources` that drop a signal: one made where a signal is in scope to a callee that takes one, without
 * giving it (the readers `jbCenterPublicClient` gives are the check above's); and one that gives its callee no signal
 * where none is in scope, in a function that a call made where one is in scope calls, which should have taken it.
 */
function drops(program: ts.Program, sources: readonly ts.SourceFile[]): string[] {
  const checker = program.getTypeChecker()
  const calls: { call: ts.CallExpression; slot: Slot | null; scoped: boolean }[] = []
  for (const source of sources) {
    const visit = (at: ts.Node) => {
      if (ts.isCallExpression(at)) calls.push({ call: at, slot: slotOf(checker, at), scoped: signalled(at) })
      ts.forEachChild(at, visit)
    }
    visit(source)
  }
  // The calls made of each function, by its declaration.
  const callsOf = new Map<ts.Node, typeof calls>()
  for (const made of calls) {
    const declaration = checker.getResolvedSignature(made.call)?.declaration
    if (declaration) callsOf.set(declaration, [...(callsOf.get(declaration) ?? []), made])
  }
  const found: string[] = []
  for (const { call, slot, scoped } of calls) {
    if (!slot || gives(call, slot)) continue
    const callee = call.expression.getText()
    if (scoped) {
      if (callee !== 'jbCenterPublicClient') found.push(`${placeOf(call)} ${callee} drops the signal in scope`)
      continue
    }
    for (let at = call.parent; at; at = at.parent) {
      if (!ts.isFunctionLike(at)) continue
      const caller = (callsOf.get(at) ?? []).find(made => made.scoped)
      if (caller) {
        found.push(`${placeOf(call)} ${callee} gets no signal, though ${placeOf(caller.call)} has one`)
        break
      }
    }
  }
  return found
}

/** The site's source, with its types. */
function typedSource(): { program: ts.Program; sources: ts.SourceFile[] } {
  const { config } = ts.readConfigFile(resolve('tsconfig.json'), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, resolve('.'))
  const rootNames = parsed.fileNames.filter(file => resolve(file).startsWith(SRC + sep))
  const program = ts.createProgram({ rootNames, options: { ...parsed.options, noEmit: true, incremental: false } })
  return { program, sources: program.getSourceFiles().filter(source => resolve(source.fileName).startsWith(SRC + sep)) }
}

/** `files`, type-checked alone, as `read.ts` and its neighbours. */
function typedSnippets(files: Record<string, string>): { program: ts.Program; sources: ts.SourceFile[] } {
  const host = ts.createCompilerHost({ strict: true, noEmit: true, target: ts.ScriptTarget.ES2022 })
  const named = new Map(Object.entries(files).map(([name, text]) => [resolve(SRC, name), text]))
  const original = host.getSourceFile
  host.getSourceFile = (fileName, language) => {
    const text = named.get(resolve(fileName))
    return text === undefined ? original.call(host, fileName, language) : ts.createSourceFile(fileName, text, language, true)
  }
  const exists = host.fileExists
  host.fileExists = fileName => named.has(resolve(fileName)) || exists.call(host, fileName)
  const program = ts.createProgram({ rootNames: [...named.keys()], options: { strict: true, noEmit: true }, host })
  return { program, sources: [...named.keys()].map(file => program.getSourceFile(file)!) }
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

  it('gives it to every read it calls that takes one, and calls no read that gives its own reads none, in every source file', () => {
    const { program, sources } = typedSource()
    expect(sources.length).toBeGreaterThanOrEqual(100)
    expect(drops(program, sources)).toEqual([])
    // ponytail: a whole type-checked program of src/, about 5 s idle and past a minute on a machine loaded with other
    // gates, so it gets five; check only the changed files' calls if src/ grows enough for that to matter.
  }, 300_000)

  it('is told apart from one that drops the signal on the way, as an argument or an option, or gives none for it', () => {
    const lib = `
      export async function readEach(chainId: number, signal: AbortSignal | undefined) { return [chainId, signal] }
      export async function readOne(chainId: number, { signal }: { signal?: AbortSignal } = {}) { return readEach(chainId, signal) }
      export async function readOneOwn(chainId: number) { return readEach(chainId, undefined) }
      export async function readOneAlone(chainId: number) { return readOne(chainId, { signal: undefined }) }
      export async function unread(chainId: number) { return readEach(chainId, undefined) }`
    const page = `
      import { readEach, readOne, readOneOwn, readOneAlone, unread } from './lib'
      export const queryFn = async ({ signal }: { signal: AbortSignal }) => [
        await readEach(1, signal),
        await readOne(2, { signal }),
        await readOne(3),
        await readOne(4, {}),
        await readOneOwn(5),
        await readOneAlone(6),
      ]
      export const server = async () => [await unread(7), await readOne(8)]`
    const { program, sources } = typedSnippets({ 'lib.ts': lib, 'page.ts': page })
    expect(drops(program, sources)).toEqual([
      'lib.ts:4 readEach gets no signal, though page.ts:8 has one',
      'lib.ts:5 readOne gets no signal, though page.ts:9 has one',
      'page.ts:6 readOne drops the signal in scope',
      'page.ts:7 readOne drops the signal in scope',
    ])
  }, 60_000)
})
