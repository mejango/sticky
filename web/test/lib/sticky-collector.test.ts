import { beforeEach, describe, expect, it, vi } from 'vitest'
import { zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import type { StickySourceCollectorDeployment } from '@bananapus/nana-sdk-core/v6'
import { createStickyCollector, reservedSplitPercent } from '@/lib/sticky-collector'
import type { BridgeRoute } from '@/lib/sticky-bridge'

const mocks = vi.hoisted(() => ({ select: vi.fn(), build: vi.fn(), verify: vi.fn(), project: vi.fn(), pending: vi.fn(), routes: vi.fn(), route: vi.fn() }))
vi.mock('@bananapus/nana-sdk-core/v6', async original => ({
  ...await original<typeof import('@bananapus/nana-sdk-core/v6')>(),
  stickySourceCollectorDeployment: mocks.select, buildStickyReservedSplit: mocks.build,
  verifyStickyCollectorRoute: mocks.verify, getProjectIdForToken: mocks.project, getStickyCollectorPending: mocks.pending,
}))
vi.mock('@/lib/sticky-bridge', () => ({ createStickyBridge: () => ({ discover: mocks.routes, validateRoute: mocks.route }) }))
vi.mock('@/lib/jbcenter-rpc', () => ({ jbCenterPublicClient: vi.fn() }))

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address
const hash = `0x${'1'.repeat(64)}` as Hex
const record: StickySourceCollectorDeployment = {
  sourceChainId: 10, destinationChainId: 8453, address: address(1), runtimeCodeHash: hash,
  feePayer: address(2), feePayerRuntimeCodeHash: hash, registry: address(3), tokens: address(4), directory: address(5), receiverFactory: address(6),
}
const verified = { receiver: address(7), sourceToken: address(8), rewardToken: address(9), destinationProjectId: 33n }
const bridgeRoute = { sourceSucker: address(10), backingToken: address(11), canPrepare: true } as BridgeRoute
const input = { sourceChainId: 10, homeChainId: 8453, sourceProject: 'op:3', stickyToken: address(12), groupId: 4008n }
const clients = new Map<number, PublicClient>([10, 8453].map(chain => [chain, { chain: { id: chain } } as PublicClient]))
const client = (chainId: number) => clients.get(chainId)!

beforeEach(() => {
  vi.resetAllMocks()
  mocks.select.mockImplementation((source, home, records: StickySourceCollectorDeployment[]) => records.find(record => record.sourceChainId === source && record.destinationChainId === home))
  mocks.verify.mockResolvedValue(verified)
  mocks.routes.mockResolvedValue([bridgeRoute])
  mocks.project.mockResolvedValue(3n)
  mocks.pending.mockResolvedValue(45n)
  mocks.build.mockImplementation(args => ({ ...args, hook: args.deployment.address, beneficiary: args.stickyToken, projectId: args.groupId }))
})

describe('reserved percentage input', () => {
  it.each([['26.3157895', 263157895], ['100', 1000000000], ['0.0000001', 1]])('keeps %s exact', (input, expected) => {
    expect(reservedSplitPercent(input)).toBe(expected)
  })
  it.each(['', '0', '-1', '1e2', '100.0000001', '0.00000001'])('refuses %s rather than rounding or changing units', input => {
    expect(() => reservedSplitPercent(input)).toThrow()
  })
})

describe('collector source orchestration', () => {
  it('has no unconfigured route fallback, and asks the SDK for the exact source/home family', async () => {
    const api = createStickyCollector(client, [])
    expect(api.deployment(10, 8453)).toBeUndefined()
    await expect(api.discover(input)).rejects.toThrow('No verified collector')
    expect(mocks.select).toHaveBeenLastCalledWith(10, 8453, [])
    expect(mocks.routes).not.toHaveBeenCalled()
    expect(mocks.verify).not.toHaveBeenCalled()
  })
  it.each(['base:3', 'unknown:3', '0', '3.2', ''])('refuses a mismatched or invalid source %s before route reads', async sourceProject => {
    await expect(createStickyCollector(client, [record]).discover({ ...input, sourceProject })).rejects.toThrow()
    expect(mocks.routes).not.toHaveBeenCalled()
    expect(mocks.verify).not.toHaveBeenCalled()
  })
  it('delegates token identity and all split encoding to SDK owners', async () => {
    const api = createStickyCollector(client, [record])
    const [source] = await api.discover({ ...input, sourceProject: address(8) })
    expect(mocks.project).toHaveBeenCalledWith(client(10), { chainId: 10, token: address(8) })
    expect(mocks.routes).toHaveBeenCalledWith({ source: { chainId: 10 }, destination: { chainId: 8453 }, sourceProjectId: 3n })
    expect(mocks.verify).toHaveBeenCalledWith(client(10), client(8453), { ...source.allocation, sucker: address(10), backingToken: address(11) })
    api.recipe(source, 263157895)
    expect(mocks.build).toHaveBeenLastCalledWith({ ...source.allocation, percent: 263157895 })
    await expect(api.pending(source)).resolves.toBe(45n)
    expect(mocks.pending).toHaveBeenCalledWith(client(10), source.allocation)
    await api.verify(source)
    expect(mocks.route).toHaveBeenCalledWith(bridgeRoute, { preparing: true, sending: true })
  })
  it('rejects a non-project token and invalid SDK allocation before route discovery', async () => {
    const api = createStickyCollector(client, [record])
    mocks.project.mockResolvedValue(null)
    await expect(api.discover({ ...input, sourceProject: address(90) })).rejects.toThrow('not a Juicebox V6')
    mocks.build.mockImplementation(() => { throw new Error('Invalid reward group') })
    await expect(api.discover(input)).rejects.toThrow('Invalid reward group')
    expect(mocks.routes).not.toHaveBeenCalled()
  })
  it('allows same-chain settlement without asking for a bridge', async () => {
    const local = { ...record, sourceChainId: record.destinationChainId }
    const [source] = await createStickyCollector(client, [local]).discover({ ...input, sourceChainId: 8453, sourceProject: '3' })
    expect(source.bridgeRoute).toBeUndefined()
    expect(mocks.routes).not.toHaveBeenCalled()
    expect(mocks.verify).toHaveBeenCalledWith(client(8453), client(8453), source.allocation)
  })
  it('keeps source credits eligible for verified setup', async () => {
    mocks.verify.mockResolvedValue({ ...verified, sourceToken: zeroAddress })
    const [source] = await createStickyCollector(client, [record]).discover(input)
    expect(source.verified.sourceToken).toBe(zeroAddress)
    expect(mocks.project).not.toHaveBeenCalled()
  })
  it('does not offer retired or absent direct lanes', async () => {
    mocks.routes.mockResolvedValue([{ ...bridgeRoute, canPrepare: false }])
    await expect(createStickyCollector(client, [record]).discover(input)).rejects.toThrow('No usable direct route')
    expect(mocks.verify).not.toHaveBeenCalled()
  })
  it('keeps independently verified candidates and propagates refusal if none qualify', async () => {
    mocks.routes.mockResolvedValue([bridgeRoute, { ...bridgeRoute, sourceSucker: address(99) }])
    mocks.verify.mockRejectedValueOnce(new Error('Home pool is not registered'))
    const api = createStickyCollector(client, [record])
    expect(await api.discover(input)).toHaveLength(1)
    mocks.verify.mockRejectedValue(new Error('Home pool is not registered'))
    await expect(api.discover(input)).rejects.toThrow('Home pool is not registered')
  })
})
