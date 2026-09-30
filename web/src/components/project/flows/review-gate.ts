import type { Address } from 'viem'
import { getViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import { EXTERNAL_WALLET_REQUIRED } from '@/providers/WalletAuthContext'

/** Why a review does not start for a connected wallet. */
export type ReviewRefusal = typeof EXTERNAL_WALLET_REQUIRED | typeof VIEW_AS_WRITE_BLOCKED

/**
 * Whether a flow's review may start, checked before it reads or plans anything: null when there is no account to send
 * from, and the visitor is asked to sign in; else the account, and why it cannot send, if it cannot. A Signa session
 * cannot send and is told so in the engine's own words, which `TxError` follows with "Connect a wallet"; nor can View
 * as. The engine refuses both again when a step is sent.
 */
export function reviewGate({
  address,
  isConnected,
  isCenterWallet,
}: {
  address: Address | undefined
  isConnected: boolean
  isCenterWallet: boolean
}): { account: Address; refusal: ReviewRefusal | null } | null {
  if (!isConnected || !address) return null
  if (isCenterWallet) return { account: address, refusal: EXTERNAL_WALLET_REQUIRED }
  if (getViewAs()) return { account: address, refusal: VIEW_AS_WRITE_BLOCKED }
  return { account: address, refusal: null }
}
