/**
 * The calls a holder sends to a Sticky project: approving the token they stick, sticking, unsticking, transferring
 * Sticky tokens and trusting a sender. Each is a request for the transaction engine and is frozen: the chain, the
 * contract and the arguments that were reviewed are the ones that are sent. A builder throws on a chain Sticky is not
 * deployed on.
 *
 * The minimums a call carries (what a stick must mint, what an unstick must pay) are the quotes of `sticky-quotes.ts`.
 */

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { buildCashOutTx, buildPayTx } from '@bananapus/nana-sdk-core/v6'
import { erc20Abi, formatUnits, maxUint256, type Abi, type Address } from 'viem'
import { stickyAutoStickAbi, stickyHookAbi, stickyTokenAbi } from '@/lib/sticky-abis'
import { stickyDeployment, type StickyDeployment } from '@/lib/sticky-addresses'
import type { AutoStickState } from '@/lib/sticky-autostick'
import type { StickyProjectInfo } from '@/lib/sticky-project'

/** The request shape of useSafeTx's `send` (`src/hooks/useSafeTx.ts`). */
export type TxRequest = {
  chainId: number
  address: Address
  abi: Abi
  functionName: string
  args: readonly unknown[]
  value?: bigint
  label?: string
}

function deploymentOn(chainId: number): StickyDeployment {
  const deployment = stickyDeployment(chainId)
  if (!deployment) throw new Error(`Sticky is not deployed on chain ${chainId}.`)
  return deployment
}

/** The request as it stands, frozen with its arguments. */
const frozen = (request: TxRequest): TxRequest => Object.freeze({ ...request, args: Object.freeze([...request.args]) })

const approval = (chainId: number, token: Address, spender: Address, amount: bigint, label: string): TxRequest =>
  frozen({ chainId, address: token, abi: erc20Abi, functionName: 'approve', args: [spender, amount], label })

/** `'exact'` leaves the allowance at the amount, and `'covering'` leaves one that already covers it. */
export type ApprovalMode = 'exact' | 'covering'

/**
 * What it takes to let `spender` pull `amount` of a token from a holder who has approved `allowance`: nothing when the
 * allowance is what is wanted, else an approval of exactly the amount. Some tokens change a nonzero allowance only by
 * way of zero, so one that is neither zero nor the amount is reset first. An amount of zero takes the allowance back,
 * with the reset alone.
 */
export function approveSteps(
  chainId: number,
  token: Address,
  spender: Address,
  allowance: bigint,
  amount: bigint,
  { symbol, decimals, mode = 'exact' }: { symbol: string; decimals: number; mode?: ApprovalMode },
): TxRequest[] {
  if (mode === 'covering' ? allowance >= amount : allowance === amount) return []
  const reset = `Reset ${symbol} allowance`
  const pretty = amount === maxUint256 ? 'unlimited' : `${formatUnits(amount, decimals)} ${symbol}`
  return [
    ...(allowance > 0n && amount > 0n ? [approval(chainId, token, spender, 0n, reset)] : []),
    approval(chainId, token, spender, amount, amount === 0n ? reset : `Approve ${pretty}`),
  ]
}

/**
 * A stick: `JBMultiTerminal.pay` of `amount` of the project's staked token, with `beneficiary` to hold the Sticky
 * tokens it mints, and no memo or metadata. `minReturned` is the quote of the Sticky tokens it must mint, and is never
 * zero: a stick without a minimum takes whatever the backing price has become.
 */
export function stickTx(
  info: Pick<StickyProjectInfo, 'chainId' | 'projectId' | 'stakedToken'>,
  beneficiary: Address,
  amount: bigint,
  minReturned: bigint,
): TxRequest {
  if (minReturned <= 0n) throw new Error('A stick needs a minimum of Sticky tokens to mint, from its quote.')
  const { terminal } = deploymentOn(info.chainId)
  return frozen({
    ...buildPayTx({
      chainId: info.chainId as JBChainId,
      terminal,
      projectId: info.projectId,
      token: info.stakedToken,
      amount,
      beneficiary,
      minReturnedTokens: minReturned,
      memo: '',
      metadata: '0x',
    }),
    label: 'Stick',
  })
}

