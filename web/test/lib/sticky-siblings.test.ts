import { type Address } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScannedLog } from '@/lib/hook-logs'
import { stickyDeployment } from '@/lib/sticky-addresses'
import { tailOverlap } from '@/lib/sticky-events'
import type { IndexedProjects } from '@/lib/sticky-indexed'
import type { StickyProjectInfo } from '@/lib/sticky-project'
import {
  launchKey,
  launchSiblings,
  missingChains,
  siblingProjects,
  siblingRows,
  siblingTotals,
  type LaunchFacts,
  type Sibling,
  type SiblingReadDeps,
  type SiblingRow,
} from '@/lib/sticky-siblings'
import { deploySticky } from './sticky-log-fixtures'

// Every read goes through the deps a call is given, so nothing here reaches Bendystraw or Center. The default reads
// have tests of their own in sticky-siblings-center.test.ts.

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

const LAUNCH = '11111111-2222-4333-8444-555555555555'
const BASE_SEPOLIA = 84532
const OP_SEPOLIA = 11155420
const ARB_SEPOLIA = 421614
const SEPOLIA = 11155111
const TESTNETS = [BASE_SEPOLIA, ARB_SEPOLIA, SEPOLIA, OP_SEPOLIA]
const PRODUCTION = [1, 10, 8453, 42161]

const facts = (
  chainId: number,
  projectId: bigint,
  launchId: string | null,
  cashOutTaxRate: bigint,
  soulbound: boolean,
  plannedChains: number[] | null = null,
): LaunchFacts => ({ chainId, projectId, launchId, cashOutTaxRate, soulbound, plannedChains })

/** The page's project: launch LAUNCH on Base Sepolia, a 5% bonus, transferable. */
const HERE = facts(BASE_SEPOLIA, 12n, LAUNCH, 500n, false)

describe('launchKey', () => {
  it('is a launch\'s id, bonus and transfer mode, and nothing without a launch id', () => {
    expect(launchKey(HERE)).toBe(`${LAUNCH}:500:false`)
    expect(launchKey({ ...HERE, soulbound: true })).toBe(`${LAUNCH}:500:true`)
    expect(launchKey({ ...HERE, launchId: null })).toBeNull()
  })
})

