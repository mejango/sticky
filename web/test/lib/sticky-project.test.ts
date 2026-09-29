import {
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  getAddress,
  multicall3Abi,
  zeroAddress,
  type Address,
  type PublicClient,
} from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stickyTokenAbi } from '@/lib/sticky-abis'
import { stickyDeployment } from '@/lib/sticky-addresses'
import {
  StickyDeploymentMismatch,
  readStickyProject,
  verifyStickyDeployment,
} from '@/lib/sticky-project'

const center = vi.hoisted(() => ({ client: vi.fn() }))
vi.mock('@/lib/jbcenter-rpc', () => ({ jbCenterPublicClient: center.client }))

const CHAIN = 84532
const deployment = stickyDeployment(CHAIN)!
const address = (digit: string) => getAddress(`0x${digit.repeat(40)}`)
const STAKED = address('2')
const STICKY = address('3')
const STORE = address('4')
const OTHER = address('9')
const HEAD = 0x55n
const LAUNCH = '11111111-2222-4333-8444-555555555555'

const uriFor = (launchId: unknown, protocol = 'Sticky') =>
  'data:application/json;charset=utf-8,' +
  encodeURIComponent(
    JSON.stringify({ protocol, version: 1, launchId, environment: 'testnet', chains: [84532, 11155420] }),
  )

// A fake chain, keyed by "<contract>.<function>". A value is what that call returns, an Error is
// how it fails, and a call nobody stocked is a bug in the read, so it throws.
type World = Record<string, unknown>
const at = (contract: Address, functionName: string) => `${contract.toLowerCase()}.${functionName}`

function world(overrides: World = {}): World {
  return {
    [at(deployment.deployer, 'stakedTokenOf')]: STAKED,
    [at(deployment.deployer, 'cashOutTaxRateOf')]: 1000n,
    [at(deployment.hook, 'tokenOf')]: STICKY,
    [at(deployment.hook, 'orphanedBalanceOf')]: 4n,
    [at(deployment.terminal, 'STORE')]: STORE,
    [at(deployment.controller, 'uriOf')]: uriFor(LAUNCH),
    [at(STAKED, 'symbol')]: 'ART',
    [at(STAKED, 'decimals')]: 6,
    [at(STAKED, 'name')]: 'Art',
    [at(STICKY, 'symbol')]: 'STICKYART',
    [at(STICKY, 'name')]: 'Streaking ART',
    [at(STICKY, 'SOULBOUND')]: false,
    [at(STICKY, 'totalSupply')]: 10n ** 18n,
    [at(STORE, 'balanceOf')]: 10n,
    ...overrides,
  }
}

type Round = {
  contracts: readonly { address: Address; functionName: string; args?: readonly unknown[] }[]
  allowFailure?: boolean
  blockNumber?: bigint
}

function fakeCenter(chain: World) {
  const getBlockNumber = vi.fn(async () => HEAD)
  const multicall = vi.fn(async ({ contracts }: Round) =>
    contracts.map(({ address: contract, functionName }) => {
      const reply = chain[at(contract, functionName)]
      if (reply === undefined) throw new Error(`the fake chain has no ${functionName} on ${contract}`)
      return reply instanceof Error
        ? { status: 'failure' as const, error: reply }
        : { status: 'success' as const, result: reply }
    }),
  )
  // Only these two reads exist: any other way of reaching the chain is a TypeError.
  center.client.mockReturnValue({ getBlockNumber, multicall } as unknown as PublicClient)
  return { getBlockNumber, multicall }
}

// What viem reports when a call reverts, and when the request carrying the calls never got an
// answer: the second is named for Multicall3's function, not the call's.
const reverted = (functionName: string) =>
  new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: stickyTokenAbi, functionName }), {
    abi: stickyTokenAbi,
    args: [],
    functionName,
  })
const unanswered = () =>
  new ContractFunctionExecutionError(new BaseError('Request exceeds defined limit.'), {
    abi: multicall3Abi,
    args: [],
    functionName: 'aggregate3',
  })

beforeEach(() => {
  center.client.mockReset()
})

