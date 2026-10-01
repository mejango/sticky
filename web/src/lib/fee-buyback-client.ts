import { JB_CHAINS, type JBChainId } from '@bananapus/nana-sdk-core'
import { feeBuybackOptions } from '@bananapus/nana-sdk-core/v6/fee-buyback'
import { createPublicClient, type Address } from 'viem'
import { jbCenterRpcTransport } from './jbcenter-rpc'

export function feeBuybackContext(chainId: number, beneficiary: Address) {
  const chain = JB_CHAINS[chainId as JBChainId]?.chain
  if (!chain) throw new Error('Unsupported chain')
  return {
    client: createPublicClient({
      chain,
      transport: jbCenterRpcTransport(chainId),
    }),
    options: feeBuybackOptions(chainId, beneficiary),
  }
}