describe('siblingProjects', () => {
  it('groups the page\'s project with each other chain\'s first copy of its launch, bonus and transfer mode', () => {
    const candidates = [
      facts(OP_SEPOLIA, 6n, LAUNCH, 500n, false),
      facts(OP_SEPOLIA, 3n, 'other-launch', 500n, false),
      facts(OP_SEPOLIA, 4n, LAUNCH, 0n, false), // same launch id, different bonus: not a sibling
      facts(OP_SEPOLIA, 5n, LAUNCH, 500n, false), // the first copy, whatever order it came in
      facts(ARB_SEPOLIA, 8n, LAUNCH, 500n, true), // same launch id, soulbound: not a sibling
      facts(SEPOLIA, 2n, LAUNCH, 500n, false),
      facts(BASE_SEPOLIA, 13n, LAUNCH, 500n, false), // the page's own chain has only the page's project
    ]
    expect(siblingProjects(HERE, candidates)).toEqual<Sibling[]>([
      { chainId: BASE_SEPOLIA, projectId: 12n, self: true },
      { chainId: OP_SEPOLIA, projectId: 5n, self: false },
      { chainId: SEPOLIA, projectId: 2n, self: false },
    ])
  })

  it('a later copy of the uri cannot displace the real sibling', () => {
    const copy = facts(OP_SEPOLIA, 9n, LAUNCH, 500n, false)
    const real = facts(OP_SEPOLIA, 5n, LAUNCH, 500n, false)
    expect(siblingProjects(HERE, [copy, real])[1]).toEqual({ chainId: OP_SEPOLIA, projectId: 5n, self: false })
    expect(siblingProjects(HERE, [real, copy])[1]).toEqual({ chainId: OP_SEPOLIA, projectId: 5n, self: false })
  })

  it('takes no copy on a chain the page\'s uri did not plan, even one that copies its uri', () => {
    const planned = { ...HERE, plannedChains: [BASE_SEPOLIA, OP_SEPOLIA] }
    const candidates = [
      facts(ARB_SEPOLIA, 3n, LAUNCH, 500n, false, [BASE_SEPOLIA, OP_SEPOLIA, ARB_SEPOLIA]),
      facts(SEPOLIA, 2n, LAUNCH, 500n, false, [BASE_SEPOLIA, OP_SEPOLIA]),
      facts(OP_SEPOLIA, 5n, LAUNCH, 500n, false, [BASE_SEPOLIA, OP_SEPOLIA]),
    ]
    expect(siblingProjects(planned, candidates).map(row => row.chainId)).toEqual([BASE_SEPOLIA, OP_SEPOLIA])
    // A page whose uri lists no chains has no plan to hold a copy to: a copy is held only to its own uri, which the
    // copy on Sepolia (a plan without Sepolia in it) fails, and the one on Arbitrum Sepolia (its own plan names it) does not.
    expect(siblingProjects(HERE, candidates).map(row => row.chainId)).toEqual([BASE_SEPOLIA, ARB_SEPOLIA, OP_SEPOLIA])
  })

  it('takes no copy whose own uri does not plan its own chain, and the next copy that does is the sibling', () => {
    const copy = facts(OP_SEPOLIA, 4n, LAUNCH, 500n, false, [BASE_SEPOLIA])
    const real = facts(OP_SEPOLIA, 5n, LAUNCH, 500n, false, [BASE_SEPOLIA, OP_SEPOLIA])
    expect(siblingProjects(HERE, [copy])).toEqual([{ chainId: BASE_SEPOLIA, projectId: 12n, self: true }])
    expect(siblingProjects(HERE, [copy, real])[1]).toEqual({ chainId: OP_SEPOLIA, projectId: 5n, self: false })
    // A uri that lists no chains has none to leave its own out of.
    expect(siblingProjects(HERE, [facts(OP_SEPOLIA, 6n, LAUNCH, 500n, false, null)])[1]?.projectId).toBe(6n)
  })

  it('has only the page\'s project when its uri carries no launch id', () => {
    const lone = { ...HERE, launchId: null }
    expect(siblingProjects(lone, [facts(OP_SEPOLIA, 5n, null, 500n, false)])).toEqual([
      { chainId: BASE_SEPOLIA, projectId: 12n, self: true },
    ])
  })
})

// ---------------------------------------------------------------- finding them

type Launch = {
  id: number
  tax: bigint
  soulbound: boolean
  launchId: string | null
  /** The chains its uri plans. A launch writes Base Sepolia and Optimism Sepolia unless a test says otherwise. */
  plan?: number[] | null
}

/** The Sticky projects each chain has, in the order they launched. */
type World = Partial<Record<number, Launch[]>>

function infoOf(chainId: number, project: Launch, figures: Partial<StickyProjectInfo> = {}): StickyProjectInfo {
  return {
    chainId,
    projectId: BigInt(project.id),
    stToken: `0x${'3'.repeat(40)}` as Address,
    stSymbol: 'STICKYART',
    stName: 'Sticky ART',
    stakedToken: `0x${'2'.repeat(40)}` as Address,
    symbol: 'ART',
    name: 'Art',
    decimals: 6,
    cashOutTaxRate: project.tax,
    soulbound: project.soulbound,
    totalSupply: 100n,
    backing: 10n,
    orphaned: 0n,
    rawBacking: 10n,
    savedOrphaned: 0n,
    launchId: project.launchId,
    plannedChains: project.plan !== undefined ? project.plan : project.launchId === null ? null : [BASE_SEPOLIA, OP_SEPOLIA],
    blockNumber: 1n,
    ...figures,
  }
}

type Spec = {
  world: World
  /** What Bendystraw lists, or how it fails. */
  index?: IndexedProjects | Error
  /** A chain whose reads fail. */
  broken?: number
}

