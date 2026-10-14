import { intent, writeIntentKey } from '@bananapus/nana-sdk-core/review'
import type { TxRequest } from '@/hooks/useSafeTx'

/**
 * REMOVE AFTER ONE RELEASE. A frozen copy of the app-local hold keys origin/main shipped (Sticky #60), so an attempt
 * saved by that deploy and retried here with regenerated calldata is still found under its old namespace and refused
 * until its exit, instead of sending twice under the new SDK builder key. Do not extend it: new writes never appear here.
 *
 * The old builder read the request's `moving` and `max` flags, which no longer exist, so every key either flag could have
 * produced is returned. A key that matches nothing costs nothing.
 */
export function legacyNamespaces(request: Pick<TxRequest, 'chainId' | 'address' | 'functionName' | 'args'>): string[] {
  const args = request.args
  const chain = request.chainId
  const address = (value: unknown) => intent.address(String(value))
  const hex = (value: unknown) => intent.hex(String(value))
  const amount = (value: unknown) => BigInt(value as bigint | number | string)
  const quantities = (value: unknown) => [amount(value), 'all' as const]
  switch (request.functionName) {
    case 'pay':
      return [writeIntentKey('stick', { chain, terminal: address(request.address), projectId: amount(args[0]), token: address(args[1]), amount: amount(args[2]), beneficiary: address(args[3]) })]
    case 'cashOutTokensOf':
      return quantities(args[2]).map(count => writeIntentKey('unstick', { chain, terminal: address(request.address), holder: address(args[0]), projectId: amount(args[1]), count, token: address(args[3]), beneficiary: address(args[5]) }))
    // No old key holds an approval (jango 2026-10-14): a repeat costs gas, not funds.
    case 'approve':
      return []
    case 'prepare':
      return [writeIntentKey('bridge-queue', { chain, sucker: address(request.address), projectTokenCount: amount(args[0]), beneficiary: hex(args[1]), metadata: hex(args[4]) })]
    case 'toRemote':
      return [writeIntentKey('bridge-send', { chain, sucker: address(request.address), token: address(args[0]) })]
    case 'claim': {
      const claim = args[0] as { token: unknown; leaf: { index: unknown } }
      return [writeIntentKey('bridge-claim', { chain, sucker: address(request.address), token: address(claim.token), leaf: amount(claim.leaf.index) })]
    }
    case 'send':
      return quantities(args[3]).map(count => writeIntentKey('collector-delivery', { chain, collector: address(request.address), sourceProjectId: amount(args[0]), stickyToken: address(args[1]), groupId: amount(args[2]), amount: count }))
    case 'transfer':
      return [writeIntentKey('transfer-all', { chain, token: address(request.address), recipient: address(args[0]) })]
    case 'settle':
      return [writeIntentKey('collector-settle-all', { chain, collector: address(request.address), sourceProjectId: amount(args[0]), stickyToken: address(args[1]), groupId: amount(args[2]) })]
    default:
      return []
  }
}
