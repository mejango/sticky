import snapshot from './protocol-rollout.json'

type ContractName = keyof (typeof snapshot.chains)['1']['contracts']
type ChainRecord = {
  alias: string
  contracts: Record<ContractName, string | null>
  history: Record<string, { previous: string | null; v1: string | null }>
}

/** A chain's current and earlier protocol deployments, which the fee buyback review trusts. */
export function rolloutChain(chainId: number): ChainRecord | undefined {
  return (snapshot.chains as Record<string, ChainRecord>)[chainId]
}
