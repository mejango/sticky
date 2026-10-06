import type { PublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HistoryTooLongError } from '@/lib/hook-logs'
import {
  accountActivity,
  accountChains,
  accountIndex,
  accountPositions,
  deployedProjects,
  listedPositions,
  type AccountIndex,
  type ActivityReadDeps,
  type PositionReadDeps,
} from '@/lib/sticky-account'
import { stickyHookAbi } from '@/lib/sticky-abis'
import { stickyDeployment } from '@/lib/sticky-addresses'
import { scanFrom } from '@/lib/sticky-events'
import { FEED_WINDOW, moveKey } from '@/lib/sticky-feed'
import type { IndexedPosition, IndexedProjects, IndexedRows } from '@/lib/sticky-indexed'
import { E18, E6, HOLDER, OTHER, positionRow, stick } from '../account-fixtures'
import { stickyInfo } from '../home-fixtures'
import { POSITION_TOPICS, staked, streakEnded, streakStarted, topic, unstaked } from './sticky-log-fixtures'

const center = vi.hoisted(() => ({ client: vi.fn() }))
vi.mock('@/lib/jbcenter-rpc', () => ({ jbCenterPublicClient: center.client }))

const CHAIN = 8453
const deployment = stickyDeployment(CHAIN)!
const { hook, autoStick } = deployment

beforeEach(() => {
  center.client.mockReset()
})

const listing = (rows: IndexedPosition[], chainIds: number[]): IndexedRows<IndexedPosition> => ({
  rows,
  blocks: new Map(chainIds.map(chainId => [chainId, 100n])),
})

describe('accountChains', () => {
  it('lists the Sticky chains of a network in the site\'s order of chains', () => {
    expect(accountChains('mainnet')).toEqual([1, 10, 8453, 42161])
    expect(accountChains('testnet')).toEqual([11155111, 11155420, 84532, 421614])
  })
})

describe('accountIndex', () => {
  const projects: IndexedProjects = { blocks: new Map([[1, 90n]]), projects: [{ chainId: 1, projectId: 4n }] }
  const warn = () => vi.spyOn(console, 'warn').mockImplementation(() => {})

  it('asks Bendystraw for the account\'s positions on every chain of the network, and for nothing more when it has them all', async () => {
    const positions = listing([positionRow(1, 5n)], [1, 10, 8453, 42161])
    const indexedPositions = vi.fn(async () => positions)
    const indexedProjects = vi.fn(async () => projects)
    const controller = new AbortController()
    const index = await accountIndex('mainnet', HOLDER, { signal: controller.signal, indexedPositions, indexedProjects })
    expect(index).toEqual({ positions, projects: null })
    expect(indexedPositions).toHaveBeenCalledWith({ holder: HOLDER, chainIds: [1, 10, 8453, 42161] }, controller.signal)
    expect(indexedProjects).not.toHaveBeenCalled()
  })

  it('asks for the network\'s projects too when the positions are not for every chain, or cannot be read', async () => {
    const said = warn()
    const partial = listing([], [1, 10])
    const indexedProjects = vi.fn(async () => projects)
    expect(await accountIndex('mainnet', HOLDER, { indexedPositions: async () => partial, indexedProjects })).toEqual({
      positions: partial,
      projects,
    })
    expect(said).not.toHaveBeenCalled()

    const down = new Error('Cannot query field "stickyPositions"')
    const index = await accountIndex('testnet', HOLDER, {
      indexedPositions: async () => {
        throw down
      },
      indexedProjects,
    })
    expect(index).toEqual({ positions: null, projects })
    expect(indexedProjects).toHaveBeenLastCalledWith('testnet', undefined)
    expect(said.mock.calls).toEqual([
      ["Bendystraw could not list the account's Sticky positions; reading every Sticky project instead.", { network: 'testnet' }, down],
    ])
  })

  it('has neither when Bendystraw can say neither, and tells the console why each time', async () => {
    const said = warn()
    const first = new Error('down')
    const second = new Error('down too')
    const index = await accountIndex('mainnet', HOLDER, {
      indexedPositions: async () => {
        throw first
      },
      indexedProjects: async () => {
        throw second
      },
    })
    expect(index).toEqual({ positions: null, projects: null })
    expect(said.mock.calls).toEqual([
      ["Bendystraw could not list the account's Sticky positions; reading every Sticky project instead.", { network: 'mainnet' }, first],
      ['Bendystraw could not list the Sticky projects; scanning each chain instead.', { network: 'mainnet' }, second],
    ])
  })

  it('rejects with the caller\'s reason when the caller cancels, and says nothing of it', async () => {
    const said = warn()
    const controller = new AbortController()
    const reason = new Error('left the page')
    const read = accountIndex('mainnet', HOLDER, {
      signal: controller.signal,
      indexedPositions: async () => {
        controller.abort(reason)
        throw reason
      },
    })
    await expect(read).rejects.toBe(reason)
    expect(said).not.toHaveBeenCalled()
  })
})

