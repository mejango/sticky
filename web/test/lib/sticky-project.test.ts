import {
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  getAddress,
  multicall3Abi,
  stringToHex,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stickyTokenAbi } from '@/lib/sticky-abis'
import { stickyDeployment } from '@/lib/sticky-addresses'
import {
  StickyDeploymentMismatch,
  backingOfShares,
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
// how it fails, and a call nobody stocked is a bug in the read, so it throws. The staked token's
// symbol and name are asked twice, as the string most tokens return and as the bytes32 some return
// (MKR), and the fake keeps the two readings apart by the type the asked function returns.
type World = Record<string, unknown>
const at = (contract: Address, functionName: string) => `${contract.toLowerCase()}.${functionName}`
const asBytes32 = (key: string) => `${key}:bytes32`
// What decoding a string's return as a bytes32 yields: the string's offset word.
const OFFSET_WORD: Hex = `0x${'0'.repeat(62)}20`

function world(overrides: World = {}): World {
  return {
    [at(deployment.deployer, 'stakedTokenOf')]: STAKED,
    [at(deployment.deployer, 'cashOutTaxRateOf')]: 1000n,
    [at(deployment.hook, 'tokenOf')]: STICKY,
    [at(deployment.hook, 'orphanedBalanceOf')]: 4n,
    [at(deployment.terminal, 'STORE')]: STORE,
    [at(deployment.controller, 'uriOf')]: uriFor(LAUNCH),
    [at(STAKED, 'symbol')]: 'ART',
    [asBytes32(at(STAKED, 'symbol'))]: OFFSET_WORD,
    [at(STAKED, 'decimals')]: 6,
    [at(STAKED, 'name')]: 'Art',
    [asBytes32(at(STAKED, 'name'))]: OFFSET_WORD,
    [at(STICKY, 'symbol')]: 'STICKYART',
    [at(STICKY, 'name')]: 'Streaking ART',
    [at(STICKY, 'SOULBOUND')]: false,
    [at(STICKY, 'totalSupply')]: 10n ** 18n,
    [at(STORE, 'balanceOf')]: 10n,
    ...overrides,
  }
}

type Round = {
  contracts: readonly { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }[]
  allowFailure?: boolean
  blockNumber?: bigint
}

const returnsBytes32 = ({ abi, functionName }: Round['contracts'][number]) =>
  abi.some(item => item.type === 'function' && item.name === functionName && item.outputs[0]?.type === 'bytes32')

function fakeCenter(chain: World) {
  const getBlockNumber = vi.fn(async () => HEAD)
  const multicall = vi.fn(async ({ contracts }: Round) =>
    contracts.map(call => {
      const { address: contract, functionName } = call
      const key = at(contract, functionName)
      const reply = chain[returnsBytes32(call) ? asBytes32(key) : key]
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
      rawBacking: 10n,
      savedOrphaned: 4n,
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
    await expect(readStickyProject(CHAIN, 12n, { orphans: 'strict' })).rejects.toThrow(/inconsistent backing/)
  })

  it.each([10n ** 18n, 0n])(
    'clamped, reads a recorded orphaned balance above what the terminal holds as no backing (supply %s)',
    async totalSupply => {
      fakeCenter(
        world({
          [at(STORE, 'balanceOf')]: 10n,
          [at(deployment.hook, 'orphanedBalanceOf')]: 11n,
          [at(STICKY, 'totalSupply')]: totalSupply,
        }),
      )
      const info = await readStickyProject(CHAIN, 12n, { orphans: 'clamp' })
      expect(info).toMatchObject({ backing: 0n, orphaned: 10n, rawBacking: 10n, savedOrphaned: 11n, totalSupply })
    },
  )

  it('clamped, reads consistent accounting as a strict read does', async () => {
    fakeCenter(world({ [at(STORE, 'balanceOf')]: 10n, [at(deployment.hook, 'orphanedBalanceOf')]: 4n }))
    const strict = await readStickyProject(CHAIN, 12n)
    expect(await readStickyProject(CHAIN, 12n, { orphans: 'clamp' })).toEqual(strict)
    expect(strict).toMatchObject({ backing: 6n, orphaned: 4n })
  })

  it.each([0n, 3n])(
    'keeps the recorded orphaned balance (%s) beside the effective one while no shares exist, for the backing chart',
    async saved => {
      fakeCenter(
        world({
          [at(STORE, 'balanceOf')]: 10n,
          [at(deployment.hook, 'orphanedBalanceOf')]: saved,
          [at(STICKY, 'totalSupply')]: 0n,
        }),
      )
      const info = await readStickyProject(CHAIN, 12n)
      expect(info.orphaned).toBe(10n)
      expect(info.savedOrphaned).toBe(saved)
      expect(info.rawBacking).toBe(10n)
      expect(info.backing).toBe(0n)
    },
  )

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
    ['the underlying decimals', at(STAKED, 'decimals')],
    ['the Sticky symbol', at(STICKY, 'symbol')],
    ['the Sticky name', at(STICKY, 'name')],
    ['the Sticky supply', at(STICKY, 'totalSupply')],
    ['the terminal balance', at(STORE, 'balanceOf')],
  ])('fails when %s cannot be read, instead of reading zero', async (_what, failing) => {
    fakeCenter(world({ [failing]: reverted(failing.split('.')[1]) }))
    await expect(readStickyProject(CHAIN, 12n)).rejects.toThrow(/could not be read/)
  })

  describe("the staked token's symbol and name", () => {
    // A token like MKR returns bytes32, so reading it as a string fails to decode.
    const bytes32Token = (symbol: Hex, name: Hex) =>
      world({
        [at(STAKED, 'symbol')]: reverted('symbol'),
        [asBytes32(at(STAKED, 'symbol'))]: symbol,
        [at(STAKED, 'name')]: reverted('name'),
        [asBytes32(at(STAKED, 'name'))]: name,
      })

    it('reads the string most tokens return, and not what the bytes32 reading of it decodes to', async () => {
      fakeCenter(world())
      expect(await readStickyProject(CHAIN, 12n)).toMatchObject({ symbol: 'ART', name: 'Art' })
    })

    it('asks for both readings in the same round as the rest', async () => {
      const { multicall } = fakeCenter(world())
      await readStickyProject(CHAIN, 12n)
      const [, second] = multicall.mock.calls
      expect(
        second[0].contracts
          .filter(call => call.address === STAKED && ['symbol', 'name'].includes(call.functionName))
          .map(call => `${call.functionName} as ${returnsBytes32(call) ? 'bytes32' : 'string'}`)
          .sort(),
      ).toEqual(['name as bytes32', 'name as string', 'symbol as bytes32', 'symbol as string'])
    })

    it.each([
      ['NUL padding', stringToHex('MKR', { size: 32 }), 'MKR'],
      ['all 32 bytes used', stringToHex('x'.repeat(32), { size: 32 }), 'x'.repeat(32)],
      ['multi-byte text', stringToHex('Ξ Maker', { size: 32 }), 'Ξ Maker'],
      ['an empty word', `0x${'0'.repeat(64)}` as Hex, ''],
    ])('reads a bytes32 symbol and name with %s', async (_what, word, text) => {
      fakeCenter(bytes32Token(word, word))
      expect(await readStickyProject(CHAIN, 12n)).toMatchObject({ symbol: text, name: text })
    })

    it('reads each of the two in its own form', async () => {
      fakeCenter(
        world({
          [at(STAKED, 'name')]: reverted('name'),
          [asBytes32(at(STAKED, 'name'))]: stringToHex('Maker', { size: 32 }),
        }),
      )
      expect(await readStickyProject(CHAIN, 12n)).toMatchObject({ symbol: 'ART', name: 'Maker' })
    })

    it.each(['symbol', 'name'])('fails when neither reading of the %s decodes', async functionName => {
      fakeCenter(
        world({
          [at(STAKED, functionName)]: reverted(functionName),
          [asBytes32(at(STAKED, functionName))]: reverted(functionName),
        }),
      )
      await expect(readStickyProject(CHAIN, 12n)).rejects.toThrow(/could not be read/)
    })

    it.each(['symbol', 'name'])('does not read a request that got no answer for the bytes32 %s as a string token', async functionName => {
      fakeCenter(world({ [asBytes32(at(STAKED, functionName))]: unanswered() }))
      await expect(readStickyProject(CHAIN, 12n)).rejects.toThrow('Request exceeds defined limit.')
    })
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

// From the old client's test/feed-amounts.test.cjs: the pool it named `{ supply, sigma }` is a project's
// `totalSupply` and `backing`.
describe('backingOfShares', () => {
  it('is the share of the backing that the shares are of the supply, rounded down', () => {
    expect(backingOfShares(10n, { totalSupply: 100n, backing: 101n })).toBe(10n)
    expect(backingOfShares(50n, { totalSupply: 100n, backing: 202n })).toBe(101n)
  })

  it('is zero while no shares exist, whatever the terminal holds', () => {
    expect(backingOfShares(50n, { totalSupply: 0n, backing: 0n })).toBe(0n)
    expect(backingOfShares(50n, { totalSupply: 0n, backing: 7n })).toBe(0n)
  })

  it('is the whole backing for the whole supply', () => {
    expect(backingOfShares(3n * 10n ** 18n, { totalSupply: 3n * 10n ** 18n, backing: 12_345n })).toBe(12_345n)
  })
})
