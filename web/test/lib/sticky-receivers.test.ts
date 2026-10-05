// @vitest-environment node

import { erc20Abi } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stickyRewardReceiverFactoryAbi } from '@/lib/sticky-abis'
import { CHAIN, OTHER, REVERT, STAKED, STICKY, address, deployment, rewardChain } from './sticky-reward-fixtures'

// The reward address of a Sticky token's group: where the factory puts it, whether it is created, and what it holds to
// settle, through the real Center reader against a fake Center (sticky-reward-fixtures.ts).

async function load() {
  vi.resetModules()
  return import('@/lib/sticky-receivers')
}

const FACTORY = deployment.rewardReceiverFactory
const RECEIVER = address('8')

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

function factory(chain: ReturnType<typeof rewardChain>, distributor = deployment.distributor) {
  chain.stock(FACTORY, stickyRewardReceiverFactoryAbi, 'DISTRIBUTOR', distributor)
  chain.stock(FACTORY, stickyRewardReceiverFactoryAbi, 'predictReceiverOf', RECEIVER)
}

describe('readReceiver', () => {
  it('receiver prediction and settlement are per group: the factory predicts the address of the Sticky token\'s group', async () => {
    const chain = rewardChain()
    factory(chain)
    const { readReceiver } = await load()
    expect(await readReceiver(CHAIN, STICKY, 4000n)).toEqual({ address: RECEIVER, created: false })
    expect(chain.reads()).toEqual([
      { target: FACTORY, functionName: 'DISTRIBUTOR', args: [] },
      { target: FACTORY, functionName: 'predictReceiverOf', args: [STICKY, 4000n] },
    ])
    expect(chain.requests.at(-1)).toMatchObject({ method: 'eth_getCode' })
  })

  it('says the address is created when it has code', async () => {
    const chain = rewardChain()
    factory(chain)
    chain.deploy(RECEIVER)
    const { readReceiver } = await load()
    expect(await readReceiver(CHAIN, STICKY, 0n)).toEqual({ address: RECEIVER, created: true })
  })

  it('refuses a factory that settles into another distributor than this deployment\'s, and asks nothing more', async () => {
    const chain = rewardChain()
    factory(chain, OTHER)
    const { readReceiver } = await load()
    await expect(readReceiver(CHAIN, STICKY, 0n)).rejects.toThrow('the reward receiver factory uses a different distributor')
    expect(chain.requests.some(request => request.method === 'eth_getCode')).toBe(false)
  })

  it('names what could not be read, and never takes it for an address that is not created', async () => {
    const chain = rewardChain()
    chain.stock(FACTORY, stickyRewardReceiverFactoryAbi, 'DISTRIBUTOR', deployment.distributor)
    chain.stock(FACTORY, stickyRewardReceiverFactoryAbi, 'predictReceiverOf', REVERT)
    const { readReceiver } = await load()
    await expect(readReceiver(CHAIN, STICKY, 0n)).rejects.toMatchObject({
      message: 'the reward address could not be read.',
      cause: expect.any(Error),
    })
  })
})

describe('readArrivals', () => {
  it('reads what a reward address holds of a token, waiting to settle', async () => {
    const chain = rewardChain()
    chain.stock(STAKED, erc20Abi, 'balanceOf', 1_500_000n)
    const { readArrivals } = await load()
    expect(await readArrivals(CHAIN, RECEIVER, STAKED)).toBe(1_500_000n)
    expect(chain.reads()).toEqual([{ target: STAKED, functionName: 'balanceOf', args: [RECEIVER] }])
  })

  it('names the arrivals when they cannot be read', async () => {
    const chain = rewardChain()
    chain.stock(STAKED, erc20Abi, 'balanceOf', REVERT)
    const { readArrivals } = await load()
    await expect(readArrivals(CHAIN, RECEIVER, STAKED)).rejects.toThrow('the arrivals could not be read.')
  })
})