describe('readStickyProject', () => {
  it('reads a project at one block: the recorded contracts first, then the tokens and store they name', async () => {
    const { getBlockNumber, multicall } = fakeCenter(world())

    const info = await readStickyProject(CHAIN, 12n)

    expect(center.client).toHaveBeenCalledWith(CHAIN)
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
      launchId: LAUNCH,
      blockNumber: HEAD,
    })
    expect(getBlockNumber).toHaveBeenCalledOnce()
    expect(multicall.mock.calls.map(([round]) => [round.blockNumber, round.allowFailure])).toEqual([
      [HEAD, true],
      [HEAD, true],
    ])
    const targets = (round: number) => new Set(multicall.mock.calls[round][0].contracts.map(call => call.address))
    expect(targets(0)).toEqual(
      new Set([deployment.deployer, deployment.hook, deployment.terminal, deployment.controller]),
    )
    expect(targets(1)).toEqual(new Set([STAKED, STICKY, STORE]))
  })

  it('asks the store for what the Sticky terminal holds of the staked token', async () => {
    const { multicall } = fakeCenter(world())
    await readStickyProject(CHAIN, 12n)
    const [, second] = multicall.mock.calls
    expect(
      second[0].contracts.filter(call => call.address === STORE).map(({ functionName, args }) => ({ functionName, args })),
    ).toEqual([{ functionName: 'balanceOf', args: [deployment.terminal, 12n, STAKED] }])
  })

  it('pool value excludes orphaned funds and treats all zero-supply backing as unowned', async () => {
    const chain = world({
      [at(STORE, 'balanceOf')]: 10n,
      [at(deployment.hook, 'orphanedBalanceOf')]: 4n,
      [at(STICKY, 'totalSupply')]: 10n ** 18n,
    })
    const { multicall } = fakeCenter(chain)

    expect((await readStickyProject(CHAIN, 12n)).backing).toBe(6n)
    expect(multicall.mock.calls.every(([round]) => round.blockNumber === HEAD)).toBe(true)

    chain[at(STICKY, 'totalSupply')] = 0n
    const empty = await readStickyProject(CHAIN, 12n)
    expect(empty.backing).toBe(0n)
    expect(empty.orphaned).toBe(10n)

    chain[at(deployment.hook, 'orphanedBalanceOf')] = 11n
    await expect(readStickyProject(CHAIN, 12n)).rejects.toThrow(/inconsistent backing/)
  })

  it('reads SOULBOUND() as the token says', async () => {
    fakeCenter(world({ [at(STICKY, 'SOULBOUND')]: true }))
    expect((await readStickyProject(CHAIN, 12n)).soulbound).toBe(true)
  })

  it('SOULBOUND() reverting reads as locked', async () => {
    fakeCenter(world({ [at(STICKY, 'SOULBOUND')]: reverted('SOULBOUND') }))
    expect((await readStickyProject(CHAIN, 12n)).soulbound).toBe(true)
  })

  it('does not read a request that got no answer as a locked token', async () => {
    fakeCenter(world({ [at(STICKY, 'SOULBOUND')]: unanswered() }))
    await expect(readStickyProject(CHAIN, 12n)).rejects.toThrow('Request exceeds defined limit.')
  })

  it('refuses a project this deployer did not launch, without reading a token', async () => {
    const { multicall } = fakeCenter(world({ [at(deployment.deployer, 'stakedTokenOf')]: zeroAddress }))
    await expect(readStickyProject(CHAIN, 99n)).rejects.toThrow('Project 99 is not a Sticky token of this deployer.')
    expect(multicall).toHaveBeenCalledOnce()
  })

  it.each([
    ['the staked token', at(deployment.deployer, 'stakedTokenOf')],
    ['the stickiness bonus', at(deployment.deployer, 'cashOutTaxRateOf')],
    ['the Sticky token', at(deployment.hook, 'tokenOf')],
    ['the unowned backing', at(deployment.hook, 'orphanedBalanceOf')],
    ['the store', at(deployment.terminal, 'STORE')],
    ['the underlying symbol', at(STAKED, 'symbol')],
    ['the underlying name', at(STAKED, 'name')],
    ['the underlying decimals', at(STAKED, 'decimals')],
    ['the Sticky symbol', at(STICKY, 'symbol')],
    ['the Sticky name', at(STICKY, 'name')],
    ['the Sticky supply', at(STICKY, 'totalSupply')],
    ['the terminal balance', at(STORE, 'balanceOf')],
  ])('fails when %s cannot be read, instead of reading zero', async (_what, failing) => {
    fakeCenter(world({ [failing]: reverted(failing.split('.')[1]) }))
    await expect(readStickyProject(CHAIN, 12n)).rejects.toThrow(/could not be read/)
  })

  const base64 = (metadata: unknown) => `data:application/json;base64,${Buffer.from(JSON.stringify(metadata)).toString('base64')}`
  it.each([
    ['a percent-encoded data uri', uriFor(LAUNCH), LAUNCH],
    ['a base64 data uri', base64({ protocol: 'Sticky', launchId: LAUNCH }), LAUNCH],
    ['another protocol', uriFor(LAUNCH, 'Other'), null],
    ['a launch id that is not text', uriFor(7), null],
    ['an empty launch id', uriFor(''), null],
    ['no launch id', `data:application/json,${encodeURIComponent('{"protocol":"Sticky"}')}`, null],
    ['json that is not an object', 'data:application/json,%5B1%5D', null],
    ['a data uri that is not json', 'data:application/json,not-json', null],
    ['a uri that is not a data uri', 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi', null],
    ['an empty uri', '', null],
  ])('takes the launch id from %s', async (_what, uri, launchId) => {
    fakeCenter(world({ [at(deployment.controller, 'uriOf')]: uri }))
    expect((await readStickyProject(CHAIN, 12n)).launchId).toBe(launchId)
  })

  it('has no launch id when uriOf reverts, since siblings are only a convenience', async () => {
    fakeCenter(world({ [at(deployment.controller, 'uriOf')]: reverted('uriOf') }))
    expect((await readStickyProject(CHAIN, 12n)).launchId).toBeNull()
  })

  it('does not read a request that got no answer as a project without a launch id', async () => {
    fakeCenter(world({ [at(deployment.controller, 'uriOf')]: unanswered() }))
    await expect(readStickyProject(CHAIN, 12n)).rejects.toThrow('Request exceeds defined limit.')
  })

  it('refuses a chain Sticky is not deployed on, without opening a reader', async () => {
    await expect(readStickyProject(137, 1n)).rejects.toThrow('Sticky is not deployed on chain 137.')
    expect(center.client).not.toHaveBeenCalled()
  })
})

