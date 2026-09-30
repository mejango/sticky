import type { HTMLAttributes } from 'react'

export function Skeleton({
  as: Component = 'div',
  className = '',
  ...props
}: HTMLAttributes<HTMLElement> & { as?: 'div' | 'span' }) {
  const ariaHidden = props['aria-hidden'] ?? (props.role ? undefined : true)

  return (
    <Component
      {...props}
      aria-hidden={ariaHidden}
      className={`skeleton-shimmer ${className}`}
    />
  )
}

export function SkeletonLines({
  lines = 3,
  className = '',
}: {
  lines?: number
  className?: string
}) {
  const widths = ['w-full', 'w-5/6', 'w-2/3', 'w-3/4']

  return (
    <div className={`space-y-2 ${className}`} aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          className={`h-3 rounded ${widths[index % widths.length]}`}
        />
      ))}
    </div>
  )
}

export function SkeletonTable({
  rows = 4,
  columns = 4,
  className = '',
}: {
  rows?: number
  columns?: number
  className?: string
}) {
  return (
    <div className={`space-y-4 ${className}`} aria-hidden="true">
      {Array.from({ length: rows }, (_, row) => (
        <div
          key={row}
          className="grid items-center gap-3"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: columns }, (_, column) => (
            <Skeleton
              key={column}
              className={`h-3 rounded ${column === 0 ? 'w-3/4' : 'w-2/3'}`}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