/** Fakes of every read. `calls` lists each read in order, with the chain it was of. */
function fakeDeps({ world, index = new Error('Bendystraw is down'), broken }: Spec) {
  const calls: { read: string; chainId: number; detail?: unknown }[] = []
  const launches = (chainId: number) => world[chainId] ?? []
  const fail = (chainId: number) => {
    if (chainId === broken) throw new Error(`chain ${chainId} is down`)
  }
  const deps = {
    indexedProjects: vi.fn<SiblingReadDeps['indexedProjects']>(async () => {
      if (index instanceof Error) throw index
      return index
    }),
    scan: vi.fn<SiblingReadDeps['scan']>(async (chainId, filter) => {
      calls.push({ read: 'scan', chainId, detail: filter.fromBlock })
      fail(chainId)
      const { fromBlock } = stickyDeployment(chainId)!
      return launches(chainId)
        .map((project, i): ScannedLog => deploySticky(BigInt(project.id), { blockNumber: fromBlock + 1n + BigInt(i) }))
        .filter(log => log.blockNumber >= filter.fromBlock)
    }),
    launchIds: vi.fn<SiblingReadDeps['launchIds']>(async (chainId, projectIds) => {
      calls.push({ read: 'launchIds', chainId, detail: projectIds })
      fail(chainId)
      return projectIds.map(id => launches(chainId).find(project => BigInt(project.id) === id)?.launchId ?? null)
    }),
    read: vi.fn<SiblingReadDeps['read']>(async (chainId, projectId) => {
      calls.push({ read: 'read', chainId, detail: projectId })
      fail(chainId)
      const project = launches(chainId).find(entry => BigInt(entry.id) === projectId)
      if (!project) throw new Error(`no project ${projectId} on ${chainId}`)
      return infoOf(chainId, project)
    }),
  } satisfies SiblingReadDeps
  return { ...deps, calls }
}

const opSepoliaLaunches: Launch[] = [
  { id: 3, tax: 500n, soulbound: false, launchId: 'other-launch' },
  { id: 4, tax: 0n, soulbound: false, launchId: LAUNCH }, // same launch id, different bonus: not a sibling
  { id: 5, tax: 500n, soulbound: false, launchId: LAUNCH },
  { id: 6, tax: 500n, soulbound: false, launchId: LAUNCH }, // a later copy cannot displace the first
]

const found = (siblings: (Sibling | { chainId: number; error: unknown })[]) =>
  siblings.map(row => ('error' in row ? [row.chainId, 'error'] : [row.chainId, row.projectId, row.self]))

