// The live reads a recording run keeps (fail-fast-service.mjs --record): JB Center
// and Bendystraw through Sticky's staging site, whose origin Center admits, and
// Center's IPFS gateway and DexScreener as the browser would ask them.

const STAGING = process.env.STICKY_RECORD_ORIGIN ?? 'https://sticky-dev.up.railway.app'
const CENTER = process.env.STICKY_RECORD_CENTER ?? 'https://dev.juicebox.center'
const IPFS_GATEWAY = 'https://juicebox.center/ipfs/'
const DEXSCREENER = 'https://api.dexscreener.com/'

export const SOURCE = {
  center: CENTER,
  origin: STAGING,
  relay: `${STAGING}/api/bendystraw`,
  ipfs: IPFS_GATEWAY,
  dexscreener: DEXSCREENER,
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Center allows 600 requests a minute across all chains. A recording run keeps
// well under that, so a page never sees a 429 the replay would not give it.
const MIN_GAP_MS = 125
let nextSlot = 0
async function slot() {
  const now = Date.now()
  const at = Math.max(now, nextSlot)
  nextSlot = at + MIN_GAP_MS
  if (at > now) await sleep(at - now)
}

let rpcId = 0
/** One JSON-RPC answer from Center, `{ result }` or `{ error }`. A rate limit, a
 * node behind the pinned head (-32001) and a lost connection are waited out. */
export async function center(chainId, method, params) {
  for (let attempt = 0; ; attempt += 1) {
    await slot()
    let response
    try {
      response = await fetch(`${CENTER}/v1/rpc/${chainId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: STAGING },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (error) {
      if (attempt >= 4) throw error
      await sleep(1_000 * (attempt + 1))
      continue
    }
    if (response.status === 429 && attempt < 8) {
      await sleep(Math.max(Number(response.headers.get('retry-after')) || 5, 1) * 1_000)
      continue
    }
    if (!response.ok) throw new Error(`Center answered ${response.status} to ${method} on ${chainId}`)
    const body = await response.json()
    if (body.error?.code === -32001 && attempt < 8) {
      await sleep(500)
      continue
    }
    return 'error' in body ? { error: body.error } : { result: body.result }
  }
}

/** A registered document's answer through the staging site's relay: `{ data }`,
 * or `{ errors }` for the relay's 502 (Bendystraw could not answer, as it cannot
 * for a table it does not have). Anything else is a recording problem. */
export async function relay(network, operation, variables) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${STAGING}/api/bendystraw/${network}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: STAGING },
      body: JSON.stringify({ operation, variables }),
      signal: AbortSignal.timeout(30_000),
    })
    const body = await response.json().catch(() => null)
    if (response.ok && body && 'data' in body) return { data: body.data }
    if (response.status === 502 && attempt < 2) {
      await sleep(2_000)
      continue
    }
    if (response.status === 502) {
      console.warn(`[record] ${network} ${operation.slice(0, 12)}: the relay answered 502 three times; kept as a failure`)
      return { errors: [{ message: 'Bendystraw unavailable (recorded through the Sticky relay)' }] }
    }
    console.error(`[record] ${network} ${operation.slice(0, 12)}: the relay answered ${response.status}`, body)
    return null
  }
}

/** A document, or `{ image: true }` for an image, whose pixels are not kept. */
export async function ipfs(path) {
  const response = await fetch(IPFS_GATEWAY + path, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) {
    console.error(`[record] ipfs ${path}: the gateway answered ${response.status}`)
    return null
  }
  if (/^image\//i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel()
    return { image: true }
  }
  return { document: await response.json() }
}

export async function dexscreener(path) {
  const response = await fetch(DEXSCREENER + path, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) {
    console.error(`[record] dexscreener ${path}: answered ${response.status}`)
    return null
  }
  return { pairs: await response.json() }
}
