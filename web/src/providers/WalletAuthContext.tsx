'use client'
import { createContext, useContext } from 'react'
/** `walletsOnly` opens the chooser with the external wallets alone, and keeps it open while Signa is the connected
 *  account, until one of them connects. */
export type SignInOptions = { walletsOnly?: boolean }
/** Resolves when the wallet chooser closes, connected or dismissed, so a
 *  pressed action can carry on without asking for a second press. */
export const WalletAuthContext = createContext<{ requestSignIn: (options?: SignInOptions) => Promise<void> }>({
  requestSignIn: () => Promise.resolve(),
})
export const useWalletAuth = () => useContext(WalletAuthContext)
/** Why a write is refused while Signa is the connected account: Signa signs in, and an external wallet sends. */
export const EXTERNAL_WALLET_REQUIRED = 'This action needs an external wallet.'