describe('launchSiblings', () => {
  it('a multichain launch finds its sibling by launch id, tax and transfer mode, scanning only its environment', async () => {
    const deps = fakeDeps({ world: { [OP_SEPOLIA]: opSepoliaLaunches } })
    const siblings = await launchSiblings(HERE, deps)
    expect(found(siblings)).toEqual([
      [BASE_SEPOLIA, 12n, true],
      [OP_SEPOLIA, 5n, false],
    ])
    // Without Bendystraw, each of the environment's other chains is scanned from its deployment block, and the
    // production chains are never touched.
    const scans = deps.calls.filter(call => call.read === 'scan')
    expect(scans.map(call => call.chainId).sort()).toEqual(TESTNETS.filter(chainId => chainId !== BASE_SEPOLIA).sort())
    for (const scan of scans) expect(scan.detail).toBe(stickyDeployment(scan.chainId)!.fromBlock)
    expect(deps.calls.some(call => PRODUCTION.includes(call.chainId))).toBe(false)
    // The launch ids narrow the candidates; only the copies of this launch are read in full, until one matches.
    expect(deps.calls.filter(call => call.read === 'read').map(call => call.detail)).toEqual([4n, 5n])
    // Kept for a page view by the query that asks (react-query's key), not here: a second call reads again.
  })

  it('with Bendystraw, siblings come from its project list; only launches past its indexed block are scanned', async () => {
    const blocks = new Map(TESTNETS.map(chainId => [chainId, stickyDeployment(chainId)!.fromBlock + 5_000n]))
    const index: IndexedProjects = {
      blocks,
      projects: opSepoliaLaunches.slice(0, 3).map(project => ({ chainId: OP_SEPOLIA, projectId: BigInt(project.id) })),
    }
    const deps = fakeDeps({ world: { [OP_SEPOLIA]: opSepoliaLaunches.slice(0, 3) }, index })
    const siblings = await launchSiblings(HERE, deps)
    expect(found(siblings)).toEqual([
      [BASE_SEPOLIA, 12n, true],
      [OP_SEPOLIA, 5n, false],
    ])
    expect(deps.indexedProjects).toHaveBeenCalledTimes(1)
    expect(deps.indexedProjects).toHaveBeenCalledWith('testnet', undefined)
    // The tail from just below each chain's indexed block, not the deployment block: a minute of its blocks, and 64
    // at least.
    const scans = deps.calls.filter(call => call.read === 'scan')
    expect(scans.length).toBe(3)
    for (const scan of scans) expect(scan.detail).toBe(blocks.get(scan.chainId)! + 1n - tailOverlap(scan.chainId))
    const overlaps = new Map(scans.map(scan => [scan.chainId, blocks.get(scan.chainId)! + 1n - (scan.detail as bigint)]))
    expect(overlaps).toEqual(new Map([[ARB_SEPOLIA, 240n], [SEPOLIA, 64n], [OP_SEPOLIA, 64n]]))
    // Bendystraw's list and the tail give the candidates; project 3's launch id rules it out without a full read,
    // and 4 and 5 are confirmed onchain.
    const asked = deps.calls.filter(call => call.read === 'launchIds' && call.chainId === OP_SEPOLIA)
    expect(asked.map(call => call.detail)).toEqual([[3n, 4n, 5n]])
    expect(deps.calls.filter(call => call.read === 'read').map(call => call.detail)).toEqual([4n, 5n])
  })

  it('searches only the chains the page\'s uri planned, and takes a copy on none of the others', async () => {
    const planned = { ...HERE, plannedChains: [BASE_SEPOLIA, OP_SEPOLIA] }
    const deps = fakeDeps({
      world: {
        [OP_SEPOLIA]: opSepoliaLaunches,
        // A copy of the launch's uri on a chain it did not plan: it names Arbitrum Sepolia in its own plan.
        [ARB_SEPOLIA]: [{ id: 2, tax: 500n, soulbound: false, launchId: LAUNCH, plan: [BASE_SEPOLIA, OP_SEPOLIA, ARB_SEPOLIA] }],
      },
    })
    expect(found(await launchSiblings(planned, deps))).toEqual([
      [BASE_SEPOLIA, 12n, true],
      [OP_SEPOLIA, 5n, false],
    ])
    expect(new Set(deps.calls.map(call => call.chainId))).toEqual(new Set([OP_SEPOLIA]))
    expect(deps.indexedProjects).toHaveBeenCalledTimes(1)
    // With no plan to go by, every chain of the environment is searched, and the copy is taken.
    const open = fakeDeps({ world: { [ARB_SEPOLIA]: [{ id: 2, tax: 500n, soulbound: false, launchId: LAUNCH, plan: null }] } })
    expect(found(await launchSiblings(HERE, open))).toEqual([
      [BASE_SEPOLIA, 12n, true],
      [ARB_SEPOLIA, 2n, false],
    ])
  })

  it('passes over a copy whose own uri does not plan its own chain, for the next one that shares the launch', async () => {
    const deps = fakeDeps({
      world: {
        [OP_SEPOLIA]: [
          { id: 3, tax: 500n, soulbound: false, launchId: LAUNCH, plan: [BASE_SEPOLIA] }, // not on its own plan
          { id: 5, tax: 500n, soulbound: false, launchId: LAUNCH },
        ],
      },
    })
    expect(found(await launchSiblings(HERE, deps))).toEqual([
      [BASE_SEPOLIA, 12n, true],
      [OP_SEPOLIA, 5n, false],
    ])
    // Both are read in full: the first shares the launch key but cannot end the search.
    expect(deps.calls.filter(call => call.read === 'read').map(call => call.detail)).toEqual([3n, 5n])
    const alone = fakeDeps({ world: { [OP_SEPOLIA]: [{ id: 3, tax: 500n, soulbound: false, launchId: LAUNCH, plan: [BASE_SEPOLIA] }] } })
    expect(found(await launchSiblings(HERE, alone))).toEqual([[BASE_SEPOLIA, 12n, true]])
  })

  it('a project whose uri plans chains that leave out its own has no siblings, and reads nothing', async () => {
    const off = { ...HERE, plannedChains: [OP_SEPOLIA, ARB_SEPOLIA] }
    const deps = fakeDeps({
      world: { [OP_SEPOLIA]: opSepoliaLaunches, [ARB_SEPOLIA]: [{ id: 2, tax: 500n, soulbound: false, launchId: LAUNCH, plan: null }] },
    })
    expect(await launchSiblings(off, deps)).toEqual([{ chainId: BASE_SEPOLIA, projectId: 12n, self: true }])
    expect(deps.calls).toEqual([])
    expect(deps.indexedProjects).not.toHaveBeenCalled()
    // A plan with its own chain among the others is searched as before, and an empty plan leaves every chain out.
    expect(found(await launchSiblings({ ...HERE, plannedChains: [BASE_SEPOLIA, OP_SEPOLIA] }, deps))).toEqual([
      [BASE_SEPOLIA, 12n, true],
      [OP_SEPOLIA, 5n, false],
    ])
    const empty = fakeDeps({ world: { [OP_SEPOLIA]: opSepoliaLaunches } })
    expect(await launchSiblings({ ...HERE, plannedChains: [] }, empty)).toEqual([{ chainId: BASE_SEPOLIA, projectId: 12n, self: true }])
    expect(empty.calls).toEqual([])
  })

  it('a single-chain project, or one whose uri carries no launch id, has no siblings to scan', async () => {
    const lone = fakeDeps({ world: { [OP_SEPOLIA]: opSepoliaLaunches } })
    expect(await launchSiblings({ ...HERE, projectId: 99n, launchId: null }, lone)).toEqual([
      { chainId: BASE_SEPOLIA, projectId: 99n, self: true },
    ])
    expect(lone.calls).toEqual([])
    expect(lone.indexedProjects).not.toHaveBeenCalled()
    // A launch no other chain has a copy of reads each chain and finds nothing.
    const single = fakeDeps({ world: {} })
    expect(found(await launchSiblings(HERE, single))).toEqual([[BASE_SEPOLIA, 12n, true]])
    expect(single.calls.some(call => call.read === 'read')).toBe(false)
  })

  it('reads the chains one after another, never at once', async () => {
    const deps = fakeDeps({ world: { [OP_SEPOLIA]: opSepoliaLaunches } })
    let inFlight = 0
    let most = 0
    const slow = deps.scan.getMockImplementation()!
    deps.scan.mockImplementation(async (...args) => {
      inFlight += 1
      most = Math.max(most, inFlight)
      await new Promise(resolve => setTimeout(resolve, 1))
      inFlight -= 1
      return slow(...args)
    })
    await launchSiblings(HERE, deps)
    expect(most).toBe(1)
    // Each chain is listed, then its candidates read, before the next chain starts.
    const order = deps.calls.map(call => call.chainId)
    expect(order).toEqual([...order].sort((a, b) => TESTNETS.indexOf(a) - TESTNETS.indexOf(b)))
  })

  it('keeps looking when a chain cannot be read, and gives that chain a row that says so', async () => {
    const deps = fakeDeps({ world: { [OP_SEPOLIA]: opSepoliaLaunches }, broken: ARB_SEPOLIA })
    const siblings = await launchSiblings(HERE, deps)
    expect(found(siblings)).toEqual([
      [BASE_SEPOLIA, 12n, true],
      [ARB_SEPOLIA, 'error'],
      [OP_SEPOLIA, 5n, false],
    ])
    const failure = siblings.find(row => 'error' in row) as { error: Error }
    expect(failure.error.message).toBe(`chain ${ARB_SEPOLIA} is down`)
  })

  it('tells the console when Bendystraw cannot list the launches, and scans each chain instead', async () => {
    const down = new Error('Bendystraw is down')
    const deps = fakeDeps({ world: { [OP_SEPOLIA]: opSepoliaLaunches }, index: down })
    await launchSiblings(HERE, deps)
    expect(vi.mocked(console.warn).mock.calls).toEqual([
      ['Bendystraw could not list the Sticky launches; reading the chains instead.', { network: 'testnet' }, down],
    ])
  })

  it('searches the production chains for a production project, and asks Bendystraw about mainnet', async () => {
    const deps = fakeDeps({ world: {} })
    await launchSiblings(facts(8453, 23n, LAUNCH, 500n, false), deps)
    expect(new Set(deps.calls.map(call => call.chainId))).toEqual(new Set([1, 10, 42161]))
    expect(deps.indexedProjects).toHaveBeenCalledWith('mainnet', undefined)
  })

  it('rejects with the caller\'s reason when it cancels, and reads no further chain', async () => {
    const controller = new AbortController()
    const deps = fakeDeps({ world: { [OP_SEPOLIA]: opSepoliaLaunches } })
    deps.scan.mockImplementationOnce(async (_chainId, _filter, { signal }) => {
      expect(signal).toBe(controller.signal)
      controller.abort(new Error('left the page'))
      throw new Error('aborted')
    })
    await expect(launchSiblings(HERE, { ...deps, signal: controller.signal })).rejects.toThrow('left the page')
    expect(deps.scan).toHaveBeenCalledTimes(1)
    expect(deps.launchIds).not.toHaveBeenCalled()
  })

  it('rejects with the caller\'s reason when it cancels during the last chain, rather than show it as unreadable', async () => {
    const controller = new AbortController()
    const deps = fakeDeps({ world: { [OP_SEPOLIA]: opSepoliaLaunches } })
    deps.read.mockImplementationOnce(async () => {
      controller.abort(new Error('left the page'))
      throw new Error('aborted')
    })
    await expect(launchSiblings(HERE, { ...deps, signal: controller.signal })).rejects.toThrow('left the page')
  })
})

