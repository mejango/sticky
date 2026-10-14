import { TransactionNotFoundError, TransactionReceiptNotFoundError, toHex, type Address, type Hex } from 'viem'
import { holds } from '@/lib/write-holds'

/**
 * A chain the SDK's hold can read, for tests that drive a saved write through the SDK itself: transactions it knows
 * (pending or mined), and an account nonce that moves once one is mined.
 */
export function heldChain(chainId: number) {
  const transactions = new Map<string, Record<string, unknown>>()
  const receipts = new Map<string, Record<string, unknown>>()
  let mined = 0
  const block = (number: bigint) => ({ hash: toHex(number, { size: 32 }), number, timestamp: 1_800_000_000n + number, transactions: [...receipts.keys()] })
  const client = {
    getChainId: async () => chainId,
    getBlockNumber: async () => 100n,
    getTransactionCount: async () => 7 + mined,
    getBlock: async (args?: { blockNumber?: bigint }) => block(args?.blockNumber ?? 100n),
    getTransaction: async ({ hash }: { hash: Hex }) => {
      const found = transactions.get(hash.toLowerCase())
      if (!found) throw new TransactionNotFoundError({ hash })
      return found
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const found = receipts.get(hash.toLowerCase())
      if (!found) throw new TransactionReceiptNotFoundError({ hash })
      return found
    },
  }
  const sent = (hash: Hex, call: { to: Address; data: Hex; value?: bigint }, from: Address) =>
    ({ hash, chainId, from, to: call.to, input: call.data, value: call.value ?? 0n, nonce: 7, type: 'eip1559' })
  return {
    client,
    /** In the mempool: known, not mined. */
    pending(hash: Hex, call: { to: Address; data: Hex; value?: bigint }, from: Address) {
      transactions.set(hash.toLowerCase(), { ...sent(hash, call, from), blockNumber: null, blockHash: null, transactionIndex: null })
    },
    /** Mined at block 90, with its receipt. */
    mined(hash: Hex, call: { to: Address; data: Hex; value?: bigint }, from: Address, status: 'success' | 'reverted' = 'success') {
      const placed = { blockNumber: 90n, blockHash: block(90n).hash, transactionIndex: 0 }
      transactions.set(hash.toLowerCase(), { ...sent(hash, call, from), ...placed })
      receipts.set(hash.toLowerCase(), {
        transactionHash: hash, status, from, to: call.to, logs: [], contractAddress: null, logsBloom: `0x${'0'.repeat(512)}`,
        cumulativeGasUsed: 50_000n, gasUsed: 50_000n, effectiveGasPrice: 1n, type: 'eip1559', ...placed,
      })
      mined = 1
    },
  }
}

/** A saved write the SDK holds as a previous visit left it: reserved, with the wallet's hash when it returned one. */
export async function heldWrite({ chainId, account, namespace, call, client, hash }: {
  chainId: number
  account: Address
  namespace: string
  call: { to: Address; data: Hex; value?: bigint }
  client: ReturnType<typeof heldChain>['client']
  hash?: Hex
}) {
  const handle = holds.open({ chainId, account, safe: false, namespace, call: { ...call, value: call.value ?? 0n } })
  await handle.send(client as never, async gate => {
    await gate.beforeSend()
    if (!hash) throw new Error('The wallet reply was lost.')
    gate.afterSubmit(hash)
    return hash
  }).catch(() => undefined)
  return handle
}
