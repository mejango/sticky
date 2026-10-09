import { decodeFunctionData, encodeFunctionData, getAddress, type Address, type Hex } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stickyDeployerAbi } from '@/lib/sticky-abis'
import { stickyDeployment } from '@/lib/sticky-addresses'
import {
  BONUS_PRESETS, ZERO, bonusBasisPoints, checkSameToken, defaultNames, launchChainBlocker, launchGranters,
  parseSenders, parseTokenInput, prepareStickyLaunch, resolveProjectToken, revalidateStickyLaunch, type LaunchInput,
} from '@/lib/sticky-launch-plan'

const rpc = vi.hoisted(() => ({ client: vi.fn() }))
vi.mock('@/lib/jbcenter-rpc', () => ({ jbCenterPublicClient: rpc.client }))
const address = (digit: string) => getAddress(`0x${digit.repeat(40)}`)
const OWNER = address('1')
const TOKEN = address('2')
const PROJECTS = address('3')
const TOKENS = address('4')
const OTHER = address('9')
const ids = [84532, 11155420]
const input: LaunchInput = { tokenInput: TOKEN, bonusChoice: '10', trustedSenders: '', soulbound: false,
  chainIds: [ids[0]], environment: 'testnet' }

function world(chainId: number) {
  const deployment = stickyDeployment(chainId)!
  const answers = new Map<string, unknown>([
    [`${deployment.deployer}.CONTROLLER`, deployment.controller],
    [`${deployment.controller}.PROJECTS`, PROJECTS], [`${deployment.controller}.TOKENS`, TOKENS],
    [`${PROJECTS}.creationFee`, BigInt(chainId)], [`${TOKENS}.tokenOf`, TOKEN],
    [`${deployment.autoStick}.DEPLOYER`, deployment.deployer],
    [`${deployment.autoStick}.DISTRIBUTOR`, deployment.distributor],
    [`${deployment.autoStick}.HOOK`, deployment.hook], [`${deployment.deployer}.HOOK`, deployment.hook],
    [`${TOKEN}.name`, 'Artizen'], [`${TOKEN}.symbol`, 'ART'], [`${TOKEN}.decimals`, 18],
  ])
  return {
    answers, deployment,
    getChainId: vi.fn(async () => chainId),
    getCode: vi.fn(async (_args: { address: Address }): Promise<Hex | undefined> => '0x6000'),
    readContract: vi.fn(async ({ address, functionName }: { address: Address; functionName: string; args?: unknown[] }) => {
      const key = `${address}.${functionName}`
      if (!answers.has(key)) throw new Error(`Unexpected read: ${key}`)
      const value = answers.get(key)
      if (value instanceof Error) throw value
      return value
    }),
  }
}
let worlds: Map<number, ReturnType<typeof world>>
beforeEach(() => {
  worlds = new Map([...ids, 8453].map(id => [id, world(id)]))
  rpc.client.mockImplementation((id: number) => {
    const found = worlds.get(id)
    if (!found) throw new Error(`Unexpected chain ${id}`)
    return found
  })
})

