import { BaseError, ContractFunctionRevertedError, type Address } from 'viem'
import { ReviewLineError } from '@bananapus/nana-sdk-core/review'
import type { TxRequest } from '@/hooks/useReviewedAction'
import { untilAborted } from '@/lib/hook-logs'
import { jbCenterPublicClient } from '@/lib/jbcenter-public-client'

/** The custom error a call reverted with, named by Sticky's own ABIs: the one part of a node's answer said to a person.
 * Undefined when the call did not revert, and null when it reverted with nothing those ABIs name. */
function revertOf(error: unknown): string | null | undefined {
  const reverted = error instanceof BaseError ? error.walk(cause => cause instanceof ContractFunctionRevertedError) : null
  return reverted instanceof ContractFunctionRevertedError ? (reverted.data?.errorName ?? null) : undefined
}

/**
 * `step` tried against the chain as `account` will send it, before its review is shown: the request the review shows,
 * asked of a node, with the flow's signal. A call the chain would refuse is refused here, in `refusal`'s words and the
 * name of its custom error, and the cause is kept.
 */
export async function preflight(step: TxRequest, account: Address, signal: AbortSignal, refusal: string): Promise<void> {
  try {
    await untilAborted(
      jbCenterPublicClient(step.chainId, signal).simulateContract({
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
    const reverted = revertOf(cause)
    // A node that failed to answer is the network's error, which core's line says with its retry.
    if (reverted === undefined) throw cause
    throw new ReviewLineError(reverted ? `${refusal}: ${reverted}` : `${refusal}.`, { cause })
  }
}
