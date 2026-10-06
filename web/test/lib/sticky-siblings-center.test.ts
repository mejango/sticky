import { getAddress, type Address, type PublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { controllerAbi } from '@/lib/sticky-abis'
import { stickyDeployment } from '@/lib/sticky-addresses'
import type { StickyProjectInfo } from '@/lib/sticky-project'
import { launchSiblings, siblingRows, type SiblingReadDeps } from '@/lib/sticky-siblings'
import { deploySticky } from './sticky-log-fixtures'

// The reads sticky-siblings makes of Center when a caller gives it none: each chain's project uris in one Multicall3
// request, and a project's figures through readStickyProject, clamped. Center is a fake client per chain.

const center = vi.hoisted(() => ({ client: vi.fn() }))
vi.mock('@/lib/jbcenter-rpc', () => ({ jbCenterPublicClient: center.client }))
const project = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@/lib/sticky-project', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-project')>()),
  readStickyProject: project.read,
}))

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

const LAUNCH = '11111111-2222-4333-8444-555555555555'
const BASE_SEPOLIA = 84532
const OP_SEPOLIA = 11155420
const uriFor = (launchId: string) =>
  'data:application/json;charset=utf-8,' +
  encodeURIComponent(
    JSON.stringify({ protocol: 'Sticky', version: 1, launchId, environment: 'testnet', chains: [84532, 11155420] }),
  )

type Call = { address: Address; abi: unknown; functionName: string; args: readonly [bigint] }
type Round = { contracts: readonly Call[]; allowFailure?: boolean }

const figures = (chainId: number, projectId: bigint, cashOutTaxRate: bigint): StickyProjectInfo => ({
  chainId,
  projectId,
  stToken: getAddress(`0x${'3'.repeat(40)}`),
  stSymbol: 'STICKYART',
  stName: 'Sticky ART',
  stakedToken: getAddress(`0x${'2'.repeat(40)}`),
  symbol: 'ART',
  name: 'Art',
  decimals: 6,
  cashOutTaxRate,
  soulbound: false,
  totalSupply: 100n,
  backing: 0n,
  orphaned: 10n,
  rawBacking: 10n,
  savedOrphaned: 11n,
  launchId: LAUNCH,
  plannedChains: [BASE_SEPOLIA, OP_SEPOLIA],
  blockNumber: 1n,
})

describe('sticky-siblings, reading for itself', () => {
  it('reads a chain\'s project uris in one request, and the copies of the launch through a clamped project read', async () => {
    const uris: Record<string, string> = { '3': uriFor('other-launch'), '5': uriFor(LAUNCH), '7': 'ipfs://not-a-launch' }
    const multicall = vi.fn(async ({ contracts }: Round) => contracts.map(call => uris[String(call.args[0])]))
    center.client.mockImplementation((chainId: number) => {
      if (chainId !== OP_SEPOLIA) throw new Error(`unexpected read of chain ${chainId}`)
      return { multicall } as unknown as PublicClient
    })
    project.read.mockImplementation(async (chainId: number, projectId: bigint) => figures(chainId, projectId, 500n))
    const { fromBlock } = stickyDeployment(OP_SEPOLIA)!
    const scan = vi.fn<SiblingReadDeps['scan']>(async chainId =>
      chainId === OP_SEPOLIA ? [3n, 5n, 7n].map((id, i) => deploySticky(id, { blockNumber: fromBlock + BigInt(i) })) : [],
    )
    const here = { chainId: BASE_SEPOLIA, projectId: 12n, launchId: LAUNCH, cashOutTaxRate: 500n, soulbound: false, plannedChains: null }

    const siblings = await launchSiblings(here, { scan, indexedProjects: async () => Promise.reject(new Error('down')) })
    expect(siblings).toEqual([
      { chainId: BASE_SEPOLIA, projectId: 12n, self: true },
      { chainId: OP_SEPOLIA, projectId: 5n, self: false },
    ])
    expect(multicall).toHaveBeenCalledTimes(1)
    const [{ contracts, allowFailure }] = multicall.mock.calls[0]
    expect(allowFailure).toBe(false)
    expect(contracts.map(call => [call.address, call.abi, call.functionName, call.args])).toEqual(
      [3n, 5n, 7n].map(id => [stickyDeployment(OP_SEPOLIA)!.controller, controllerAbi, 'uriOf', [id]]),
    )
    // A sibling whose recorded orphans exceed its balance is still found, and shows no backing.
    expect(project.read.mock.calls).toEqual([[OP_SEPOLIA, 5n, { orphans: 'clamp' }]])

    project.read.mockClear()
    center.client.mockImplementation(() => {
      throw new Error('siblingRows reads through readStickyProject alone')
    })
    // Each with the read's signal, so a page that is left stops them.
    const { signal } = new AbortController()
    const rows = await siblingRows(siblings, { signal })
    expect(project.read.mock.calls).toEqual([
      [BASE_SEPOLIA, 12n, { orphans: 'clamp', signal }],
      [OP_SEPOLIA, 5n, { orphans: 'clamp', signal }],
    ])
    expect(rows.map(row => ('info' in row ? row.info.backing : null))).toEqual([0n, 0n])
  })
})
