'use client'

import { EXTERNAL_WALLET_REQUIRED, useWalletAuth } from '@/providers/WalletAuthContext'

/**
 * The way on from a write refused because Signa is the connected account: connecting an external wallet, from the
 * chooser with the external wallets alone. Nothing for any other error.
 */
export function ExternalWalletAction({ error }: { error: unknown }) {
  return error === EXTERNAL_WALLET_REQUIRED ? <ConnectWallet /> : null
}

function ConnectWallet() {
  const { requestSignIn } = useWalletAuth()
  return (
    <>
      {' '}
      <button type="button" className="btn-link" onClick={() => void requestSignIn({ walletsOnly: true })}>
        Connect a wallet
      </button>
    </>
  )
}
