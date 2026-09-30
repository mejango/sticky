import { afterEach, describe, expect, it, vi } from 'vitest'
import { stickyInfo } from '../home-fixtures'
import { CHAIN, HOOK, POSITION_TOPICS, staked } from './sticky-log-fixtures'

// homeChain's own reads, when a caller gives it none: each is one of Sticky's readers, handed the caller's signal. The
// readers have tests of their own, their cancelling included; this holds the wiring.

const mocks = vi.hoisted(() => ({
  projectsOn: vi.fn(),
  scan: vi.fn(),
  creationBlock: vi.fn(),
  readProjects: vi.fn(),
  indexedMoves: vi.fn(),
  terminalMoves: vi.fn(),
}))
vi.mock('@/lib/sticky-events', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-events')>()),
  stickyProjectsOn: mocks.projectsOn,
  scanToHead: mocks.scan,
  projectCreationBlock: mocks.creationBlock,
}))
vi.mock('@/lib/sticky-project', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-project')>()),
  readStickyProjects: mocks.readProjects,
}))
vi.mock('@/lib/sticky-indexed', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-indexed')>()),
  indexedStickyMoves: mocks.indexedMoves,
}))
vi.mock('@/lib/sticky-feed', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-feed')>()),
  terminalMoves: mocks.terminalMoves,
}))

import { homeChain } from '@/lib/sticky-home'

afterEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
})

describe('homeChain\'s own reads', () => {
  it('lists, reads and scans a chain with Sticky\'s readers, each handed the caller\'s signal', async () => {
    const { signal } = new AbortController()
    mocks.projectsOn.mockResolvedValue({ projects: [{ chainId: CHAIN, projectId: 23n }], source: 'scanned', degraded: null })
    mocks.readProjects.mockResolvedValue([stickyInfo(CHAIN, 23n)])
    mocks.creationBlock.mockResolvedValue(51_900_000n)
    mocks.scan.mockResolvedValue([staked(`0x${'a'.repeat(40)}`, `0x${'a'.repeat(40)}`, 1n, 1n)])
    mocks.terminalMoves.mockResolvedValue(new Map())

    const chain = await homeChain(CHAIN, { index: null, latest: null, signal })

    expect(mocks.projectsOn).toHaveBeenCalledWith(CHAIN, null, { signal })
    expect(mocks.readProjects).toHaveBeenCalledWith(CHAIN, [23n], { signal })
    expect(mocks.creationBlock).toHaveBeenCalledWith(CHAIN, 23n, { signal })
    expect(mocks.scan).toHaveBeenCalledWith(
      CHAIN,
      { address: HOOK, topics: [POSITION_TOPICS], fromBlock: 51_900_000n },
      { signal },
    )
    expect(mocks.terminalMoves).toHaveBeenCalledWith(expect.any(Array), { signal })
    expect(chain.activity).toHaveLength(1)
  })

  it('reads a chain\'s pays and cash outs from Bendystraw with the caller\'s signal', async () => {
    const { signal } = new AbortController()
    mocks.projectsOn.mockResolvedValue({ projects: [{ chainId: CHAIN, projectId: 23n }], source: 'indexed', degraded: null })
    mocks.readProjects.mockResolvedValue([stickyInfo(CHAIN, 23n)])
    mocks.indexedMoves.mockResolvedValue({ rows: [], blocks: new Map([[CHAIN, 1n]]) })
    const index = { blocks: new Map([[CHAIN, 1n]]), projects: [{ chainId: CHAIN, projectId: 23n }] }

    await homeChain(CHAIN, { index, latest: null, signal })

    expect(mocks.indexedMoves).toHaveBeenCalledWith(CHAIN, [23n], signal)
    expect(mocks.scan).not.toHaveBeenCalled()
  })
})