describe('legacy launch rules', () => {
  it('keeps presets and exact hundredths without floating point', () => {
    expect(BONUS_PRESETS.map(preset => bonusBasisPoints(preset))).toEqual([0n, 500n, 1000n, 2500n])
    expect(() => bonusBasisPoints('50')).toThrow('Choose')
    for (const [text, expected] of [['0', 0n], ['7', 700n], ['12.5', 1250n], ['99.99', 9999n], [' 3.05 ', 305n]] as const) {
      expect(bonusBasisPoints('custom', text)).toBe(expected)
    }
    for (const text of ['100', '100.00', '99.999', '-1', '', '1e2', 'abc', '0x10']) {
      expect(() => bonusBasisPoints('custom', text)).toThrow('0 to 99.99')
    }
    expect(() => bonusBasisPoints('custom')).toThrow('0 to 99.99')
    expect(defaultNames('Artizen', 'art')).toEqual({ name: 'Sticky Artizen', symbol: 'STICKYART' })
  })

  it('validates senders and appends exactly one AutoStick granter', () => {
    const adapter = address('a')
    const upper = `0x${adapter.slice(2).toUpperCase()}` as Address
    expect(parseSenders(` ${OWNER}, ${adapter}, ${upper}, `)).toEqual([OWNER, adapter])
    expect(parseSenders('')).toEqual([])
    for (const invalid of ['0x123', ZERO]) expect(() => parseSenders(invalid)).toThrow('Not an address')
    expect(launchGranters([upper, OWNER], adapter, 'Base')).toEqual([OWNER, adapter])
    for (const missing of [undefined, '', ZERO, '0x1234']) {
      expect(() => launchGranters([], missing, 'OP Sepolia')).toThrow('OP Sepolia has no auto-stick helper')
    }
    expect(launchChainBlocker(84532)).toBe('')
    expect(launchChainBlocker(999)).toBe('not deployed')
  })

  it('parses addresses, positive project IDs and chain aliases', () => {
    expect(parseTokenInput(` ${TOKEN} `)).toEqual({ kind: 'address', address: TOKEN })
    expect(parseTokenInput('12')).toEqual({ kind: 'project', projectId: 12n, chainId: null })
    expect(parseTokenInput('base-sepolia:3')).toEqual({ kind: 'project', projectId: 3n, chainId: 84532 })
    expect(parseTokenInput('mars:3')).toEqual({ kind: 'unknown-chain', prefix: 'mars' })
    expect(parseTokenInput('').kind).toBe('empty')
    for (const text of ['0', '0x12', '1.5', 'base:', '100000000000000000000']) expect(parseTokenInput(text).kind).toBe('invalid')
  })

  it('resolves a project only on the selected home chain and refuses conflicting prefixes', async () => {
    const tokenOfAt = vi.fn(async () => TOKEN)
    const args = { projectId: 4n, chainId: null, targetChainIds: [ids[0]], tokenOfAt, nameOf: (id: number) => `chain ${id}` }
    expect(await resolveProjectToken(args)).toEqual({ address: TOKEN, chainIds: [ids[0]] })
    expect(tokenOfAt).toHaveBeenCalledExactlyOnceWith(ids[0], 4n)
    await expect(resolveProjectToken({ ...args, targetChainIds: [] })).rejects.toThrow('one home chain')
    await expect(resolveProjectToken({ ...args, targetChainIds: ids })).rejects.toThrow('one home chain')
    for (const value of [ZERO, new Error('reverted')]) {
      await expect(resolveProjectToken({ ...args, tokenOfAt: async () => {
        if (value instanceof Error) throw value
        return value
      } })).rejects.toThrow('Project #4 has no ERC-20 on chain 84532')
    }
    tokenOfAt.mockClear()
    await expect(resolveProjectToken({ ...args, chainId: 8453 })).rejects.toThrow('selected home chain')
    expect(tokenOfAt).not.toHaveBeenCalled()
    expect(await resolveProjectToken({ ...args, chainId: ids[0] })).toEqual({ address: TOKEN, chainIds: [ids[0]] })
    expect(tokenOfAt).toHaveBeenCalledExactlyOnceWith(ids[0], 4n)
  })

  it('requires identical token name, symbol and decimals', () => {
    const first = { name: 'Base', tokenName: 'Art', tokenSymbol: 'ART', tokenDecimals: 18 }
    expect(checkSameToken([first, { ...first, name: 'OP' }])).toBe(first)
    for (const change of [{ tokenName: 'Artt' }, { tokenSymbol: 'ARTT' }, { tokenDecimals: 6 }]) {
      expect(() => checkSameToken([first, { ...first, ...change, name: 'OP' }])).toThrow('OP: the token differs from the one on Base')
    }
    expect(() => checkSameToken([])).toThrow('Choose at least one')
  })
})

