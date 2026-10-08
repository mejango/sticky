'use client'

import type { BendystrawNetwork } from '@bananapus/nana-sdk-core'
import { useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { HomeHero } from '@/components/home/HomeHero'
import { SecuredChart } from '@/components/home/SecuredChart'
import { StickiestCard } from '@/components/home/StickiestCard'
import { FeedPlaceholder, StickyFeed } from '@/components/StickyFeed'
import { Revalidating } from '@/components/ui/Revalidating'
import { useStickyHome, type StickyHome } from '@/hooks/useStickyHome'
import { useWallet } from '@/hooks/useWallet'
import type { FeedRow } from '@/lib/sticky-feed'
import { stickyLabel } from '@/lib/sticky-format'
import { chainName } from '@/lib/urn'
import { useViewAs } from '@/lib/viewAs'
import { openStickyLaunch } from '@/lib/sticky-launch-events'

type List = 'latest' | 'stickiest' | 'airdrops'
type Ranking = Exclude<List, 'latest'>

const LISTS: readonly List[] = ['latest', 'stickiest', 'airdrops']
const RANKINGS: readonly Ranking[] = ['stickiest', 'airdrops']
const TITLES: Record<List, string> = { latest: 'Latest', stickiest: 'Stickiest', airdrops: 'Airdrops' }

const STEPS = [
  ['Stick', 'Lock a token and get Sticky shares of its backing.'],
  ['Earn', 'Share the rewards funders send, by balance or weeks stuck.'],
  ['Unstick', 'Take your share of the backing and leave the bonus to those who stay.'],
] as const

type View = { state: 'loading' | 'empty' | 'error' | 'ready'; note: string; retry: boolean }

/** Tailwind's `sm` and `xl`: from `sm` Latest stands on its own and the rankings share tabs; from `xl` every list
 * shows. The classes lay the lists out; this names them for assistive technology, which CSS cannot. */
const TABLET = '(min-width: 40rem)'
const DESKTOP = '(min-width: 80rem)'
type Tier = 'phone' | 'tablet' | 'desktop'

function onTierChange(change: () => void) {
  const queries = [TABLET, DESKTOP].map(query => window.matchMedia(query))
  for (const query of queries) query.addEventListener('change', change)
  return () => {
    for (const query of queries) query.removeEventListener('change', change)
  }
}
const tierNow = (): Tier =>
  window.matchMedia(DESKTOP).matches ? 'desktop' : window.matchMedia(TABLET).matches ? 'tablet' : 'phone'
/** The server names the lists as a desktop does, with no tabs; the browser names them for its own width. */
const tierOnServer = (): Tier => 'desktop'

/** A list's tab panel role and its one label, when a tab shows it at `tier`: a phone's list tab, a tablet's ranking
 * tab. A list that no tab shows is no tab panel. */
function tabbed(tier: Tier, name: List) {
  if (tier === 'phone') return { role: 'tabpanel', 'aria-labelledby': `home-tab-${name}` }
  if (tier === 'tablet' && name !== 'latest') return { role: 'tabpanel', 'aria-labelledby': `home-rank-${name}` }
  return {}
}

/**
 * What the home shows. It loads until a chain has a card or every chain has answered. With no card it is empty when
 * every chain answered, and an error when one failed. With cards it is ready, and its note names the chains that
 * failed. A network Sticky is not deployed on is an error that no retry mends.
 */
function viewOf({ chains, cards, failedChains, pending }: StickyHome, testnet: boolean): View {
  if (!chains.length) {
    return { state: 'error', note: testnet ? 'Sticky is not on testnets yet.' : 'Sticky is not deployed yet.', retry: false }
  }
  const failed = failedChains.length ? `Could not read Sticky tokens on ${failedChains.map(chainName).join(', ')}.` : ''
  if (cards.length) return { state: 'ready', note: failed, retry: failedChains.length > 0 }
  if (pending) return { state: 'loading', note: '', retry: false }
  if (failedChains.length) {
    const all = failedChains.length === chains.length
    return { state: 'error', note: all ? 'Could not read Sticky tokens.' : failed, retry: true }
  }
  return { state: 'empty', note: testnet ? 'No sticky tokens on testnets yet.' : 'No sticky tokens yet.', retry: false }
}

/** A row of tabs. The selected tab is the one in the page's tab order; the arrow keys, Home and End move between
 * them. */
function Tabs<T extends List>({
  label,
  idPrefix,
  names,
  active,
  onSelect,
  className,
  tabClassName,
}: {
  label: string
  idPrefix: string
  names: readonly T[]
  active: T
  onSelect: (name: T) => void
  className: string
  tabClassName: (selected: boolean) => string
}) {
  const buttons = useRef(new Map<T, HTMLButtonElement>())
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = names.length - 1
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? last
          : event.key === 'ArrowRight'
            ? (index + 1) % names.length
            : event.key === 'ArrowLeft'
              ? (index + last) % names.length
              : null
    if (next === null) return
    event.preventDefault()
    onSelect(names[next])
    buttons.current.get(names[next])?.focus()
  }
  return (
    <div role="tablist" aria-label={label} className={className}>
      {names.map((name, index) => (
        <button
          key={name}
          ref={button => {
            if (button) buttons.current.set(name, button)
            else buttons.current.delete(name)
          }}
          id={`${idPrefix}-${name}`}
          type="button"
          role="tab"
          aria-selected={name === active}
          aria-controls={`home-panel-${name}`}
          tabIndex={name === active ? 0 : -1}
          onClick={() => onSelect(name)}
          onKeyDown={event => move(event, index)}
          className={tabClassName(name === active)}
        >
          {TITLES[name]}
        </button>
      ))}
    </div>
  )
}

