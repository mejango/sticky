'use client'

import Link from 'next/link'
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { Address } from 'viem'
import { useBalance } from 'wagmi'
import { AccountTrigger, WALLET_WRAPPER } from '@/components/WalletButton'
import { ViewAsForm } from '@/components/ViewAsForm'
import { useAccountIdentity } from '@/hooks/useAccountIdentity'
import { useOutsideClose } from '@/hooks/useOutsideClose'
import { useProjectInView, useTestnetInView } from '@/hooks/useProjectInView'
import { useWallet } from '@/hooks/useWallet'
import { displayChainName } from '@/lib/chainDisplay'
import { formatAmount } from '@/lib/sticky-format'
import { useViewAs } from '@/lib/viewAs'

function formatWalletBalance(
  value: bigint | undefined,
  decimals: number,
  symbol: string,
) {
  if (value === undefined) return 'Loading…'
  return `${formatAmount(value, decimals)} ${symbol}`
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

/**
 * The link to an account's page, on the network of the page in view. Only the open menu renders it, and only the
 * client opens the menu, so reading the search parameters here needs no Suspense boundary above the header.
 */
function AccountLink({ account, onClick }: { account: Address; onClick: () => void }) {
  const testnet = useTestnetInView()
  return (
    <Link
      href={`/account/${account}${testnet ? '?network=testnet' : ''}`}
      onClick={onClick}
      className="menu-item"
    >
      Account
    </Link>
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

/**
 * The button and menu of the account that is signed in or being viewed (the viewed one wins). It loads once there is
 * such an account; until it has, WalletButton shows the same button with the short address.
 */
export function SignedInWallet({
  account,
  viewing,
  connected,
  openOnLoad = false,
}: {
  account: Address
  viewing: Address | null
  connected: boolean
  /** Whether the button was pressed while this loaded. */
  openOnLoad?: boolean
}) {
  const { address, isCenterWallet, disconnect } = useWallet()
  const { clearViewAs } = useViewAs()
  const [menuOpen, setMenuOpen] = useState(openOnLoad)
  const [viewAsOpen, setViewAsOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const routeProject = useProjectInView()
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

  // A menu opened for an account does not outlive it: this unmounts with it, and WalletButton shows Sign in.

  useEffect(() => {
    if (menuOpen) panelRef.current?.querySelector<HTMLElement>('a, button')?.focus()
  }, [menuOpen])

  return (
    <div
      className={WALLET_WRAPPER}
      ref={wrapperRef}
      onKeyDown={event => {
        if (event.key !== 'Escape' || !menuOpen) return
        event.preventDefault()
        dismissMenu()
      }}
    >
      <AccountTrigger
        ref={triggerRef}
        viewing={viewing}
        address={address}
        isCenterWallet={isCenterWallet}
        label={label}
        onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? panelId : undefined}
      />

      {menuOpen ? (
        <div
          id={panelId}
          ref={panelRef}
          className="absolute right-0 top-full z-[60] mt-1.5 min-w-[180px] rounded-md border border-ink bg-[#fdffff] p-1 text-[13px] shadow-[0_8px_24px_rgba(33,30,26,0.18)]"
        >
          {routeProject ? (
            <WalletBalances address={account} chainId={routeProject.chainId} />
          ) : null}
          <AccountLink account={account} onClick={closeMenu} />
          {viewing ? (
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
            {viewing ? 'View as another account…' : 'View as…'}
          </MenuButton>
          {viewAsOpen ? (
            <ViewAsForm onDone={closeMenu} className="px-2.5 pb-2 pt-1.5" />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
