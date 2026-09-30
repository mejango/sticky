'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { formatUnits, type Address } from 'viem'
import { useBalance } from 'wagmi'
import { ViewAsForm } from '@/components/ViewAsForm'
import { useAccountIdentity } from '@/hooks/useAccountIdentity'
import { useOutsideClose } from '@/hooks/useOutsideClose'
import { useWallet } from '@/hooks/useWallet'
import { displayChainName } from '@/lib/chainDisplay'
import { projectRouteSegmentFromPathname } from '@/lib/project-handles'
import { parseUrn } from '@/lib/urn'
import { useViewAs } from '@/lib/viewAs'
import { preloadCenterWallet } from '@/providers/preload-center'
import { useResolvedProjectRoute } from '@/providers/ProjectRouteContext'

const CONNECT_BUTTON =
  'max-w-full whitespace-nowrap rounded-sm border px-3 py-[5px] font-bold tracking-[1px] text-ink max-[520px]:px-2.5 max-[520px]:text-[13px] max-[520px]:tracking-[.5px]'

function formatTokenAmount(wei: bigint, decimals = 18, maxDigits = 4) {
  return formatAmount(Number(formatUnits(wei, decimals)), maxDigits)
}

/** A token amount already in whole-token units. */
function formatAmount(value: number, maxDigits = 4) {
  if (value === 0) return '0'
  // A real amount never reads as nothing: below the digit budget, show its first significant figure.
  if (value > 0 && value < 0.0001)
    return value.toFixed(Math.ceil(-Math.log10(value))).replace(/0+$/, '')
  return value.toLocaleString('en-US', { maximumFractionDigits: maxDigits })
}

function formatWalletBalance(
  value: bigint | undefined,
  decimals: number,
  symbol: string,
) {
  if (value === undefined) return 'Loading…'
  return `${formatTokenAmount(value, decimals)} ${symbol}`
}

function BalanceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-5 leading-[1.7]">
      <dt className="text-muted">{label}</dt>
      <dd className="whitespace-nowrap font-semibold">{value}</dd>
    </div>
  )
}

/** What the account holds on the chain of the project in view. */
function WalletBalances({
  address,
  chainId,
}: {
  address: Address
  chainId: number
}) {
  const { data, isError } = useBalance({ address, chainId })
  const symbol = data?.symbol ?? 'ETH'
  return (
    <div className="mb-1 border-b border-line px-2.5 py-1.5">
      <div className="text-muted">{displayChainName(chainId)}</div>
      <dl>
        <BalanceRow
          label={symbol}
          value={
            isError
              ? 'Unavailable'
              : formatWalletBalance(data?.value, data?.decimals ?? 18, symbol)
          }
        />
      </dl>
    </div>
  )
}

function MenuButton({
  children,
  danger,
  ...props
}: {
  children: ReactNode
  danger?: boolean
  onClick: () => void
  'aria-expanded'?: boolean
}) {
  return (
    <button
      type="button"
      className={danger ? 'menu-item text-err' : 'menu-item'}
      {...props}
    >
      {children}
    </button>
  )
}

