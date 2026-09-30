import { numberToHex, type Address, type Hex, type PublicClient } from 'viem'

/** A generous explicit ceiling for reviewed project-action preflights. */
export const TRANSACTION_SIMULATION_GAS = 10_000_000n
export const TRANSACTION_SIMULATION_MAX_RETURN_BYTES = 4_096

/**
 * Simulate a state-changing transaction without invoking Viem's CCIP-read
 * machinery. A target-controlled OffchainLookup revert must remain a revert:
 * following its URL would turn an authorization preflight into an SSRF surface
 * and would not match the eventual onchain transaction.
 */
export async function simulateStateChangingTransaction(
  client: PublicClient,
  {
    from,
    to,
    data,
    value = 0n,
    gas = TRANSACTION_SIMULATION_GAS,
  }: {
    from: Address
    to: Address
    data: Hex
    value?: bigint
    gas?: bigint
  },
): Promise<Hex> {
  if (gas <= 0n) throw new Error('Transaction simulation gas must be positive.')
  // Raw JSON-RPC deliberately bypasses call()/simulateContract(), whose
  // behavior can inherit a client-level CCIP-read policy.
  const result = await client.request({
    method: 'eth_call',
    params: [
      {
        from,
        to,
        data,
        value: numberToHex(value),
        gas: numberToHex(gas),
      },
      'latest',
    ],
  })
  if (typeof result !== 'string' || !/^0x(?:[0-9a-f]{2})*$/iu.test(result)) {
    throw new Error('Transaction simulation returned malformed data.')
  }
  const returnBytes = (result.length - 2) / 2
  if (
    !Number.isSafeInteger(returnBytes) ||
    returnBytes > TRANSACTION_SIMULATION_MAX_RETURN_BYTES
  ) {
    throw new Error('Transaction simulation returned too much data.')
  }
  return result as Hex
}
