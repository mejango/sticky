/**
 * Reward addresses: one receiver for each Sticky token and reward group, which turns plain transfers (a launchpad's fee
 * payouts, say) into airdrops once anyone settles them. Its address is fixed before it exists, so it can be given out as a
 * recipient at once. The factory is held to this deployment's distributor first: a receiver settles into its factory's
 * distributor, and one that is not this deployment's would fund another.
 */

import { erc20Abi, isAddressEqual, type Address } from 'viem'
import { asked } from '@/lib/hook-logs'
import { jbCenterPublicClient } from '@/lib/jbcenter-rpc'
import { stickyRewardReceiverFactoryAbi } from '@/lib/sticky-abis'
import { stickyDeployment, type StickyDeployment } from '@/lib/sticky-addresses'
import type { Answer } from '@/lib/sticky-project'
import { need, readAt } from '@/lib/sticky-rewards'

type Cancel = { signal?: AbortSignal }

/** Where a group's reward address is, and whether it has been created. */
export type RewardReceiver = { address: Address; created: boolean }

function deploymentOn(chainId: number): StickyDeployment {
  const deployment = stickyDeployment(chainId)
  if (!deployment) throw new Error(`Sticky is not deployed on chain ${chainId}.`)
  return deployment
}

/**
 * The reward address of the holders of `stToken` in group `groupId` (OLD renderRewardAddress, app.js:4040): where the
 * factory predicts it, and whether it has code, read once the factory is known to settle into this deployment's
 * distributor. A factory that settles into another is refused, and a read that cannot be made rejects, naming what it
 * could not read.
 */
export async function readReceiver(
  chainId: number,
  stToken: Address,
  groupId: bigint,
  { signal }: Cancel = {},
): Promise<RewardReceiver> {
  const { rewardReceiverFactory: factory, distributor } = deploymentOn(chainId)
  const [settlesInto, predicted] = (await asked(
    'the reward address',
    () =>
      readAt(
        chainId,
        [
          { address: factory, abi: stickyRewardReceiverFactoryAbi, functionName: 'DISTRIBUTOR' },
          { address: factory, abi: stickyRewardReceiverFactoryAbi, functionName: 'predictReceiverOf', args: [stToken, groupId] },
        ],
        undefined,
        signal,
      ),
    signal,
  )) as Answer<Address>[]
  if (!isAddressEqual(need(settlesInto, "the factory's distributor"), distributor)) {
    throw new Error('the reward receiver factory uses a different distributor')
  }
  const address = need(predicted, 'the reward address')
  const code = await asked('whether the reward address is created', () => jbCenterPublicClient(chainId).getCode({ address }), signal)
  return { address, created: code !== undefined && code !== '0x' }
}

/** What a reward address holds of an ERC-20, which settling it makes this round's rewards. */
export async function readArrivals(chainId: number, receiver: Address, token: Address, { signal }: Cancel = {}): Promise<bigint> {
  const [held] = (await asked(
    'the arrivals',
    () => readAt(chainId, [{ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [receiver] }], undefined, signal),
    signal,
  )) as Answer<bigint>[]
  return need(held, 'the arrivals')
}
