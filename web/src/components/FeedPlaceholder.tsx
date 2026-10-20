import { Skeleton } from '@/components/ui/Skeleton'

// Its own module, so a loading state can show it without loading the feed.
/** What a list shows while it is read: pairs of lines where rows will be. */
export function FeedPlaceholder() {
  return (
    <div className="space-y-5 py-3.5" aria-hidden="true">
      {[
        ['w-[62%]', 'w-[38%]'],
        ['w-[70%]', 'w-[30%]'],
        ['w-[54%]', 'w-[42%]'],
      ].map(([first, second]) => (
        <div key={first} className="space-y-2.5">
          <Skeleton className={`h-2.5 rounded ${first}`} />
          <Skeleton className={`h-2 rounded ${second}`} />
        </div>
      ))}
    </div>
  )
}