// A tab is never narrower than its label, and the row scrolls sideways before labels could run together, as
// juicebox.money's feed tabs do. Below 360 px the labels step down so that a 320 px phone fits all three.
const phoneTab = (selected: boolean) =>
  `min-h-11 flex-1 shrink-0 whitespace-nowrap border-b-2 px-0.5 font-agrandir-wide text-xl max-[359px]:text-[17px] ${
    selected ? 'border-accent text-accent' : 'border-transparent text-muted'
  }`
const rankingTab = (selected: boolean) =>
  `whitespace-nowrap border-b-2 px-0.5 pb-2 pt-1.5 font-agrandir-wide text-[13px] tracking-[1.5px] ${
    selected ? 'border-amber text-ink' : 'border-transparent text-muted'
  }`
const heading = 'mb-2 mt-1 font-agrandir-wide text-xl'

/**
 * The home: "Secured by Sticky", the Latest, Stickiest and Airdrops lists and the hero, laid out like juicebox.money's
 * home. Desktops show all three lists; tablets keep Latest and put Stickiest and Airdrops under tabs; phones put all
 * three under tabs. Each part draws its own placeholder while it loads, and what a return visit restored reads as
 * unconfirmed until the chains answer again. Without a card to show, the dashboard gives way to the hero and its note,
 * and to the three steps when there are no Sticky tokens yet.
 */
