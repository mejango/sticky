import type { ReactNode } from 'react'
import { Revalidating } from '@/components/ui/Revalidating'
import type { StickyProjectInfo } from '@/lib/sticky-project'

/** The protocol fee on what an unstick takes out: 2.5%. */
const PROTOCOL_FEE = 0.025
/** How many Sticky shares the illustration unsticks. */
const SHARES = 100
const BAR_WIDTH = 460
const BAR_HEIGHT = 26
/** A share backed by no more than this reads as backed by one, and the sentence saying more is left out. */
const BACKED_BY_ONE = 1.0005

/** An amount of the split: thousands grouped and rounded, and below a thousand to a tenth without a trailing zero. */
const quantity = (value: number) =>
  value >= 1000 ? Math.round(value).toLocaleString('en-US') : String(parseFloat(value.toFixed(1)))

/**
 * The stickiness bonus card: what an unstick leaves behind for the holders who stay, and where the value of 100 Sticky
 * shares goes when one holder unsticks them: to the unstickers less the protocol fee, to the holders who stay, and to
 * the protocol. The split is in the staked token, at what one share is backed by today. A project with no bonus has no
 * card. `pending` marks a project the browser kept from an earlier visit, which this visit has not read yet.
 */
export function BonusSplit({ info, pending }: { info: StickyProjectInfo; pending: boolean }) {
  const { cashOutTaxRate, backing, totalSupply, decimals, symbol, stSymbol } = info
  if (cashOutTaxRate <= 0n) return null

  const bonus = Number(cashOutTaxRate) / 10_000
  // What one share is backed by, in the staked token: with no shares, one.
  const backedBy = totalSupply > 0n ? Number((backing * 10n ** 18n) / totalSupply) / 10 ** decimals : 1
  const value = SHARES * (backedBy || 1)
  const stays = value * bonus
  const fee = (value - stays) * PROTOCOL_FEE
  const toUnstickers = value - stays - fee
  const leaver = (toUnstickers / value) * BAR_WIDTH
  const remaining = (stays / value) * BAR_WIDTH

  return (
    <section aria-labelledby="tokens-bonus-title" className="card p-5">
      <h2 id="tokens-bonus-title" className="mb-3.5 font-agrandir-wide text-base leading-tight">
        Stickiness bonus
      </h2>
      <Revalidating as="div" pending={pending} className="[overflow-wrap:anywhere]">
        <p className="text-muted">
          Unsticks leave up to {Number(cashOutTaxRate) / 100}% behind for holders who stay.
          {backedBy > BACKED_BY_ONE
            ? ` 1 ${stSymbol} is currently backed by ${parseFloat(backedBy.toFixed(4))} ${symbol}.`
            : ''}
        </p>
        <p className="mb-1.5 mt-2.5 text-[13px] text-muted">
          Unsticking {SHARES} {stSymbol || 'sticky tokens'}, a small share of supply
        </p>
        <svg
          viewBox={`0 0 ${BAR_WIDTH} ${BAR_HEIGHT}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          className="w-full max-w-[460px] rounded-[4px]"
        >
          <rect x="0" y="0" width={leaver} height={BAR_HEIGHT} className="fill-amber" />
          <rect x={leaver} y="0" width={remaining} height={BAR_HEIGHT} className="fill-accent" />
          <rect
            x={leaver + remaining}
            y="0"
            width={BAR_WIDTH - leaver - remaining}
            height={BAR_HEIGHT}
            className="fill-[#e2d7bd]"
          />
        </svg>
        <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5 text-[13px] text-muted">
          <Key color="bg-amber">
            {quantity(toUnstickers)} {symbol} to the unstickers
          </Key>
          <Key color="bg-accent">{quantity(stays)} stays with stickers</Key>
          <Key color="bg-[#e2d7bd]">{quantity(fee)} protocol fee</Key>
        </ul>
      </Revalidating>
    </section>
  )
}

function Key({ color, children }: { color: string; children: ReactNode }) {
  return (
    <li>
      <i className={`mr-[5px] inline-block size-[9px] rounded-[2px] ${color}`} />
      {children}
    </li>
  )
}
