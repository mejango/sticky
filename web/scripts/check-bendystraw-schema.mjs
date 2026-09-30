import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import {
  buildClientSchema,
  getIntrospectionQuery,
  parse,
  validate,
  visit,
} from 'graphql'

const minimumDocuments = Number(process.argv[2] ?? 1)
const writeRegistry = process.argv.includes('--write-registry')
// The registry check is a pure local hash comparison; the schema validation below talks to
// live Bendystraw. `--offline` runs only the deterministic half so CI can gate registry drift
// without depending on a third party being up.
const offline = process.argv.includes('--offline')
const registryPath = path.resolve('src/lib/bendystraw-operation-registry.json')
const sourceRoot = path.resolve('src')
const extensions = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx'])
let declarations = new Map()
const documents = new Map()
const unresolved = []

function filesUnder(directory) {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '.next', 'dist', 'build'].includes(entry.name)) continue
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...filesUnder(full))
    else if (extensions.has(path.extname(entry.name)) && !/\.(test|spec|coverage)\./u.test(entry.name)) files.push(full)
  }
  return files
}

function evaluate(node, seen = new Set(), environment = new Map()) {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return evaluate(node.expression, seen, environment)
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isNumericLiteral(node)) return Number(node.text)
  if (ts.isParenthesizedExpression(node)) return evaluate(node.expression, seen, environment)
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(item => evaluate(item, seen, environment))
  if (ts.isObjectLiteralExpression(node)) {
    const value = {}
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) return undefined
      const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
        ? property.name.text
        : undefined
      if (!name) return undefined
      value[name] = evaluate(property.initializer, seen, environment)
    }
    return value
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evaluate(node.left, seen, environment)
    const right = evaluate(node.right, seen, environment)
    return left == null || right == null ? undefined : left + right
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text
    for (const span of node.templateSpans) {
      const expression = evaluate(span.expression, seen, environment)
      if (expression == null) return undefined
      value += expression + span.literal.text
    }
    return value
  }
  if (ts.isIdentifier(node)) {
    if (environment.has(node.text)) return environment.get(node.text)
    if (seen.has(node.text)) return undefined
    const initializer = declarations.get(node.text)
    return initializer
      ? evaluate(initializer, new Set([...seen, node.text]), environment)
      : undefined
  }
  if (ts.isPropertyAccessExpression(node)) {
    const object = evaluate(node.expression, seen, environment)
    return object && typeof object === 'object' ? object[node.name.text] : undefined
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const receiver = evaluate(node.expression.expression, seen, environment)
    const method = node.expression.name.text
    if (method === 'join' && Array.isArray(receiver)) {
      const separator = node.arguments.length ? evaluate(node.arguments[0], seen, environment) : ','
      return receiver.join(typeof separator === 'string' ? separator : ',')
    }
    if (method === 'slice' && Array.isArray(receiver)) {
      const bounds = node.arguments.map(argument => evaluate(argument, seen, environment))
      if (bounds.length > 2 || bounds.some(bound => !Number.isSafeInteger(bound))) return undefined
      return receiver.slice(...bounds)
    }
    if (method === 'map' && Array.isArray(receiver) && node.arguments.length === 1) {
      const callback = node.arguments[0]
      if (!ts.isArrowFunction(callback) || callback.parameters.length !== 1 || !ts.isIdentifier(callback.parameters[0].name)) return undefined
      return receiver.map(item => {
        const next = new Map(environment)
        next.set(callback.parameters[0].name.text, item)
        return evaluate(callback.body, seen, next)
      })
    }
  }
  return undefined
}

const sources = filesUnder(sourceRoot).map(file => ({
  file,
  source: ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true),
}))
for (const { file, source } of sources) {
  declarations = new Map()
  const gather = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      declarations.set(node.name.text, node.initializer)
    }
    ts.forEachChild(node, gather)
  }
  gather(source)
  const add = (node, value) => {
    if (typeof value !== 'string' || !/^\s*(query|mutation)\b/u.test(value)) return
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
    documents.set(value, `${path.relative(process.cwd(), file)}:${line}`)
  }
  const inspect = node => {
    if (ts.isVariableDeclaration(node) && node.initializer) add(node, evaluate(node.initializer))
    else if (ts.isPropertyAssignment(node)) add(node, evaluate(node.initializer))
    else if (ts.isCallExpression(node)) {
      for (const argument of node.arguments) add(node, evaluate(argument))
    }
    if (ts.isTemplateExpression(node) && /^\s*(query|mutation)\b/u.test(node.head.text) && evaluate(node) == null) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      unresolved.push(`${path.relative(process.cwd(), file)}:${line}`)
    }
    ts.forEachChild(node, inspect)
  }
  inspect(source)
}

