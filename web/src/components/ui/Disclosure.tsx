import type { ReactNode } from 'react'

/** The disclosure's title, with its own marker: closed points right, and open points down. */
const SUMMARY =
  "w-max max-w-full list-none text-accent before:inline-block before:w-[1.1em] before:content-['▸'] group-open:before:content-['▾'] [&::-webkit-details-marker]:hidden"

/** What a card keeps behind its title until it is opened: a `<details>` whose summary is the title. */
export function Disclosure({ summary, className = '', children }: { summary: ReactNode; className?: string; children: ReactNode }) {
  return (
    <details className={`group ${className}`}>
      <summary className={SUMMARY}>{summary}</summary>
      {children}
    </details>
  )
}
