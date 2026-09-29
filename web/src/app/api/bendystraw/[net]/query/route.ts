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
    const data = await bendystraw(
      persisted.query,
      persisted.variables,
      { network: net, policy: 'live' },
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
  } catch {
    return Response.json(
      { error: 'Bendystraw unavailable' },
      { status: 502 },
    )
  }
}