describe('listedPositions', () => {
  const index = (positions: AccountIndex['positions']): AccountIndex => ({ positions, projects: null })

  it('lists the projects Bendystraw lists the account\'s positions in on the chain, and the block it is indexed through', () => {
    const positions = {
      rows: [positionRow(1, 9n), positionRow(8453, 23n), positionRow(8453, 4n)],
      blocks: new Map([[1, 90n], [8453, 120n]]),
    }
    expect(listedPositions(index(positions), 8453)).toEqual({ projects: [23n, 4n], through: 120n })
    expect(listedPositions(index(positions), 1)).toEqual({ projects: [9n], through: 90n })
  })

  it('lists none for a chain with no position, and null for a chain Bendystraw does not cover or could not read', () => {
    const positions = listing([positionRow(1, 9n)], [1, 8453])
    expect(listedPositions(index(positions), 8453)).toEqual({ projects: [], through: 100n })
    expect(listedPositions(index(positions), 10)).toBeNull()
    expect(listedPositions(index(null), 1)).toBeNull()
  })
})

describe('deployedProjects', () => {
  it('lists the chain\'s Sticky projects from Bendystraw\'s project list and the deployer\'s launches past it', async () => {
    const projects: IndexedProjects = { blocks: new Map([[1, 90n]]), projects: [] }
    const controller = new AbortController()
    const projectsOn = vi.fn(async (chainId: number) => ({
      projects: [3n, 9n].map(projectId => ({ chainId, projectId })),
      source: 'indexed' as const,
      degraded: null,
    }))
    expect(await deployedProjects(1, { positions: null, projects }, { signal: controller.signal, projectsOn })).toEqual([3n, 9n])
    expect(projectsOn).toHaveBeenCalledWith(1, projects, { signal: controller.signal })
  })
})

/** A request StickyHook is asked, as Multicall3 carries it. */
type HookRequest = {
  contracts: { address: string; abi: unknown; functionName: string; args: readonly [bigint, string] }[]
  allowFailure: boolean
  batchSize: number
}

/** What the hook says of HOLDER, by project: [staked, start, longest]. */
function fakeHook(says: Record<string, [bigint, bigint, bigint]> = {}) {
  const multicall = vi.fn(async ({ contracts }: HookRequest) =>
    contracts.map(({ functionName, args: [projectId] }) => {
      const [staked, start, longest] = says[projectId.toString()] ?? [0n, 0n, 0n]
      return functionName === 'stakedBalanceOf' ? staked : functionName === 'streakStartOf' ? start : longest
    }),
  )
  center.client.mockReturnValue({ multicall } as unknown as PublicClient)
  return multicall
}
const figures = (): PositionReadDeps['readProjects'] => async (chainId, projectIds) =>
  projectIds.map(projectId => stickyInfo(chainId, projectId))