/** What taking auto-stick apart needs of a holder's settings: its last minimum and cooldown, which the adapter keeps
 * while it is off, and whether the holder gave it trust and an allowance. */
type AutoStickSettings = Pick<AutoStickState, 'minimum' | 'cooldown' | 'personallyTrusted' | 'allowance'>

/**
 * A holder's auto-stick, taken apart: the adapter turned off, then the trust and the allowance the holder gave it taken
 * back. A project that launched with the adapter as a granter needs no trust from the holder, so there may be none to
 * take back, and an allowance that is spent or never given has nothing to withdraw.
 */
export function autoStickOffTxs(
  info: Pick<StickyProjectInfo, 'chainId' | 'projectId' | 'stakedToken' | 'symbol'>,
  { minimum, cooldown, personallyTrusted, allowance }: AutoStickSettings,
): TxRequest[] {
  const { chainId, projectId, stakedToken, symbol } = info
  const { autoStick } = deploymentOn(chainId)
  return [
    // The adapter asks for a valid minimum and cooldown even to be turned off, so it is told the ones it has.
    frozen({
      chainId,
      address: autoStick,
      abi: stickyAutoStickAbi,
      functionName: 'setConfigFor',
      args: [projectId, false, minimum, cooldown],
      label: 'Turn off auto-stick',
    }),
    ...(personallyTrusted
      ? [trustTx(chainId, projectId, autoStick, false, `Stop the auto-stick contract from sticking ${symbol} for you`)]
      : []),
    ...(allowance > 0n
      ? [approval(chainId, stakedToken, autoStick, 0n, `Remove the auto-stick contract's ${symbol} allowance`)]
      : []),
  ]
}

/**
 * An unstick: `JBMultiTerminal.cashOutTokensOf` of `count` Sticky tokens from `holder`, reclaiming the staked token
 * for them, with no metadata. `minReclaimed` is the quote of the net it must pay, which is zero at a full stickiness
 * bonus, and the call then says it gives nothing back.
 *
 * A holder who unsticks all of what they hold, `balance`, while their auto-stick is on takes it apart first, so that it
 * does not keep trust and an allowance to stick for a position that is gone.
 */
export function unstickTxs(
  info: Pick<StickyProjectInfo, 'chainId' | 'projectId' | 'stakedToken' | 'symbol'>,
  holder: Address,
  count: bigint,
  minReclaimed: bigint,
  autoStick?: { state: Pick<AutoStickState, 'enabled'> & AutoStickSettings; balance: bigint },
): TxRequest[] {
  const { terminal } = deploymentOn(info.chainId)
  const teardown = autoStick?.state.enabled && count === autoStick.balance ? autoStickOffTxs(info, autoStick.state) : []
  return [
    ...teardown,
    frozen({
      ...buildCashOutTx({
        chainId: info.chainId as JBChainId,
        terminal,
        holder,
        projectId: info.projectId,
        cashOutCount: count,
        tokenToReclaim: info.stakedToken,
        minTokensReclaimed: minReclaimed,
        beneficiary: holder,
        metadata: '0x',
      }),
      label: minReclaimed === 0n ? 'Unstick without reclaiming tokens' : 'Unstick',
    }),
  ]
}

/** A transfer of `amount` Sticky tokens, which have 18 decimals, to `recipient`. */
export function transferTx(
  info: Pick<StickyProjectInfo, 'chainId' | 'stToken' | 'stSymbol'>,
  recipient: Address,
  amount: bigint,
): TxRequest {
  return frozen({
    chainId: info.chainId,
    address: info.stToken,
    abi: stickyTokenAbi,
    functionName: 'transfer',
    args: [recipient, amount],
    label: `Transfer ${formatUnits(amount, 18)} ${info.stSymbol}`,
  })
}

/** Whether `sender` may stick for the holder who sends this call, in a project: `trusted` lets it, and false takes that
 * back. The hook keeps the record. */
export function trustTx(
  chainId: number,
  projectId: bigint,
  sender: Address,
  trusted: boolean,
  label = trusted ? 'Trust sender' : 'Untrust sender',
): TxRequest {
  return frozen({
    chainId,
    address: deploymentOn(chainId).hook,
    abi: stickyHookAbi,
    functionName: 'setTrustedSenderFor',
    args: [projectId, sender, trusted],
    label,
  })
}
