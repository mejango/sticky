import type { ReactNode } from 'react'

/** The disclosure's title, with its own marker: closed points right, and open points down. */
const SUMMARY =
  "w-max max-w-full list-none text-accent before:inline-block before:w-[1.1em] before:content-['▸'] group-open:before:content-['▾'] [&::-webkit-details-marker]:hidden"

/** What a card keeps behind its title until it is opened: a `<details>` whose summary is the title. `onToggle` hears
 * whether it is open, for content that reads only once it is. */
export function Disclosure({
  summary,
  className = '',
  onToggle,
  children,
}: {
  summary: ReactNode
  className?: string
  onToggle?: (open: boolean) => void
  children: ReactNode
}) {
  return (
    <details className={`group ${className}`} onToggle={onToggle ? event => onToggle(event.currentTarget.open) : undefined}>
      <summary className={SUMMARY}>{summary}</summary>
      {children}
    </details>
  )
}