// ---------------------------------------------------------------- their figures

describe('siblingRows', () => {
  const siblings: (Sibling | { chainId: number; error: unknown })[] = [
    { chainId: BASE_SEPOLIA, projectId: 12n, self: true },
    { chainId: ARB_SEPOLIA, error: new Error('down') },
    { chainId: OP_SEPOLIA, projectId: 5n, self: false },
  ]
  const world: World = {
    [BASE_SEPOLIA]: [{ id: 12, tax: 500n, soulbound: false, launchId: LAUNCH }],
    [OP_SEPOLIA]: opSepoliaLaunches,
  }

  it('reads each sibling\'s backing and supply, the page\'s own included, one chain after another', async () => {
    const deps = fakeDeps({ world })
    const rows = await siblingRows(siblings, { read: deps.read })
    expect(rows.map(row => ('info' in row ? [row.chainId, row.info.projectId] : [row.chainId, 'error']))).toEqual([
      [BASE_SEPOLIA, 12n],
      [ARB_SEPOLIA, 'error'],
      [OP_SEPOLIA, 5n],
    ])
    expect(deps.calls.map(call => [call.chainId, call.detail])).toEqual([
      [BASE_SEPOLIA, 12n],
      [OP_SEPOLIA, 5n],
    ])
  })

  it('gives a chain whose figures cannot be read a row that says so, and reads the others', async () => {
    const deps = fakeDeps({ world, broken: BASE_SEPOLIA })
    const rows = await siblingRows(siblings, { read: deps.read })
    expect(rows[0]).toMatchObject({ chainId: BASE_SEPOLIA, projectId: 12n, self: true, error: expect.any(Error) })
    expect('info' in rows[2]).toBe(true)
  })

  it('rejects with the caller\'s reason when it cancels', async () => {
    const controller = new AbortController()
    const deps = fakeDeps({ world })
    deps.read.mockImplementationOnce(async () => {
      controller.abort(new Error('left the page'))
      throw new Error('aborted')
    })
    await expect(siblingRows(siblings, { read: deps.read, signal: controller.signal })).rejects.toThrow('left the page')
    expect(deps.read).toHaveBeenCalledTimes(1)
  })

  it('rejects with the caller\'s reason when it cancels during the last row, rather than show it as unreadable', async () => {
    const controller = new AbortController()
    const deps = fakeDeps({ world })
    deps.read.mockImplementation(async (chainId, projectId) => {
      if (chainId === OP_SEPOLIA) {
        controller.abort(new Error('left the page'))
        throw new Error('aborted')
      }
      return infoOf(chainId, { id: Number(projectId), tax: 500n, soulbound: false, launchId: LAUNCH })
    })
    await expect(siblingRows(siblings, { read: deps.read, signal: controller.signal })).rejects.toThrow('left the page')
  })
})

