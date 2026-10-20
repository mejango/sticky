'use client'
import { CENTER_WALLET_ENABLED } from './wallet-config'
/** Fetches the sign-in dialog, and the Signa runtime when Signa is on, so a click on Sign in has nothing left to wait for. */
export function preloadSignIn() {
  void import('./ExternalWalletDialog')
  if (CENTER_WALLET_ENABLED) void import('./center-runtime')
}
