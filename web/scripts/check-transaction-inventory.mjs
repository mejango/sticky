import { readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = join(root, 'src')
const manifestPath = join(root, 'test', 'transaction-sites.json')
const coveragePath = join(root, 'test', 'TRANSACTION_COVERAGE.md')

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (manifest.version !== 1) {
  throw new Error(`Unsupported transaction inventory version: ${manifest.version}`)
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : []
  })
}

function repositoryPath(path) {
  return relative(root, path).split(sep).join('/')
}

function increment(map, file, amount = 1) {
  map[file] = (map[file] ?? 0) + amount
}

function calledName(expression) {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteral(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text
  }
  return null
}

const actual = {
  useSafeTx: {},
  authorityCalls: {},
  reviewedDirectWrites: {},
  rawWalletCalls: {},
}
const rawNames = new Set([
  ...Object.keys(manifest.rawWalletCalls),
  'useSendTransaction',
  'sendTransactionAsync',
  'useSignTypedData',
  'signTypedDataAsync',
  'useSignMessage',
  'signMessage',
  'signMessageAsync',
  'signTransaction',
  'signTransactionAsync',
  'sendRawTransaction',
  'sendCalls',
  'writeContracts',
])
const forbiddenRpcMethods = []

for (const path of sourceFiles(sourceRoot)) {
  const file = repositoryPath(path)
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    extname(path) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const safeTxVariables = new Set()
  const monitoredNames = new Set([
    'useSafeTx',
    'runAuthorityCalls',
    'submitReviewedContractWrite',
    ...rawNames,
  ])
  const aliases = new Map()

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue
    const bindings = statement.importClause.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const specifier of bindings.elements) {
      const imported = (specifier.propertyName ?? specifier.name).text
      if (monitoredNames.has(imported)) {
        aliases.set(specifier.name.text, imported)
      }
    }
  }

  function canonicalCalledName(expression) {
    const name = calledName(expression)
    return name && ts.isIdentifier(expression) ? (aliases.get(name) ?? name) : name
  }

  // Collect hook bindings first, so source order and imported aliases cannot
  // hide a send during the second pass.
  function collectBindings(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      canonicalCalledName(node.initializer.expression) === 'useSafeTx'
    ) {
      safeTxVariables.add(node.name.text)
      actual.useSafeTx[file] ??= { hooks: 0, sends: 0 }
      actual.useSafeTx[file].hooks += 1
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ['useWriteContract', 'useSendTransaction'].includes(
        canonicalCalledName(node.initializer.expression) ?? '',
      )
    ) {
      for (const element of node.name.elements) {
        if (!ts.isIdentifier(element.name)) continue
        const exposed = element.propertyName
          ? element.propertyName.getText(source)
          : element.name.text
        if (rawNames.has(exposed)) aliases.set(element.name.text, exposed)
      }
    }
    ts.forEachChild(node, collectBindings)
  }
  collectBindings(source)

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const name = canonicalCalledName(node.expression)
      if (
        name === 'send' &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        safeTxVariables.has(node.expression.expression.text)
      ) {
        actual.useSafeTx[file] ??= { hooks: 0, sends: 0 }
        actual.useSafeTx[file].sends += 1
      }
      if (name === 'runAuthorityCalls') {
        increment(actual.authorityCalls, file)
      }
      if (name === 'submitReviewedContractWrite') {
        increment(actual.reviewedDirectWrites, file)
      }
      if (name && rawNames.has(name)) {
        actual.rawWalletCalls[name] ??= {}
        increment(actual.rawWalletCalls[name], file)
      }
    }

    if (
      ts.isStringLiteral(node) &&
      ['eth_sendTransaction', 'eth_sendRawTransaction'].includes(node.text)
    ) {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source))
      forbiddenRpcMethods.push(`${file}:${position.line + 1} (${node.text})`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

const failures = []

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, stable(nested)]),
  )
}

function checkMap(label, expected, observed) {
  const normalizedExpected = stable(expected)
  const normalizedObserved = stable(observed)
  if (JSON.stringify(normalizedExpected) !== JSON.stringify(normalizedObserved)) {
    failures.push(
      `${label} changed.\nExpected: ${JSON.stringify(normalizedExpected, null, 2)}\nObserved: ${JSON.stringify(normalizedObserved, null, 2)}`,
    )
  }
}

