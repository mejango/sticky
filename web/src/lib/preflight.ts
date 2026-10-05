import { BaseError, ContractFunctionRevertedError, type Address } from 'viem'
import type { TxRequest } from '@/hooks/useSafeTx'
import { untilAborted } from '@/lib/hook-logs'
import { jbCenterPublicClient } from '@/lib/jbcenter-rpc'

/** Why the chain refuses a call, in the words of its revert when it has any. */
export function reasonOf(error: unknown): string {
  if (!(error instanceof BaseError)) return error instanceof Error ? error.message : 'no reason was given'
  const reverted = error.walk(cause => cause instanceof ContractFunctionRevertedError)
  return reverted instanceof ContractFunctionRevertedError
    ? (reverted.data?.errorName ?? reverted.reason ?? reverted.shortMessage)
    : error.shortMessage
}

/**
 * `step` tried against the chain as `account` will send it, before its review is shown: the request the review shows,
 * asked of a node. A call the chain would refuse is refused here, in `refusal`'s words and the chain's, and the cause
 * is kept.
 */
export async function preflight(step: TxRequest, account: Address, signal: AbortSignal, refusal: string): Promise<void> {
  try {
    await untilAborted(
      jbCenterPublicClient(step.chainId).simulateContract({
        account,
        address: step.address,
        abi: step.abi,
        functionName: step.functionName,
        args: step.args as unknown[],
        value: step.value,
      }),
      signal,
    )
  } catch (cause) {
    if (signal.aborted) throw cause
    throw new Error(`${refusal}: ${reasonOf(cause)}`, { cause })
  }
}
