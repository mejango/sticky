'use client'
import { lazyConnector } from './lazy-connector'
import { CENTER_WALLET_CONFIG } from './wallet-config'
import { jbCenterRpcTransport } from '@/lib/jbcenter-rpc'
import { base } from '@bananapus/nana-sdk-core/chains'
export function lazyCenterConnector() {
  return lazyConnector({ id: 'juicebox-center', name: 'Juicebox account', type: 'juicebox-center',
    shouldRestore: () => {
      try { return !!CENTER_WALLET_CONFIG && !!window.sessionStorage.getItem('center.wallet.connection.v1:' + CENTER_WALLET_CONFIG.issuer + ':' + window.location.origin + '/center/callback') }
      catch { return false }
    },
    load: async () => {
      const [{ centerAccountConnector }, { centerWalletClient }] = await Promise.all([import('@bananapus/nana-sdk-connect/wagmi'), import('./center-runtime')])
      const rpc = jbCenterRpcTransport(8453)({ chain: base })
      return centerAccountConnector({ wallet: async () => centerWalletClient(), read: input => rpc.request(input as never) })
    },
  })
}