checkMap(
  'useSafeTx call sites',
  Object.fromEntries(
    Object.entries(manifest.useSafeTx).map(([file, entry]) => [
      file,
      { hooks: entry.hooks, sends: entry.sends },
    ]),
  ),
  actual.useSafeTx,
)
checkMap(
  'runAuthorityCalls call sites',
  Object.fromEntries(
    Object.entries(manifest.authorityCalls).map(([file, entry]) => [
      file,
      entry.calls,
    ]),
  ),
  actual.authorityCalls,
)
checkMap(
  'submitReviewedContractWrite call sites',
  Object.fromEntries(
    Object.entries(manifest.reviewedDirectWrites).map(([file, entry]) => [
      file,
      entry.calls,
    ]),
  ),
  actual.reviewedDirectWrites,
)
checkMap('raw wallet calls', manifest.rawWalletCalls, actual.rawWalletCalls)

if (forbiddenRpcMethods.length) {
  failures.push(
    `Raw wallet JSON-RPC methods bypass the reviewed boundary:\n${forbiddenRpcMethods.join('\n')}`,
  )
}

const coverageRows = new Map()
const testFiles = new Set(
  sourceFiles(join(root, 'test')).map(path => repositoryPath(path)),
)
for (const line of readFileSync(coveragePath, 'utf8').split(/\r?\n/)) {
  if (!line.startsWith('|') || line.startsWith('| ---')) continue
  const columns = line.split('|').slice(1, -1).map(column => column.trim())
  if (columns.length !== 4 || columns[0] === 'User action') continue
  coverageRows.set(columns[0], {
    level: columns[2],
    tests: [...columns[3].matchAll(/`([^`]+\.test\.[^`]+)`/g)].map(
      match => match[1],
    ),
  })
}

function checkActionReference(file, action, { requireExact = false } = {}) {
  const row = coverageRows.get(action)
  if (!row) {
    failures.push(`${file} references missing TRANSACTION_COVERAGE action: ${action}`)
    return
  }
  if (!row.tests.length) {
    failures.push(`${file} action ${action} has no dedicated test reference`)
    return
  }
  if (requireExact && !row.level.includes('E')) {
    failures.push(`${file} action ${action} lacks exact request/calldata coverage`)
  }
  const missingTests = row.tests.filter(test => !testFiles.has(`test/${test}`))
  for (const test of missingTests) {
    failures.push(`${file} action ${action} references missing test/${test}`)
  }
  if (row.tests.every(test => test === 'transactions/use-safe-tx.test.ts')) {
    failures.push(
      `${file} action ${action} only references the shared useSafeTx wrapper test`,
    )
  }
}

const sendSiteIds = new Set()
let mappedSendCount = 0
for (const [file, entry] of Object.entries(manifest.useSafeTx)) {
  if (!Array.isArray(entry.sendSites) || entry.sendSites.length !== entry.sends) {
    failures.push(
      `${file} inventories ${entry.sends} sends but has ${entry.sendSites?.length ?? 0} per-send action records`,
    )
    continue
  }
  mappedSendCount += entry.sendSites.length
  for (const site of entry.sendSites) {
    const qualifiedId = `${file}#${site.id}`
    if (!site.id || sendSiteIds.has(qualifiedId)) {
      failures.push(`${file} has a missing or duplicate send-site id: ${site.id ?? ''}`)
    }
    sendSiteIds.add(qualifiedId)
    if (!site.actions?.length) {
      failures.push(`${qualifiedId} has no transaction coverage action assigned`)
      continue
    }
    for (const action of site.actions) {
      checkActionReference(qualifiedId, action, { requireExact: true })
    }
  }
}

for (const section of [manifest.authorityCalls, manifest.reviewedDirectWrites]) {
  for (const [file, entry] of Object.entries(section)) {
    if (!entry.actions?.length) {
      failures.push(`${file} has no transaction coverage action assigned`)
      continue
    }
    for (const action of entry.actions) {
      checkActionReference(file, action)
    }
  }
}

if (failures.length) {
  console.error(
    'Transaction inventory check failed. Every wallet write must use a reviewed boundary and be recorded in test/transaction-sites.json plus test/TRANSACTION_COVERAGE.md.\n',
  )
  for (const failure of failures) console.error(`${failure}\n`)
  process.exit(1)
}

const safeSendCount = Object.values(actual.useSafeTx).reduce(
  (sum, entry) => sum + entry.sends,
  0,
)
const authorityCount = Object.values(actual.authorityCalls).reduce(
  (sum, count) => sum + count,
  0,
)
const directCount = Object.values(actual.reviewedDirectWrites).reduce(
  (sum, count) => sum + count,
  0,
)
console.log(
  `Transaction inventory verified: ${safeSendCount} useSafeTx sends (${mappedSendCount} individually action-mapped), ${authorityCount} authority entry points, ${directCount} reviewed direct-write entry points, and no unreviewed raw wallet API sites.`,
)