/** Sign in, or the menu of the account that is signed in or being viewed. */
export function WalletButton() {
  const { isConnected, address, isCenterWallet, openSignIn, disconnect } =
    useWallet()
  const { viewAs, clearViewAs } = useViewAs()
  const [menuOpen, setMenuOpen] = useState(false)
  const [viewAsOpen, setViewAsOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const pathname = usePathname()
  const routeSegment = projectRouteSegmentFromPathname(pathname) ?? ''
  // The handle a `/@handle` route names, spelled the way the server resolved it.
  const routeHandle = routeSegment.startsWith('@')
    ? routeSegment.slice(1).replace(/\.eth$/i, '').toLowerCase()
    : null
  const resolvedRouteProject = useResolvedProjectRoute()
  const routeProject =
    parseUrn(routeSegment) ??
    (routeHandle && resolvedRouteProject?.handle === routeHandle
      ? resolvedRouteProject
      : null)

  // Wallet state only exists client-side; render the signed-out shell on the
  // server so hydration always matches.
  useEffect(() => setMounted(true), [])

  const connected = mounted && isConnected && !!address
  const activeViewAs = mounted ? viewAs : null
  // The account the button and its menu speak for: the viewed one wins.
  const account = activeViewAs ?? (connected ? address : undefined)
  const { label } = useAccountIdentity(account)

  const closeMenu = useCallback(() => {
    setMenuOpen(false)
    setViewAsOpen(false)
  }, [])
  const dismissMenu = () => {
    closeMenu()
    triggerRef.current?.focus()
  }

  useOutsideClose(wrapperRef, closeMenu, menuOpen)

  // A menu opened for an account must not outlive it and reopen for the next.
  useEffect(() => {
    if (!account) closeMenu()
  }, [account, closeMenu])

  useEffect(() => {
    if (menuOpen) panelRef.current?.querySelector<HTMLElement>('a, button')?.focus()
  }, [menuOpen])

  const menuAttributes = {
    ref: triggerRef,
    type: 'button' as const,
    onClick: () => (menuOpen ? closeMenu() : setMenuOpen(true)),
    'aria-expanded': menuOpen,
    'aria-controls': menuOpen ? panelId : undefined,
  }

  return (
    <div
      className="relative min-w-0 max-w-[calc(100vw-96px)]"
      ref={wrapperRef}
      onKeyDown={event => {
        if (event.key !== 'Escape' || !menuOpen) return
        event.preventDefault()
        dismissMenu()
      }}
    >
      {activeViewAs ? (
        <button
          {...menuAttributes}
          title={activeViewAs}
          className={`${CONNECT_BUTTON} border-ink bg-amber`}
        >
          <span className="block truncate">Viewing as {label}</span>
        </button>
      ) : connected ? (
        <button
          {...menuAttributes}
          title={isCenterWallet ? `Signa account ${address}` : address}
          className={`${CONNECT_BUTTON} flex flex-col items-start border-line bg-[#fdffff] leading-tight hover:border-ink`}
        >
          {/* The state is the headline; which account is the detail. */}
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full bg-[#3fae6a]"
            />
            Signed in
          </span>
          <span className="block max-w-full truncate pl-3.5 text-[11px] font-normal tracking-[.5px] text-muted">
            {label}
          </span>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void openSignIn()}
          // Fetch the Signa runtime as the pointer arrives, so the click has
          // nothing left to wait for.
          onMouseEnter={preloadCenterWallet}
          onFocus={preloadCenterWallet}
          onTouchStart={preloadCenterWallet}
          className={`${CONNECT_BUTTON} border-ink bg-transparent hover:bg-card`}
        >
          Sign in
        </button>
      )}

      {menuOpen && account ? (
        <div
          id={panelId}
          ref={panelRef}
          className="absolute right-0 top-full z-[60] mt-1.5 min-w-[180px] rounded-md border border-ink bg-[#fdffff] p-1 text-[13px] shadow-[0_8px_24px_rgba(33,30,26,0.18)]"
        >
          {routeProject ? (
            <WalletBalances address={account} chainId={routeProject.chainId} />
          ) : null}
          <Link
            href={`/account/${account}`}
            onClick={closeMenu}
            className="menu-item"
          >
            Account
          </Link>
          {activeViewAs ? (
            <MenuButton
              onClick={() => {
                closeMenu()
                clearViewAs()
              }}
            >
              {connected ? 'View as connected wallet' : 'Exit View as'}
            </MenuButton>
          ) : (
            <>
              <MenuButton
                onClick={() => {
                  void navigator.clipboard?.writeText(account).catch(() => undefined)
                  dismissMenu()
                }}
              >
                Copy address
              </MenuButton>
              <MenuButton
                danger
                onClick={() => {
                  closeMenu()
                  disconnect()
                }}
              >
                Disconnect
              </MenuButton>
            </>
          )}
          <div className="mx-2 my-[3px] border-t border-line" />
          <MenuButton
            aria-expanded={viewAsOpen}
            onClick={() => setViewAsOpen(open => !open)}
          >
            {activeViewAs ? 'View as another account…' : 'View as…'}
          </MenuButton>
          {viewAsOpen ? (
            <ViewAsForm onDone={closeMenu} className="px-2.5 pb-2 pt-1.5" />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
