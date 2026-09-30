import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { decodeFunctionData, decodeFunctionResult, encodeFunctionResult, multicall3Abi } from 'viem'

// The only answers the browser suite gets: JB Center's reads, Bendystraw's
// documents, IPFS documents and DexScreener prices, all recorded from live
// reads into fixtures/sticky.json, whose `source` says where from. A request
// the recording does not hold is answered with an error and listed at
// /__fixture/status, and the suite's teardown fails on it. With --record
// (`npm run test:browser:record`), such a request is read live instead, at the
// recorded head, and kept. Delete the file first to record a new head.

const portIndex = process.argv.indexOf('--port')
const port = Number(
  portIndex >= 0
    ? process.argv[portIndex + 1]
    : (process.env.PLAYWRIGHT_FIXTURE_PORT ?? 8793),
)

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid deterministic fixture port: ${port}`)
}

const RECORDING = process.argv.includes('--record')
const FIXTURE_FILE = new URL('./fixtures/sticky.json', import.meta.url)
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'
const PLACEHOLDER_IMAGE = new URL('../../public/assets/drip-round.png', import.meta.url)

// The deterministic build's transport names a network; the Signa build's is
// Center's own path, which names a chain.
const RPC_NETWORKS = {
  mainnet: 1,
  'optimism-mainnet': 10,
  'base-mainnet': 8453,
  'arbitrum-mainnet': 42161,
  sepolia: 11155111,
  'optimism-sepolia': 11155420,
  'base-sepolia': 84532,
  'arbitrum-sepolia': 421614,
}
const CHAIN_IDS = new Set(Object.values(RPC_NETWORKS))

const empty = () => ({
  recordedAt: null,
  source: null,
  heads: {},
  rpc: {},
  calls: {},
  logs: {},
  graphql: {},
  ipfs: {},
  dexscreener: {},
})

const fixture = existsSync(FIXTURE_FILE)
  ? { ...empty(), ...JSON.parse(readFileSync(FIXTURE_FILE, 'utf8')) }
  : empty()
for (const kept of Object.values(fixture.logs)) kept.ranges = merged(kept.ranges)
if (!RECORDING && !fixture.recordedAt) {
  throw new Error('No recorded fixture. Run npm run test:browser:record first.')
}
const upstream = RECORDING ? await import('./record-upstream.mjs') : null

const state = {
  graphql: Object.create(null),
  // Each document and its variables, so a spec can count the answers to one question.
  graphqlRequests: Object.create(null),
  rpc: Object.create(null),
  multicallBatches: 0,
  preflights: 0,
  ipfs: 0,
  dexscreener: 0,
  recorded: 0,
  unknown: [],
}

function increment(bucket, key) {
  bucket[key] = (bucket[key] ?? 0) + 1
}

function recordUnknown(kind, detail) {
  if (state.unknown.length < 100) state.unknown.push({ kind, detail })
}

function comparable(value) {
  if (typeof value === 'bigint') return `bigint:${value}`
  if (typeof value === 'string') {
    return /^0x[0-9a-f]+$/i.test(value) ? value.toLowerCase() : value
  }
  if (Array.isArray(value)) return value.map(comparable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, comparable(item)]),
    )
  }
  return value
}

const stable = value => JSON.stringify(comparable(value))

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    stable(Object.keys(value).sort()) === stable([...keys].sort())
  )
}

// --- Keeping what a recording run reads -------------------------------------

let writeTimer
function remember(section, key, value) {
  fixture[section][key] = value
  state.recorded += 1
  writeTimer ??= setTimeout(saveFixture, 2_000)
}

/** One entry a line, keys sorted, so a new recording diffs by entry. */
function saveFixture() {
  if (!RECORDING) return
  clearTimeout(writeTimer)
  writeTimer = undefined
  fixture.recordedAt ??= new Date().toISOString()
  fixture.source = upstream.SOURCE
  const sections = Object.keys(empty()).map(section => {
    const value = fixture[section]
    if (!value || typeof value !== 'object') return `  ${JSON.stringify(section)}: ${JSON.stringify(value)}`
    const entries = Object.keys(value)
      .sort()
      .map(key => `    ${JSON.stringify(key)}: ${JSON.stringify(value[key])}`)
    return `  ${JSON.stringify(section)}: {${entries.length ? `\n${entries.join(',\n')}\n  ` : ''}}`
  })
  writeFileSync(FIXTURE_FILE, `{\n${sections.join(',\n')}\n}\n`)
}

// --- JSON-RPC -----------------------------------------------------------------

function rpcError(id, message, code = -32_004) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function rpcAnswer(id, recorded) {
  return 'error' in recorded
    ? { jsonrpc: '2.0', id: id ?? null, error: recorded.error }
    : { jsonrpc: '2.0', id: id ?? null, result: recorded.result }
}

function validRpcEnvelope(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  if (payload.jsonrpc !== '2.0') return false
  if (typeof payload.id !== 'number' && typeof payload.id !== 'string') return false
  const keys = payload.params === undefined
    ? ['id', 'jsonrpc', 'method']
    : ['id', 'jsonrpc', 'method', 'params']
  return exactKeys(payload, keys)
}

const rpcKey = (chainId, method, params) => `${chainId} ${method} ${stable(params ?? [])}`
const callKey = (chainId, block, to, data) => `${chainId} ${block} ${to.toLowerCase()} ${data.toLowerCase()}`
const logsKey = (chainId, filter) => `${chainId} ${stable(filter.address)} ${stable(filter.topics ?? [])}`

/** The head a chain was recorded at. Every read of the chain is as of it. */
async function headOf(chainId) {
  if (fixture.heads[chainId]) return fixture.heads[chainId]
  if (!upstream) return null
  const answer = await upstream.center(chainId, 'eth_blockNumber', [])
  if (!answer.result) throw new Error(`No head for chain ${chainId}: ${stable(answer)}`)
  fixture.heads[chainId] ??= answer.result
  remember('heads', String(chainId), fixture.heads[chainId])
  return fixture.heads[chainId]
}

/** A request as it is asked of the live chain while recording: `latest` is the recorded head. */
function atHead(params, head) {
  const pin = value => (value === 'latest' ? head : value)
  return params.map(param =>
    param && typeof param === 'object' && !Array.isArray(param) && ('toBlock' in param || 'fromBlock' in param)
      ? { ...param, fromBlock: pin(param.fromBlock), toBlock: pin(param.toBlock) }
      : pin(param),
  )
}

async function liveAnswer(chainId, method, params) {
  const head = await headOf(chainId)
  return upstream.center(chainId, method, atHead(params ?? [], head))
}

/** Ranges sorted, with touching or overlapping ones joined. */
function merged(ranges) {
  const joined = []
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = joined.at(-1)
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end)
    else joined.push([start, end])
  }
  return joined
}

function covered(ranges, from, to) {
  let next = from
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (start > next) break
    if (end >= next) next = end + 1
    if (next > to) return true
  }
  return next > to
}

async function getLogs(id, chainId, params) {
  const [filter] = params
  const key = logsKey(chainId, filter)
  const head = Number(await headOf(chainId))
  const from = Number(filter.fromBlock === 'latest' ? head : filter.fromBlock)
  const to = Number(filter.toBlock === 'latest' ? head : filter.toBlock)
  const kept = fixture.logs[key]
  if (kept && covered(kept.ranges, from, to)) {
    return rpcAnswer(id, {
      result: kept.logs.filter(log => Number(log.blockNumber) >= from && Number(log.blockNumber) <= to),
    })
  }
  if (!upstream) {
    recordUnknown('rpc-logs', `${key} ${from}-${to}`)
    return rpcError(id, 'Deterministic fixture has no recorded logs for this range')
  }
  const answer = await recordLogs(chainId, filter, from, to)
  if (!Array.isArray(answer.result)) {
    remember('rpc', rpcKey(chainId, 'eth_getLogs', params), answer)
    return rpcAnswer(id, answer)
  }
  readAhead(chainId, filter, to + 1, to - from + 1, head)
  return rpcAnswer(id, answer)
}

// A scan asks for its windows a couple at a time, and each live answer takes
// most of a second, so a recording run reads the windows after the one asked
// for in the meantime. The scan's next request then finds its window kept, or
// waits for the read already under way.
const READ_AHEAD = 24
const READ_AHEAD_IN_FLIGHT = 6
const reading = new Map()
const readAheadQueue = []
let readingAhead = 0

const hex = block => `0x${block.toString(16)}`

/** One window read live and kept with its filter's other logs. */
function recordLogs(chainId, filter, from, to) {
  const id = `${logsKey(chainId, filter)} ${from}-${to}`
  let pending = reading.get(id)
  if (!pending) {
    pending = liveAnswer(chainId, 'eth_getLogs', [{ ...filter, fromBlock: hex(from), toBlock: hex(to) }])
      .then(answer => {
        if (Array.isArray(answer.result)) keepLogs(chainId, filter, from, to, answer.result)
        return answer
      })
      .finally(() => reading.delete(id))
    reading.set(id, pending)
  }
  return pending
}

function keepLogs(chainId, filter, from, to, found) {
  const key = logsKey(chainId, filter)
  const kept = fixture.logs[key]
  const logs = new Map((kept?.logs ?? []).map(log => [`${log.transactionHash}:${log.logIndex}`, log]))
  for (const log of found) logs.set(`${log.transactionHash}:${log.logIndex}`, log)
  remember('logs', key, {
    ranges: merged([...(kept?.ranges ?? []), [from, to]]),
    logs: [...logs.values()].sort(
      (a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex),
    ),
  })
}

/** Queues the READ_AHEAD windows of `span` blocks from `start`, up to the head. */
function readAhead(chainId, filter, start, span, head) {
  for (let at = 0, from = start; at < READ_AHEAD && from <= head; at += 1, from += span) {
    const to = Math.min(from + span - 1, head)
    readAheadQueue.push(() => {
      const kept = fixture.logs[logsKey(chainId, filter)]
      return kept && covered(kept.ranges, from, to) ? Promise.resolve() : recordLogs(chainId, filter, from, to)
    })
  }
  pumpReadAhead()
}

function pumpReadAhead() {
  while (readingAhead < READ_AHEAD_IN_FLIGHT && readAheadQueue.length) {
    readingAhead += 1
    // A window read ahead that fails is read again when the scan asks for it.
    readAheadQueue
      .shift()()
      .catch(() => {})
      .finally(() => {
        readingAhead -= 1
        pumpReadAhead()
      })
  }
}

async function multicall(id, chainId, params) {
  const [call, block = 'latest'] = params
  const exact = fixture.rpc[rpcKey(chainId, 'eth_call', params)]
  if (exact) return rpcAnswer(id, exact)
  const decoded = decodeFunctionData({ abi: multicall3Abi, data: call.data })
  if (decoded.functionName !== 'aggregate3' || !Array.isArray(decoded.args?.[0])) {
    throw new Error('Only aggregate3 is supported')
  }
  const calls = decoded.args[0]
  if (calls.length === 0) throw new Error('Empty multicall')
  state.multicallBatches += 1
  const results = calls.map(inner => fixture.calls[callKey(chainId, block, inner.target, inner.callData)])
  if (results.every(Boolean)) {
    return rpcAnswer(id, {
      result: encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results }),
    })
  }
  if (!upstream) {
    const missing = calls.filter((_, at) => !results[at])
    recordUnknown(
      'contract-read',
      missing.map(inner => `${chainId}@${block} ${inner.target}:${inner.callData.slice(0, 10)}`).join(', '),
    )
    return rpcError(id, 'Deterministic fixture has no recorded answer for a batched read')
  }
  const answer = await liveAnswer(chainId, 'eth_call', params)
  if (typeof answer.result !== 'string') {
    remember('rpc', rpcKey(chainId, 'eth_call', params), answer)
    return rpcAnswer(id, answer)
  }
  const live = decodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', data: answer.result })
  calls.forEach((inner, at) => {
    remember('calls', callKey(chainId, block, inner.target, inner.callData), {
      success: live[at].success,
      returnData: live[at].returnData,
    })
  })
  return rpcAnswer(id, answer)
}

async function handleRpcCall(payload, chainId) {
  if (!validRpcEnvelope(payload)) {
    recordUnknown('rpc-envelope', 'Malformed JSON-RPC 2.0 request')
    return rpcError(payload?.id, 'Malformed deterministic JSON-RPC envelope', -32_600)
  }

  const { id, method, params = [] } = payload
  increment(state.rpc, String(method))
  if (!Array.isArray(params)) {
    recordUnknown('rpc-parameters', `${method} parameters are not a list`)
    return rpcError(id, `Invalid parameters for ${method}`, -32_602)
  }
  if (method === 'eth_chainId') return rpcAnswer(id, { result: `0x${chainId.toString(16)}` })
  if (method === 'net_version') return rpcAnswer(id, { result: String(chainId) })
  if (method === 'eth_blockNumber') {
    const head = await headOf(chainId)
    if (head) return rpcAnswer(id, { result: head })
    recordUnknown('rpc-head', String(chainId))
    return rpcError(id, `Deterministic fixture has no head for chain ${chainId}`)
  }

  try {
    if (method === 'eth_getLogs' && params.length === 1 && params[0] && !params[0].blockHash) {
      return await getLogs(id, chainId, params)
    }
    if (method === 'eth_call' && params[0]?.to?.toLowerCase() === MULTICALL3) {
      return await multicall(id, chainId, params)
    }
  } catch (error) {
    recordUnknown('rpc-request', error instanceof Error ? error.message : String(error))
    return rpcError(id, 'Deterministic fixture rejected a malformed read', -32_602)
  }

  const key = rpcKey(chainId, method, params)
  const recorded = fixture.rpc[key]
  if (recorded) return rpcAnswer(id, recorded)
  if (!upstream) {
    recordUnknown('rpc-method', key.slice(0, 240))
    return rpcError(id, `Deterministic fixture has no recorded answer for ${String(method)}`)
  }
  const answer = await liveAnswer(chainId, method, params)
  remember('rpc', key, answer)
  return rpcAnswer(id, answer)
}

// --- GraphQL ------------------------------------------------------------------

const graphqlToken =
  /\.\.\.|[_A-Za-z][_0-9A-Za-z]*|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|"(?:\\.|[^"\\])*"|[!$&():=@[\]{|}]/g

function canonicalGraphql(document) {
  const source = document.replace(/#[^\r\n]*/g, '')
  const tokens = []
  let cursor = 0
  for (const match of source.matchAll(graphqlToken)) {
    if (!/^[\s,]*$/.test(source.slice(cursor, match.index))) {
      throw new Error('Unsupported token in GraphQL document')
    }
    tokens.push(match[0])
    cursor = match.index + match[0].length
  }
  if (!/^[\s,]*$/.test(source.slice(cursor))) {
    throw new Error('Unsupported token in GraphQL document')
  }
  return tokens.join(' ')
}

function operationNameOf(canonical) {
  const [operation, candidate] = canonical.split(' ')
  return ['mutation', 'query', 'subscription'].includes(operation) &&
    /^[_A-Za-z][_0-9A-Za-z]*$/.test(candidate ?? '')
    ? candidate
    : undefined
}

/** An operation's ID is the SHA-256 of its exact text, as the site's registry has it. */
const operationId = query => createHash('sha256').update(query, 'utf8').digest('hex')

async function handleGraphql(request, response, network) {
  if (!hasJsonContentType(request)) {
    recordUnknown('graphql-content-type', String(request.headers['content-type']))
    sendJson(request, response, 415, {
      errors: [{ message: 'GraphQL fixture requires application/json' }],
    })
    return
  }

  const payload = await readJson(request)
  const hasOperationName =
    payload !== null &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    Object.hasOwn(payload, 'operationName')
  const envelopeKeys = hasOperationName
    ? ['operationName', 'query', 'variables']
    : ['query', 'variables']
  if (!exactKeys(payload, envelopeKeys)) {
    recordUnknown(
      'graphql-envelope',
      'Expected query, variables, and only an optional operationName',
    )
    sendJson(request, response, 400, {
      errors: [{ message: 'Malformed deterministic GraphQL envelope' }],
    })
    return
  }

  let canonical
  try {
    canonical = canonicalGraphql(payload.query)
  } catch (error) {
    recordUnknown(
      'graphql-document',
      error instanceof Error ? error.message : 'Malformed document',
    )
    sendJson(request, response, 400, {
      errors: [{ message: 'Malformed deterministic GraphQL document' }],
    })
    return
  }
  const operationName = operationNameOf(canonical)
  if (!operationName || (hasOperationName && payload.operationName !== operationName)) {
    recordUnknown(
      'graphql-operation-name',
      'operationName does not match the selected document operation',
    )
    sendJson(request, response, 400, {
      errors: [{ message: 'Invalid deterministic GraphQL operationName' }],
    })
    return
  }

  const operation = operationId(payload.query)
  const key = `${network} ${operationName} ${stable(payload.variables)}`
  let recorded = fixture.graphql[key]
  if (recorded && recorded.operation !== operation) {
    recordUnknown('graphql-document', `${operationName} changed since it was recorded`)
    recorded = undefined
  } else if (!recorded && upstream) {
    recorded = await upstream.relay(network, operation, payload.variables)
    if (recorded) remember('graphql', key, { operation, ...recorded })
  }
  if (!recorded) {
    if (!upstream) recordUnknown('graphql-variables', key.slice(0, 240))
    sendJson(request, response, 503, {
      errors: [{ message: 'Deterministic fixture has no matching GraphQL query' }],
    })
    return
  }

  increment(state.graphql, operationName)
  increment(state.graphqlRequests, key)
  // A failure the live relay gave is a GraphQL error here, which the site's
  // relay turns into the same 502 without retrying.
  sendJson(request, response, 200, 'data' in recorded ? { data: recorded.data } : { errors: recorded.errors })
}

// --- IPFS and DexScreener, for the browser's stubs ----------------------------

const IPFS_PATH = /^\/ipfs\/((?:[A-Za-z\d._~-]{1,128}\/){0,7}[A-Za-z\d._~-]{1,128})$/
const DEXSCREENER_PATH = /^\/dexscreener\/(tokens\/v1\/[a-z]+\/[0-9a-fA-Fx,]{1,1400})$/

async function handleIpfs(request, response, path) {
  let recorded = fixture.ipfs[path]
  if (!recorded && upstream) {
    recorded = await upstream.ipfs(path)
    if (recorded) remember('ipfs', path, recorded)
  }
  if (!recorded) {
    if (!upstream) recordUnknown('ipfs', path)
    sendJson(request, response, 404, { error: 'Deterministic fixture has no such IPFS document' })
    return
  }
  state.ipfs += 1
  if (recorded.image) {
    // A logo's pixels are not kept: every recorded image is this one.
    response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'image/png' })
    response.end(readFileSync(PLACEHOLDER_IMAGE))
    return
  }
  sendJson(request, response, 200, recorded.document)
}

async function handleDexscreener(request, response, path) {
  let recorded = fixture.dexscreener[path]
  if (!recorded && upstream) {
    recorded = await upstream.dexscreener(path)
    if (recorded) remember('dexscreener', path, recorded)
  }
  if (!recorded) {
    if (!upstream) recordUnknown('dexscreener', path)
    sendJson(request, response, 503, { error: 'Deterministic fixture has no such price' })
    return
  }
  state.dexscreener += 1
  sendJson(request, response, 200, recorded.pairs)
}

// --- HTTP ---------------------------------------------------------------------

function localCorsHeaders(request) {
  const origin = request.headers.origin
  if (!origin) return {}

  try {
    const hostname = new URL(origin).hostname
    if (
      hostname !== '127.0.0.1' &&
      hostname !== 'localhost' &&
      hostname !== '::1'
    ) {
      return {}
    }
  } catch {
    return {}
  }

  return {
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-origin': origin,
    vary: 'origin',
  }
}

function sendJson(request, response, status, body) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    ...localCorsHeaders(request),
  })
  response.end(JSON.stringify(body))
}

async function readJson(request) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > 64 * 1024) {
      throw new Error('Fixture request body exceeded 64 KiB')
    }
    chunks.push(chunk)
  }
  if (bytes === 0) throw new Error('Fixture request body was empty')
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function hasJsonContentType(request) {
  return /^application\/json(?:\s*;|$)/i.test(
    String(request.headers['content-type'] ?? ''),
  )
}

function rpcChainOf(url) {
  const network = /^\/rpc\/([a-z-]+)$/.exec(url)?.[1]
  if (network) return RPC_NETWORKS[network]
  const chainId = Number(/^\/v1\/rpc\/([0-9]{1,12})$/.exec(url)?.[1])
  return CHAIN_IDS.has(chainId) ? chainId : undefined
}

const server = createServer(async (request, response) => {
  try {
    if (request.url === '/health' && request.method === 'GET') {
      response.writeHead(204).end()
      return
    }

    if (request.url === '/__fixture/status' && request.method === 'GET') {
      sendJson(request, response, 200, state)
      return
    }

    const graphqlNetwork = /^\/(mainnet|testnet)\/graphql$/.exec(request.url ?? '')?.[1]
    const rpcChainId = rpcChainOf(request.url ?? '')
    if (request.method === 'OPTIONS' && (graphqlNetwork || rpcChainId)) {
      state.preflights += 1
      response.writeHead(204, localCorsHeaders(request)).end()
      return
    }

    if (graphqlNetwork && request.method === 'POST') {
      await handleGraphql(request, response, graphqlNetwork)
      return
    }

    if (rpcChainId && request.method === 'POST') {
      if (!hasJsonContentType(request)) {
        recordUnknown('rpc-content-type', String(request.headers['content-type']))
        sendJson(request, response, 415, rpcError(null, 'RPC fixture requires application/json'))
        return
      }
      const payload = await readJson(request)
      if (Array.isArray(payload) && payload.length === 0) {
        recordUnknown('rpc-batch', 'Empty JSON-RPC batch')
        sendJson(request, response, 400, rpcError(null, 'Empty JSON-RPC batch', -32_600))
        return
      }
      const result = Array.isArray(payload)
        ? await Promise.all(payload.map(item => handleRpcCall(item, rpcChainId)))
        : await handleRpcCall(payload, rpcChainId)
      sendJson(request, response, 200, result)
      return
    }

    const ipfsPath = IPFS_PATH.exec(request.url ?? '')?.[1]
    if (ipfsPath && request.method === 'GET') {
      await handleIpfs(request, response, ipfsPath)
      return
    }

    const dexscreenerPath = DEXSCREENER_PATH.exec(request.url ?? '')?.[1]
    if (dexscreenerPath && request.method === 'GET') {
      await handleDexscreener(request, response, dexscreenerPath)
      return
    }

    recordUnknown('http-route', `${request.method} ${request.url}`)
    sendJson(request, response, 503, {
      errors: [{ message: 'Deterministic browser fixture: service unavailable' }],
    })
  } catch (error) {
    recordUnknown(
      'request-error',
      error instanceof Error ? error.message : 'Invalid fixture request',
    )
    sendJson(request, response, 400, {
      errors: [
        {
          message:
            error instanceof Error ? error.message : 'Invalid fixture request',
        },
      ],
    })
  }
})

server.listen(port, '127.0.0.1')

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    saveFixture()
    server.close(() => process.exit(0))
  })
}