describe('accountPositions', () => {
  it('asks StickyHook for the account\'s balance, streak start and longest streak in each project, in one request that is not split', async () => {
    const multicall = fakeHook()
    const { signal } = new AbortController()
    await accountPositions(CHAIN, HOLDER, [7n, 5n], { readProjects: figures(), signal })

    // Through the page's reader, so a page that is left does not send it.
    expect(center.client).toHaveBeenCalledWith(CHAIN, signal)
    expect(multicall).toHaveBeenCalledTimes(1)
    const [request] = multicall.mock.calls[0]
    expect(request).toMatchObject({ allowFailure: false, batchSize: 0 })
    expect(request.contracts.map(({ address, functionName, args }) => [address, functionName, args])).toEqual(
      [7n, 5n].flatMap(projectId =>
        ['stakedBalanceOf', 'streakStartOf', 'longestStreakOf'].map(name => [hook, name, [projectId, HOLDER]]),
      ),
    )
    expect(request.contracts.every(call => call.abi === stickyHookAbi)).toBe(true)
  })

  it('lists the projects the account holds shares in, or has had a streak in, by project ID, with what the hook says', async () => {
    fakeHook({ '7': [3n * E18, 1_000n, 90n], '5': [0n, 0n, 7_200n], '6': [0n, 0n, 0n], '9': [E18, 0n, 0n] })
    const chain = await accountPositions(CHAIN, HOLDER, [9n, 7n, 6n, 5n], { readProjects: figures() })

    expect(chain.chainId).toBe(CHAIN)
    expect(chain.skipped).toBe(0)
    expect(chain.positions.map(({ info, staked, start, longest }) => [info.projectId, staked, start, longest])).toEqual([
      [5n, 0n, 0, 7_200],
      [7n, 3n * E18, 1_000, 90],
      [9n, E18, 0, 0],
    ])
  })

  it('reads the figures of the projects held together, at one block, and of no other', async () => {
    fakeHook({ '5': [E18, 0n, 0n], '7': [E18, 0n, 0n] })
    const readProjects = vi.fn(figures())
    const controller = new AbortController()
    await accountPositions(CHAIN, HOLDER, [7n, 6n, 5n], { readProjects, signal: controller.signal })
    // Strictly: a project whose accounting does not hold together is left out, not shown with a wrong figure.
    expect(readProjects).toHaveBeenCalledTimes(1)
    expect(readProjects).toHaveBeenCalledWith(CHAIN, [5n, 7n], { signal: controller.signal })
  })

  it('counts the projects whose figures cannot be read, and still lists the others', async () => {
    fakeHook({ '5': [E18, 0n, 0n], '7': [E18, 0n, 0n], '9': [E18, 0n, 0n] })
    const readProjects: PositionReadDeps['readProjects'] = async (chainId, projectIds) =>
      projectIds.filter(projectId => projectId !== 7n).map(projectId => stickyInfo(chainId, projectId))
    const chain = await accountPositions(CHAIN, HOLDER, [5n, 7n, 9n], { readProjects })
    expect(chain.positions.map(position => position.info.projectId)).toEqual([5n, 9n])
    expect(chain.skipped).toBe(1)
  })

  it('reads no figures, and counts nothing, when the account holds nothing', async () => {
    fakeHook()
    const readProjects = vi.fn(figures())
    expect(await accountPositions(CHAIN, HOLDER, [1n, 2n], { readProjects })).toEqual({ chainId: CHAIN, positions: [], skipped: 0 })
    expect(await accountPositions(CHAIN, HOLDER, [], { readProjects })).toEqual({ chainId: CHAIN, positions: [], skipped: 0 })
    expect(readProjects).not.toHaveBeenCalled()
  })

  it('asks about each project once, however often it is listed', async () => {
    const multicall = fakeHook({ '5': [E18, 0n, 0n] })
    const chain = await accountPositions(CHAIN, HOLDER, [5n, 5n, 5n], { readProjects: figures() })
    expect(chain.positions).toHaveLength(1)
    expect(multicall.mock.calls[0][0].contracts).toHaveLength(3)
  })

  it('asks about 80 projects in a request, one request after another', async () => {
    const ids = Array.from({ length: 81 }, (_, at) => BigInt(at + 1))
    const first = Promise.withResolvers<void>()
    let started = 0
    const multicall = vi.fn(async ({ contracts }: HookRequest) => {
      started += 1
      if (started === 1) await first.promise
      return contracts.map(() => 0n)
    })
    center.client.mockReturnValue({ multicall } as unknown as PublicClient)
    const read = accountPositions(CHAIN, HOLDER, ids, { readProjects: figures() })

    await Promise.resolve()
    expect(multicall).toHaveBeenCalledTimes(1)
    expect(multicall.mock.calls[0][0].contracts).toHaveLength(240)
    first.resolve()
    await read
    expect(multicall).toHaveBeenCalledTimes(2)
    expect(multicall.mock.calls[1][0].contracts).toHaveLength(3)
  })

  it('finds a position among the projects of a later request', async () => {
    const ids = Array.from({ length: 100 }, (_, at) => BigInt(at + 1))
    fakeHook({ '3': [E18, 0n, 0n], '90': [2n * E18, 0n, 0n] })
    const chain = await accountPositions(CHAIN, HOLDER, ids, { readProjects: figures() })
    expect(chain.positions.map(position => [position.info.projectId, position.staked])).toEqual([
      [3n, E18],
      [90n, 2n * E18],
    ])
  })

  it('rejects when the hook cannot be read, never as an account that holds nothing', async () => {
    const down = new Error('rpc down')
    center.client.mockReturnValue({ multicall: vi.fn().mockRejectedValue(down) } as unknown as PublicClient)
    await expect(accountPositions(CHAIN, HOLDER, [5n], { readProjects: figures() })).rejects.toBe(down)
  })

  it('rejects with the caller\'s reason the moment the caller cancels, and asks for nothing more', async () => {
    const controller = new AbortController()
    const reason = new Error('left the page')
    const multicall = vi.fn(() => new Promise<never>(() => {}))
    center.client.mockReturnValue({ multicall } as unknown as PublicClient)
    const readProjects = vi.fn(figures())
    const read = accountPositions(CHAIN, HOLDER, [5n], { readProjects, signal: controller.signal })
    await Promise.resolve()
    controller.abort(reason)
    await expect(read).rejects.toBe(reason)
    expect(readProjects).not.toHaveBeenCalled()

    const later = vi.fn(figures())
    const ids = Array.from({ length: 81 }, (_, at) => BigInt(at + 1))
    const answers = new AbortController()
    center.client.mockReturnValue({
      multicall: vi.fn(async ({ contracts }: HookRequest) => {
        answers.abort(reason)
        return contracts.map(() => 0n)
      }),
    } as unknown as PublicClient)
    await expect(accountPositions(CHAIN, HOLDER, ids, { readProjects: later, signal: answers.signal })).rejects.toBe(reason)
  })
})

