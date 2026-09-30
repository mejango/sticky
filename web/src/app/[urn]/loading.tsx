import { FeedPlaceholder } from '@/components/StickyFeed'
import { Skeleton } from '@/components/ui/Skeleton'

/** A project page's shape while its route is resolved: the header, the Stick card and Latest, and the tab row. */
export default function Loading() {
  return (
    <div role="status" aria-label="Loading project" className="mx-auto w-full max-w-[1068px]">
      <div className="flex items-center gap-4 max-[400px]:flex-col max-[400px]:items-start">
        <Skeleton className="size-[104px] shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1 space-y-2.5">
          <Skeleton className="h-4 w-[min(220px,50vw)] rounded" />
          <Skeleton className="h-3.5 w-[min(34rem,100%)] rounded" />
        </div>
      </div>
      <div className="mt-10 flex flex-col gap-8 min-[821px]:flex-row min-[821px]:gap-10">
        <div className="min-[821px]:w-[320px] min-[821px]:shrink-0 lg:w-[384px]">
          <div className="rounded-xl border-2 border-accent bg-card p-5">
            <Skeleton className="mb-3.5 h-5 w-[120px] rounded" />
            <Skeleton className="h-9 w-full rounded" />
            <Skeleton className="mt-3 h-10 w-full rounded-lg" />
          </div>
          <div className="hidden min-[821px]:block">
            <FeedPlaceholder />
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex gap-6 border-b border-line pb-3">
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} className="h-4 w-20 shrink-0 rounded" />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
