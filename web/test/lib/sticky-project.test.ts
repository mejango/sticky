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
  readStickyProjects,
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
// (MKR), and the fake keeps the two readings apart by the type the asked function returns. A key
// with one of the call's arguments after it, "<contract>.<function>@<argument>", stocks one project's
// answer apart from the others'.
type World = Record<string, unknown>
const at = (contract: Address, functionName: string) => `${contract.toLowerCase()}.${functionName}`
const forProject = (key: string, projectId: bigint) => `${key}@${projectId}`
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

/** `lost` names a contract whose calls lose the whole request that carries them, as a token can by answering with more
 * than Center carries or by running Multicall3 out of gas. */
function fakeCenter(chain: World, { lost }: { lost?: Address } = {}) {
  const getBlockNumber = vi.fn(async () => HEAD)
  const multicall = vi.fn(async ({ contracts }: Round) => {
    if (contracts.some(call => call.address === lost)) {
      return contracts.map(() => ({ status: 'failure' as const, error: unanswered() }))
    }
    return contracts.map(call => {
      const { address: contract, functionName } = call
      const key = at(contract, functionName)
      const own = call.args?.map(arg => chain[`${key}@${String(arg)}`]).find(reply => reply !== undefined)
      const reply = own ?? chain[returnsBytes32(call) ? asBytes32(key) : key]
      if (reply === undefined) throw new Error(`the fake chain has no ${functionName} on ${contract}`)
      return reply instanceof Error
        ? { status: 'failure' as const, error: reply }
        : { status: 'success' as const, result: reply }
    })
  })
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

    expect(center.client).toHaveBeenCalledWith(CHAIN, undefined)
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
      plannedChains: [84532, 11155420],
      blockNumber: HEAD,
    })
    // The block is the head as Center says it now, not one viem kept from a read before a write landed.
    expect(getBlockNumber.mock.calls).toEqual([[{ cacheTime: 0 }]])
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

  // The old client wrote a launch's uri as
  // `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify({protocol: "Sticky", version: 1,
  // launchId, environment, chains}))}` (webclient/app.js:5020-5026).
  const oldClientUri = (chains: unknown) =>
    `data:application/json;charset=utf-8,${encodeURIComponent(
      JSON.stringify({ protocol: 'Sticky', version: 1, launchId: LAUNCH, environment: 'production', chains }),
    )}`
  it.each([
    ['the chains the old client wrote', oldClientUri([8453, 10, 42161]), [8453, 10, 42161]],
    ['one chain', oldClientUri([84532]), [84532]],
    ['chains written as numeric strings', oldClientUri(['8453', '10']), [8453, 10]],
    ['a chain listed twice, once', oldClientUri([8453, 10, 8453]), [8453, 10]],
    ['only the entries that are chain ids', oldClientUri([8453, 0, -1, 1.5, 'base', null, 10]), [8453, 10]],
    ['a base64 data uri', base64({ protocol: 'Sticky', launchId: LAUNCH, chains: [1, 10] }), [1, 10]],
    ['no chains', oldClientUri(undefined), null],
    ['an empty list', oldClientUri([]), null],
    ['a list with no chain ids', oldClientUri(['base']), null],
    ['chains that are not a list', oldClientUri('8453,10'), null],
    ['another protocol', `data:application/json,${encodeURIComponent('{"protocol":"Other","chains":[8453]}')}`, null],
    ['a uri that is not a data uri', 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi', null],
  ])('takes the planned chains from %s', async (_what, uri, plannedChains) => {
    fakeCenter(world({ [at(deployment.controller, 'uriOf')]: uri }))
    const info = await readStickyProject(CHAIN, 12n)
    expect(info.plannedChains).toEqual(plannedChains)
  })

  it('reads the launch id and the planned chains from the same uri, each without the other', async () => {
    const chainsOnly = `data:application/json,${encodeURIComponent('{"protocol":"Sticky","chains":[8453]}')}`
    fakeCenter(world({ [at(deployment.controller, 'uriOf')]: chainsOnly }))
    expect(await readStickyProject(CHAIN, 12n)).toMatchObject({ launchId: null, plannedChains: [8453] })
    fakeCenter(world({ [at(deployment.controller, 'uriOf')]: oldClientUri(undefined) }))
    expect(await readStickyProject(CHAIN, 12n)).toMatchObject({ launchId: LAUNCH, plannedChains: null })
  })

  it('has no planned chains when uriOf reverts', async () => {
    fakeCenter(world({ [at(deployment.controller, 'uriOf')]: reverted('uriOf') }))
    expect((await readStickyProject(CHAIN, 12n)).plannedChains).toBeNull()
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

describe('the length of a token\'s symbol and name', () => {
  it('cuts the staked token\'s and the Sticky token\'s at 256 characters', async () => {
    fakeCenter(
      world({
        [at(STAKED, 'symbol')]: 'S'.repeat(300),
        [at(STAKED, 'name')]: 'N'.repeat(100_000),
        [at(STICKY, 'symbol')]: 'T'.repeat(257),
        [at(STICKY, 'name')]: 'M'.repeat(256),
      }),
    )
    expect(await readStickyProject(CHAIN, 12n)).toMatchObject({
      symbol: 'S'.repeat(256),
      name: 'N'.repeat(256),
      stSymbol: 'T'.repeat(256),
      stName: 'M'.repeat(256),
    })
  })

  it('counts characters, not UTF-16 units, so a cut never splits one', async () => {
    fakeCenter(world({ [at(STAKED, 'symbol')]: '🍩'.repeat(300) }))
    expect((await readStickyProject(CHAIN, 12n)).symbol).toBe('🍩'.repeat(256))
  })
})

describe('readStickyProjects', () => {
  const ids = (count: number, from = 1n) => Array.from({ length: count }, (_, at) => from + BigInt(at))

  it('reads a chain\'s projects in the same two Multicall3 rounds, at one block', async () => {
    const { getBlockNumber, multicall } = fakeCenter(world())
    const infos = await readStickyProjects(CHAIN, ids(3, 12n))

    expect(infos.map(info => info.projectId)).toEqual([12n, 13n, 14n])
    expect(infos[1]).toEqual({ ...(await readStickyProject(CHAIN, 12n)), projectId: 13n })
    expect(getBlockNumber).toHaveBeenCalledTimes(2)
    // Three projects: five calls each and the store once, then ten calls each.
    const [first, second] = multicall.mock.calls.slice(0, 2).map(([round]) => round)
    expect([first.contracts.length, second.contracts.length]).toEqual([16, 30])
    expect([first.blockNumber, second.blockNumber]).toEqual([HEAD, HEAD])
  })

  it('carries at most 25 projects in a request', async () => {
    const { multicall } = fakeCenter(world())
    const infos = await readStickyProjects(CHAIN, ids(30))
    expect(infos).toHaveLength(30)
    expect(multicall.mock.calls.map(([round]) => round.contracts.length)).toEqual([126, 250, 26, 50])
  })

  it('leaves out a project that cannot be read, tells the console which, and reads the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failure = reverted('tokenOf')
    fakeCenter(
      world({
        [forProject(at(deployment.deployer, 'stakedTokenOf'), 13n)]: zeroAddress,
        [forProject(at(deployment.hook, 'tokenOf'), 14n)]: failure,
      }),
    )
    const infos = await readStickyProjects(CHAIN, ids(4, 12n))

    expect(infos.map(info => info.projectId)).toEqual([12n, 15n])
    expect(warn.mock.calls.map(([label, about, error]) => [label, about, (error as Error).message])).toEqual([
      [expect.stringMatching(/project/), { chainId: CHAIN, projectId: 13n }, 'Project 13 is not a Sticky token of this deployer.'],
      [expect.stringMatching(/project/), { chainId: CHAIN, projectId: 14n }, 'Sticky project 14 on chain 84532: the Sticky token could not be read.'],
    ])
    warn.mockRestore()
  })

  it('reads no further than the first round for projects none of which it can read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { multicall } = fakeCenter(world({ [at(deployment.deployer, 'stakedTokenOf')]: zeroAddress }))
    expect(await readStickyProjects(CHAIN, ids(2))).toEqual([])
    expect(multicall).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('gives each project its own figures', async () => {
    const [staked, sticky] = [address('5'), address('6')]
    fakeCenter(
      world({
        [forProject(at(deployment.deployer, 'stakedTokenOf'), 13n)]: staked,
        [forProject(at(deployment.deployer, 'cashOutTaxRateOf'), 13n)]: 2500n,
        [forProject(at(deployment.hook, 'tokenOf'), 13n)]: sticky,
        [forProject(at(deployment.hook, 'orphanedBalanceOf'), 13n)]: 7n,
        [at(staked, 'symbol')]: 'MKR',
        [asBytes32(at(staked, 'symbol'))]: OFFSET_WORD,
        [at(staked, 'decimals')]: 18,
        [at(staked, 'name')]: 'Maker',
        [asBytes32(at(staked, 'name'))]: OFFSET_WORD,
        [at(sticky, 'symbol')]: 'STICKYMKR',
        [at(sticky, 'name')]: 'Streaking MKR',
        [at(sticky, 'SOULBOUND')]: true,
        [at(sticky, 'totalSupply')]: 5n * 10n ** 18n,
        [forProject(at(STORE, 'balanceOf'), 13n)]: 70n,
      }),
    )

    const infos = await readStickyProjects(CHAIN, [12n, 13n])

    expect(infos).toEqual([
      expect.objectContaining({
        projectId: 12n,
        stakedToken: STAKED,
        symbol: 'ART',
        name: 'Art',
        decimals: 6,
        stToken: STICKY,
        stSymbol: 'STICKYART',
        stName: 'Streaking ART',
        soulbound: false,
        totalSupply: 10n ** 18n,
        backing: 6n,
        orphaned: 4n,
        cashOutTaxRate: 1000n,
      }),
      expect.objectContaining({
        projectId: 13n,
        stakedToken: staked,
        symbol: 'MKR',
        name: 'Maker',
        decimals: 18,
        stToken: sticky,
        stSymbol: 'STICKYMKR',
        stName: 'Streaking MKR',
        soulbound: true,
        totalSupply: 5n * 10n ** 18n,
        backing: 63n,
        orphaned: 7n,
        cashOutTaxRate: 2500n,
      }),
    ])
  })

  describe('a request one project loses for the rest', () => {
    // Its staked token answers with more than Center carries, or runs Multicall3 out of gas, so the round that asks it
    // gets no answer for any project in that request.
    const HOSTILE = address('7')
    const hostile = (projectId: bigint) =>
      world({ [forProject(at(deployment.deployer, 'stakedTokenOf'), projectId)]: HOSTILE })
    // A project read on its own: its first round, then its second.
    const alone = (count: number) => Array.from({ length: count }, () => [6, 10]).flat()

    it.each([
      { request: 'the first', lost: 3n, requests: [126, 250, ...alone(25), 26, 50] },
      { request: 'a later', lost: 28n, requests: [126, 250, 26, 50, ...alone(5)] },
    ])(
      'in $request request, reads the rest of that request one project at a time and leaves that one out',
      async ({ lost, requests }) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const { getBlockNumber, multicall } = fakeCenter(hostile(lost), { lost: HOSTILE })

        const infos = await readStickyProjects(CHAIN, ids(30))

        expect(infos.map(info => info.projectId)).toEqual(ids(30).filter(id => id !== lost))
        expect(warn.mock.calls.map(([label, about]) => [label, about])).toEqual([
          [expect.stringMatching(/project/), { chainId: CHAIN, projectId: lost }],
        ])
        // Center is asked afresh whether it still answers, and every read stays at the block the first asked for.
        expect(getBlockNumber.mock.calls).toEqual([[{ cacheTime: 0 }], [{ cacheTime: 0 }]])
        expect(multicall.mock.calls.map(([round]) => round.contracts.length)).toEqual(requests)
        expect(multicall.mock.calls.every(([round]) => round.blockNumber === HEAD)).toBe(true)
        warn.mockRestore()
      },
    )

    it('rejects with why the request was lost when Center does not answer either', async () => {
      const { getBlockNumber, multicall } = fakeCenter(hostile(3n), { lost: HOSTILE })
      getBlockNumber.mockResolvedValueOnce(HEAD).mockRejectedValueOnce(new Error('Center is busy.'))
      await expect(readStickyProjects(CHAIN, ids(30))).rejects.toThrow('Request exceeds defined limit.')
      expect(multicall).toHaveBeenCalledTimes(2)
    })

    it('rejects when the one project read loses its request, without asking Center again', async () => {
      const { getBlockNumber } = fakeCenter(hostile(3n), { lost: HOSTILE })
      await expect(readStickyProjects(CHAIN, [3n])).rejects.toThrow('Request exceeds defined limit.')
      await expect(readStickyProject(CHAIN, 3n)).rejects.toThrow('Request exceeds defined limit.')
      expect(getBlockNumber).toHaveBeenCalledTimes(2)
    })
  })

  it('reads nothing for no projects', async () => {
    const { getBlockNumber, multicall } = fakeCenter(world())
    expect(await readStickyProjects(CHAIN, [])).toEqual([])
    expect(getBlockNumber).not.toHaveBeenCalled()
    expect(multicall).not.toHaveBeenCalled()
  })

  it('reads one project through the page\'s reader when given the page\'s signal, and rejects with its reason once it aborts', async () => {
    const controller = new AbortController()
    const reason = new Error('left the page')
    const { multicall } = fakeCenter(world())
    multicall.mockReturnValue(new Promise(() => {}))
    const reading = readStickyProject(CHAIN, 12n, { signal: controller.signal })
    await vi.waitFor(() => expect(multicall).toHaveBeenCalled())
    expect(center.client).toHaveBeenCalledWith(CHAIN, controller.signal)
    controller.abort(reason)
    await expect(reading).rejects.toBe(reason)
  })

  it('rejects with the caller\'s reason once cancelled, without waiting for the request under way', async () => {
    const controller = new AbortController()
    const reason = new Error('left the page')
    const { multicall } = fakeCenter(world())
    multicall.mockReturnValue(new Promise(() => {}))
    const reading = readStickyProjects(CHAIN, ids(2), { signal: controller.signal })
    await vi.waitFor(() => expect(multicall).toHaveBeenCalled())
    // Through the page's reader, so the request stops too.
    expect(center.client).toHaveBeenCalledWith(CHAIN, controller.signal)
    controller.abort(reason)
    await expect(reading).rejects.toBe(reason)
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
