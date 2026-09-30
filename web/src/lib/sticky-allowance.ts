import { erc20Abi, type Address } from 'viem'
import { freshHead } from '@/lib/hook-logs'
import { jbCenterPublicClient } from '@/lib/jbcenter-rpc'
import type { Answer } from '@/lib/sticky-project'
import { asked } from '@/lib/sticky-quotes'
import { need, readAt } from '@/lib/sticky-rewards'

/**
 * What `owner` holds of a token and has allowed `spender` to take of it, read together at a head that is asked for
 * afresh. A review plans from what it finds here, and a head that viem kept from a moment ago could be one from before
 * an approval that has landed since. A read that cannot be made rejects, naming what could not be read and keeping the
 * cause: it is never filled in as zero.
 */
export async function readBalanceAndAllowance(
  chainId: number,
  { token, owner, spender }: { token: Address; owner: Address; spender: Address },
  { signal }: { signal?: AbortSignal } = {},
): Promise<{ balance: bigint; allowance: bigint }> {
  const [balance, allowance] = (await asked(
    'the balance and the allowance',
    async () =>
      readAt(
        chainId,
        [
          { address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] },
          { address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] },
        ],
        await freshHead(jbCenterPublicClient(chainId), signal),
        signal,
      ),
    signal,
  )) as Answer<bigint>[]
  return { balance: need(balance, 'the balance'), allowance: need(allowance, 'the allowance') }
}