describe('siblingTotals', () => {
  const art = (backing: bigint, totalSupply: bigint): SiblingRow => ({
    chainId: BASE_SEPOLIA,
    projectId: 12n,
    self: true,
    info: infoOf(BASE_SEPOLIA, { id: 12, tax: 500n, soulbound: false, launchId: LAUNCH }, { backing, totalSupply }),
  })
  const other = (symbol: string, decimals: number): SiblingRow => ({
    chainId: OP_SEPOLIA,
    projectId: 5n,
    self: false,
    info: infoOf(OP_SEPOLIA, opSepoliaLaunches[2], { backing: 5n, totalSupply: 50n, symbol, decimals }),
  })

  it('sibling totals add supply everywhere, and backing only when every chain backs with the same token', () => {
    expect(siblingTotals([art(10n, 100n), art(5n, 50n)])).toEqual({
      supply: 150n,
      backing: 15n,
      decimals: 6,
      symbol: 'ART',
      complete: true,
    })
    const mixed = siblingTotals([art(10n, 100n), other('USDC', 6)])
    expect(mixed.backing).toBeNull()
    expect(mixed.supply).toBe(150n)
    expect(siblingTotals([art(10n, 100n), { chainId: 10, error: 'down' }]).complete).toBe(false)
  })

  it('counts a token with the same symbol and other decimals as another token', () => {
    expect(siblingTotals([art(10n, 100n), other('ART', 18)]).backing).toBeNull()
  })

  it('leaves out rows it could not read, and says the totals are incomplete', () => {
    const failed: SiblingRow = { chainId: OP_SEPOLIA, projectId: 5n, self: false, error: new Error('down') }
    expect(siblingTotals([art(10n, 100n), failed])).toEqual({
      supply: 100n,
      backing: 10n,
      decimals: 6,
      symbol: 'ART',
      complete: false,
    })
    expect(siblingTotals([failed])).toEqual({
      supply: 0n,
      backing: null,
      decimals: undefined,
      symbol: undefined,
      complete: false,
    })
  })
})

