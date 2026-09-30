import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  getAddress,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ensAvailable, lookupEnsName } from '@/lib/ens'
import {
  ENS_REGISTRY_ADDRESS,
  PROJECT_HANDLES_ADDRESS,
  ensTextResolverAbi,
  jbProjectHandlesAbi,
} from '@/lib/project-handles'
import { projectsAbi } from '@/lib/sticky-abis'
import { stickyDeployment } from '@/lib/sticky-addresses'
import { resolveProjectHandle, type HandleReads } from '@/lib/sticky-handles'

// Names and handles are read only on production chains: the chain of the accounts a name is asked for, and the chain
// a handle's record points at.

const center = vi.hoisted(() => ({ client: vi.fn() }))
vi.mock('@/lib/jbcenter-rpc', () => ({ jbCenterPublicClient: center.client }))

const PRODUCTION = [1, 10, 8453, 42161]
const TESTNETS = [11155111, 11155420, 84532, 421614]
const OWNER = getAddress(`0x${'2'.repeat(40)}`)
const PROJECTS = getAddress(`0x${'5'.repeat(40)}`)
const RESOLVER = getAddress(`0x${'6'.repeat(40)}`)
const UNIVERSAL_RESOLVER = '0xeeeeeeee14d718c2b47d9923deab1335e144eeee'

// The universal resolver's `reverseWithGateways`, which is what viem's getEnsName calls.
const reverseAbi = parseAbi([
  'function reverseWithGateways(bytes reverseName, uint256 coinType, string[] gateways) view returns (string resolvedName, address resolver, address reverseResolver)',
])

/** Fetches of Ethereum's public RPC, answered as a universal resolver would: a name for each address in `names`,
 * a failure for each in `failing`, and no name for any other. */
function ensNode(names: Record<string, string> = {}, failing: string[] = []) {
  const calls: { to: string; data: Hex }[] = []
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; params: [{ to: string; data: Hex }] }
    const [{ to, data }] = body.params
    calls.push({ to, data })
    const account = String(decodeFunctionData({ abi: reverseAbi, data }).args[0]).toLowerCase()
    if (failing.includes(account)) {
      return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'boom' } })
    }
    const result = encodeFunctionResult({
      abi: reverseAbi,
      functionName: 'reverseWithGateways',
      result: [names[account] ?? '', zeroAddress, zeroAddress],
    })
    return Response.json({ jsonrpc: '2.0', id: body.id, result })
  })
  vi.stubGlobal('fetch', fetcher)
  return { calls, fetcher }
}

const account = (seed: number) => getAddress(`0x${seed.toString(16).padStart(40, '0')}`)

