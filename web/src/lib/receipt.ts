import type { Hex, PublicClient, TransactionReceipt } from 'viem'

export class TransactionReceiptUnavailableError extends Error {
  readonly name = 'TransactionReceiptUnavailableError'

  constructor(
    readonly hash: Hex,
    readonly chainId?: number,
    options?: ErrorOptions,
  ) {
    super(
      `Transaction ${hash} was submitted${chainId ? ` on chain ${chainId}` : ''}, but confirmation tracking is temporarily unavailable. Check this transaction and do not submit it again yet.`,
      options,
    )
  }
}

export function isTransactionReceiptUnavailableError(
  error: unknown,
): error is TransactionReceiptUnavailableError {
  return error instanceof TransactionReceiptUnavailableError
}

/** Fall back to direct receipt reads when viem's receipt watcher rejects. */
export async function waitForTrackedReceipt(
  client: PublicClient,
  hash: Hex,
  options: { attempts?: number; intervalMs?: number } = {},
): Promise<TransactionReceipt> {
  try {
    return await client.waitForTransactionReceipt({ hash, timeout: 120_000 })
  } catch (cause) {
    const attempts = Math.max(1, options.attempts ?? 90)
    const intervalMs = Math.max(0, options.intervalMs ?? 2_000)
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await client.getTransactionReceipt({ hash })
      } catch {
        if (attempt + 1 < attempts) {
          await new Promise(resolve => setTimeout(resolve, intervalMs))
        }
      }
    }
    throw new TransactionReceiptUnavailableError(hash, client.chain?.id, {
      cause,
    })
  }
}