describe('missingChains', () => {
  it('is the chains the launch planned, in the page\'s environment, that no row stands for', () => {
    const rows = [{ chainId: BASE_SEPOLIA }, { chainId: ARB_SEPOLIA }]
    const plannedChains = [BASE_SEPOLIA, OP_SEPOLIA, ARB_SEPOLIA, SEPOLIA, 8453, 999]
    expect(missingChains({ chainId: BASE_SEPOLIA, plannedChains }, rows)).toEqual([OP_SEPOLIA, SEPOLIA])
    const production = { chainId: 8453, plannedChains: [8453, 999, 10, BASE_SEPOLIA] }
    expect(missingChains(production, [{ chainId: 8453 }])).toEqual([10])
  })

  it('has none for a launch whose uri lists no chains', () => {
    expect(missingChains({ chainId: BASE_SEPOLIA, plannedChains: null }, [{ chainId: BASE_SEPOLIA }])).toEqual([])
    expect(missingChains({ chainId: BASE_SEPOLIA, plannedChains: [] }, [])).toEqual([])
  })

  it('reads the chains of the project info, as its uri listed them', () => {
    const info = infoOf(BASE_SEPOLIA, { id: 12, tax: 500n, soulbound: false, launchId: LAUNCH })
    expect(missingChains(info, [{ chainId: BASE_SEPOLIA }])).toEqual([OP_SEPOLIA])
  })
})
