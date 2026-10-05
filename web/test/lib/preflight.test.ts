// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stickyDistributorAbi } from '@/lib/sticky-abis'
import { CHAIN, HOLDER, REVERT, STICKY, deployment, rewardChain } from './sticky-reward-fixtures'

// A request tried against the chain before its review is shown, as the account that will send it, through the real
// Center reader against a fake Center (sticky-reward-fixtures.ts).

async function load() {
  vi.resetModules()
  return import('@/lib/preflight')
}

const collect = {
  chainId: CHAIN,
  address: deployment.distributor,
  abi: stickyDistributorAbi,
  functionName: 'collectVestedRewards',
  args: [STICKY, 0n, [BigInt(HOLDER)], [STICKY], HOLDER] as const,
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('preflight', () => {
  it('asks the chain as the sender, and goes on when the chain would take the call', async () => {
    const chain = rewardChain()
    chain.stock(deployment.distributor, stickyDistributorAbi, 'collectVestedRewards', undefined, 5)
    const { preflight } = await load()
    await expect(preflight(collect, HOLDER, new AbortController().signal, 'The distributor would refuse this')).resolves.toBeUndefined()
    expect(chain.requests).toEqual([
      expect.objectContaining({ method: 'eth_call', from: HOLDER, reads: [expect.objectContaining({ functionName: 'collectVestedRewards' })] }),
    ])
  })

  it('refuses a call the chain would refuse, in the words given and the chain\'s, and keeps the cause', async () => {
    const chain = rewardChain()
    chain.stock(deployment.distributor, stickyDistributorAbi, 'collectVestedRewards', REVERT, 5)
    const { preflight } = await load()
    await expect(preflight(collect, HOLDER, new AbortController().signal, 'The distributor would refuse this')).rejects.toMatchObject({
      message: expect.stringMatching(/^The distributor would refuse this: .+/),
      cause: expect.any(Error),
    })
  })

  it('stops with the reason of a signal that aborts', async () => {
    rewardChain()
    const { preflight } = await load()
    const controller = new AbortController()
    controller.abort(new Error('the page moved on'))
    await expect(preflight(collect, HOLDER, controller.signal, 'The distributor would refuse this')).rejects.toThrow('the page moved on')
  })
})
