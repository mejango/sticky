// @vitest-environment node

import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  multicall3Abi,
  type Hex,
} from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SUPPORTED_CHAINS } from '@/lib/chains'
import { jbCenterPublicClient, jbCenterRpcTransport } from '@/lib/jbcenter-rpc'

afterEach(() => {
  vi.unstubAllGlobals()
})

const BASE = 8453
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const HOLDER = '0x000000000000000000000000000000000000dEaD'
const word = (value: bigint): Hex => encodeFunctionResult({ abi: erc20Abi, functionName: 'totalSupply', result: value })

/** A Center that answers `eth_call`s: single reads with one word, Multicall3 batches with one word per call. */
function center() {
  const requests: { url: string; method: string; to: string; calls?: number }[] = []
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const { id, method, params } = JSON.parse(String(init.body)) as {
      id: number
      method: string
      params: [{ to: string; data: Hex }]
    }
    const [{ to, data }] = params
    let result: Hex = word(5n)
    let calls: number | undefined
    if (method === 'eth_call' && to.toLowerCase() === '0xca11bde05977b3631167028862be2a173976ca11') {
      const [batch] = decodeFunctionData({ abi: multicall3Abi, data }).args as [readonly unknown[]]
      calls = batch.length
      result = encodeFunctionResult({
        abi: multicall3Abi,
        functionName: 'aggregate3',
        result: batch.map(() => ({ success: true, returnData: word(5n) })),
      })
    }
    requests.push({ url, method, to, calls })
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { requests, fetchMock }
}

const read = (client: ReturnType<typeof jbCenterPublicClient>, functionName: 'balanceOf' | 'totalSupply') =>
  functionName === 'balanceOf'
    ? client.readContract({ address: USDC, abi: erc20Abi, functionName, args: [HOLDER] })
    : client.readContract({ address: USDC, abi: erc20Abi, functionName })

describe('the Center reader', () => {
  it('is one client per chain, made once', () => {
    expect(jbCenterPublicClient(BASE)).toBe(jbCenterPublicClient(BASE))
    expect(jbCenterPublicClient(BASE)).not.toBe(jbCenterPublicClient(1))
  })

  it.each(SUPPORTED_CHAINS.map(chain => [chain.name, chain.id] as const))(
    'has %s set, with its Multicall3 address, so batching can happen',
    (_name, chainId) => {
      const client = jbCenterPublicClient(chainId)
      expect(client.chain?.id).toBe(chainId)
      expect(client.chain?.contracts?.multicall3?.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    },
  )

  it('sends reads made together as one Multicall3 request', async () => {
    const { requests, fetchMock } = center()
    const client = jbCenterPublicClient(BASE)

    const results = await Promise.all([read(client, 'balanceOf'), read(client, 'totalSupply'), read(client, 'balanceOf')])

    expect(results).toEqual([5n, 5n, 5n])
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(requests).toEqual([
      { url: 'https://juicebox.center/v1/rpc/8453', method: 'eth_call', to: expect.stringMatching(/^0xca11/i), calls: 3 },
    ])
  })

  it('would send each read alone through a client without a chain, which is what this reader prevents', async () => {
    const { requests } = center()
    const withoutChain = createPublicClient({
      transport: jbCenterRpcTransport(BASE),
      batch: { multicall: true },
    })

    await Promise.all([read(withoutChain as never, 'balanceOf'), read(withoutChain as never, 'totalSupply')])

    expect(requests.map(request => request.calls)).toEqual([undefined, undefined])
    expect(requests.map(request => request.to.toLowerCase())).toEqual([USDC.toLowerCase(), USDC.toLowerCase()])
  })

  it('reads on the chain it was made for', async () => {
    const { requests } = center()
    await read(jbCenterPublicClient(10), 'totalSupply')
    expect(requests.map(request => request.url)).toEqual(['https://juicebox.center/v1/rpc/10'])
  })
})