export function HomeLists({ network }: { network: BendystrawNetwork }) {
  const home = useStickyHome(network)
  const { viewAs } = useViewAs()
  const { address } = useWallet()
  const tier = useSyncExternalStore(onTierChange, tierNow, tierOnServer)
  const [list, setList] = useState<List>('latest')
  const [ranking, setRanking] = useState<Ranking>('stickiest')
  const { state, note, retry } = viewOf(home, network === 'testnet')
  const dashboard = state === 'loading' || state === 'ready'
  const loading = state === 'loading'
  const create = () => openStickyLaunch(network === 'testnet' ? 'testnet' : 'production')

  const labels = new Map(
    home.cards.flatMap(group => group.cards.map(({ info }) => [`${info.chainId}:${info.projectId}`, stickyLabel(info)])),
  )
  const labelOf = (row: FeedRow) => labels.get(`${row.chainId}:${row.projectId}`)
  const shownOnPhone = (name: List) => (list === name ? 'block' : 'hidden')
  const shownOnTablet = (name: Ranking) => (ranking === name ? 'sm:block' : 'sm:hidden')

  return (
    <div data-state={state} aria-busy={loading} className="w-full">
      {dashboard ? <div className="mb-4 flex justify-end"><button type="button" className="btn-primary px-4 py-2" onClick={create}>Make your token sticky</button></div> : null}
      <div
        className={
          dashboard
            ? 'grid items-start gap-5 sm:grid-cols-2 sm:grid-rows-[auto_auto_auto_1fr] md:grid-cols-3 md:grid-rows-[auto_auto_1fr] xl:grid-cols-[repeat(3,minmax(0,1fr))_minmax(0,1.5fr)] xl:grid-rows-[auto_1fr]'
            : 'block'
        }
      >
        {dashboard ? (
          <>
            <div className="order-2 min-w-0 border-b border-line pb-[22px] sm:col-span-2 sm:row-start-2 sm:pt-2 md:col-start-1 md:row-start-1 xl:row-start-1">
              <SecuredChart series={home.secured} pending={home.revalidating} />
            </div>
            <Tabs
              label="Homepage lists"
              idPrefix="home-tab"
              names={LISTS}
              active={list}
              onSelect={setList}
              className="order-3 my-1 flex w-full overflow-x-auto border-b border-line sm:hidden"
              tabClassName={phoneTab}
            />
            <Tabs
              label="Sticky rankings"
              idPrefix="home-rank"
              names={RANKINGS}
              active={ranking}
              onSelect={setRanking}
              className="hidden gap-[18px] border-b border-l border-line pl-5 sm:col-start-2 sm:row-start-3 sm:flex md:row-start-2 xl:hidden"
              tabClassName={rankingTab}
            />
            <div
              id="home-panel-latest"
              {...tabbed(tier, 'latest')}
              className={`${shownOnPhone('latest')} order-4 min-w-0 sm:col-start-1 sm:row-span-2 sm:row-start-3 sm:block md:row-start-2 xl:row-span-1 xl:row-start-2`}
            >
              <h2 className={`${heading} hidden sm:block`}>Latest</h2>
              <Revalidating as="div" pending={home.revalidating}>
                <StickyFeed rows={loading ? undefined : home.activity} empty="No activity yet" label={labelOf} />
              </Revalidating>
            </div>
            <div
              id="home-panel-stickiest"
              {...tabbed(tier, 'stickiest')}
              className={`${shownOnPhone('stickiest')} ${shownOnTablet('stickiest')} order-4 min-w-0 sm:col-start-2 sm:row-start-4 sm:border-l sm:border-line sm:pl-5 md:row-start-3 xl:col-start-2 xl:row-start-2 xl:block`}
            >
              <h2 className={`${heading} hidden xl:block`}>Stickiest</h2>
              <Revalidating as="div" pending={home.revalidating}>
                {loading ? (
                  <FeedPlaceholder />
                ) : (
                  home.cards.map((group, at) => (
                    <StickiestCard
                      key={`${group.cards[0].info.chainId}:${group.cards[0].info.projectId}`}
                      group={group}
                      rank={at + 1}
                    />
                  ))
                )}
              </Revalidating>
            </div>
            <div
              id="home-panel-airdrops"
              {...tabbed(tier, 'airdrops')}
              className={`${shownOnPhone('airdrops')} ${shownOnTablet('airdrops')} order-4 min-w-0 sm:col-start-2 sm:row-start-4 sm:border-l sm:border-line sm:pl-5 md:row-start-3 xl:col-start-3 xl:row-span-2 xl:row-start-1 xl:block`}
            >
              <h2 className={`${heading} hidden xl:block`}>Airdrops</h2>
              <Revalidating as="div" pending={home.revalidating}>
                <StickyFeed
                  rows={loading ? undefined : home.airdrops}
                  empty="No airdrops yet"
                  label={labelOf}
                  you={viewAs ?? address ?? null}
                />
              </Revalidating>
            </div>
          </>
        ) : null}
        <div
          className={
            dashboard
              ? 'order-1 min-w-0 sm:col-span-2 sm:row-start-1 md:col-span-1 md:col-start-3 md:row-span-3 md:row-start-1 md:border-l md:border-line md:pl-5 xl:col-start-4 xl:row-span-2'
              : 'mx-auto max-w-[560px]'
          }
        >
          <HomeHero note={note} error={state === 'error'} onRetry={retry ? home.retry : undefined} onCreate={create} />
        </div>
      </div>
      {state === 'empty' ? (
        <ol
          aria-label="How Sticky works"
          className="mx-auto mt-3 grid max-w-[900px] list-none grid-cols-1 gap-4 p-0 sm:grid-cols-3 sm:gap-5"
        >
          {STEPS.map(([title, text]) => (
            <li key={title} className="flex flex-col gap-1 text-center text-[15px] leading-[1.45]">
              <b className="font-agrandir-wide text-[17px] leading-tight text-accent">{title}</b>
              <span>{text}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}
