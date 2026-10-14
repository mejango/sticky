import { intent, writeIntentKey } from '@bananapus/nana-sdk-core/review'
import type { TxRequest } from '@/hooks/useSafeTx'

/**
 * The one home for a write's hold key. The SDK holds a write by its exact call, which is right when a retry regenerates
 * the same bytes. Where a retry's calldata or value is regenerated (a quote, a fee, a proof, an amount that covers a
 * moving claim), the exact call changes while the user's intent does not, so a retry would send again with no exit.
 * Those writes are held by their intent, built by the SDK's `writeIntentKey` from the action, the identity of what is
 * acted on and the parameters the user chose, with every volatile field left out. Any other write is held by its
 * exact call (undefined). Writes pending from before this key existed are held by their exact call, which the SDK
 * always includes beside the intent.
 */
export function holdIntent(request: Pick<TxRequest, 'chainId' | 'address' | 'functionName' | 'args'>): string | undefined {
  const args = request.args
  const chain = request.chainId
  const address = (value: unknown) => intent.address(String(value))
  const hex = (value: unknown) => intent.hex(String(value))
  const amount = (value: unknown) => BigInt(value as bigint | number | string)
  switch (request.functionName) {
    // JBMultiTerminal.pay (a stick): minReturnedTokens (4) is a quote.
    case 'pay':
      return writeIntentKey('stick', { chain, terminal: address(request.address), projectId: amount(args[0]), token: address(args[1]), amount: amount(args[2]), beneficiary: address(args[3]) })
    // JBMultiTerminal.cashOutTokensOf (an unstick): minTokensReclaimed (4) is a quote.
    case 'cashOutTokensOf':
      return writeIntentKey('unstick', { chain, terminal: address(request.address), holder: address(args[0]), projectId: amount(args[1]), count: amount(args[2]), token: address(args[3]), beneficiary: address(args[5]) })
    // An approval covers a claim or a stick that can move: the token and the spender are the intent.
    case 'approve':
      return writeIntentKey('approve', { chain, token: address(request.address), spender: address(args[0]) })
    // Sucker.prepare (a bridge queue): minTokensReclaimed (2) is a quote.
    case 'prepare':
      return writeIntentKey('bridge-queue', { chain, sucker: address(request.address), projectTokenCount: amount(args[0]), beneficiary: hex(args[1]), token: address(args[3]), metadata: hex(args[4]) })
    // Sucker.toRemote (a bridge send): the transport budget is the call's value, a quote.
    case 'toRemote':
      return writeIntentKey('bridge-send', { chain, sucker: address(request.address), token: address(args[0]) })
    // Sucker.claim: the proof moves as the tree grows; the leaf is the intent.
    case 'claim': {
      const claim = args[0] as { token: unknown; leaf: { index: unknown } }
      return writeIntentKey('bridge-claim', { chain, sucker: address(request.address), token: address(claim.token), leaf: amount(claim.leaf.index) })
    }
    // Source collector send: the bridge fee is the call's value, a quote.
    case 'send':
      return writeIntentKey('collector-delivery', { chain, collector: address(request.address), sourceProjectId: amount(args[0]), stickyToken: address(args[1]), groupId: amount(args[2]), amount: amount(args[3]), sucker: address(args[4]), backingToken: address(args[5]) })
    default:
      return undefined
  }
}