describe('runtime preparation', () => {
  it('enforces one home chain before any preparation or revalidation RPC', async () => {
    await expect(prepareStickyLaunch({ ...input, chainIds: ids }, OWNER)).rejects.toThrow('one home chain')
    expect(rpc.client).not.toHaveBeenCalled()
    const plan = await prepareStickyLaunch({ ...input, chainIds: [ids[0]] }, OWNER)
    rpc.client.mockClear()
    plan.targets.push({ ...plan.targets[0], chainId: ids[1], call: { ...plan.targets[0].call, chain: ids[1] } })
    await expect(revalidateStickyLaunch(plan)).rejects.toThrow('one home chain')
    expect(rpc.client).not.toHaveBeenCalled()
  })

  it('rejects a qualified token on another chain before preparation reads', async () => {
    await expect(prepareStickyLaunch({ ...input, chainIds: [ids[0]], tokenInput: 'base:4' }, OWNER))
      .rejects.toThrow('selected home chain')
    expect(rpc.client).not.toHaveBeenCalled()
  })

  it('binds one home call to verified runtime, token, fee, names and its launch identity', async () => {
    const plan = await prepareStickyLaunch({ ...input, trustedSenders: OWNER, soulbound: true }, OWNER)
    expect(plan).toMatchObject({ owner: OWNER, token: TOKEN, name: 'Sticky Artizen', symbol: 'STICKYART',
      tokenName: 'Artizen', tokenSymbol: 'ART', tokenDecimals: 18, cashOutTaxRate: '1000', soulbound: true })
    const metadata = JSON.parse(decodeURIComponent(plan.projectUri.split(',')[1]))
    expect(metadata).toEqual({ protocol: 'Sticky', version: 1, launchId: plan.id, environment: 'testnet', chains: [ids[0]] })
    expect(plan.targets).toHaveLength(1)
    for (const target of plan.targets) {
      const state = worlds.get(target.chainId)!
      expect(target).toMatchObject({ deployer: state.deployment.deployer, controller: state.deployment.controller, projects: PROJECTS,
        call: { chain: target.chainId, target: state.deployment.deployer, value: String(target.chainId) } })
      expect(decodeFunctionData({ abi: stickyDeployerAbi, data: target.call.data })).toMatchObject({
        functionName: 'deployStickyFor', args: [TOKEN, plan.name, plan.symbol, plan.projectUri, 1000n, [OWNER, state.deployment.autoStick], true],
      })
      expect(state.getChainId).toHaveBeenCalledOnce()
      expect(state.getCode.mock.calls.map(([args]) => args.address)).toEqual(expect.arrayContaining([
        state.deployment.deployer, state.deployment.controller, PROJECTS, TOKENS, state.deployment.autoStick,
      ]))
    }
    expect(() => JSON.stringify(plan)).not.toThrow()
  })

  it('resolves a bare ID only on its home chain and refreshes creation fees for the next preparation', async () => {
    const first = await prepareStickyLaunch({ ...input, tokenInput: '4', name: ' Custom ', symbol: ' custom ' }, OWNER)
    expect(first).toMatchObject({ name: 'Custom', symbol: 'custom', token: TOKEN })
    for (const state of worlds.values()) if (await state.getChainId() === ids[0]) {
      expect(state.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: TOKENS, functionName: 'tokenOf', args: [4n] }))
    }
    worlds.get(ids[0])!.answers.set(`${PROJECTS}.creationFee`, 20n)
    const second = await prepareStickyLaunch(input, OWNER)
    expect(second.targets[0].call.value).toBe('20')
    expect(second.id).not.toBe(first.id)
  })

  it('resolves a matching prefixed project and reads metadata on the home chain only', async () => {
    await prepareStickyLaunch({ ...input, tokenInput: 'base-sepolia:4' }, OWNER)
    expect(worlds.get(ids[0])!.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'tokenOf', args: [4n] }))
    expect(worlds.get(ids[0])!.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: TOKEN, functionName: 'decimals' }))
    for (const id of [ids[1], 8453]) expect(worlds.get(id)!.readContract).not.toHaveBeenCalled()
  })

  it('rejects invalid identity, unsupported environment choices and malformed token inputs', async () => {
    await expect(prepareStickyLaunch(input, ZERO)).rejects.toThrow('Connect a wallet')
    await expect(prepareStickyLaunch({ ...input, chainIds: [] }, OWNER)).rejects.toThrow('one home chain')
    for (const chainIds of [[8453], [999]]) {
      await expect(prepareStickyLaunch({ ...input, chainIds }, OWNER)).rejects.toThrow('selected network environment')
    }
    for (const tokenInput of ['', '0', '0x123', ZERO]) {
      await expect(prepareStickyLaunch({ ...input, tokenInput }, OWNER)).rejects.toThrow('Enter a token address')
    }
    await expect(prepareStickyLaunch({ ...input, tokenInput: 'mars:4' }, OWNER)).rejects.toThrow('Unknown chain "mars"')
  })

  it('rejects wrong-chain RPCs, missing runtime bytecode, and inconsistent AutoStick links', async () => {
    const state = worlds.get(ids[0])!
    state.getChainId.mockResolvedValueOnce(1)
    await expect(prepareStickyLaunch(input, OWNER)).rejects.toThrow('configured RPC returned chain 1')
    for (const missing of [state.deployment.deployer, state.deployment.controller, PROJECTS, TOKENS, state.deployment.autoStick]) {
      state.getCode.mockImplementation(async ({ address }) => address === missing ? undefined : '0x6000')
      await expect(prepareStickyLaunch(input, OWNER)).rejects.toThrow('required Sticky contract is missing')
    }
    state.getCode.mockResolvedValue('0x6000')
    for (const fn of ['DEPLOYER', 'HOOK', 'DISTRIBUTOR']) {
      const key = `${state.deployment.autoStick}.${fn}`
      const before = state.answers.get(key)
      state.answers.set(key, OTHER)
      await expect(prepareStickyLaunch(input, OWNER)).rejects.toThrow('does not match this Sticky deployment and distributor')
      state.answers.set(key, before)
    }
  })

  it('rejects absent project tokens and unreadable metadata', async () => {
    const state = worlds.get(ids[0])!
    state.answers.set(`${TOKENS}.tokenOf`, ZERO)
    await expect(prepareStickyLaunch({ ...input, tokenInput: '4' }, OWNER)).rejects.toThrow('has no ERC-20')
    state.answers.set(`${TOKEN}.symbol`, new Error('metadata unavailable'))
    await expect(prepareStickyLaunch(input, OWNER)).rejects.toThrow('metadata unavailable')
  })

  it('revalidates a saved plan without changing its identity and refuses fresh fee, metadata or deployment drift', async () => {
    const plan = await prepareStickyLaunch(input, OWNER)
    const saved = JSON.stringify(plan)
    await expect(revalidateStickyLaunch(plan)).resolves.toBeUndefined()
    expect(JSON.stringify(plan)).toBe(saved)
    const state = worlds.get(ids[0])!
    state.answers.set(`${PROJECTS}.creationFee`, 0n)
    await expect(revalidateStickyLaunch(plan)).rejects.toThrow('creation fee changed')
    state.answers.set(`${PROJECTS}.creationFee`, BigInt(ids[0]))
    state.answers.set(`${TOKEN}.decimals`, 6)
    await expect(revalidateStickyLaunch(plan)).rejects.toThrow('token differs')
    state.answers.set(`${TOKEN}.decimals`, 18)
    const changed = structuredClone(plan)
    changed.targets[0].controller = OTHER
    await expect(revalidateStickyLaunch(changed)).rejects.toThrow('deployment changed')
  })

  it('rejects saved calls with a different chain, intent argument, AutoStick granter or function', async () => {
    const plan = await prepareStickyLaunch(input, OWNER)
    const wrongChain = structuredClone(plan)
    wrongChain.targets[0].call.chain = 1
    await expect(revalidateStickyLaunch(wrongChain)).rejects.toThrow('deployment changed')
    for (const granters of [[], [OTHER], [worlds.get(ids[0])!.deployment.autoStick, worlds.get(ids[0])!.deployment.autoStick]]) {
      const changed = structuredClone(plan)
      changed.targets[0].call.data = encodeFunctionData({ abi: stickyDeployerAbi, functionName: 'deployStickyFor', args: [
        plan.token, plan.name, plan.symbol, plan.projectUri, BigInt(plan.cashOutTaxRate), granters, plan.soulbound,
      ] })
      await expect(revalidateStickyLaunch(changed)).rejects.toThrow(granters.length ? 'does not match the reviewed launch' : 'differs from its reviewed configuration')
    }
    await expect(revalidateStickyLaunch({ ...plan, name: 'Changed' })).rejects.toThrow('differs from its reviewed configuration')
    const wrongFunction = structuredClone(plan)
    wrongFunction.targets[0].call.data = encodeFunctionData({ abi: stickyDeployerAbi, functionName: 'CONTROLLER' })
    await expect(revalidateStickyLaunch(wrongFunction)).rejects.toThrow('not a Sticky launch')
    await expect(revalidateStickyLaunch({ ...plan, targets: [] })).rejects.toThrow('saved launch is invalid')
    await expect(revalidateStickyLaunch({ ...plan, environment: 'production' })).rejects.toThrow('network environment')
  })
})
