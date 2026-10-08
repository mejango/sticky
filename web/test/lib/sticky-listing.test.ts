import { JBCenterClient } from '@bananapus/nana-sdk-core/jbcenter'
import { getAddress, keccak256, stringToHex, type Hex } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LaunchPlan } from '@/lib/sticky-launch-plan'
import { STICKY_LISTING_FORWARDER, buildStickyEnvelope, createStickyCenterClient, listingCapability, publishStickyListing } from '@/lib/sticky-listing'

const rpc = vi.hoisted(() => ({ client: vi.fn() }))
vi.mock('@/lib/jbcenter-rpc', () => ({ jbCenterPublicClient: rpc.client }))
const address = (digit: string) => getAddress(`0x${digit.repeat(40)}`)
const OWNER = address('1')
const DEPLOYER = address('2')
const TOKEN = address('3')
const signature = `0x${'b'.repeat(130)}` as Hex
// The Center fixture hashes exact returned casing and recursively sorted keys, as the service does.
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
}
function plan(ids = [11155420, 84532]): LaunchPlan {
  return { id: '11111111-2222-4333-8444-555555555555', owner: OWNER, name: 'Sticky Art', symbol: 'STICKYART',
    token: TOKEN, tokenName: 'Art', tokenSymbol: 'ART', tokenDecimals: 18, cashOutTaxRate: '1000', soulbound: false,
    projectUri: 'data:,sticky-launch', environment: 'testnet',
    targets: ids.map(chainId => ({ chainId, deployer: DEPLOYER, controller: address('4'), projects: address('5'),
      call: { chain: chainId, target: DEPLOYER, data: '0xABCDEF', value: '123' } })),
  }
}
const getCode = vi.fn<() => Promise<Hex | undefined>>()
const readContract = vi.fn()
beforeEach(() => {
  getCode.mockResolvedValue(undefined)
  readContract.mockRejectedValue(new Error('execution reverted'))
  rpc.client.mockReturnValue({ getCode, readContract })
})

describe('Sticky listing envelope', () => {
  it('preserves legacy metadata, sorts chain calls, omits unsigned creation fees and leaves the plan untouched', () => {
    const launch = plan()
    expect(buildStickyEnvelope(launch)).toEqual({
      format: 'sticky.center/deploy.v1', deploymentVersion: '6', chainIds: [84532, 11155420],
      deploymentCalls: [84532, 11155420].map(chainId => ({ chainId, to: DEPLOYER, data: '0xabcdef' })),
      jb: { app: 'sticky', kind: 'sticky', name: 'Sticky Art', owner: OWNER, chainIds: [84532, 11155420],
        symbol: 'STICKYART', stakedToken: TOKEN, stakedTokenSymbol: 'ART', cashOutTaxRate: '1000', soulbound: false,
        launchId: launch.id, projectUri: launch.projectUri },
    })
    expect(launch.targets.map(target => target.chainId)).toEqual([11155420, 84532])
    expect(() => buildStickyEnvelope(plan([]))).toThrow('at least one')
    expect(() => buildStickyEnvelope({ ...launch, owner: 'bad' as Hex })).toThrow('launching wallet')
    expect(() => buildStickyEnvelope(plan([84532, 84532]))).toThrow('one launch per chain')
  })

  it('wallet-action:authorize-sticky-listing uses this deployment’s Center endpoint and authenticates a listing before asking the signer', async () => {
    vi.stubEnv('NEXT_PUBLIC_JBCENTER_URL', 'https://center.example')
    expect(createStickyCenterClient().baseUrl).toBe('https://center.example')
    const launch = plan()
    const HASH = keccak256(stringToHex(canonicalJson(buildStickyEnvelope(launch))))
    const message = `Juice Central project intent\nVersion: 1\nContent hash: ${HASH}`
    const prepare = vi.spyOn(JBCenterClient.prototype, 'prepareIntent').mockResolvedValue({
      contentHash: HASH, message, envelope: buildStickyEnvelope(launch),
    })
    const publish = vi.spyOn(JBCenterClient.prototype, 'publishIntent').mockRejectedValue(new Error('Publication received no answer'))
    const sign = vi.fn(async () => signature)
    await expect(publishStickyListing(launch, sign)).rejects.toThrow('Publication received no answer')
    expect(sign).toHaveBeenCalledExactlyOnceWith(message)
    expect(publish).toHaveBeenCalledExactlyOnceWith({ ...buildStickyEnvelope(launch), publisher: OWNER, signature }, undefined)
    prepare.mockResolvedValueOnce({ contentHash: HASH, message: `Other message ${HASH}`, envelope: buildStickyEnvelope(launch) })
    sign.mockClear()
    await expect(publishStickyListing(launch, sign)).rejects.toThrow('signing message')
    expect(sign).not.toHaveBeenCalled()
    prepare.mockResolvedValueOnce({ contentHash: HASH, message, envelope: { ...buildStickyEnvelope(launch), jb: { name: 'changed' } } })
    await expect(publishStickyListing(launch, sign)).rejects.toThrow('different intent')
    expect(sign).not.toHaveBeenCalled()
  })
})

describe('listing eligibility', () => {
  it('keeps current deployers self-paid and checks the exact canonical forwarder', async () => {
    expect(await listingCapability(plan())).toBe('self-paid')
    expect(readContract).toHaveBeenCalledTimes(2)
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ address: DEPLOYER,
      functionName: 'isTrustedForwarder', args: [STICKY_LISTING_FORWARDER] }))
    expect(STICKY_LISTING_FORWARDER.toLowerCase()).toBe('0x3ba60b60933916a7c87d0860dcee62a0ce34e3e2')
  })

  it('requires forwarder trust on every eligible chain and never sponsors Ethereum mainnet', async () => {
    readContract.mockResolvedValue(true)
    expect(await listingCapability(plan())).toBe('sponsored')
    expect(await listingCapability(plan([8453]))).toBe('sponsored')
    readContract.mockClear()
    expect(await listingCapability(plan([1, 8453]))).toBe('self-paid')
    expect(readContract).not.toHaveBeenCalled()
    readContract.mockResolvedValueOnce(false)
    expect(await listingCapability(plan())).toBe('self-paid')
    expect(await listingCapability(plan([]))).toBe('unavailable')
  })

  it('accepts empty-code and exact delegated EOAs; rejects contracts, malformed delegation and unknown code', async () => {
    for (const code of [undefined, '0x', `0xef0100${'a'.repeat(40)}`] as const) {
      getCode.mockResolvedValueOnce(code)
      expect(await listingCapability(plan())).toBe('self-paid')
    }
    for (const code of ['0x6080604052', `0xef0100${'a'.repeat(40)}00`, '0xef0100'] as const) {
      getCode.mockResolvedValueOnce(code)
      expect(await listingCapability(plan())).toBe('unavailable')
    }
    getCode.mockRejectedValueOnce(new Error('RPC unavailable'))
    expect(await listingCapability(plan())).toBe('unavailable')
  })
})
