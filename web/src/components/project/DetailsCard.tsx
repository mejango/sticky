'use client'

import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import { Revalidating } from '@/components/ui/Revalidating'
import { Skeleton } from '@/components/ui/Skeleton'
import { useStickyEvents, useStickyProject } from '@/hooks/useStickyProject'
import { stickyDeployment } from '@/lib/sticky-addresses'
import type { StickyEvent } from '@/lib/sticky-events'
import { formatAmount } from '@/lib/sticky-format'

const pct = (basisPoints: bigint) => `${Number(basisPoints) / 100}%`

/** How long a copy button says what became of the copy. */
const COPY_NOTICE_MS = 1_500

const COPY_REFUSED = 'Could not copy an address to the clipboard.'

/** How many holders the hook lists as granters: a launch's trusted senders, who can stick for any holder. The
 * auto-stick adapter is its own pre-approval, so it is not one. */
function trustedSenders(events: readonly StickyEvent[], adapter: Address | undefined): number {
  const granters = new Set(events.filter(event => event.kind === 'granter').map(event => event.holder.toLowerCase()))
  if (adapter) granters.delete(adapter.toLowerCase())
  return granters.size
}

/** A label's style: beside its value, or above it on a phone. */
const LABEL =
  'whitespace-nowrap border-b border-line py-2 pr-4 text-muted max-[560px]:border-b-0 max-[560px]:pb-0 max-[560px]:text-xs'

/** One label and its value. The value never wraps mid-word, so a long one is cut, and its tooltip says all of it. */
function Row({ label, text, title = text }: { label: string; text: string; title?: string }) {
  return (
    <>
      <dt className={LABEL}>{label}</dt>
      <dd
        title={title}
        className="m-0 overflow-hidden text-ellipsis whitespace-nowrap border-b border-line py-2 text-right max-[560px]:pt-0.5 max-[560px]:text-left"
      >
        {text}
      </dd>
    </>
  )
}

/** A copy button for an address: it says "Copied!" for a moment, or "Could not copy" when the browser refuses. */
function CopyAddress({ label, address }: { label: string; address: string }) {
  const [notice, setNotice] = useState<'copied' | 'refused' | null>(null)
  useEffect(() => {
    if (notice === null) return
    const timer = setTimeout(() => setNotice(null), COPY_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address)
      setNotice('copied')
    } catch (error) {
      console.warn(COPY_REFUSED, error)
      setNotice('refused')
    }
  }

  return (
    <button
      type="button"
      aria-label={`Copy ${label} address`}
      onClick={() => void copy()}
      className={`btn-link ml-2 min-h-0 align-baseline text-xs font-medium decoration-amber ${notice === 'refused' ? 'text-err' : ''}`}
    >
      {notice === 'copied' ? 'Copied!' : notice === 'refused' ? 'Could not copy' : 'Copy'}
    </button>
  )
}

/** A contract's name and its full address, which may break anywhere, with its copy button. */
function Contract({ label, address }: { label: string; address: string }) {
  return (
    <>
      <dt className={LABEL}>{label}</dt>
      <dd className="m-0 whitespace-normal border-b border-line py-2 text-left max-[560px]:pt-0.5">
        <span className="break-all font-mono text-xs leading-[1.4]">{address}</span>
        <CopyAddress label={label} address={address} />
      </dd>
    </>
  )
}

/** The disclosure's title, with its own marker: closed points right, and open points down. */
const SUMMARY =
  "w-max max-w-full list-none text-accent before:inline-block before:w-[1.1em] before:content-['▸'] group-open:before:content-['▾'] [&::-webkit-details-marker]:hidden"

const LIST =
  'm-0 grid grid-cols-[max-content_minmax(0,1fr)] text-sm max-[560px]:grid-cols-[minmax(0,1fr)] [&>dd:last-of-type]:border-b-0 [&>dt:last-of-type]:border-b-0'

