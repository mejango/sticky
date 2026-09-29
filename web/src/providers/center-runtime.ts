'use client'
import { createCenterWalletClient } from '@bananapus/nana-sdk-connect/core'
import { CENTER_WALLET_CONFIG } from './wallet-config'
import { centerReturnPath } from './center-callback'
const returnKey = 'sticky:center:return:v2'
let client: ReturnType<typeof createCenterWalletClient> | undefined
export function centerWalletClient() {
  if (!CENTER_WALLET_CONFIG || typeof window === 'undefined') throw new Error('Juicebox account is not configured for this site.')
  client ??= createCenterWalletClient({ ...CENTER_WALLET_CONFIG, callbackUri: window.location.origin + '/center/callback' })
  return client
}
/** A passkey connection is a full-page redirect; this runs right before it leaves. */
export function saveCenterReturnPath() {
  const path = centerReturnPath(window.location.pathname)
  window.sessionStorage.setItem(returnKey, path)
  if (window.sessionStorage.getItem(returnKey) !== path) throw new Error('This tab could not preserve the original page.')
}
export function originalCenterPage() { return centerReturnPath(window.sessionStorage.getItem(returnKey) ?? '/') }
