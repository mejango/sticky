'use client'
import { createContext, useContext } from 'react'
/** Resolves when the wallet chooser closes, connected or dismissed, so a
 *  pressed action can carry on without asking for a second press. */
export const WalletAuthContext = createContext({ requestSignIn: (): Promise<void> => Promise.resolve() })
export const useWalletAuth = () => useContext(WalletAuthContext)
