import { notFound } from 'next/navigation'
import { AirdropsTab } from '@/components/project/AirdropsTab'
import { OverviewTab } from '@/components/project/OverviewTab'
import { ProjectHeader } from '@/components/project/ProjectHeader'
import { ProjectLatest } from '@/components/project/ProjectLatest'
import { StickCard } from '@/components/project/StickCard'
import { ProjectTabs } from '@/components/project/Tabs'
import { TokensTab } from '@/components/project/TokensTab'
import { decodeProjectRouteSegment } from '@/lib/project-route'
import { projectRouteSnapshot, resolveProjectRoute, type ResolvedProjectRoute } from '@/lib/project-route.server'
import { ProjectRouteBoundary } from '@/providers/ProjectRouteContext'

/** A Sticky project's page, at `/base:23` or `/@handle`: its header, the Stick card and Latest beside its tabs. */
export default async function ProjectPage({ params }: PageProps<'/[urn]'>) {
  const segment = (await params).urn
  let route: ResolvedProjectRoute | null
  try {
    route = await resolveProjectRoute(segment)
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
    <ProjectRouteBoundary snapshot={projectRouteSnapshot(route)}>
      <div className="mx-auto w-full max-w-[1068px]">
        <ProjectHeader chainId={chainId} projectId={projectId} />
        <ProjectTabs
          activityLabel="Latest"
          sidebar={<StickCard chainId={chainId} projectId={projectId} />}
          activity={<ProjectLatest chainId={chainId} projectId={projectId} />}
          tabs={[
            {
              label: 'Overview',
              content: <OverviewTab chainId={chainId} projectId={projectId} />,
            },
            {
              label: 'Tokens',
              content: <TokensTab chainId={chainId} projectId={projectId} />,
            },
            {
              label: 'Airdrops',
              content: <AirdropsTab chainId={chainId} projectId={projectId} />,
            },
          ]}
        />
      </div>
    </ProjectRouteBoundary>
  )
}
