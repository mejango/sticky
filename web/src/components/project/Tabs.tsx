'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'

import {
  ProjectOverflowIcon,
  ProjectTabIcon,
} from '@/components/project/ProjectTabIcon'
import { requestProjectTabNavigation } from '@/providers/ProjectRouteContext'
import { projectRouteSegmentFromPathname } from '@/lib/project-route'

export type TabDef = {
  /** Exact label shown on the tab button. */
  label: string
  /** Renders the tab's content. Tabs are lazy: first activation mounts it,
   *  after which it stays mounted (hidden) so reads don't re-fire. */
  content: ReactNode
}

const PROJECT_OVERFLOW_TABS = new Set(['extras', 'operator', 'owner'])

/** URL-hash slug for a tab label (website/ parity: tabSlug). */
export function tabSlug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Next patches the history instance and can treat a hash-only update as an
 * app-router restore while its private history marker is unavailable during
 * hydration. Use the browser's native prototype method: tabs are local UI
 * state, so changing their shareable hash must never reload the project route.
 */
export function replaceTabHash(hash: string): void {
  const history = window.history
  const nativeReplaceState = Object.getPrototypeOf(history)?.replaceState as
    | History['replaceState']
    | undefined

  if (nativeReplaceState) {
    nativeReplaceState.call(history, history.state, '', hash)
    return
  }

  // Minimal non-browser test doubles may not model History.prototype.
  history.replaceState(history.state, '', hash)
}

/** Keep local tab state and shareable hashes under the verified alias lease. */
export function replaceProjectTabHash(hash: string): void {
  const commit = () => {
    replaceTabHash(hash)
    window.dispatchEvent(new Event('hashchange'))
  }
  const segment = projectRouteSegmentFromPathname(window.location.pathname)
  if (segment?.startsWith('@')) requestProjectTabNavigation(commit)
  else commit()
}

/**
 * The shared tab machinery every variant renders (SubTabs here, AccountTabs
 * on the account view): the tablist row and the lazily-mounted panels. A
 * tab's content mounts on first activation and then stays mounted (hidden)
 * so its reads don't re-fire; each variant passes its own spacing classes.
 */
