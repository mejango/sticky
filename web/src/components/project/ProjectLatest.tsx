'use client'

import { ProjectTabIcon } from '@/components/project/ProjectTabIcon'
import { StickyFeed } from '@/components/StickyFeed'
import { Revalidating } from '@/components/ui/Revalidating'
import { useProjectLatest } from '@/hooks/useStickyProject'
import { useWallet } from '@/hooks/useWallet'
import { useViewAs } from '@/lib/viewAs'

/**
 * A project's Latest list: its newest sticks, unsticks and streaks, in the staked token. It sits under the Stick card
 * beside the tabs, and is a tab of its own on a phone, where the tab names it. What the browser kept from an earlier
 * visit shows at once, and reads as unconfirmed until this visit reads it again.
 */
export function ProjectLatest({ chainId, projectId }: { chainId: number; projectId: number }) {
  const latest = useProjectLatest(chainId, projectId)
  const { viewAs } = useViewAs()
  const { address } = useWallet()
  const failed = latest.isError && latest.data === undefined

  return (
    <section className="min-[821px]:mt-5">
      <h2 className="my-1 hidden items-center gap-2 font-agrandir-wide text-sm leading-tight min-[821px]:flex">
        <ProjectTabIcon label="Activity" />
        Latest
      </h2>
      {failed ? (
        <p role="alert" className="py-3.5 text-sm text-err">
          Could not read Latest.{' '}
          <button type="button" className="btn-link font-semibold" onClick={() => void latest.refetch()}>
            Try again
          </button>
        </p>
      ) : (
        <Revalidating
          as="div"
          pending={latest.isFetching && latest.data !== undefined}
          className="min-[821px]:max-h-[max(780px,82vh)] min-[821px]:overflow-y-auto min-[821px]:pr-1"
        >
          <StickyFeed rows={latest.data} empty="No activity yet" you={viewAs ?? address ?? null} />
        </Revalidating>
      )}
    </section>
  )
}