describe('accountPositions, past the block the listing is indexed through', () => {
  const THROUGH = deployment.fromBlock + 1_000n
  const opened = (projectId: bigint, blockNumber = THROUGH + 3n) =>
    staked(HOLDER, HOLDER, E18, E18, { project: projectId, blockNumber })
  const tail = (logs: ReturnType<typeof opened>[] = []) => vi.fn<PositionReadDeps['scan']>(async () => logs)
  /** Bendystraw's listing, indexed through `through`, whose list of every Sticky project of the chain is not asked for
   * unless a test says so. */
  const listedThrough = (through: bigint, everyProject = vi.fn(async (): Promise<bigint[]> => {
    throw new Error('every project was not to be asked for')
  })) => ({ through, everyProject })

  it('asks for the account\'s position events from just below that block, and asks about the projects they show too', async () => {
    const multicall = fakeHook({ '5': [E18, 0n, 0n], '9': [2n * E18, 0n, 0n] })
    const scan = tail([opened(9n)])
    const controller = new AbortController()
    const chain = await accountPositions(CHAIN, HOLDER, [5n], {
      readProjects: figures(),
      scan,
      listing: listedThrough(THROUGH),
      signal: controller.signal,
    })

    // The position events of StickyHook that name the account: the way a holder's activity is tailed.
    expect(scan).toHaveBeenCalledExactlyOnceWith(
      CHAIN,
      { address: hook, topics: [POSITION_TOPICS, null, topic(HOLDER)], fromBlock: THROUGH + 1n - 64n },
      { signal: controller.signal },
    )
    expect(multicall.mock.calls[0][0].contracts.map(({ args: [projectId] }) => projectId)).toEqual([5n, 5n, 5n, 9n, 9n, 9n])
    expect(chain.positions.map(position => [position.info.projectId, position.staked])).toEqual([
      [5n, E18],
      [9n, 2n * E18],
    ])
  })

  it('reads the events before it asks the hook about any balance', async () => {
    const multicall = fakeHook({ '9': [E18, 0n, 0n] })
    const scan = tail([opened(9n)])
    await accountPositions(CHAIN, HOLDER, [], { readProjects: figures(), scan, listing: listedThrough(THROUGH) })
    expect(scan.mock.invocationCallOrder[0]).toBeLessThan(multicall.mock.invocationCallOrder[0])
  })

  it('never starts from below the deployer\'s block', async () => {
    fakeHook()
    const scan = tail()
    await accountPositions(CHAIN, HOLDER, [], { readProjects: figures(), scan, listing: listedThrough(deployment.fromBlock - 5_000n) })
    expect(scan.mock.calls[0][1].fromBlock).toBe(deployment.fromBlock)
    expect(scan.mock.calls[0][1].fromBlock).toBe(scanFrom(deployment.fromBlock - 5_000n, deployment))
  })

  it('asks about a project once when the listing and the events both have it', async () => {
    const multicall = fakeHook({ '5': [E18, 0n, 0n] })
    const chain = await accountPositions(CHAIN, HOLDER, [5n], {
      readProjects: figures(),
      scan: tail([opened(5n), opened(5n, THROUGH + 4n)]),
      listing: listedThrough(THROUGH),
    })
    expect(chain.positions).toHaveLength(1)
    expect(multicall.mock.calls[0][0].contracts).toHaveLength(3)
  })

  it('takes the project of every kind of position event, and of no event that is not the account\'s', async () => {
    const multicall = fakeHook()
    const at = { blockNumber: THROUGH + 3n }
    await accountPositions(CHAIN, HOLDER, [], {
      readProjects: figures(),
      listing: listedThrough(THROUGH),
      scan: tail([
        opened(11n),
        unstaked(HOLDER, E18, 0n, { project: 12n, ...at }),
        streakStarted(HOLDER, { project: 13n, ...at }),
        streakEnded(HOLDER, 60n, { project: 14n, ...at }),
        // Another account's event, which a node that ignores the filter may send, and another contract's.
        staked(OTHER, OTHER, E18, E18, { project: 15n, ...at }),
        staked(HOLDER, HOLDER, E18, E18, { project: 16n, address: OTHER, ...at }),
      ]),
    })
    const asked = multicall.mock.calls[0][0].contracts.map(({ args: [projectId] }) => projectId)
    expect([...new Set(asked)]).toEqual([11n, 12n, 13n, 14n])
  })

  it('reads no events for a list that is not Bendystraw\'s listing', async () => {
    fakeHook({ '5': [E18, 0n, 0n] })
    const scan = tail([opened(9n)])
    const chain = await accountPositions(CHAIN, HOLDER, [5n], { readProjects: figures(), scan })
    expect(scan).not.toHaveBeenCalled()
    expect(chain.positions.map(position => position.info.projectId)).toEqual([5n])
  })

  it('asks about every Sticky project of the chain, as without a listing, when the events past its block are too many to scan', async () => {
    // Bendystraw lists the account's positions, but is far behind the head, as when it replays its history.
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const multicall = fakeHook({ '5': [E18, 0n, 0n], '6': [2n * E18, 0n, 0n] })
    const tooLong = new HistoryTooLongError('This history spans 600000 blocks, more than this RPC can scan in 1024 requests.')
    const scan = vi.fn<PositionReadDeps['scan']>(async () => {
      throw tooLong
    })
    const everyProject = vi.fn(async () => [5n, 6n, 7n])
    const chain = await accountPositions(CHAIN, HOLDER, [5n], {
      readProjects: figures(),
      scan,
      listing: listedThrough(THROUGH, everyProject),
    })

    expect(everyProject).toHaveBeenCalledOnce()
    expect(multicall.mock.calls[0][0].contracts.map(({ args: [projectId] }) => projectId)).toEqual([5n, 5n, 5n, 6n, 6n, 6n, 7n, 7n, 7n])
    expect(chain.positions.map(position => [position.info.projectId, position.staked])).toEqual([
      [5n, E18],
      [6n, 2n * E18],
    ])
    expect(warning.mock.calls).toEqual([
      ["Bendystraw could not list the account's Sticky positions; reading every Sticky project instead.", { chainId: CHAIN }, tooLong],
    ])
  })

  it('rejects when the events cannot be read, and asks the hook for nothing: a shorter list is not the chain\'s', async () => {
    const multicall = fakeHook({ '5': [E18, 0n, 0n] })
    const failure = new Error('This history spans 600000 blocks, more than this RPC can scan in 1024 requests.')
    const scan = vi.fn<PositionReadDeps['scan']>(async () => {
      throw failure
    })
    await expect(
      accountPositions(CHAIN, HOLDER, [5n], { readProjects: figures(), scan, listing: listedThrough(THROUGH) }),
    ).rejects.toBe(failure)
    expect(multicall).not.toHaveBeenCalled()
  })

  it('rejects for an event it cannot read, rather than leave its project out', async () => {
    fakeHook()
    const { blockTimestamp: _time, ...withoutTime } = opened(9n)
    await expect(
      accountPositions(CHAIN, HOLDER, [], { readProjects: figures(), scan: tail([withoutTime]), listing: listedThrough(THROUGH) }),
    ).rejects.toThrow("came without its block's time")
  })
})