export function TabShell({
  tabs,
  active,
  onSelect,
  listClassName,
  buttonClassName,
  panelClassName,
  ariaLabel,
}: {
  tabs: TabDef[]
  active: number
  onSelect: (index: number) => void
  listClassName: string
  buttonClassName: string
  panelClassName: string
  ariaLabel?: string
}) {
  // Every index that has ever been active stays mounted. Adding during
  // render is safe: it's idempotent and only ever grows the set.
  const mounted = useRef(new Set<number>())
  mounted.current.add(active)

  return (
    <div>
      <div
        role="tablist"
        aria-label={ariaLabel}
        className={`touch-pan-x overflow-y-hidden overscroll-x-contain ${listClassName}`}
      >
        {tabs.map((tab, i) => (
          <button
            key={tab.label}
            type="button"
            role="tab"
            aria-selected={active === i}
            onClick={() => onSelect(i)}
            className={`${buttonClassName} ${
              active === i
                ? 'border-ink text-ink'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className={panelClassName}>
        {tabs.map((tab, i) =>
          mounted.current.has(i) ? (
            <div key={tab.label} hidden={active !== i}>
              {tab.content}
            </div>
          ) : null,
        )}
      </div>
    </div>
  )
}

/**
 * The project page's tab row + content area (website/ parity). Deep links
 * via the URL hash (#tab or #tab/subtab); lazy-mounts each tab on first
 * view and keeps it mounted after, like website/'s built{} cache.
 */
export function ProjectTabs({
  tabs,
  sidebar,
  activity,
  activityLabel = 'Activity',
}: {
  tabs: TabDef[]
  sidebar: ReactNode
  activity: ReactNode
  /** The label of the single-column tab that shows `activity`, which also names its hash. */
  activityLabel?: string
}) {
  const firstSlug = tabSlug(tabs[0]?.label ?? '')
  const activitySlug = tabSlug(activityLabel)
  const [activeSlug, setActiveSlug] = useState(firstSlug)
  const [isSingleColumn, setIsSingleColumn] = useState(false)
  const [overflowExpanded, setOverflowExpanded] = useState(false)
  const subtabByParent = useRef<Record<string, string>>({})
  const mounted = useRef(new Set<string>())

  const normalActiveSlug = tabs.some(
    tab => tabSlug(tab.label) === activeSlug,
  )
    ? activeSlug
    : firstSlug
  const activityActive = isSingleColumn && activeSlug === activitySlug
  const visibleTabs = tabs.filter(
    tab => !PROJECT_OVERFLOW_TABS.has(tabSlug(tab.label)),
  )
  const overflowTabs = tabs.filter(tab =>
    PROJECT_OVERFLOW_TABS.has(tabSlug(tab.label)),
  )
  mounted.current.add(normalActiveSlug)

  // Resolve the initial tab from the URL hash, and follow hash changes
  // (back/forward navigation). Activity participates whenever the project
  // shell is single-column.
  useEffect(() => {
    const singleColumnQuery = window.matchMedia('(max-width: 820px)')
    const apply = () => {
      const [slug, child] = window.location.hash.replace('#', '').split('/')
      const singleColumn = singleColumnQuery.matches
      setIsSingleColumn(singleColumn)

      if (slug) {
        const normalized = tabSlug(slug)
        if (child) subtabByParent.current[normalized] = tabSlug(child)
        else delete subtabByParent.current[normalized]

        if (singleColumn && normalized === activitySlug) {
          setActiveSlug(activitySlug)
          return
        }
        const tab = tabs.find(t => tabSlug(t.label) === normalized)
        if (tab) {
          setActiveSlug(tabSlug(tab.label))
          return
        }
      }

      setActiveSlug(singleColumn ? activitySlug : firstSlug)
    }
    apply()
    window.addEventListener('hashchange', apply)
    singleColumnQuery.addEventListener('change', apply)
    return () => {
      window.removeEventListener('hashchange', apply)
      singleColumnQuery.removeEventListener('change', apply)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const activate = (nextSlug: string) => {
    const [currentParent, currentChild] = window.location.hash
      .replace('#', '')
      .split('/')
    if (currentParent && currentChild) {
      subtabByParent.current[tabSlug(currentParent)] = tabSlug(currentChild)
    }

    // Keep the hash shareable without adding history entries per click.
    const child = subtabByParent.current[nextSlug]
    replaceProjectTabHash(`#${nextSlug}${child ? `/${child}` : ''}`)
  }

  const buttonClasses = (selected: boolean) =>
    `inline-flex min-h-[44px] shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3.5 font-agrandir-wide text-sm font-medium transition-colors ${
      selected
        ? 'border-ink text-ink'
        : 'border-transparent text-muted hover:text-ink'
    }`

  return (
    <div className="mt-10 flex flex-col min-[821px]:flex-row min-[821px]:gap-10">
      <aside className="contents min-[821px]:order-1 min-[821px]:flex min-[821px]:w-[320px] min-[821px]:shrink-0 min-[821px]:flex-col lg:w-[384px]">
        <div className="order-1 min-[821px]:order-none">{sidebar}</div>
        <div
          className={`order-3 ${
            activityActive ? 'block' : 'hidden'
          } pt-6 min-[821px]:order-none min-[821px]:block min-[821px]:pt-0`}
        >
          {activity}
        </div>
      </aside>

      <div className="contents min-[821px]:order-2 min-[821px]:block min-[821px]:min-w-0 min-[821px]:flex-1">
        <div className="order-2 -mx-1 mt-8 flex border-b border-line px-1 min-[821px]:order-none min-[821px]:mt-0">
          <div
            data-project-tab-scroll
            className="scrollbar-none flex min-w-0 flex-1 touch-pan-x gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain"
          >
            <div
              role="tablist"
              aria-label="Project sections"
              className="flex shrink-0 gap-1"
            >
              <button
                type="button"
                role="tab"
                aria-selected={activityActive}
                onClick={() => activate(activitySlug)}
                className={`${buttonClasses(activityActive)} min-[821px]:hidden`}
              >
                <ProjectTabIcon label="Activity" />
                {activityLabel}
              </button>
              {[...visibleTabs, ...(overflowExpanded ? overflowTabs : [])].map(tab => {
                const slug = tabSlug(tab.label)
                const selected = !activityActive && normalActiveSlug === slug
                return (
                  <button
                    key={tab.label}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => activate(slug)}
                    className={buttonClasses(selected)}
                  >
                    <ProjectTabIcon label={tab.label} />
                    <span>{tab.label}</span>
                  </button>
                )
              })}
            </div>
            <ProjectOverflowMenu
              tabs={overflowTabs}
              activeSlug={activityActive ? activitySlug : normalActiveSlug}
              expanded={overflowExpanded}
              onToggle={() => setOverflowExpanded(current => !current)}
            />
          </div>
        </div>

        <div
          className={`order-4 pt-6 min-[821px]:order-none ${
            activityActive ? 'hidden' : 'block'
          }`}
        >
          {tabs.map(tab => {
            const slug = tabSlug(tab.label)
            return mounted.current.has(slug) ? (
              <div key={tab.label} hidden={normalActiveSlug !== slug}>
                {tab.content}
              </div>
            ) : null
          })}
        </div>
      </div>
    </div>
  )
}

function ProjectOverflowMenu({
  tabs,
  activeSlug,
  expanded,
  onToggle,
}: {
  tabs: TabDef[]
  activeSlug: string
  expanded: boolean
  onToggle: () => void
}) {
  const activeTab = tabs.find(tab => tabSlug(tab.label) === activeSlug)

  if (!tabs.length) return null

  return (
    <button
      type="button"
      aria-label={`More project sections${activeTab ? `, current: ${activeTab.label}` : ''}`}
      aria-expanded={expanded}
      onClick={onToggle}
      className={`flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center border-b-2 px-3 text-xl leading-none transition-colors ${
        activeTab && !expanded
          ? 'border-ink text-ink'
          : 'border-transparent text-muted hover:text-ink'
      }`}
    >
      <span
        data-overflow-orientation={expanded ? 'horizontal' : 'vertical'}
        className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
      >
        <ProjectOverflowIcon />
      </span>
    </button>
  )
}

/**
 * A subtab row used inside project tabs. When `hashParent` is provided, the
 * second URL-hash segment selects and deep-links the subtab (`#shop/customers`).
 */
export function SubTabs({
  tabs,
  hashParent,
}: {
  tabs: TabDef[]
  hashParent?: string
}) {
  const [active, setActive] = useState(0)

  useEffect(() => {
    if (!hashParent) return
    const apply = () => {
      const [parent, child] = window.location.hash.replace('#', '').split('/')
      if (tabSlug(parent ?? '') !== tabSlug(hashParent)) return
      const i = child
        ? tabs.findIndex(tab => tabSlug(tab.label) === tabSlug(child))
        : 0
      if (i < 0) return
      setActive(i)
    }
    apply()
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
    // The tab definitions are stable for the mounted section; only their
    // labels are used here, and remounting re-runs this resolver.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hashParent])

  const activate = (i: number) => {
    if (!hashParent) setActive(i)
    if (hashParent) {
      replaceProjectTabHash(
        `#${tabSlug(hashParent)}/${tabSlug(tabs[i].label)}`,
      )
    }
  }

  return (
    <TabShell
      tabs={tabs}
      active={active}
      onSelect={activate}
      listClassName="scrollbar-none flex gap-6 overflow-x-auto border-b border-line"
      buttonClassName="min-h-[40px] shrink-0 whitespace-nowrap border-b-2 px-1 font-agrandir-wide text-sm font-medium transition-colors"
      panelClassName="pt-4"
    />
  )
}
