export const dynamic = 'force-dynamic'

export function GET() {
  return Response.json(
    { ok: true, revision: process.env.NEXT_PUBLIC_VERSION?.trim() || 'unknown' },
    { headers: { 'cache-control': 'no-store' } },
  )
}
