import { normalizeProjectHandle } from '@/lib/project-handles'
import { decodeProjectRouteSegment } from '@/lib/project-route'
import { projectRouteSnapshot, resolveProjectRoute } from '@/lib/project-route.server'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const decoded = decodeProjectRouteSegment(url.searchParams.get('segment') ?? '')
  const requested = decoded?.startsWith('@') ? normalizeProjectHandle(decoded) : null
  const headers = { 'Cache-Control': 'no-store' }
  if (!requested) return Response.json({ error: 'Invalid project alias' }, { status: 400, headers })
  try {
    const route = await resolveProjectRoute(`@${requested.handle}`, url.searchParams.get('fresh') === '1')
    if (route) return Response.json(projectRouteSnapshot(route), { headers })
  } catch {
    // A failed proof is unavailable, not a missing project or a cacheable answer.
  }
  return Response.json({ error: 'Project link could not be verified.' }, { status: 503, headers })
}