describe('verifyStickyDeployment', () => {
  const deployer = (overrides: World = {}): World => ({
    [at(deployment.deployer, 'HOOK')]: deployment.hook,
    [at(deployment.deployer, 'TERMINAL')]: deployment.terminal,
    [at(deployment.deployer, 'CONTROLLER')]: deployment.controller,
    ...overrides,
  })

  it('accepts a deployer that reports the recorded hook, terminal and controller', async () => {
    const { multicall } = fakeCenter(deployer())
    await expect(verifyStickyDeployment(CHAIN)).resolves.toBeUndefined()
    expect(center.client).toHaveBeenCalledWith(CHAIN)
    expect(multicall).toHaveBeenCalledOnce()
    expect(multicall.mock.calls[0][0].allowFailure).toBe(true)
    expect(multicall.mock.calls[0][0].contracts.map(call => [call.address, call.functionName])).toEqual([
      [deployment.deployer, 'HOOK'],
      [deployment.deployer, 'TERMINAL'],
      [deployment.deployer, 'CONTROLLER'],
    ])
  })

  it('throws StickyDeploymentMismatch on a hook mismatch', async () => {
    fakeCenter(deployer({ [at(deployment.deployer, 'HOOK')]: OTHER }))
    const error = await verifyStickyDeployment(CHAIN).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(StickyDeploymentMismatch)
    expect(error).toMatchObject({
      name: 'StickyDeploymentMismatch',
      chainId: CHAIN,
      differences: [{ name: 'HOOK', expected: deployment.hook, actual: OTHER }],
    })
    expect((error as Error).message).toContain(`HOOK() is ${OTHER}, expected ${deployment.hook}`)
  })

  it.each(['TERMINAL', 'CONTROLLER'])('throws when only %s differs, and names it alone', async name => {
    fakeCenter(deployer({ [at(deployment.deployer, name)]: OTHER }))
    const error = (await verifyStickyDeployment(CHAIN).catch((caught: unknown) => caught)) as StickyDeploymentMismatch
    expect(error).toBeInstanceOf(StickyDeploymentMismatch)
    expect(error.differences.map(difference => difference.name)).toEqual([name])
  })

  it('names every difference', async () => {
    fakeCenter(
      deployer({ [at(deployment.deployer, 'HOOK')]: OTHER, [at(deployment.deployer, 'CONTROLLER')]: OTHER }),
    )
    const error = (await verifyStickyDeployment(CHAIN).catch((caught: unknown) => caught)) as StickyDeploymentMismatch
    expect(error.differences.map(difference => difference.name)).toEqual(['HOOK', 'CONTROLLER'])
  })

  it('reads a deployer that cannot answer as a mismatch, not as a pass', async () => {
    fakeCenter(deployer({ [at(deployment.deployer, 'HOOK')]: reverted('HOOK') }))
    const error = (await verifyStickyDeployment(CHAIN).catch((caught: unknown) => caught)) as StickyDeploymentMismatch
    expect(error).toBeInstanceOf(StickyDeploymentMismatch)
    expect(error.differences).toEqual([{ name: 'HOOK', expected: deployment.hook, actual: null }])
    expect(error.message).toContain('HOOK() is unreadable')
  })

  it('does not read a request that got no answer as a mismatch', async () => {
    fakeCenter(deployer({ [at(deployment.deployer, 'HOOK')]: unanswered() }))
    const error = await verifyStickyDeployment(CHAIN).catch((caught: unknown) => caught)
    expect(error).not.toBeInstanceOf(StickyDeploymentMismatch)
    expect((error as Error).message).toContain('Request exceeds defined limit.')
  })

  it('compares addresses, not their spelling', async () => {
    fakeCenter(deployer({ [at(deployment.deployer, 'HOOK')]: deployment.hook.toLowerCase() }))
    await expect(verifyStickyDeployment(CHAIN)).resolves.toBeUndefined()
  })

  it('refuses a chain Sticky is not deployed on, without opening a reader', async () => {
    await expect(verifyStickyDeployment(137)).rejects.toThrow('Sticky is not deployed on chain 137.')
    expect(center.client).not.toHaveBeenCalled()
  })
})
