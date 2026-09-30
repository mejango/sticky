// @vitest-environment node

import {
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  erc20Abi_bytes32,
  getAddress,
  multicall3Abi,
  stringToHex,
  toFunctionSelector,
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
} from 'viem'
import { describe, expect, it, vi } from 'vitest'
import {
  controllerAbi,
  stickyDeployerAbi,
  stickyHookAbi,
  stickyTokenAbi,
  terminalAbi,
  terminalStoreAbi,
} from '@/lib/sticky-abis'
import { stickyDeployment } from '@/lib/sticky-addresses'

// The same reads as sticky-project.test.ts, but through the real Center reader, so viem's own
// multicall, its Multicall3 batching and its error shapes are in play and only the HTTP call to
// Center is faked. Telling a lost request from a revert rests on those shapes.

const CHAIN = 84532
// Past Base Sepolia's Multicall3 deployment, which viem checks when a read is pinned to a block.
const HEAD = 47_400_000n
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'
const deployment = stickyDeployment(CHAIN)!
const address = (digit: string) => getAddress(`0x${digit.repeat(40)}`)
const STAKED = address('2')
const STICKY = address('3')
const STORE = address('4')
const LAUNCH = '11111111-2222-4333-8444-555555555555'
const URI =
  'data:application/json;charset=utf-8,' +
  encodeURIComponent(JSON.stringify({ protocol: 'Sticky', version: 1, launchId: LAUNCH }))

type Call = { target: Address; callData: Hex }
type Request = { method: string; block?: unknown; calls?: readonly Call[] }

/** A Center that answers Multicall3's aggregate3 from a table of what each contract returns. */
function center() {
  const table = new Map<string, { success: boolean; returnData: Hex }>()
  const stock = (target: Address, abi: Abi, functionName: string, result: unknown, success = true) => {
    const item = abi.find((entry): entry is AbiFunction => entry.type === 'function' && entry.name === functionName)!
    table.set(`${target.toLowerCase()}:${toFunctionSelector(item)}`, {
      success,
      returnData: success ? encodeFunctionResult({ abi, functionName, result }) : '0x',
    })
  }
  const requests: Request[] = []
  let refuse: (calls: readonly Call[]) => boolean = () => false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const { id, method, params } = JSON.parse(String(init.body)) as {
        id: number
        method: string
        params: [{ to: string; data: Hex }, unknown]
      }
      const envelope = (result: unknown) =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
          headers: { 'content-type': 'application/json' },
        })
      if (method === 'eth_blockNumber') {
        requests.push({ method })
        return envelope(`0x${HEAD.toString(16)}`)
      }
      if (method !== 'eth_call' || params[0].to.toLowerCase() !== MULTICALL3) {
        throw new Error(`unexpected ${method} to ${params?.[0]?.to}`)
      }
      const [calls] = decodeFunctionData({ abi: multicall3Abi, data: params[0].data }).args as readonly [readonly Call[]]
      requests.push({ method, block: params[1], calls })
      if (refuse(calls)) {
        return new Response(JSON.stringify({ error: { message: 'slow down' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        })
      }
      return envelope(
        encodeFunctionResult({
          abi: multicall3Abi,
          functionName: 'aggregate3',
          result: calls.map(({ target, callData }) => {
            const answer = table.get(`${target.toLowerCase()}:${callData.slice(0, 10)}`)
            if (!answer) throw new Error(`the fake chain has nothing at ${target} for ${callData.slice(0, 10)}`)
            return answer
          }),
        }),
      )
    }),
  )
  return {
    stock,
    requests,
    /** Answers any request that carries a call to this contract with a 429, as Center does when it is busy. */
    refuseCallsTo(target: Address) {
      refuse = calls => calls.some(call => call.target.toLowerCase() === target.toLowerCase())
    },
  }
}

function stockProject(
  chain: ReturnType<typeof center>,
  { soulbound, text = 'string' }: { soulbound: boolean | 'reverts'; text?: 'string' | 'bytes32' | 'reverts' },
) {
  const { stock } = chain
  stock(deployment.deployer, stickyDeployerAbi, 'stakedTokenOf', STAKED)
  stock(deployment.deployer, stickyDeployerAbi, 'cashOutTaxRateOf', 1000n)
  stock(deployment.hook, stickyHookAbi, 'tokenOf', STICKY)
  stock(deployment.hook, stickyHookAbi, 'orphanedBalanceOf', 4n)
  stock(deployment.terminal, terminalAbi, 'STORE', STORE)
  stock(deployment.controller, controllerAbi, 'uriOf', URI)
  // The staked token's symbol and name: a string, a bytes32 as MKR returns, or nothing at all.
  if (text === 'bytes32') {
    stock(STAKED, erc20Abi_bytes32, 'symbol', stringToHex('MKR', { size: 32 }))
    stock(STAKED, erc20Abi_bytes32, 'name', stringToHex('Maker', { size: 32 }))
  } else {
    stock(STAKED, erc20Abi, 'symbol', 'ART', text === 'string')
    stock(STAKED, erc20Abi, 'name', 'Art', text === 'string')
  }
  stock(STAKED, erc20Abi, 'decimals', 6)
  stock(STICKY, stickyTokenAbi, 'symbol', 'STICKYART')
  stock(STICKY, stickyTokenAbi, 'name', 'Streaking ART')
  stock(STICKY, stickyTokenAbi, 'SOULBOUND', soulbound === 'reverts' ? false : soulbound, soulbound !== 'reverts')
  stock(STICKY, stickyTokenAbi, 'totalSupply', 10n ** 18n)
  stock(STORE, terminalStoreAbi, 'balanceOf', 10n)
}

