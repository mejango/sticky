import { approvalIntent, bridgeIntent, cashOutIntent, payIntent, writeIntentKey, intent } from '@bananapus/nana-sdk-core/review'
import type { Address } from 'viem'
import type { TxRequest } from '@/hooks/useSafeTx'

/**
 * The one home for a Sticky write's hold key, built only from the SDK's intent builders so every web client keys the same
 * user action the same way: identity plus the user's explicit choices, never an amount, a quote, a route or a fee. A
 * retry of the same action from any app, tab or deploy is held by the first attempt until it settles or the user takes
 * its explicit exit.
 *
 * Not covered by an SDK builder, keyed with `writeIntentKey` from identity alone: a transfer of Sticky tokens (token,
 * recipient, account) and a collector settle (collector, source project, Sticky token, group, account). The rest (a fund, a
 * collect, a claim-and-stick, a trust, the auto-stick settings, a compound, a begin-vesting, a receiver deploy and a settle)
 * are held by their exact call (undefined): their calldata is typed input and does not regenerate on a retry.
 */
export function holdIntent(request: Pick<TxRequest, 'chainId' | 'address' | 'functionName' | 'args' | 'parent'>, account: Address): string | undefined {
  const args = request.args
  const chainId = request.chainId
  switch (request.functionName) {
    // JBMultiTerminal.pay (a stick): the project and who the Sticky tokens go to.
    case 'pay':
      return payIntent({ chainId, project: args[0] as bigint, beneficiary: args[3] as Address })
    // JBMultiTerminal.cashOutTokensOf (an unstick): the project, the holder and who receives.
    case 'cashOutTokensOf':
      return cashOutIntent({ chainId, project: args[1] as bigint, holder: args[0] as Address, beneficiary: args[5] as Address })
    // Sucker.prepare (a bridge queue) and Sucker.toRemote (a bridge send): the sucker, the token and the account.
    case 'prepare':
      return bridgeIntent({ chainId, sucker: request.address, token: args[3] as Address, account })
    case 'toRemote':
      return bridgeIntent({ chainId, sucker: request.address, token: args[0] as Address, account })
    // Sucker.claim: the claiming account on the sucker, for the token.
    case 'claim':
      return bridgeIntent({ chainId, sucker: request.address, token: (args[0] as { token: Address }).token, account })
    // A collector delivery crosses through a sucker: the same bridge intent.
    case 'send':
      return bridgeIntent({ chainId, sucker: args[4] as Address, token: args[5] as Address, account })
    // Not covered by an SDK builder: identity only, never an amount.
    case 'transfer':
      return writeIntentKey('transfer', { chain: chainId, token: intent.address(request.address), recipient: intent.address(args[0] as Address), account: intent.address(account) })
    case 'settle':
      return writeIntentKey('collector-settle', { chain: chainId, collector: intent.address(request.address), sourceProjectId: args[0] as bigint, stickyToken: intent.address(args[1] as Address), groupId: args[2] as bigint, account: intent.address(account) })
    // An approval step belongs to the action it serves: no amount, only the step, the token and the spender.
    case 'approve':
      return approvalIntent(request.parent ?? PARENTLESS, { step: (args[1] as bigint) === 0n ? 'reset' : 'approve', token: request.address, spender: args[0] as Address })
    default:
      return undefined
  }
}

/** Approvals planned without a parent action share one parent, so a pending one still blocks its twin. */
const PARENTLESS = writeIntentKey('approval-parent', { action: 'unattached' })

/** The key an approval's action is held under: its intent, else its function and contract. */
export function parentOf(request: Pick<TxRequest, 'chainId' | 'address' | 'functionName' | 'args' | 'parent'>, account: Address): string {
  return holdIntent(request, account) ?? writeIntentKey('approval-parent', { chain: request.chainId, contract: intent.address(request.address), action: request.functionName })
}

/** Approvals of a plan take the plan's last step (the action they serve) as their parent. */
export function withApprovalParent<T extends TxRequest>(steps: T[], account: Address): T[] {
  const main = steps[steps.length - 1]
  if (!main || main.functionName === 'approve') return steps
  const parent = parentOf(main, account)
  return steps.map(step => (step.functionName === 'approve' ? { ...step, parent } : step))
}
