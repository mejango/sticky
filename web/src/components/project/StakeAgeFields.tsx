'use client'

import { useId } from 'react'
import { asSentence } from '@/lib/sticky-format'
import { groupNote } from '@/lib/sticky-rewards'

/** A form field's label and input, as the airdrop forms draw them. */
export const FIELD_LABEL = 'mb-[3px] block text-xs font-semibold uppercase tracking-[1px] text-muted'
export const FIELD_INPUT =
  'min-h-[36px] w-full rounded-[4px] border border-line bg-[#fdffff] px-2 py-1.5 text-ink focus:border-amber focus:outline-none'

/**
 * The two stake-age fields that name a reward group (`groupIdFromWeeks`), and the line under them that says who the group
 * rewards, or why the weeks name no group. A blank or zero minimum is everyone, and a blank maximum is no upper bound.
 */
export function StakeAgeFields({
  minWeeks,
  maxWeeks,
  onMinWeeks,
  onMaxWeeks,
}: {
  minWeeks: string
  maxWeeks: string
  onMinWeeks: (value: string) => void
  onMaxWeeks: (value: string) => void
}) {
  const minId = useId()
  const maxId = useId()
  return (
    <>
      <div className="grid gap-3 min-[480px]:grid-cols-2">
        <div className="min-w-0">
          <label htmlFor={minId} className={FIELD_LABEL}>
            Minimum stake age (weeks)
          </label>
          <input
            id={minId}
            value={minWeeks}
            onChange={event => onMinWeeks(event.target.value)}
            placeholder="0 for everyone"
            inputMode="numeric"
            autoComplete="off"
            maxLength={10}
            className={FIELD_INPUT}
          />
        </div>
        <div className="min-w-0">
          <label htmlFor={maxId} className={FIELD_LABEL}>
            Maximum stake age (weeks)
          </label>
          <input
            id={maxId}
            value={maxWeeks}
            onChange={event => onMaxWeeks(event.target.value)}
            placeholder="no limit"
            inputMode="numeric"
            autoComplete="off"
            maxLength={10}
            className={FIELD_INPUT}
          />
        </div>
      </div>
      <p data-group-note className="text-[13px] text-muted">
        {asSentence(groupNote(minWeeks, maxWeeks).text)}
      </p>
    </>
  )
}