/**
 * The Details card: one short label and value per row, then the rules and contracts behind a disclosure. The backing
 * is in the staked token and the supply in Sticky shares, which always have 18 decimals. What the browser kept from an
 * earlier visit shows at once, and reads as unconfirmed until this visit reads the project again.
 */
export function DetailsCard({ chainId, projectId }: { chainId: number; projectId: number }) {
  const { info, verified, failed, retry } = useStickyProject(chainId, projectId)
  const events = useStickyEvents(chainId, projectId)
  const deployment = stickyDeployment(chainId)
  const trusted = events.data ? trustedSenders(events.data.events, deployment?.autoStick) : undefined

  return (
    <section aria-labelledby="details-title" className="card mb-5 p-5">
      <h2 id="details-title" className="mb-3.5 font-agrandir-wide text-base leading-tight">
        Details
      </h2>
      {info === undefined ? (
        failed ? (
          <p role="alert" className="text-err">
            Could not read the details.{' '}
            <button type="button" className="btn-link font-semibold" onClick={retry}>
              Try again
            </button>
          </p>
        ) : (
          <div className="space-y-3.5" aria-hidden="true">
            {[0, 1, 2, 3, 4, 5].map(row => (
              <Skeleton key={row} className="h-3.5 w-full rounded" />
            ))}
          </div>
        )
      ) : (
        <Revalidating as="div" pending={!verified}>
          <dl className={LIST}>
            <Row label="Token" text={`${info.stName} (${info.stSymbol})`} />
            <Row label="Sticks" text={`${info.name} (${info.symbol})`} />
            <Row label="Supply" text={`${formatAmount(info.totalSupply, 18)} ${info.stSymbol}`} />
            <Row label="Backing" text={`${formatAmount(info.backing, info.decimals)} ${info.symbol}`} />
            {info.totalSupply > 0n ? (
              <Row
                label="Backing per token"
                text={`${formatAmount((info.backing * 10n ** 18n) / info.totalSupply, info.decimals)} ${info.symbol}`}
              />
            ) : null}
            {info.orphaned > 0n ? (
              <Row
                label="Unowned backing"
                text={`${formatAmount(info.orphaned, info.decimals)} ${info.symbol}`}
                title="Left when nobody was stuck. No one can claim it."
              />
            ) : null}
            <Row label="Stickiness bonus" text={pct(info.cashOutTaxRate)} />
            <Row label="Transfers" text={info.soulbound ? 'Off' : 'On'} />
          </dl>
          <details className="group mt-2.5 text-[13px]">
            <summary className={SUMMARY}>Rules and contracts</summary>
            <ul className="mb-3.5 mt-3 list-disc pl-[18px] text-sm text-ink">
              <li className="my-1">
                {info.cashOutTaxRate > 0n
                  ? `Unsticking leaves up to ${pct(info.cashOutTaxRate)} behind for holders who stay.`
                  : 'Unsticking returns your share of the backing.'}
              </li>
              <li className="my-1">
                {info.soulbound
                  ? "Sticky tokens can't be transferred."
                  : 'Transferred tokens start a new stick for the recipient.'}
              </li>
              {trusted !== undefined ? (
                <li className="my-1">
                  {trusted > 0
                    ? `${trusted} trusted sender${trusted === 1 ? ' can' : 's can'} stick for any holder.`
                    : 'Holders choose who can stick for them.'}
                </li>
              ) : events.isPending ? (
                <li className="my-1 list-none" aria-hidden="true">
                  <Skeleton className="h-3.5 w-3/4 rounded" />
                </li>
              ) : null}
            </ul>
            <dl className={LIST}>
              <Contract label={`${info.stSymbol} token`} address={info.stToken} />
              <Contract label={`${info.symbol} token`} address={info.stakedToken} />
              {deployment ? <Contract label="Stick accounting" address={deployment.hook} /> : null}
            </dl>
          </details>
        </Revalidating>
      )}
    </section>
  )
}