if (unresolved.length) throw new Error(`Unvalidated generated GraphQL documents:\n${unresolved.join('\n')}`)
if (documents.size < minimumDocuments) {
  throw new Error(`Found ${documents.size} GraphQL documents; expected at least ${minimumDocuments}`)
}

const expectedRegistry = Object.fromEntries(
  [...documents.keys()]
    .map(document => [
      createHash('sha256').update(document, 'utf8').digest('hex'),
      document,
    ])
    .sort(([left], [right]) => left.localeCompare(right)),
)
const expectedRegistryJson = `${JSON.stringify(expectedRegistry, null, 2)}\n`
if (writeRegistry) {
  fs.writeFileSync(registryPath, expectedRegistryJson)
  console.log(`Wrote ${documents.size} persisted Bendystraw operations to ${path.relative(process.cwd(), registryPath)}.`)
} else {
  if (!fs.existsSync(registryPath)) {
    throw new Error('Missing persisted Bendystraw operation registry; run npm run bendystraw:registry')
  }
  if (fs.readFileSync(registryPath, 'utf8') !== expectedRegistryJson) {
    throw new Error('Persisted Bendystraw operation registry is stale; run npm run bendystraw:registry')
  }
}

const parsedDocuments = [...documents].map(([document, location]) => {
  const parsed = parse(document)
  visit(parsed, {
    ObjectValue(node) {
      const names = new Set(node.fields.map(field => field.name.value))
      if (names.has('projectId_in') && names.has('chainId_in')) {
        throw new Error(`${location}: independent projectId_in + chainId_in creates cross-product matches`)
      }
      const or = node.fields.find(field => field.name.value === 'OR')
      if (or?.value.kind === 'ListValue') {
        for (const branch of or.value.values) {
          if (branch.kind !== 'ObjectValue') continue
          const branchNames = branch.fields.map(field => field.name.value)
          const identityFields = branchNames.filter(name => ['chainId', 'projectId', 'version'].includes(name))
          if (identityFields.length > 1 && !branchNames.includes('AND')) {
            throw new Error(`${location}: project identity fields inside OR must use an explicit AND`)
          }
        }
      }
    },
  })
  return { parsed, location }
})

async function liveSchema(endpoint) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ query: getIntrospectionQuery() }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`${endpoint} schema request returned ${response.status}`)
  const envelope = await response.json()
  if (envelope.errors?.length || !envelope.data) throw new Error(`${endpoint} rejected schema introspection`)
  return buildClientSchema(envelope.data)
}

const ENDPOINTS = [
  'https://bendystraw.up.railway.app/graphql',
  'https://testnet.bendystraw.xyz/graphql',
]

// Documents that query fields an unmerged indexer PR adds. They run behind a
// fallback — a schema error degrades to the on-chain read — so shipping them
// ahead of the indexer is safe, but they cannot be validated until it deploys.
// Each entry names the PR that removes it and the ONE endpoint still missing the
// field, and the check FAILS once that endpoint serves it, so the list cannot
// quietly rot after the feature lands.
const PENDING_SCHEMA_FIELDS = []

if (offline) {
  console.log(`Registry is current for ${documents.size} Bendystraw documents (schema validation skipped).`)
  process.exit(0)
}

for (const endpoint of ENDPOINTS) {
  const schema = await liveSchema(endpoint)
  const errors = parsedDocuments.flatMap(({ parsed, location }) =>
    validate(schema, parsed).map(error => `${location}: ${error.message}`),
  )
  const pending = PENDING_SCHEMA_FIELDS.filter(entry => entry.endpoint === endpoint)
  // Shipped = the field no longer produces a validation error. Testing the root-query field
  // set instead would never fire for a NESTED field like accountingTokenUsdRate, letting the
  // entry outlive the indexer PR it names — which is the one thing this list must not do.
  const shipped = pending.filter(
    ({ field }) => !errors.some(error => error.includes(`"${field}"`)),
  )
  if (shipped.length) {
    throw new Error(
      `${endpoint} now serves ${shipped.map(({ field }) => field).join(', ')} — ` +
        'drop it from PENDING_SCHEMA_FIELDS so the document is validated again',
    )
  }
  const blocking = errors.filter(
    error => !pending.some(({ field }) => error.includes(`"${field}"`)),
  )
  if (blocking.length) throw new Error(`${endpoint} schema mismatch:\n${blocking.join('\n')}`)
  for (const { field, reason } of pending) {
    console.log(`Pending on ${endpoint}: ${field} (${reason})`)
  }
}
console.log(`Validated ${documents.size} production GraphQL documents against both Bendystraw schemas.`)
