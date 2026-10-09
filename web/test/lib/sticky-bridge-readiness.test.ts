import { getJBContractAddress, jbControllerAbi } from '@bananapus/nana-sdk-core'
import { pad, type Address, type PublicClient } from 'viem'
import { expect, it, vi } from 'vitest'
import { BRIDGE_NATIVE_TOKEN, createStickyBridge, type BridgeRoute } from '@/lib/sticky-bridge'

vi.mock('@/lib/jbcenter-rpc', () => ({ jbCenterPublicClient: vi.fn() }))

const address = (id: number) => `0x${id.toString(16).padStart(40, '0')}` as Address

it('refuses source preparation when the registered destination peer cannot mint the reviewed rewards', async () => {
  const controller = address(50), owner = address(51), receiver = address(52)
  const route: BridgeRoute = {
    source: { chainId: 10 }, destination: { chainId: 1 }, sourceSucker: address(11), destinationSucker: address(12),
    sourceProjectId: '3', destinationProjectId: '30', sourceToken: address(31), rewardToken: address(32),
    backingToken: BRIDGE_NATIVE_TOKEN, remoteBackingToken: BRIDGE_NATIVE_TOKEN,
    terminal: getJBContractAddress('JBMultiTerminal', 6, 10), sourceMeta: { symbol: 'TOK', decimals: 18 },
    rewardMeta: { symbol: 'TOK', decimals: 18 }, backingMeta: { symbol: 'ETH', decimals: 18 }, canPrepare: true,
  }
  const clients = new Map<number, PublicClient>()
  const mint = vi.fn(async () => { throw new Error('JBController_MintNotAllowedAndNotTerminalOrHook') })
  const clientFor = (chainId: number): PublicClient => {
    if (clients.has(chainId)) return clients.get(chainId)!
    const source = chainId === 10
    const client = {
      getChainId: async () => chainId, getCode: async () => '0x6000', simulateContract: mint,
      readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
        switch (functionName) {
          case 'isSuckerOf': return true
          case 'peer': return pad(source ? route.destinationSucker : route.sourceSucker)
          case 'peerChainId': return BigInt(source ? 1 : 10)
          case 'projectId': return BigInt(source ? 3 : 30)
          case 'tokenOf': return source ? route.sourceToken : route.rewardToken
          case 'TOKENS': return getJBContractAddress('JBTokens', 6, chainId as 1 | 10)
          case 'DIRECTORY': return getJBContractAddress('JBDirectory', 6, chainId as 1 | 10)
          case 'remoteTokenFor': return { enabled: true, emergencyHatch: false, minGas: 200_000, addr: pad(BRIDGE_NATIVE_TOKEN) }
          case 'state': return 0
          case 'controllerOf': return controller
          case 'primaryTerminalOf': return route.terminal
          case 'accountingContextForTokenOf': return { token: args![1], decimals: 18, currency: 61166 }
          case 'outboxOf': return { tree: { count: 0n }, numberOfClaimsSent: 0n }
          case 'balanceOf': return 1000n
          case 'allowance': return 1000n
          case 'previewCashOutFrom': return [0n, 1000n, 0n]
          case 'feeFreeSurplusOf': return 0n
          case 'FEELESS_ADDRESSES': return address(60)
          case 'isFeelessFor': return false
          default: throw new Error(`Unhandled ${functionName}`)
        }
      },
    } as unknown as PublicClient
    clients.set(chainId, client)
    return client
  }
  // The claim's actual current-controller call is already impossible before any origin tokens move.
  await expect(clientFor(1).simulateContract({ address: controller, abi: jbControllerAbi, functionName: 'mintTokensOf',
    args: [30n, 1000n, receiver, '', false], account: route.destinationSucker })).rejects.toThrow('MintNotAllowed')
  mint.mockClear()
  await expect(createStickyBridge(clientFor).prepare({ route, amount: 1000n, owner, receiver, metadata: pad('0x01') }))
    .rejects.toThrow('MintNotAllowed')
  expect(mint).toHaveBeenCalledWith(expect.objectContaining({
    address: controller, account: route.destinationSucker, args: [30n, 1000n, receiver, '', false],
  }))
})