describe('accountActivity', () => {
  const T = 1_790_000_000 - 10_000
  const info = (chainId: number, projectId: bigint) =>
    stickyInfo(chainId, projectId, { symbol: 'SLOPSHOP', decimals: 6, stSymbol: `STICKY${projectId}` })
  function fakeDeps(events = [stick(CHAIN, 23n, T)]) {
    return {
      holderEvents: vi.fn<ActivityReadDeps['holderEvents']>(async () => ({ events, source: 'indexed', degraded: null })),
      readProjects: vi.fn<ActivityReadDeps['readProjects']>(async (chainId, projectIds) =>
        projectIds.map(projectId => info(chainId, projectId)),
      ),
      terminalMoves: vi.fn<ActivityReadDeps['terminalMoves']>(async () => new Map()),
    }
  }

  it('reads the account\'s events on the chain, with the projects Bendystraw lists it in, and shows them as rows', async () => {
    const deps = fakeDeps()
    const controller = new AbortController()
    const activity = await accountActivity(CHAIN, HOLDER, { ...deps, projects: [23n, 30n], signal: controller.signal })

    expect(deps.holderEvents).toHaveBeenCalledWith(CHAIN, HOLDER, { signal: controller.signal, projects: [23n, 30n] })
    expect(activity.chainId).toBe(CHAIN)
    expect(activity.rows).toEqual([
      expect.objectContaining({
        chainId: CHAIN,
        projectId: 23n,
        direction: 'in',
        // The terminal gave no amount, so what moved is the Sticky shares.
        amount: { value: 10n * E18, decimals: 18, symbol: 'STICKY23' },
        line: { kind: 'stuck', holder: HOLDER },
      }),
    ])
    expect(activity.labels).toEqual({ '23': 'STICKY23' })
  })

  it('shows what the terminal took in, in the staked token, when it says', async () => {
    const [event] = [stick(CHAIN, 23n, T)]
    const deps = fakeDeps([event])
    deps.terminalMoves.mockResolvedValue(
      new Map([[moveKey({ ...event, kind: 'stick', count: event.count! }), 5n * E6]]),
    )
    const { rows } = await accountActivity(CHAIN, HOLDER, deps)
    expect(rows[0].amount).toEqual({ value: 5n * E6, decimals: 6, symbol: 'SLOPSHOP' })
    expect(deps.terminalMoves).toHaveBeenCalledWith([event], { signal: undefined })
  })

  it('makes one row of what one transaction did for the account in one project, newest first', async () => {
    const first = stick(CHAIN, 23n, T)
    const events = [
      first,
      { ...first, kind: 'streakStart' as const, logIndex: 0, payer: undefined, count: undefined, balance: undefined },
      stick(CHAIN, 23n, T + 60),
      stick(CHAIN, 24n, T + 120, { payer: OTHER }),
    ]
    const { rows } = await accountActivity(CHAIN, HOLDER, fakeDeps(events))
    expect(rows.map(row => [row.projectId, row.line])).toEqual([
      [24n, { kind: 'gift', holder: HOLDER, payer: OTHER }],
      [23n, { kind: 'stuck', holder: HOLDER }],
      [23n, { kind: 'stuck', holder: HOLDER, streak: 'started' }],
    ])
  })

  it('reads a stick by the auto-stick adapter as auto-stuck, and no airdrop', async () => {
    const { rows } = await accountActivity(CHAIN, HOLDER, fakeDeps([stick(CHAIN, 23n, T, { payer: autoStick })]))
    expect(rows[0].line).toEqual({ kind: 'autoStuck', holder: HOLDER })
  })

  it('reads the newest FEED_WINDOW events, the projects of those and their amounts, and no older ones', async () => {
    const events = Array.from({ length: FEED_WINDOW + 5 }, (_, at) => stick(CHAIN, BigInt(1 + (at % 3)), T + at))
    const deps = fakeDeps(events)
    const controller = new AbortController()
    const { rows } = await accountActivity(CHAIN, HOLDER, { ...deps, signal: controller.signal })

    expect(rows).toHaveLength(FEED_WINDOW)
    expect(deps.terminalMoves).toHaveBeenCalledWith(events.slice(-FEED_WINDOW), { signal: controller.signal })
    // Only what a name, a symbol and decimals are wanted of: a project whose accounting does not hold together has them.
    expect(deps.readProjects).toHaveBeenCalledTimes(1)
    expect(deps.readProjects).toHaveBeenCalledWith(CHAIN, [3n, 1n, 2n], { signal: controller.signal, orphans: 'clamp' })
  })

  it('reads nothing more when the account has no activity on the chain', async () => {
    const deps = fakeDeps([])
    expect(await accountActivity(CHAIN, HOLDER, deps)).toEqual({ chainId: CHAIN, rows: [], labels: {} })
    expect(deps.readProjects).not.toHaveBeenCalled()
    expect(deps.terminalMoves).not.toHaveBeenCalled()
  })

  it('has no rows, and no label, for a project whose figures cannot be read', async () => {
    const deps = fakeDeps([stick(CHAIN, 23n, T), stick(CHAIN, 24n, T + 5)])
    deps.readProjects.mockImplementation(async (chainId, projectIds) =>
      projectIds.filter(projectId => projectId !== 24n).map(projectId => info(chainId, projectId)),
    )
    const activity = await accountActivity(CHAIN, HOLDER, deps)
    expect(activity.rows.map(row => row.projectId)).toEqual([23n])
    expect(activity.labels).toEqual({ '23': 'STICKY23' })
  })

  it('rejects when its events cannot be read, never as an account with no activity', async () => {
    const down = new Error('over budget')
    const deps = fakeDeps()
    deps.holderEvents.mockRejectedValue(down)
    await expect(accountActivity(CHAIN, HOLDER, deps)).rejects.toBe(down)
  })

  it('reads a chain other than the deployment\'s only when Sticky is deployed on it', async () => {
    await expect(accountActivity(137, HOLDER, fakeDeps())).rejects.toThrow('Sticky is not deployed on chain 137.')
    await expect(accountPositions(137, HOLDER, [1n], { readProjects: figures() })).rejects.toThrow(
      'Sticky is not deployed on chain 137.',
    )
  })
})
