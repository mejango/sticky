import { keccak256, toHex } from 'viem'
import type { TxRequest } from '@/hooks/useSafeTx'

/**
 * The one home for a write's hold key. The SDK holds a write by its exact call, which is right when a retry regenerates
 * the same bytes. Where a retry's calldata or value is regenerated (a quote, a fee, a proof, an amount that covers a
 * moving claim), the exact call changes while the user's intent does not, so a retry would send again with no exit.
 * Those writes are held by their intent: the action and the parameters the user chose, with every volatile field left
 * out. Any other write is held by its exact call (undefined).
 */
export function holdIntent(request: Pick<TxRequest, 'chainId' | 'address' | 'functionName' | 'args'>): string | undefined {
  const args = request.args
  const except = (...volatile: number[]) => args.filter((_, index) => !volatile.includes(index))
  // The SDK limits a namespace to 128 lowercase characters, so the intent is named by the action and a digest of its parameters.
  // Only hex identities are normalized (an address or bytes32 may arrive in any letter case); nothing else is altered.
  const part = (value: unknown) => (typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value) ? value.toLowerCase() : String(value))
  const key = (...parts: readonly unknown[]) =>
    `${request.functionName.toLowerCase()}:${keccak256(toHex([request.chainId, request.address, request.functionName, ...parts].map(part).join(':'))).slice(2, 42)}`
  switch (request.functionName) {
    // JBMultiTerminal.pay (a stick): minReturnedTokens is a quote.
    case 'pay': return key(...except(4))
    // JBMultiTerminal.cashOutTokensOf (an unstick): minTokensReclaimed is a quote.
    case 'cashOutTokensOf': return key(...except(4))
    // An approval covers a claim or a stick that can move: the spender is the intent.
    case 'approve': return key(args[0])
    // Sucker.prepare (a bridge queue): minTokensReclaimed is a quote.
    case 'prepare': return key(...except(2))
    // Sucker.toRemote (a bridge send): the transport budget is the call's value, a quote.
    case 'toRemote': return key(args[0])
    // Sucker.claim: the proof moves as the tree grows; the leaf is the intent.
    case 'claim': {
      const claim = args[0] as { token: unknown; leaf: { index: unknown } }
      return key(claim.token, claim.leaf.index)
    }
    // Source collector send: the bridge fee is the call's value, a quote.
    case 'send': return key(...args)
    default: return undefined
  }
}