describe('ENS names', () => {
  it.each(PRODUCTION)('are read for the accounts of production chain %s', async chainId => {
    const holder = account(chainId)
    const { calls } = ensNode({ [holder.toLowerCase()]: `holder-${chainId}.eth` })

    expect(await lookupEnsName(holder, chainId)).toBe(`holder-${chainId}.eth`)

    expect(calls).toHaveLength(1)
    expect(calls[0].to.toLowerCase()).toBe(UNIVERSAL_RESOLVER)
    expect(calls[0].data.slice(0, 10)).toBe('0xb7d6ca64')
  })

  it.each(TESTNETS)('are not read for the accounts of testnet %s: a mainnet name does not describe them', async chainId => {
    const { fetcher } = ensNode({ [account(chainId).toLowerCase()]: 'not-theirs.eth' })

    expect(await lookupEnsName(account(chainId), chainId)).toBeNull()

    expect(fetcher).not.toHaveBeenCalled()
  })

  it('are not read on a chain Sticky does not know either', async () => {
    const { fetcher } = ensNode()
    expect(await lookupEnsName(account(137), 137)).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('are asked for by the address, with Ethereum\'s coin type', async () => {
    const holder = account(0xabc)
    const { calls } = ensNode()
    await lookupEnsName(holder, 8453)
    const { args } = decodeFunctionData({ abi: reverseAbi, data: calls[0].data })
    expect(String(args[0]).toLowerCase()).toBe(holder.toLowerCase())
    expect(args[1]).toBe(60n)
  })

  it('are read for an address in any letter case, once', async () => {
    const holder = account(0xdef)
    const { calls } = ensNode({ [holder.toLowerCase()]: 'def.eth' })
    expect(await lookupEnsName(holder, 1)).toBe('def.eth')
    expect(await lookupEnsName(holder.toLowerCase(), 1)).toBe('def.eth')
    expect(await lookupEnsName(`  ${holder.toUpperCase().replace('0X', '0x')} `, 10)).toBe('def.eth')
    expect(calls).toHaveLength(1)
  })

  it('do not follow an off-chain lookup that an account\'s resolver asks for', async () => {
    const holder = account(0x555)
    const gateway = 'https://gateway.example/{sender}/{data}.json'
    const offchainLookup = encodeErrorResult({
      abi: parseAbi(['error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)']),
      errorName: 'OffchainLookup',
      args: [UNIVERSAL_RESOLVER, [gateway], '0x1234', '0x12345678', '0x'],
    })
    const requested: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        requested.push(String(url))
        const { id } = JSON.parse(String(init?.body)) as { id: number }
        return Response.json({ jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted', data: offchainLookup } })
      }),
    )

    expect(await lookupEnsName(holder, 1)).toBeNull()

    expect(requested).toEqual(['https://ethereum-rpc.publicnode.com/'])
  })

  it('are cached with the misses, so an address without a name is not asked again', async () => {
    const holder = account(0x111)
    const { calls } = ensNode()
    expect(await lookupEnsName(holder, 1)).toBeNull()
    expect(await lookupEnsName(holder, 1)).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('are cached with the failures, which read as no name', async () => {
    const holder = account(0x222)
    const { calls } = ensNode({}, [holder.toLowerCase()])
    expect(await lookupEnsName(holder, 1)).toBeNull()
    expect(await lookupEnsName(holder, 1)).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('share one request between lookups made together', async () => {
    const holder = account(0x333)
    const { calls } = ensNode({ [holder.toLowerCase()]: 'together.eth' })
    const names = await Promise.all([lookupEnsName(holder, 1), lookupEnsName(holder, 1), lookupEnsName(holder, 8453)])
    expect(names).toEqual(['together.eth', 'together.eth', 'together.eth'])
    expect(calls).toHaveLength(1)
  })

  it.each(['', 'vitalik.eth', '0x123', `0x${'g'.repeat(40)}`, `0x${'1'.repeat(41)}`])(
    'are not read for %j, which is no address',
    async value => {
      const { fetcher } = ensNode()
      expect(await lookupEnsName(value, 1)).toBeNull()
      expect(fetcher).not.toHaveBeenCalled()
    },
  )

  it('are not read at all in the deterministic browser build', async () => {
    vi.stubEnv('NEXT_PUBLIC_DETERMINISTIC_BROWSER', 'true')
    vi.resetModules()
    const deterministic = await import('@/lib/ens')
    const { fetcher } = ensNode({ [account(0x444).toLowerCase()]: 'fixture.eth' })
    expect(await deterministic.lookupEnsName(account(0x444), 1)).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('are available for production chains only', () => {
    for (const chainId of PRODUCTION) expect(ensAvailable(chainId)).toBe(true)
    for (const chainId of [...TESTNETS, 137, 0]) expect(ensAvailable(chainId)).toBe(false)
  })
})

describe('resolveProjectHandle', () => {
  const UNREADABLE = 'A project handle could not be read; its page offers to try again.'

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  /** The three reads, stocked with a handle `banny.eth` that points at project 42 on Base, whose owner claimed it. */
  function stocked(overrides: Partial<HandleReads> = {}) {
    const reads = {
      record: vi.fn(async (_ensName: string) => '8453:42' as string | null),
      ownerOf: vi.fn(async (_chainId: number, _projectId: number) => OWNER as Address | null),
      claim: vi.fn(async (_chainId: number, _projectId: number, _setter: Address) => 'banny' as string | null),
      ...overrides,
    }
    return reads as typeof reads & HandleReads
  }

  it('names the project a record points at, when the project\'s owner claimed the same handle', async () => {
    const reads = stocked()

    expect(await resolveProjectHandle('@banny', reads)).toEqual({ chainId: 8453, projectId: 42, handle: 'banny' })

    expect(reads.record).toHaveBeenCalledWith('banny.eth')
    expect(reads.ownerOf).toHaveBeenCalledWith(8453, 42)
    // The claim that counts is the owner's: it is asked of the address that owns the project.
    expect(reads.claim).toHaveBeenCalledWith(8453, 42, OWNER)
  })

  it.each(['@banny', 'banny', '@Banny', 'BANNY.eth', '@banny.eth', '  @banny  '])('takes %j for banny', async form => {
    const reads = stocked()
    expect(await resolveProjectHandle(form, reads)).toEqual({ chainId: 8453, projectId: 42, handle: 'banny' })
    expect(reads.record).toHaveBeenCalledWith('banny.eth')
  })

  it('names the handle as the contract and the URL spell it: normalized, without @ or .eth', async () => {
    const reads = stocked({ claim: vi.fn(async () => 'café.juicebox') })
    expect(await resolveProjectHandle('@Café.Juicebox.eth', reads)).toEqual({
      chainId: 8453,
      projectId: 42,
      handle: 'café.juicebox',
    })
    expect(reads.record).toHaveBeenCalledWith('café.juicebox.eth')
  })

  it.each(['', '@', 'foo..eth', 'foo.eth.eth', '@foo eth'])('names nothing for %j, and reads nothing', async handle => {
    const reads = stocked()
    expect(await resolveProjectHandle(handle, reads)).toBeNull()
    expect(reads.record).not.toHaveBeenCalled()
  })

  it.each([null, '', ' 8453:42', '8453:42 ', '0:42', '8453:0', '8453:-2', '8453:2.5', 'banny', '8453'])(
    'names nothing when the name\'s record is %j, and asks nothing of the chain',
    async record => {
      const reads = stocked({ record: vi.fn(async () => record) })
      expect(await resolveProjectHandle('@banny', reads)).toBeNull()
      expect(reads.ownerOf).not.toHaveBeenCalled()
      expect(reads.claim).not.toHaveBeenCalled()
    },
  )

  it.each(PRODUCTION)('names a project on production chain %s', async chainId => {
    const reads = stocked({ record: vi.fn(async () => `${chainId}:7`) })
    expect(await resolveProjectHandle('@banny', reads)).toEqual({ chainId, projectId: 7, handle: 'banny' })
  })

  it.each([...TESTNETS, 137, 1337])(
    'names nothing when the record points at chain %s, a testnet or a chain Sticky is not on, and reads nothing further',
    async chainId => {
      const reads = stocked({ record: vi.fn(async () => `${chainId}:7`) })
      expect(await resolveProjectHandle('@banny', reads)).toBeNull()
      expect(reads.ownerOf).not.toHaveBeenCalled()
      expect(reads.claim).not.toHaveBeenCalled()
    },
  )

  it('names nothing for a project that does not exist, and asks for no claim', async () => {
    const reads = stocked({ ownerOf: vi.fn(async () => null) })
    expect(await resolveProjectHandle('@banny', reads)).toBeNull()
    expect(reads.claim).not.toHaveBeenCalled()
  })

  it.each([
    ['no claim', null],
    ['a claim of another name', 'another'],
    ['a claim spelled another way', 'Banny'],
    ['a claim that keeps the .eth', 'banny.eth'],
    ['a claim that keeps the @', '@banny'],
    ['an empty claim', ''],
  ])('names nothing for a record that is confirmed by %s: a record alone is only a candidate', async (_what, claim) => {
    const reads = stocked({ claim: vi.fn(async () => claim) })
    expect(await resolveProjectHandle('@banny', reads)).toBeNull()
  })

  it('rejects when a read fails, whichever it is: a lookup that is down is no answer, and never a 404', async () => {
    const failure = new Error('429')
    await expect(resolveProjectHandle('@banny', stocked({ record: vi.fn().mockRejectedValue(failure) }))).rejects.toBe(failure)
    await expect(resolveProjectHandle('@banny', stocked({ ownerOf: vi.fn().mockRejectedValue(failure) }))).rejects.toBe(failure)
    await expect(resolveProjectHandle('@banny', stocked({ claim: vi.fn().mockRejectedValue(failure) }))).rejects.toBe(failure)
  })

  it('tells the console when a read fails, under one label with the handle', async () => {
    const failure = new Error('429')
    const failed = (reads: HandleReads, handle = '@banny') => resolveProjectHandle(handle, reads).catch(() => 'failed')
    expect(await failed(stocked({ record: vi.fn().mockRejectedValue(failure) }), '@Banny.eth')).toBe('failed')
    expect(await failed(stocked({ ownerOf: vi.fn().mockRejectedValue(failure) }))).toBe('failed')
    expect(await failed(stocked({ claim: vi.fn().mockRejectedValue(failure) }))).toBe('failed')

    expect(vi.mocked(console.warn).mock.calls).toEqual([
      [UNREADABLE, { handle: 'banny' }, failure],
      [UNREADABLE, { handle: 'banny' }, failure],
      [UNREADABLE, { handle: 'banny' }, failure],
    ])
  })

  it('says nothing to the console for a handle that simply names nothing', async () => {
    expect(await resolveProjectHandle('', stocked())).toBeNull()
    expect(await resolveProjectHandle('@banny', stocked({ record: vi.fn(async () => null) }))).toBeNull()
    expect(await resolveProjectHandle('@banny', stocked({ ownerOf: vi.fn(async () => null) }))).toBeNull()
    expect(await resolveProjectHandle('@banny', stocked({ record: vi.fn(async () => '84532:7') }))).toBeNull()
    expect(await resolveProjectHandle('@banny', stocked({ claim: vi.fn(async () => null) }))).toBeNull()
    expect(await resolveProjectHandle('@banny', stocked({ claim: vi.fn(async () => 'another') }))).toBeNull()
    expect(await resolveProjectHandle('@banny', stocked())).not.toBeNull()
    expect(console.warn).not.toHaveBeenCalled()
  })

  describe('through Center', () => {
    const deployment = stickyDeployment(8453)!
    const PROJECT = 42n
    const NODE = '0x7b'

    type Read = { address: Address; functionName: string; args?: readonly unknown[] }
    type Raw = { method: string; params: [{ to: Address; data: Hex; from?: Address; gas?: Hex }, unknown] }

    function fakeChains(
      { record = '8453:42' as string | null, claim = 'banny', owner = OWNER as Address | Error } = {},
    ) {
      // Ethereum: the ENS registry (resolver and owner of the name), the resolver's `juicebox` record, and
      // JBProjectHandles' claim.
      const ethereum = {
        getBlockNumber: vi.fn(async () => BigInt(NODE)),
        readContract: vi.fn(async ({ address, functionName }: Read) => {
          if (address === ENS_REGISTRY_ADDRESS && functionName === 'resolver') return record === null ? zeroAddress : RESOLVER
          if (address === ENS_REGISTRY_ADDRESS && functionName === 'owner') return OWNER
          throw new Error(`Unexpected read of ${functionName} on ${address}`)
        }),
        request: vi.fn(async ({ params: [call] }: Raw) => {
          if (call.to === RESOLVER) {
            return encodeFunctionResult({ abi: ensTextResolverAbi, functionName: 'text', result: record ?? '' })
          }
          if (call.to === PROJECT_HANDLES_ADDRESS) {
            return encodeFunctionResult({ abi: jbProjectHandlesAbi, functionName: 'handleOf', result: claim })
          }
          throw new Error(`Unexpected call to ${call.to}`)
        }),
      }
      // The project's chain: the JBProjects that the recorded controller names, and who owns the project.
      const projectChain = {
        readContract: vi.fn(async ({ address, functionName, args }: Read) => {
          if (address === deployment.controller && functionName === 'PROJECTS') return PROJECTS
          if (address === PROJECTS && functionName === 'ownerOf' && args?.[0] === PROJECT) {
            if (owner instanceof Error) throw owner
            return owner
          }
          throw new Error(`Unexpected read of ${functionName} on ${address}`)
        }),
      }
      center.client.mockImplementation((chainId: number) => {
        if (chainId === 1) return ethereum as unknown as PublicClient
        if (chainId === 8453) return projectChain as unknown as PublicClient
        throw new Error(`Unexpected read of chain ${chainId}`)
      })
      return { ethereum, projectChain }
    }

    beforeEach(() => {
      center.client.mockReset()
    })

    it('reads the name and the claim on Ethereum, and the owner on the project\'s chain, all through Center', async () => {
      const { ethereum, projectChain } = fakeChains()

      expect(await resolveProjectHandle('@banny')).toEqual({ chainId: 8453, projectId: 42, handle: 'banny' })

      // The record is read from the resolver the registry names, as the contract reads it.
      expect(ethereum.request).toHaveBeenCalledWith(
        { method: 'eth_call', params: [expect.objectContaining({ to: RESOLVER, from: PROJECT_HANDLES_ADDRESS }), NODE] },
        undefined,
      )
      // The claim is JBProjectHandles.handleOf(8453, 42, owner).
      const handleOf = ethereum.request.mock.calls.map(([raw]) => raw.params[0]).find(call => call.to === PROJECT_HANDLES_ADDRESS)!
      expect(decodeFunctionData({ abi: jbProjectHandlesAbi, data: handleOf.data })).toEqual({
        functionName: 'handleOf',
        args: [8453n, 42n, OWNER],
      })
      expect(projectChain.readContract).toHaveBeenCalledWith(
        expect.objectContaining({ address: PROJECTS, functionName: 'ownerOf', args: [PROJECT] }),
      )
      expect(new Set(center.client.mock.calls.map(([chainId]) => chainId))).toEqual(new Set([1, 8453]))
    })

    it('rejects, and tells the console, when Ethereum cannot be asked for the name: a record it could not read is no answer', async () => {
      const down = new Error('429')
      const { ethereum, projectChain } = fakeChains()
      ethereum.getBlockNumber.mockRejectedValue(down)
      ethereum.readContract.mockRejectedValue(down)
      ethereum.request.mockRejectedValue(down)

      await expect(resolveProjectHandle('@banny')).rejects.toBe(down)

      // The record's reader takes a failed lookup for no record, so Ethereum is asked afresh whether it answers.
      expect(ethereum.getBlockNumber).toHaveBeenLastCalledWith({ cacheTime: 0 })
      expect(vi.mocked(console.warn).mock.calls).toEqual([[UNREADABLE, { handle: 'banny' }, down]])
      expect(projectChain.readContract).not.toHaveBeenCalled()
    })

    it('rejects, and tells the console, when the claim cannot be read', async () => {
      const down = new Error('429')
      const { ethereum } = fakeChains()
      const answers = ethereum.request.getMockImplementation()!
      ethereum.request.mockImplementation(async raw => {
        if (raw.params[0].to === PROJECT_HANDLES_ADDRESS) throw down
        return answers(raw)
      })

      await expect(resolveProjectHandle('@banny')).rejects.toBe(down)

      expect(vi.mocked(console.warn).mock.calls).toEqual([[UNREADABLE, { handle: 'banny' }, down]])
    })

    it('names nothing when the name has no record while Ethereum answers, and never reads the project', async () => {
      const { ethereum, projectChain } = fakeChains({ record: null })
      expect(await resolveProjectHandle('@banny')).toBeNull()
      expect(ethereum.getBlockNumber).toHaveBeenLastCalledWith({ cacheTime: 0 })
      expect(projectChain.readContract).not.toHaveBeenCalled()
      expect(console.warn).not.toHaveBeenCalled()
    })

    it('names nothing when the owner never claimed the handle', async () => {
      fakeChains({ claim: '' })
      expect(await resolveProjectHandle('@banny')).toBeNull()
    })

    it('names nothing, and says nothing, when JBProjects reverts: the project does not exist', async () => {
      const revert = new ContractFunctionExecutionError(
        new ContractFunctionRevertedError({ abi: projectsAbi, functionName: 'ownerOf', message: 'execution reverted' }),
        { abi: projectsAbi, functionName: 'ownerOf', args: [PROJECT], contractAddress: PROJECTS },
      )
      const { ethereum } = fakeChains({ owner: revert })
      expect(await resolveProjectHandle('@banny')).toBeNull()
      expect(console.warn).not.toHaveBeenCalled()
      // No claim is asked for a project that does not exist.
      expect(ethereum.request.mock.calls.map(([raw]) => raw.params[0].to)).not.toContain(PROJECT_HANDLES_ADDRESS)
    })

    it('rejects, and tells the console, when the project\'s owner cannot be read', async () => {
      const down = new Error('429')
      fakeChains({ owner: down })
      await expect(resolveProjectHandle('@banny')).rejects.toBe(down)
      expect(vi.mocked(console.warn).mock.calls).toEqual([[UNREADABLE, { handle: 'banny' }, down]])
    })

    it('asks no chain for a record that points at a testnet', async () => {
      const { projectChain } = fakeChains({ record: '84532:42' })
      expect(await resolveProjectHandle('@banny')).toBeNull()
      expect(projectChain.readContract).not.toHaveBeenCalled()
      expect(center.client).not.toHaveBeenCalledWith(84532)
    })
  })
})
