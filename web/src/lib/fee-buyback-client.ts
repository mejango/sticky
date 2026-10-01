import {
  JB_CHAINS,
  jbContractAddress,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { createPublicClient, type Address } from 'viem'
import { jbCenterRpcTransport } from './jbcenter-rpc'
import { rolloutChain } from './protocol-rollout'

export function feeBuybackContext(chainId: number, beneficiary: Address) {
  const chain = JB_CHAINS[chainId as JBChainId]?.chain
  if (!chain) throw new Error('Unsupported chain')
  const deployment = rolloutChain(chainId)
  const sdk = jbContractAddress['6'] as unknown as Record<
    string,
    Record<number, string>
  >
  const addresses = (name: string) =>
    [
      (deployment?.contracts as Record<string, string | null> | undefined)?.[
        name
      ],
      ...Object.values(deployment?.history[name] ?? {}),
      sdk[name]?.[chainId],
    ].filter((value): value is string => !!value)
  const terminals = addresses('JBMultiTerminal')
  return {
    client: createPublicClient({
      chain,
      transport: jbCenterRpcTransport(chainId),
    }),
    options: {
      beneficiary,
      trustedHooks: addresses('JBBuybackHook'),
      terminals,
      controllers: addresses('JBController'),
      feePayers: [...terminals, ...addresses('REVLoans')],
    },
  }
}
