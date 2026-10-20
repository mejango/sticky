'use client'

import { lazy, Suspense, useEffect, useState, type ButtonHTMLAttributes, type Ref } from 'react'
import type { Address } from 'viem'
import { useWallet } from '@/hooks/useWallet'
import { shortAddress } from '@/lib/sticky-format'
import { useViewAs } from '@/lib/viewAs'
import { preloadSignIn } from '@/providers/preload-center'

const CONNECT_BUTTON =
  'max-w-full whitespace-nowrap rounded-sm border px-3 py-[5px] font-bold tracking-[1px] text-ink max-[520px]:px-2.5 max-[520px]:text-[13px] max-[520px]:tracking-[.5px]'
export const WALLET_WRAPPER = 'relative min-w-0 max-w-[calc(100vw-96px)]'

// The account's menu, its balances and its ENS name load once there is an account to show.
const SignedInWallet = lazy(() => import('@/components/SignedInWallet').then(module => ({ default: module.SignedInWallet })))

/** The header button of the account that is signed in or being viewed: the viewed one is named as such. */
export function AccountTrigger({
  ref,
  viewing,
  address,
  isCenterWallet,
  label,
  ...props
}: {
  ref?: Ref<HTMLButtonElement>
  viewing: Address | null
  address: Address | undefined
  isCenterWallet: boolean
  label: string
} & Pick<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'aria-expanded' | 'aria-controls'>) {
  return viewing ? (
    <button ref={ref} type="button" {...props} title={viewing} className={`${CONNECT_BUTTON} border-ink bg-amber`}>
      <span className="block truncate">Viewing as {label}</span>
    </button>
  ) : (
    <button
      ref={ref}
      type="button"
      {...props}
      title={isCenterWallet ? `Signa account ${address}` : address}
      className={`${CONNECT_BUTTON} flex flex-col items-start border-line bg-[#fdffff] leading-tight hover:border-ink`}
    >
      {/* The state is the headline; which account is the detail. */}
      <span className="flex items-center gap-1.5">
        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-[#3fae6a]" />
        Signed in
      </span>
      <span className="block max-w-full truncate pl-3.5 text-[11px] font-normal tracking-[.5px] text-muted">{label}</span>
    </button>
  )
}

/** Sign in, or the menu of the account that is signed in or being viewed. */
export function WalletButton() {
  const { isConnected, address, isCenterWallet, openSignIn } = useWallet()
  const { viewAs } = useViewAs()
  const [mounted, setMounted] = useState(false)
  // A press of the button before the menu has loaded opens it once it has.
  const [pressed, setPressed] = useState(false)

  // Wallet state only exists client-side; render the signed-out shell on the
  // server so hydration always matches.
  useEffect(() => setMounted(true), [])

  const connected = mounted && isConnected && !!address
  const viewing = mounted ? viewAs : null
  // The account the button and its menu speak for: the viewed one wins.
  const account = viewing ?? (connected ? address : undefined)
  // A queued press is for the account it was made for; signing out drops it.
  useEffect(() => {
    if (!account) setPressed(false)
  }, [account])

  if (account) {
    return (
      <Suspense
        fallback={
          <div className={WALLET_WRAPPER}>
            <AccountTrigger
              viewing={viewing}
              address={address}
              isCenterWallet={isCenterWallet}
              label={shortAddress(account)}
              onClick={() => setPressed(true)}
            />
          </div>
        }
      >
        <SignedInWallet account={account} viewing={viewing} connected={connected} openOnLoad={pressed} />
      </Suspense>
    )
  }
  return (
    <div className={WALLET_WRAPPER}>
      <button
        type="button"
        onClick={() => void openSignIn()}
        // Fetch the sign-in dialog and the Signa runtime as the pointer
        // arrives, so the click has nothing left to wait for.
        onMouseEnter={preloadSignIn}
        onFocus={preloadSignIn}
        onTouchStart={preloadSignIn}
        className={`${CONNECT_BUTTON} border-ink bg-transparent hover:bg-card`}
      >
        Sign in
      </button>
    </div>
  )
}