// The Center reader is made once per chain, and viem caches the block number for a moment, so each
// test loads its own copy.
async function load() {
  vi.resetModules()
  return import('@/lib/sticky-project')
}

describe('readStickyProject through the Center reader', () => {
  it('asks Center for the block, then for each round as one Multicall3 request at that block', async () => {
    const chain = center()
    stockProject(chain, { soulbound: false })
    const { readStickyProject } = await load()

    const info = await readStickyProject(CHAIN, 12n)

    expect(info).toEqual({
      chainId: CHAIN,
      projectId: 12n,
      stToken: STICKY,
      stSymbol: 'STICKYART',
      stName: 'Streaking ART',
      stakedToken: STAKED,
      symbol: 'ART',
      name: 'Art',
      decimals: 6,
      cashOutTaxRate: 1000n,
      soulbound: false,
      totalSupply: 10n ** 18n,
      backing: 6n,
      orphaned: 4n,
      rawBacking: 10n,
      savedOrphaned: 4n,
      launchId: LAUNCH,
      blockNumber: HEAD,
    })
    expect(chain.requests.map(({ method, block, calls }) => [method, block, calls?.length])).toEqual([
      ['eth_blockNumber', undefined, undefined],
      ['eth_call', `0x${HEAD.toString(16)}`, 6],
      // The staked token's symbol and name are asked as a string and as a bytes32: two calls more.
      ['eth_call', `0x${HEAD.toString(16)}`, 10],
    ])
  })

  it('reads a bytes32 symbol and name, as MKR returns, once real viem has failed to decode them as strings', async () => {
    const chain = center()
    stockProject(chain, { soulbound: false, text: 'bytes32' })
    const { readStickyProject } = await load()
    expect(await readStickyProject(CHAIN, 12n)).toMatchObject({ symbol: 'MKR', name: 'Maker' })
  })

  it('fails when the staked token answers neither as a string nor as a bytes32', async () => {
    const chain = center()
    stockProject(chain, { soulbound: false, text: 'reverts' })
    const { readStickyProject } = await load()
    await expect(readStickyProject(CHAIN, 12n)).rejects.toThrow(/could not be read/)
  })

  it('reads a SOULBOUND() that reverts inside Multicall3 as locked', async () => {
    const chain = center()
    stockProject(chain, { soulbound: 'reverts' })
    const { readStickyProject } = await load()
    expect((await readStickyProject(CHAIN, 12n)).soulbound).toBe(true)
  })

  it('does not read a refused request as a locked token', async () => {
    const chain = center()
    stockProject(chain, { soulbound: false })
    chain.refuseCallsTo(STICKY)
    const { readStickyProject } = await load()
    // viem names a lost request for Multicall3's function, not the call's: that is how it is told from a revert.
    await expect(readStickyProject(CHAIN, 12n)).rejects.toMatchObject({ functionName: 'aggregate3' })
  })
})

describe('verifyStickyDeployment through the Center reader', () => {
  const stockDeployer = (chain: ReturnType<typeof center>, hook: Address) => {
    chain.stock(deployment.deployer, stickyDeployerAbi, 'HOOK', hook)
    chain.stock(deployment.deployer, stickyDeployerAbi, 'TERMINAL', deployment.terminal)
    chain.stock(deployment.deployer, stickyDeployerAbi, 'CONTROLLER', deployment.controller)
  }

  it('asks the deployer for all three in one request and accepts what was recorded', async () => {
    const chain = center()
    stockDeployer(chain, deployment.hook)
    const { verifyStickyDeployment } = await load()
    await expect(verifyStickyDeployment(CHAIN)).resolves.toBeUndefined()
    expect(chain.requests.map(({ method, calls }) => [method, calls?.length])).toEqual([['eth_call', 3]])
  })

  it('throws StickyDeploymentMismatch when the deployer reports another hook', async () => {
    const chain = center()
    stockDeployer(chain, address('9'))
    const { StickyDeploymentMismatch, verifyStickyDeployment } = await load()
    await expect(verifyStickyDeployment(CHAIN)).rejects.toBeInstanceOf(StickyDeploymentMismatch)
  })

  it('reads a deployer that reverts as a mismatch', async () => {
    const chain = center()
    stockDeployer(chain, deployment.hook)
    chain.stock(deployment.deployer, stickyDeployerAbi, 'HOOK', undefined, false)
    const { StickyDeploymentMismatch, verifyStickyDeployment } = await load()
    await expect(verifyStickyDeployment(CHAIN)).rejects.toBeInstanceOf(StickyDeploymentMismatch)
  })

  it('does not read a refused request as a mismatch', async () => {
    const chain = center()
    stockDeployer(chain, deployment.hook)
    chain.refuseCallsTo(deployment.deployer)
    const { StickyDeploymentMismatch, verifyStickyDeployment } = await load()
    const error = await verifyStickyDeployment(CHAIN).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ functionName: 'aggregate3' })
    expect(error).not.toBeInstanceOf(StickyDeploymentMismatch)
  })
})
