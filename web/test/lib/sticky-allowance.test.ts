// @vitest-environment node

import { erc20Abi } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CHAIN,
  HOLDER,
  REVERT,
  STAKED,
  blockHex,
  deployment,
  rewardChain,
  shape,
} from './sticky-reward-fixtures'

// What a holder has of a token and has let a spender take of it, read through the real Center reader against a fake
// Center (sticky-reward-fixtures.ts). A review sends what it reads here, so it is read at a head asked for afresh.

async function load() {
  vi.resetModules()
  return import('@/lib/sticky-allowance')
}

const TERMINAL = deployment.terminal
const token = { token: STAKED, owner: HOLDER, spender: TERMINAL }

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('readBalanceAndAllowance', () => {
  it('reads the balance and the allowance at the head, together in one request', async () => {
    const chain = rewardChain()
    chain.stock(STAKED, erc20Abi, 'balanceOf', 500n)
    chain.stock(STAKED, erc20Abi, 'allowance', 7n)
    const { readBalanceAndAllowance } = await load()

    expect(await readBalanceAndAllowance(CHAIN, token)).toEqual({ balance: 500n, allowance: 7n })

    expect(shape(chain.requests)).toEqual([
      ['eth_blockNumber', undefined, undefined],
      ['eth_call', blockHex, 2],
    ])
    expect(chain.reads()).toEqual([
      { target: STAKED, functionName: 'balanceOf', args: [HOLDER] },
      { target: STAKED, functionName: 'allowance', args: [HOLDER, TERMINAL] },
    ])
  })

  it('asks the node for the head each time, never taking the last one viem kept', async () => {
    const chain = rewardChain()
    chain.stock(STAKED, erc20Abi, 'balanceOf', 1n)
    chain.stock(STAKED, erc20Abi, 'allowance', 1n)
    const { readBalanceAndAllowance } = await load()

    await readBalanceAndAllowance(CHAIN, token)
    await readBalanceAndAllowance(CHAIN, token)

    expect(chain.requests.filter(request => request.method === 'eth_blockNumber')).toHaveLength(2)
  })

  it('takes a token that reverts for what it is, and never for a balance or an allowance of nothing', async () => {
    const chain = rewardChain()
    chain.stock(STAKED, erc20Abi, 'balanceOf', 500n)
    chain.stock(STAKED, erc20Abi, 'allowance', REVERT)
    const { readBalanceAndAllowance } = await load()
    await expect(readBalanceAndAllowance(CHAIN, token)).rejects.toMatchObject({
      message: 'the allowance could not be read.',
      cause: expect.any(Error),
    })

    chain.stock(STAKED, erc20Abi, 'balanceOf', REVERT)
    await expect(readBalanceAndAllowance(CHAIN, token)).rejects.toThrow('the balance could not be read.')
  })

  it('takes a request Center refuses for what it is, and keeps the cause', async () => {
    const chain = rewardChain()
    chain.stock(STAKED, erc20Abi, 'balanceOf', 500n)
    chain.stock(STAKED, erc20Abi, 'allowance', 7n)
    chain.lose(() => true)
    const { readBalanceAndAllowance } = await load()
    await expect(readBalanceAndAllowance(CHAIN, token)).rejects.toMatchObject({
      message: 'the balance and the allowance could not be read.',
      cause: expect.any(Error),
    })
  })

  it('stops with the reason of a signal that aborts, and reads nothing', async () => {
    const chain = rewardChain()
    chain.stock(STAKED, erc20Abi, 'balanceOf', 500n)
    chain.stock(STAKED, erc20Abi, 'allowance', 7n)
    const { readBalanceAndAllowance } = await load()
    const controller = new AbortController()
    controller.abort(new Error('the page moved on'))
    await expect(readBalanceAndAllowance(CHAIN, token, { signal: controller.signal })).rejects.toThrow('the page moved on')
    expect(chain.requests).toEqual([])
  })
})
