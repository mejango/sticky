import { notFound } from 'next/navigation'
import { ProjectHeader } from '@/components/project/ProjectHeader'
import { ProjectLatest } from '@/components/project/ProjectLatest'
import { StickCard } from '@/components/project/StickCard'
import { ProjectTabs } from '@/components/project/Tabs'
import { decodeProjectRouteSegment } from '@/lib/project-route'
import { stickyDeployment } from '@/lib/sticky-addresses'
import { resolveProjectHandle } from '@/lib/sticky-handles'
import { parseUrn } from '@/lib/urn'
import { ProjectRouteSync, type ResolvedProjectRoute } from '@/providers/ProjectRouteContext'

/**
 * The project a route segment names: `base:23`, or `@handle` resolved through ENS and JBProjectHandles. Null when it
 * names none. A handle whose reads fail rejects: that is no answer, so it is never taken for a miss, and nothing here
 * keeps an answer between requests.
 */
async function projectRouteOf(segment: string): Promise<ResolvedProjectRoute | null> {
  const decoded = decodeProjectRouteSegment(segment)
  if (decoded === null) return null
  const urn = parseUrn(decoded)
  if (urn) return stickyDeployment(urn.chainId) ? { ...urn, handle: null } : null
  if (!decoded.startsWith('@')) return null
  const found = await resolveProjectHandle(decoded)
  return found && { chainId: found.chainId, projectId: found.projectId, handle: found.handle }
}

/** A Sticky project's page, at `/base:23` or `/@handle`: its header, the Stick card and Latest beside its tabs. */
export default async function ProjectPage({ params }: PageProps<'/[urn]'>) {
  const segment = (await params).urn
  let route: ResolvedProjectRoute | null
  try {
    route = await projectRouteOf(segment)
  } catch {
    // resolveProjectHandle has told the console why. Trying again reads the handle afresh.
    return (
      <section role="alert" className="card mx-auto mt-10 max-w-[560px] p-5 text-center">
        <p className="text-err">Could not read this handle.</p>
        <a href={`/${encodeURIComponent(decodeProjectRouteSegment(segment) ?? segment)}`} className="btn-link font-semibold">
          Try again
        </a>
      </section>
    )
  }
  if (!route) notFound()
  const { chainId, projectId } = route

  return (
    <div key={`${chainId}:${projectId}`} className="mx-auto w-full max-w-[1068px]">
      <ProjectRouteSync route={route} />
      <ProjectHeader chainId={chainId} projectId={projectId} />
      <ProjectTabs
        activityLabel="Latest"
        sidebar={<StickCard chainId={chainId} projectId={projectId} />}
        activity={<ProjectLatest chainId={chainId} projectId={projectId} />}
        tabs={[
          {
            label: 'Overview',
            content: null,
          },
          {
            label: 'Tokens',
            content: null,
          },
          {
            label: 'Airdrops',
            content: null,
          },
        ]}
      />
    </div>
  )
}
