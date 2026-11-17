import { isRateLimited, retryAfterOf } from '@bananapus/nana-sdk-core/jbcenter'
import { bendystraw } from '@/lib/bendystraw'
import { resolvePersistedBendystrawRequest } from '@/lib/bendystraw-proxy'

const MAX_REQUEST_BYTES = 32 * 1024

async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ net: string }> },
) {
  const { net } = await params
  if (net !== 'mainnet' && net !== 'testnet') {
    return Response.json({ error: 'unsupported network' }, { status: 404 })
  }
  if (
    !request.headers.get('content-type')?.toLowerCase().startsWith(
      'application/json',
    )
  ) {
    return Response.json(
      { error: 'content type must be application/json' },
      { status: 415 },
    )
  }
  const declaredSize = Number(request.headers.get('content-length') ?? 0)
  if (declaredSize > MAX_REQUEST_BYTES) {
    return Response.json({ error: 'request is too large' }, { status: 413 })
  }

  const bytes = await readBoundedBody(request.body)
  if (!bytes) {
    return Response.json({ error: 'request is too large' }, { status: 413 })
  }

  let persisted
  try {
    persisted = resolvePersistedBendystrawRequest(
      JSON.parse(new TextDecoder().decode(bytes)),
    )
  } catch {
    persisted = null
  }
  if (!persisted) {
    return Response.json(
      { error: 'unknown or invalid operation' },
      { status: 400 },
    )
  }

  try {
    // Uncached: Next's fetch cache would keep a disk file for every distinct
    // client query. Asked once: the browser's request retries, so a retry here
    // would multiply with it.
    const data = await bendystraw(
      persisted.query,
      persisted.variables,
      { network: net, policy: 'no-store', once: true },
    )
    return Response.json(
      { data },
      {
        headers: {
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      },
    )
  } catch (error) {
    // The cause is logged, on one line, and never sent: the answer is the same
    // whatever failed, except a refusal for the rate. Control characters go
    // too, so an indexer's text cannot start a terminal sequence or forge a
    // log line.
    console.error(
      'Bendystraw relay failed:',
      String(error).replace(/[\p{Cc}\s]+/gu, ' '),
    )
    // A rate refusal is told apart, with the wait the indexer asked for: the
    // browser's request asks once more, no sooner than that, and its query
    // does not ask again.
    if (isRateLimited(error)) {
      const seconds = retryAfterOf(error)
      return Response.json(
        { error: 'Bendystraw rate limited' },
        {
          status: 429,
          headers: seconds === undefined ? {} : { 'retry-after': String(seconds) },
        },
      )
    }
    return Response.json(
      { error: 'Bendystraw unavailable' },
      { status: 502 },
    )
  }
}
