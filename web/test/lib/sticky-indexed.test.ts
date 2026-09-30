// @vitest-environment node

import { createHash } from 'node:crypto'
import { getEventListeners } from 'node:events'
import { BendystrawTimeoutError } from '@bananapus/nana-sdk-core'
import { describe, expect, it, vi } from 'vitest'
import registry from '@/lib/bendystraw-operation-registry.json'
import { stickyDeployment } from '@/lib/sticky-addresses'
import {
  indexedBlocks,
  indexedStickyCreateTx,
  indexedStickyEvents,
  indexedStickyMoves,
  indexedStickyPositions,
  indexedStickyProjects,
  indexedStickySettings,
} from '@/lib/sticky-indexed'

// Bendystraw is faked at its HTTP edge. The transport, the seven documents and the operation registry are the
// real ones, so a document the registry lacks, or a variable its contract refuses, fails here as it would
// against the relay.

const TESTNET = 'https://testnet.bendystraw.xyz/graphql'
const MAINNET = 'https://bendystraw.up.railway.app/graphql'
const DEPLOYER = stickyDeployment(84532)!.deployer.toLowerCase()
const HOLDER = `0x${'a'.repeat(40)}`
const OTHER = `0x${'b'.repeat(40)}`
const CAROL = `0x${'c'.repeat(40)}`
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}`

type Variables = Record<string, unknown>
type Answer = { data: unknown } | { errors: { message: string }[] } | Response
type Sent = { url: string; operation: string; query: string; variables: Variables }

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Answers each document by name, as Bendystraw would, and lists what it was asked. A request for a document
 * the registry does not hold gets the relay's 400. */
function indexer(handlers: Record<string, (variables: Variables) => Answer | Promise<Answer>>): Sent[] {
  const sent: Sent[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query?: string; operation?: string; variables: Variables }
      const query = body.query ?? (registry as Record<string, string>)[body.operation ?? '']
      if (!query) return reply({ error: 'unknown or invalid operation' }, 400)
      const operation = /query (\w+)/.exec(query)![1]
      sent.push({ url, operation, query, variables: body.variables })
      const handler = handlers[operation]
      if (!handler) return reply({ errors: [{ message: `unexpected ${operation}` }] })
      const answer = await handler(body.variables)
      return answer instanceof Response ? answer : reply(answer)
    }),
  )
  return sent
}

/** An indexer that never answers. */
const hang = () => vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))

/** How a read ended: the error it rejected with, or undefined when it resolved. */
const failure = (work: Promise<unknown>) => work.then(() => undefined, (error: unknown) => error)

const page = (items: unknown[], next?: string) => ({
  items,
  pageInfo: { hasNextPage: next !== undefined, endCursor: next ?? null },
})
const status = (entries: [string, number, number][]) =>
  Object.fromEntries(entries.map(([name, id, number]) => [name, { id, block: { number, timestamp: 1 } }]))
const indexOf = (
  entries: [string, number, number][],
  projects: unknown[],
  next?: string,
) => ({ data: { _meta: { status: status(entries) }, projects: page(projects, next) } })

const project = (chainId: number, projectId: number, extra: Variables = {}) => ({
  chainId,
  projectId,
  version: 6,
  owner: DEPLOYER,
  metadataUri: null,
  createdAt: 1,
  ...extra,
})
const TESTNET_CHAINS: [string, number, number][] = [
  ['baseSepolia', 84532, 500],
  ['optimismSepolia', 11155420, 900],
]

const pay = (projectId: number, extra: Variables = {}) => ({
  chainId: 84532,
  projectId,
  version: 6,
  txHash: tx(1),
  logIndex: 1,
  timestamp: 20,
  caller: OTHER,
  beneficiary: HOLDER,
  amount: '5',
  newlyIssuedTokenCount: '50',
  ...extra,
})
const cashOut = (projectId: number, extra: Variables = {}) => ({
  chainId: 84532,
  projectId,
  version: 6,
  txHash: tx(2),
  logIndex: 2,
  timestamp: 30,
  caller: HOLDER,
  holder: HOLDER,
  beneficiary: HOLDER,
  cashOutCount: '20',
  reclaimAmount: '2',
  ...extra,
})

const eventRow = (type: string, extra: Variables = {}) => ({
  chainId: 84532,
  projectId: 37,
  version: 6,
  txHash: tx(1),
  logIndex: 1,
  timestamp: 100,
  holder: HOLDER,
  type,
  count: null,
  stakedBalance: null,
  payer: null,
  duration: null,
  ...extra,
})
const staked = (extra: Variables = {}) =>
  eventRow('staked', { count: '10', stakedBalance: '25', payer: OTHER, ...extra })
const unstaked = (extra: Variables = {}) => eventRow('unstaked', { count: '4', stakedBalance: '21', ...extra })
const streakStarted = (extra: Variables = {}) => eventRow('streakStarted', extra)
const streakEnded = (extra: Variables = {}) => eventRow('streakEnded', { duration: 86_400, ...extra })

const positionRow = (extra: Variables = {}) => ({
  chainId: 84532,
  projectId: 37,
  version: 6,
  holder: HOLDER,
  stakedBalance: '25',
  streakStartedAt: 1_700_000_000,
  longestCompletedStreak: 86_400,
  ...extra,
})

const settingRow = (type: string, extra: Variables = {}) => ({
  chainId: 84532,
  projectId: 37,
  version: 6,
  txHash: tx(1),
  logIndex: 1,
  timestamp: 100,
  type,
  account: null,
  holder: null,
  trusted: null,
  amount: null,
  caller: null,
  ...extra,
})

/** One call to every reader, each with the arguments it needs for chain 84532 and project 37. */
const readers: [string, (signal?: AbortSignal) => Promise<unknown>][] = [
  ['indexedStickyProjects', signal => indexedStickyProjects('testnet', signal)],
  ['indexedBlocks', signal => indexedBlocks('testnet', signal)],
  ['indexedStickyMoves', signal => indexedStickyMoves(84532, [37n], signal)],
  ['indexedStickyCreateTx', signal => indexedStickyCreateTx(84532, 37n, signal)],
  ['indexedStickyEvents', signal => indexedStickyEvents({ chainId: 84532, projectId: 37n }, signal)],
  ['indexedStickyPositions', signal => indexedStickyPositions({ chainId: 84532, projectId: 37n }, signal)],
  ['indexedStickySettings', signal => indexedStickySettings(84532, 37n, signal)],
]

/** The three readers of the tables peripheralist/bendystraw#36 adds, with the document each runs and the
 * root field it queries. */
const newReaders: [string, string, string, () => Promise<unknown>][] = [
  ['indexedStickyEvents', 'StickyEvents', 'stickyEvents', () => indexedStickyEvents({ chainId: 84532, projectId: 37n })],
  ['indexedStickyPositions', 'StickyPositions', 'stickyPositions', () => indexedStickyPositions({ chainId: 84532, projectId: 37n })],
  ['indexedStickySettings', 'StickySettings', 'stickySettingEvents', () => indexedStickySettings(84532, 37n)],
]

describe('the network index: projects and indexed blocks', () => {
  it('lists the Sticky projects of the chains it has a status for, and the lowest block those chains are indexed through', async () => {
    const sent = indexer({
      StickyIndex: () =>
        indexOf(
          [...TESTNET_CHAINS, ['ethereumSepolia', 11155111, 7], ['elsewhere', 999, 1]],
          [
            project(84532, 38),
            project(84532, 37),
            project(11155420, 5),
            // Another owner's project, one from before V6, one on a chain Sticky is not on, and one on a
            // Sticky chain the status has no block for: none of them is a Sticky project the index covers.
            project(84532, 3, { owner: OTHER }),
            project(84532, 9, { version: 5 }),
            project(999, 1),
            project(421614, 2),
          ],
        ),
    })

    const index = await indexedStickyProjects('testnet')

    expect(index).toEqual({
      block: 7n,
      projects: [
        { chainId: 84532, projectId: 37n },
        { chainId: 84532, projectId: 38n },
        { chainId: 11155420, projectId: 5n },
      ],
    })
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe(TESTNET)
    expect(sent[0].variables).toEqual({ owners: [DEPLOYER], after: null })
  })

  it('reports each chain with a status and the block it is indexed through, and leaves out any chain without one', async () => {
    indexer({
      StickyIndex: () =>
        indexOf(
          [...TESTNET_CHAINS, ['ethereumSepolia', 11155111, 7], ['elsewhere', 999, 1]],
          [],
        ),
    })

    expect(await indexedBlocks('testnet')).toEqual(
      new Map([
        [84532, 500n],
        [11155420, 900n],
        [11155111, 7n],
      ]),
    )
  })

  it('leaves out a chain whose status has no usable block, instead of reading it as block 0', async () => {
    indexer({
      StickyIndex: () => ({
        data: {
          _meta: {
            status: {
              baseSepolia: { id: 84532, block: { number: 500, timestamp: 1 } },
              optimismSepolia: { id: 11155420, block: { number: -1, timestamp: 1 } },
              ethereumSepolia: { id: 11155111, block: { number: 1.5, timestamp: 1 } },
              arbitrumSepolia: { id: 421614, block: { number: '900', timestamp: 1 } },
              // Entries that are not a chain with a block leave everything else as it was.
              nothing: null,
              text: 'up',
              noBlock: { id: 84532 },
              nullBlock: { id: 84532, block: null },
              textId: { id: '84532', block: { number: 5, timestamp: 1 } },
            },
          },
          projects: page([]),
        },
      }),
    })

    expect(await indexedBlocks('testnet')).toEqual(new Map([[84532, 500n]]))
  })

  it('reads a production index from the production indexer for the production chains', async () => {
    const sent = indexer({
      StickyIndex: () =>
        indexOf([['ethereum', 1, 26_061_894], ['arbitrum', 42161, 509_092_274], ['sepoliaToo', 84532, 5]], []),
    })

    expect(await indexedBlocks('mainnet')).toEqual(
      new Map([
        [1, 26_061_894n],
        [42161, 509_092_274n],
      ]),
    )
    expect(sent[0].url).toBe(MAINNET)
    expect(sent[0].variables).toEqual({ owners: [DEPLOYER], after: null })
  })

  it('answers a truly empty index as no projects, from Bendystraw alone', async () => {
    const sent = indexer({
      StickyIndex: () => indexOf([['ethereum', 1, 26_061_894], ['arbitrum', 42161, 509_092_274]], []),
    })

    expect(await indexedStickyProjects('mainnet')).toEqual({ block: 26_061_894n, projects: [] })
    expect(sent.every(({ url }) => url === MAINNET)).toBe(true)
  })

  it('rejects, rather than listing no projects, when the index has no status for any Sticky chain', async () => {
    indexer({ StickyIndex: () => indexOf([['elsewhere', 999, 1]], []) })

    await expect(indexedStickyProjects('testnet')).rejects.toThrow('no status')
    expect(await indexedBlocks('testnet')).toEqual(new Map())
  })

  it('has nothing to read for a network Sticky is not deployed on, and asks nothing', async () => {
    vi.resetModules()
    vi.doMock('@/lib/sticky-deployments.json', () => ({ default: {} }))
    try {
      const undeployed = await import('@/lib/sticky-indexed')
      const sent = indexer({})

      expect(await undeployed.indexedBlocks('testnet')).toEqual(new Map())
      await expect(undeployed.indexedStickyProjects('testnet')).rejects.toThrow('no status')
      expect(sent).toHaveLength(0)
    } finally {
      vi.doUnmock('@/lib/sticky-deployments.json')
      vi.resetModules()
    }
  })

  it('follows the cursor, and takes the block from the first page, which is the earliest', async () => {
    const sent = indexer({
      StickyIndex: ({ after }) =>
        after === null
          ? indexOf([['baseSepolia', 84532, 500]], [project(84532, 37)], 'cursor-1')
          : indexOf([['baseSepolia', 84532, 640]], [project(84532, 38)]),
    })

    expect(await indexedStickyProjects('testnet')).toEqual({
      block: 500n,
      projects: [
        { chainId: 84532, projectId: 37n },
        { chainId: 84532, projectId: 38n },
      ],
    })
    expect(sent.map(({ variables }) => variables.after)).toEqual([null, 'cursor-1'])
  })

  it('stops at 20 pages with an error instead of quietly truncating', async () => {
    let next = 0
    const sent = indexer({
      StickyIndex: () => indexOf([['baseSepolia', 84532, 500]], [project(84532, (next += 1))], `cursor-${next}`),
    })

    await expect(indexedStickyProjects('testnet')).rejects.toThrow('more projects than one page load reads')
    expect(sent).toHaveLength(20)
  })

  it('rejects a page that says there is more but names no cursor', async () => {
    indexer({
      StickyIndex: () => ({
        data: {
          _meta: { status: status([['baseSepolia', 84532, 500]]) },
          projects: { items: [], pageInfo: { hasNextPage: true, endCursor: null } },
        },
      }),
    })

    await expect(indexedStickyProjects('testnet')).rejects.toThrow('no cursor')
  })

  it('rejects on a Bendystraw error, an HTTP failure, a missing status or a missing list, never answering empty', async () => {
    indexer({ StickyIndex: () => ({ errors: [{ message: 'Unknown field' }] }) })
    await expect(indexedStickyProjects('testnet')).rejects.toThrow('Unknown field')
    await expect(indexedBlocks('testnet')).rejects.toThrow('Unknown field')

    indexer({ StickyIndex: () => reply({ error: 'unknown or invalid operation' }, 400) })
    await expect(indexedStickyProjects('testnet')).rejects.toThrow('Bendystraw request failed (400)')

    for (const meta of [null, { status: null }, { status: 'up' }, { status: [] }]) {
      indexer({ StickyIndex: () => ({ data: { _meta: meta, projects: page([]) } }) })
      await expect(indexedStickyProjects('testnet')).rejects.toThrow('no indexing status')
      await expect(indexedBlocks('testnet')).rejects.toThrow('no indexing status')
    }

    indexer({ StickyIndex: () => ({ data: { _meta: { status: status(TESTNET_CHAINS) }, projects: null } }) })
    await expect(indexedStickyProjects('testnet')).rejects.toThrow('no projects')
  })

  it('rejects an item that is not a record, rather than dropping it', async () => {
    indexer({ StickyIndex: () => indexOf(TESTNET_CHAINS, [project(84532, 37), null]) })

    await expect(indexedStickyProjects('testnet')).rejects.toThrow('incomplete Sticky project')
  })

  it('rejects a project of the deployer that has no usable ID, rather than dropping it', async () => {
    for (const projectId of [0, -3, 1.5, '37', null]) {
      indexer({ StickyIndex: () => indexOf(TESTNET_CHAINS, [project(84532, 37), project(84532, 1, { projectId })]) })
      await expect(indexedStickyProjects('testnet')).rejects.toThrow('incomplete Sticky project')
    }
  })
})

describe('sticks and unsticks', () => {
  it('reads pays and cash outs for one chain at version 6, drops rows for other projects, chains and versions, and orders them by time', async () => {
    const sent = indexer({
      // Bendystraw has ignored filters before: a row outside the request must not reach the page.
      StickyPays: () => ({
        data: {
          payEvents: page([
            pay(37),
            pay(99),
            pay(37, { version: 4 }),
            pay(37, { chainId: 10 }),
            pay(37, { timestamp: 10, logIndex: 0, txHash: tx(9) }),
          ]),
        },
      }),
      StickyCashOuts: () => ({ data: { cashOutTokensEvents: page([cashOut(37)]) } }),
    })

    const moves = await indexedStickyMoves(84532, [37n])

    expect(sent.map(({ operation, variables }) => [operation, variables]).sort()).toEqual([
      ['StickyCashOuts', { where: { chainId: 84532, version: 6, projectId_in: [37] }, after: null }],
      ['StickyPays', { where: { chainId: 84532, version: 6, projectId_in: [37] }, after: null }],
    ])
    expect(sent.every(({ url }) => url === TESTNET)).toBe(true)
    expect(moves).toEqual([
      { kind: 'stick', chainId: 84532, projectId: 37n, txHash: tx(9), logIndex: 0, timestamp: 10, payer: OTHER, holder: HOLDER, amount: 5n, tokens: 50n },
      { kind: 'stick', chainId: 84532, projectId: 37n, txHash: tx(1), logIndex: 1, timestamp: 20, payer: OTHER, holder: HOLDER, amount: 5n, tokens: 50n },
      { kind: 'unstick', chainId: 84532, projectId: 37n, txHash: tx(2), logIndex: 2, timestamp: 30, holder: HOLDER, amount: 2n, tokens: 20n },
    ])
  })

  it('lowercases addresses and reads amounts past 2^53 exactly', async () => {
    indexer({
      StickyPays: () => ({
        data: {
          payEvents: page([
            pay(37, { caller: OTHER.toUpperCase().replace('0X', '0x'), beneficiary: HOLDER.toUpperCase().replace('0X', '0x'), amount: '123456789012345678901', newlyIssuedTokenCount: '9007199254740993' }),
          ]),
        },
      }),
      StickyCashOuts: () => ({ data: { cashOutTokensEvents: page([]) } }),
    })

    expect(await indexedStickyMoves(84532, [37n])).toEqual([
      expect.objectContaining({ payer: OTHER, holder: HOLDER, amount: 123456789012345678901n, tokens: 9007199254740993n }),
    ])
  })

  it('reads an amount that came as a JSON number, and rejects one that is not a whole number', async () => {
    indexer({
      StickyPays: () => ({ data: { payEvents: page([pay(37, { amount: 5, newlyIssuedTokenCount: 50 })]) } }),
      StickyCashOuts: () => ({ data: { cashOutTokensEvents: page([]) } }),
    })
    expect(await indexedStickyMoves(84532, [37n])).toEqual([expect.objectContaining({ amount: 5n, tokens: 50n })])

    indexer({
      StickyPays: () => ({ data: { payEvents: page([pay(37, { amount: 1.5 })]) } }),
      StickyCashOuts: () => ({ data: { cashOutTokensEvents: page([]) } }),
    })
    await expect(indexedStickyMoves(84532, [37n])).rejects.toThrow('incomplete Sticky event')
  })

  it('asks Bendystraw nothing, and answers no moves, for no projects', async () => {
    const sent = indexer({})

    expect(await indexedStickyMoves(84532, [])).toEqual([])
    expect(sent).toHaveLength(0)
  })

  it('names each project once', async () => {
    const sent = indexer({
      StickyPays: () => ({ data: { payEvents: page([]) } }),
      StickyCashOuts: () => ({ data: { cashOutTokensEvents: page([]) } }),
    })

    await indexedStickyMoves(84532, [37n, 38n, 37n])

    expect((sent[0].variables.where as { projectId_in: number[] }).projectId_in).toEqual([37, 38])
  })

  it('follows the cursors of both lists', async () => {
    const sent = indexer({
      StickyPays: ({ after }) =>
        after === null
          ? { data: { payEvents: page([pay(37, { txHash: tx(1) })], 'p1') } }
          : { data: { payEvents: page([pay(37, { txHash: tx(3), timestamp: 40 })]) } },
      StickyCashOuts: () => ({ data: { cashOutTokensEvents: page([cashOut(37)]) } }),
    })

    const moves = await indexedStickyMoves(84532, [37n])

    expect(moves.map(({ txHash }) => txHash)).toEqual([tx(1), tx(2), tx(3)])
    expect(sent.filter(({ operation }) => operation === 'StickyPays').map(({ variables }) => variables.after)).toEqual([null, 'p1'])
  })

  it('stops at 20 pages of either list with an error', async () => {
    let next = 0
    indexer({
      StickyPays: () => ({ data: { payEvents: page([pay(37)], `p${(next += 1)}`) } }),
      StickyCashOuts: () => ({ data: { cashOutTokensEvents: page([]) } }),
    })
    await expect(indexedStickyMoves(84532, [37n])).rejects.toThrow('more payEvents than one page load reads')

    next = 0
    indexer({
      StickyPays: () => ({ data: { payEvents: page([]) } }),
      StickyCashOuts: () => ({ data: { cashOutTokensEvents: page([cashOut(37)], `c${(next += 1)}`) } }),
    })
    await expect(indexedStickyMoves(84532, [37n])).rejects.toThrow('more cashOutTokensEvents than one page load reads')
  })

  it('rejects when either list fails, rather than answering with half the moves', async () => {
    indexer({
      StickyPays: () => ({ errors: [{ message: 'timeout' }] }),
      StickyCashOuts: () => ({ data: { cashOutTokensEvents: page([]) } }),
    })
    await expect(indexedStickyMoves(84532, [37n])).rejects.toThrow('timeout')

    indexer({
      StickyPays: () => ({ data: { payEvents: page([pay(37)]) } }),
      StickyCashOuts: () => ({ errors: [{ message: 'database is down' }] }),
    })
    await expect(indexedStickyMoves(84532, [37n])).rejects.toThrow('database is down')
  })

  it('stops paging the other list once one fails', async () => {
    let asked = 0
    indexer({
      StickyPays: () => ({ errors: [{ message: 'timeout' }] }),
      // Slower than the failure, so its first page arrives after the read has already been given up.
      StickyCashOuts: async () => {
        asked += 1
        await new Promise(resolve => setTimeout(resolve, 10))
        return { data: { cashOutTokensEvents: page([cashOut(37)], `c${asked}`) } }
      },
    })

    await expect(indexedStickyMoves(84532, [37n])).rejects.toThrow('timeout')
    await new Promise(resolve => setTimeout(resolve, 40))

    expect(asked).toBe(1)
  })

  it.each([
    ['a pay with no token count', 'pay', { newlyIssuedTokenCount: null }],
    ['a pay with a fractional amount', 'pay', { amount: '1.5' }],
    ['a pay with a negative amount', 'pay', { amount: '-5' }],
    ['a pay whose payer is not an address', 'pay', { caller: 'me' }],
    ['a pay whose beneficiary is not an address', 'pay', { beneficiary: null }],
    ['a pay with no transaction hash', 'pay', { txHash: '0x12' }],
    ['a pay with no log index', 'pay', { logIndex: null }],
    ['a pay with no timestamp', 'pay', { timestamp: '20' }],
    ['a cash out with no reclaim amount', 'cashOut', { reclaimAmount: null }],
    ['a cash out with no holder', 'cashOut', { holder: '' }],
    ['a cash out with no count', 'cashOut', { cashOutCount: 'many' }],
  ])('rejects the whole read for %s', async (_name, kind, extra) => {
    indexer({
      StickyPays: () => ({ data: { payEvents: page(kind === 'pay' ? [pay(37, extra)] : []) } }),
      StickyCashOuts: () => ({ data: { cashOutTokensEvents: page(kind === 'cashOut' ? [cashOut(37, extra)] : []) } }),
    })

    await expect(indexedStickyMoves(84532, [37n])).rejects.toThrow('incomplete Sticky event')
  })

  it('does not read a project ID that is not one', async () => {
    const sent = indexer({})

    await expect(indexedStickyMoves(84532, [0n])).rejects.toThrow(RangeError)
    await expect(indexedStickyMoves(84532, [2n ** 60n])).rejects.toThrow(RangeError)
    expect(sent).toHaveLength(0)
  })
})

describe('a project\'s creating transaction', () => {
  it('is the hash of the one creation Bendystraw has, asked for at version 6', async () => {
    const sent = indexer({
      StickyCreate: () => ({ data: { projectCreateEvents: { items: [{ txHash: tx(7), timestamp: 1 }] } } }),
    })

    expect(await indexedStickyCreateTx(84532, 37n)).toBe(tx(7))
    expect(sent[0].url).toBe(TESTNET)
    expect(sent[0].variables).toEqual({ where: { chainId: 84532, projectId: 37, version: 6 } })
  })

  it.each([
    ['no creation', []],
    ['two creations', [{ txHash: tx(7), timestamp: 1 }, { txHash: tx(8), timestamp: 2 }]],
    ['a creation with a malformed hash', [{ txHash: '0x1234', timestamp: 1 }]],
    ['a creation with no hash', [{ txHash: null, timestamp: 1 }]],
  ])('is null for %s, so the caller finds the block another way', async (_name, items) => {
    indexer({ StickyCreate: () => ({ data: { projectCreateEvents: { items } } }) })

    expect(await indexedStickyCreateTx(84532, 37n)).toBeNull()
  })

  it('rejects, rather than answering null, when Bendystraw errors or has no list', async () => {
    indexer({ StickyCreate: () => ({ errors: [{ message: 'down' }] }) })
    await expect(indexedStickyCreateTx(84532, 37n)).rejects.toThrow('down')

    indexer({ StickyCreate: () => ({ data: { projectCreateEvents: null } }) })
    await expect(indexedStickyCreateTx(84532, 37n)).rejects.toThrow('no project creation')
  })
})

describe('Sticky events', () => {
  it('reads one project\'s events oldest first, of every kind, with addresses in lowercase', async () => {
    const sent = indexer({
      StickyEvents: () => ({
        data: {
          stickyEvents: page([
            streakEnded({ txHash: tx(4), logIndex: 3, timestamp: 300 }),
            staked({ txHash: tx(1), logIndex: 5, timestamp: 100, payer: OTHER.toUpperCase().replace('0X', '0x') }),
            unstaked({ txHash: tx(3), logIndex: 2, timestamp: 200 }),
            streakStarted({ txHash: tx(1), logIndex: 4, timestamp: 100 }),
          ]),
        },
      }),
    })

    const events = await indexedStickyEvents({ chainId: 84532, projectId: 37n })

    expect(sent[0].url).toBe(TESTNET)
    expect(sent[0].variables).toEqual({
      where: { version: 6, chainId: 84532, projectId: 37 },
      orderDirection: 'asc',
      limit: 1000,
      after: null,
    })
    const place = { chainId: 84532, projectId: 37n, holder: HOLDER }
    expect(events).toEqual([
      { ...place, type: 'streakStarted', txHash: tx(1), logIndex: 4, timestamp: 100 },
      { ...place, type: 'staked', txHash: tx(1), logIndex: 5, timestamp: 100, payer: OTHER, count: 10n, stakedBalance: 25n },
      { ...place, type: 'unstaked', txHash: tx(3), logIndex: 2, timestamp: 200, count: 4n, stakedBalance: 21n },
      { ...place, type: 'streakEnded', txHash: tx(4), logIndex: 3, timestamp: 300, duration: 86_400 },
    ])
  })

  it('reads one holder\'s events on a chain', async () => {
    const sent = indexer({ StickyEvents: () => ({ data: { stickyEvents: page([staked()]) } }) })

    await indexedStickyEvents({ chainId: 84532, holder: HOLDER.toUpperCase().replace('0X', '0x') as `0x${string}` })

    expect(sent[0].variables.where).toEqual({ version: 6, chainId: 84532, holder: HOLDER })
  })

  it('reads the newest N events of several chains with one request, filtering on chainId_in only, and hands them over oldest first', async () => {
    const sent = indexer({
      // Newest first, as the request asked; more exist than were asked for.
      StickyEvents: () => ({
        data: {
          stickyEvents: page(
            [
              staked({ chainId: 11155420, txHash: tx(3), timestamp: 300 }),
              unstaked({ chainId: 84532, txHash: tx(2), timestamp: 200 }),
            ],
            'more',
          ),
        },
      }),
    })

    const events = await indexedStickyEvents({ chainIds: [84532, 11155420], newest: 40 })

    expect(sent).toHaveLength(1)
    expect(sent[0].variables).toEqual({
      where: { version: 6, chainId_in: [84532, 11155420] },
      orderDirection: 'desc',
      limit: 40,
      after: null,
    })
    const where = sent[0].variables.where as Variables
    expect(where).not.toHaveProperty('projectId')
    expect(where).not.toHaveProperty('projectId_in')
    expect(events.map(({ txHash }) => txHash)).toEqual([tx(2), tx(3)])
  })

  it.each([0, -1, 1.5, 1001, Number.NaN])('refuses to ask for the newest %s events', async newest => {
    const sent = indexer({})

    await expect(indexedStickyEvents({ chainId: 84532, newest })).rejects.toThrow(RangeError)
    expect(sent).toHaveLength(0)
  })

  it('reads all of the events of several chains when it is not after the newest', async () => {
    const sent = indexer({
      StickyEvents: ({ after }) =>
        after === null
          ? { data: { stickyEvents: page([staked({ timestamp: 100 })], 'e1') } }
          : { data: { stickyEvents: page([unstaked({ timestamp: 200 })]) } },
    })

    const events = await indexedStickyEvents({ chainIds: [84532, 11155420] })

    expect(events.map(({ type }) => type)).toEqual(['staked', 'unstaked'])
    expect(sent.map(({ variables }) => [variables.limit, variables.after])).toEqual([
      [1000, null],
      [1000, 'e1'],
    ])
  })

  it('answers no events, and asks nothing, for no chains', async () => {
    const sent = indexer({})

    expect(await indexedStickyEvents({ chainIds: [] })).toEqual([])
    expect(sent).toHaveLength(0)
  })

  it.each([
    ['no chain', {}],
    ['a chain and a list of chains', { chainId: 84532, chainIds: [84532] }],
    ['a project on several chains', { chainIds: [84532, 11155420], projectId: 37n }],
    ['a holder that is not an address', { chainId: 84532, holder: 'me' as `0x${string}` }],
  ])('refuses a question that names %s, without asking', async (_name, q) => {
    const sent = indexer({})

    await expect(indexedStickyEvents(q)).rejects.toThrow(TypeError)
    expect(sent).toHaveLength(0)
  })

  it('does not reach across networks or to a chain it does not know', async () => {
    const sent = indexer({})

    await expect(indexedStickyEvents({ chainIds: [8453, 84532] })).rejects.toThrow('cannot mix mainnet and testnet')
    await expect(indexedStickyEvents({ chainIds: [999_999] })).rejects.toThrow('Unsupported Bendystraw chain ID')
    expect(sent).toHaveLength(0)
  })

  it('drops rows outside the question, as an indexer that ignored the filter would send them', async () => {
    indexer({
      StickyEvents: () => ({
        data: {
          stickyEvents: page([
            staked({ txHash: tx(1) }),
            staked({ txHash: tx(2), projectId: 99 }),
            staked({ txHash: tx(3), chainId: 10 }),
            staked({ txHash: tx(4), version: 5 }),
            staked({ txHash: tx(5), holder: OTHER }),
          ]),
        },
      }),
    })

    const events = await indexedStickyEvents({ chainId: 84532, projectId: 37n, holder: HOLDER as `0x${string}` })

    expect(events.map(({ txHash }) => txHash)).toEqual([tx(1)])
  })

  it.each([
    ['a kind it does not know', eventRow('transferred')],
    ['a stake with no share count', staked({ count: null })],
    ['a stake with no balance', staked({ stakedBalance: null })],
    ['a stake with no payer', staked({ payer: null })],
    ['an unstake with no balance', unstaked({ stakedBalance: null })],
    ['a streak end with no duration', streakEnded({ duration: null })],
    ['an event with a malformed hash', staked({ txHash: '0xabc' })],
    ['an event with no holder', staked({ holder: null })],
    ['an event with no log index', staked({ logIndex: null })],
    ['an item that is not a record', null],
  ])('rejects the whole read for %s', async (_name, row) => {
    indexer({ StickyEvents: () => ({ data: { stickyEvents: page([staked(), row]) } }) })

    await expect(indexedStickyEvents({ chainId: 84532, projectId: 37n })).rejects.toThrow('incomplete Sticky event')
  })

  it('stops at 20 pages with an error', async () => {
    let next = 0
    const sent = indexer({ StickyEvents: () => ({ data: { stickyEvents: page([staked()], `e${(next += 1)}`) } }) })

    await expect(indexedStickyEvents({ chainId: 84532, projectId: 37n })).rejects.toThrow('more stickyEvents than one page load reads')
    expect(sent).toHaveLength(20)
  })
})

describe('Sticky positions', () => {
  it('reads every position of a holder across a network\'s chains', async () => {
    const sent = indexer({
      StickyPositions: () => ({
        data: {
          stickyPositions: page([
            positionRow(),
            positionRow({ chainId: 11155420, projectId: 5, stakedBalance: '0', streakStartedAt: null, longestCompletedStreak: 0 }),
          ]),
        },
      }),
    })

    const positions = await indexedStickyPositions({ chainIds: [84532, 11155420], holder: HOLDER as `0x${string}` })

    expect(sent[0].url).toBe(TESTNET)
    expect(sent[0].variables).toEqual({
      where: { version: 6, chainId_in: [84532, 11155420], holder: HOLDER },
      after: null,
    })
    expect(positions).toEqual([
      { chainId: 84532, projectId: 37n, holder: HOLDER, stakedBalance: 25n, streakStartedAt: 1_700_000_000, longestCompletedStreak: 86_400 },
      { chainId: 11155420, projectId: 5n, holder: HOLDER, stakedBalance: 0n, streakStartedAt: null, longestCompletedStreak: 0 },
    ])
  })

  it('reads every holder of one project', async () => {
    const sent = indexer({
      StickyPositions: ({ after }) =>
        after === null
          ? { data: { stickyPositions: page([positionRow({ holder: CAROL })], 'h1') } }
          : { data: { stickyPositions: page([positionRow()]) } },
    })

    const positions = await indexedStickyPositions({ chainId: 84532, projectId: 37n })

    expect(sent[0].variables.where).toEqual({ version: 6, chainId: 84532, projectId: 37 })
    expect(positions.map(({ holder }) => holder)).toEqual([CAROL, HOLDER])
    expect(sent.map(({ variables }) => variables.after)).toEqual([null, 'h1'])
  })

  it('refuses a question that names no chain, rather than answering for mainnet', async () => {
    const sent = indexer({})

    await expect(indexedStickyPositions({ holder: HOLDER as `0x${string}` })).rejects.toThrow(TypeError)
    expect(await indexedStickyPositions({ chainIds: [], holder: HOLDER as `0x${string}` })).toEqual([])
    expect(sent).toHaveLength(0)
  })

  it('drops rows outside the question and rejects incomplete ones', async () => {
    indexer({
      StickyPositions: () => ({
        data: {
          stickyPositions: page([
            positionRow(),
            positionRow({ projectId: 99 }),
            positionRow({ holder: OTHER }),
            positionRow({ version: 5 }),
          ]),
        },
      }),
    })
    expect(
      await indexedStickyPositions({ chainId: 84532, projectId: 37n, holder: HOLDER as `0x${string}` }),
    ).toHaveLength(1)

    for (const extra of [
      { stakedBalance: null },
      { stakedBalance: '-1' },
      { streakStartedAt: 'today' },
      { longestCompletedStreak: null },
      { holder: null },
    ]) {
      indexer({ StickyPositions: () => ({ data: { stickyPositions: page([positionRow(extra)]) } }) })
      await expect(indexedStickyPositions({ chainId: 84532, projectId: 37n })).rejects.toThrow('incomplete Sticky position')
    }
  })

  it('stops at 20 pages with an error', async () => {
    let next = 0
    indexer({ StickyPositions: () => ({ data: { stickyPositions: page([positionRow()], `h${(next += 1)}`) } }) })

    await expect(indexedStickyPositions({ chainId: 84532, projectId: 37n })).rejects.toThrow('more stickyPositions than one page load reads')
  })
})

describe('Sticky settings', () => {
  it('reads a project\'s granters, trusted senders and orphaned-balance exclusions oldest first', async () => {
    const sent = indexer({
      StickySettings: () => ({
        data: {
          stickySettingEvents: page([
            settingRow('orphanedBalanceExcluded', { txHash: tx(3), timestamp: 300, amount: '5000000000000000000', caller: CAROL }),
            settingRow('trustedSenderSet', { txHash: tx(2), timestamp: 200, account: OTHER, holder: HOLDER, trusted: false }),
            settingRow('granterSet', { txHash: tx(1), timestamp: 100, account: OTHER.toUpperCase().replace('0X', '0x'), caller: CAROL }),
            settingRow('trustedSenderSet', { txHash: tx(2), logIndex: 0, timestamp: 200, account: OTHER, holder: HOLDER, trusted: true }),
          ]),
        },
      }),
    })

    const settings = await indexedStickySettings(84532, 37n)

    expect(sent[0].url).toBe(TESTNET)
    expect(sent[0].variables).toEqual({ where: { chainId: 84532, projectId: 37, version: 6 }, after: null })
    const place = { chainId: 84532, projectId: 37n }
    expect(settings).toEqual([
      { ...place, type: 'granterSet', txHash: tx(1), logIndex: 1, timestamp: 100, granter: OTHER, caller: CAROL },
      { ...place, type: 'trustedSenderSet', txHash: tx(2), logIndex: 0, timestamp: 200, holder: HOLDER, sender: OTHER, trusted: true },
      { ...place, type: 'trustedSenderSet', txHash: tx(2), logIndex: 1, timestamp: 200, holder: HOLDER, sender: OTHER, trusted: false },
      { ...place, type: 'orphanedBalanceExcluded', txHash: tx(3), logIndex: 1, timestamp: 300, amount: 5_000_000_000_000_000_000n, caller: CAROL },
    ])
  })

  it('drops rows for other projects, chains and versions, and follows the cursor', async () => {
    const sent = indexer({
      StickySettings: ({ after }) =>
        after === null
          ? {
              data: {
                stickySettingEvents: page(
                  [
                    settingRow('granterSet', { account: OTHER, caller: CAROL, txHash: tx(1) }),
                    settingRow('granterSet', { account: OTHER, caller: CAROL, projectId: 99 }),
                    settingRow('granterSet', { account: OTHER, caller: CAROL, chainId: 10 }),
                  ],
                  's1',
                ),
              },
            }
          : { data: { stickySettingEvents: page([settingRow('granterSet', { account: HOLDER, caller: CAROL, txHash: tx(2), version: 5 })]) } },
    })

    const settings = await indexedStickySettings(84532, 37n)

    expect(settings.map(({ txHash }) => txHash)).toEqual([tx(1)])
    expect(sent.map(({ variables }) => variables.after)).toEqual([null, 's1'])
  })

  it.each([
    ['a kind it does not know', settingRow('tokenSet', { account: OTHER })],
    ['a granter with no account', settingRow('granterSet', { caller: CAROL })],
    ['a granter with no caller', settingRow('granterSet', { account: OTHER })],
    ['a trusted sender with no sender', settingRow('trustedSenderSet', { holder: HOLDER, trusted: true })],
    ['a trusted sender with no holder', settingRow('trustedSenderSet', { account: OTHER, trusted: true })],
    ['a trusted sender with no trusted flag', settingRow('trustedSenderSet', { account: OTHER, holder: HOLDER })],
    ['an exclusion with no amount', settingRow('orphanedBalanceExcluded', { caller: CAROL })],
    ['an exclusion with no caller', settingRow('orphanedBalanceExcluded', { amount: '5' })],
    ['a setting with a malformed hash', settingRow('granterSet', { account: OTHER, caller: CAROL, txHash: '0xabc' })],
  ])('rejects the whole read for %s', async (_name, row) => {
    indexer({ StickySettings: () => ({ data: { stickySettingEvents: page([row]) } }) })

    await expect(indexedStickySettings(84532, 37n)).rejects.toThrow('incomplete Sticky setting')
  })

  it('stops at 20 pages with an error', async () => {
    let next = 0
    indexer({
      StickySettings: () => ({
        data: { stickySettingEvents: page([settingRow('granterSet', { account: OTHER, caller: CAROL })], `s${(next += 1)}`) },
      }),
    })

    await expect(indexedStickySettings(84532, 37n)).rejects.toThrow('more stickySettingEvents than one page load reads')
  })
})

describe('an indexer that does not have the Sticky tables yet', () => {
  it.each(newReaders)(
    '%s rejects with the schema error and never returns an empty list',
    async (_name, operation, field, read) => {
      indexer({ [operation]: () => ({ errors: [{ message: `Cannot query field "${field}" on type "Query".` }] }) })

      await expect(read()).rejects.toThrow(`Cannot query field "${field}"`)
    },
  )

  it.each(newReaders)(
    '%s rejects when the schema does not know the filter type either',
    async (_name, operation, field, read) => {
      indexer({ [operation]: () => ({ errors: [{ message: `Unknown type "${field}Filter".` }] }) })

      await expect(read()).rejects.toThrow('Unknown type')
    },
  )

  it('rejects through the same-origin relay, which answers a schema error with a 502, whichever reader asked', async () => {
    vi.stubGlobal('window', {})
    // A 502 is retried twice, after 250 ms and 750 ms, before the transport gives up. The three reads wait
    // together, in real time: the browser transport hashes each document with the platform's own crypto.
    const fetcher = vi.fn(async () => reply({ error: 'Bendystraw unavailable' }, 502))
    vi.stubGlobal('fetch', fetcher)

    const outcomes = await Promise.all(newReaders.map(([, , , read]) => failure(read())))

    for (const outcome of outcomes) expect(outcome).toMatchObject({ message: 'Bendystraw request failed (502)' })
    expect(fetcher).toHaveBeenCalledTimes(9)
  })

  it.each(newReaders)('%s rejects when the answer has no list, however the error was worded', async (_name, operation, _field, read) => {
    indexer({ [operation]: () => ({ data: { anything: page([]) } }) })

    await expect(read()).rejects.toThrow()
  })
})

describe('the read deadline', () => {
  it.each(readers)('%s gives up on an indexer that never answers after 8 s, with the transport\'s timeout error', async (_name, read) => {
    vi.useFakeTimers()
    hang()
    let settled = false
    const outcome = failure(read()).then(error => {
      settled = true
      return error
    })

    await vi.advanceTimersByTimeAsync(7_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    const error = await outcome
    expect(error).toBeInstanceOf(BendystrawTimeoutError)
    expect(error).toMatchObject({ timeoutMs: 8_000 })
  })

  it('counts the 8 s across all of a read\'s pages, and asks for no more once it has passed', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 5_000))
      return reply({ data: { _meta: { status: status(TESTNET_CHAINS) }, projects: page([project(84532, 1)], 'more') } })
    })
    vi.stubGlobal('fetch', fetcher)
    const outcome = failure(indexedStickyProjects('testnet'))

    await vi.advanceTimersByTimeAsync(8_000)
    expect(await outcome).toBeInstanceOf(BendystrawTimeoutError)
    await vi.advanceTimersByTimeAsync(30_000)

    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('lets a read that is answered within 8 s finish, however slowly', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 7_999))
        return reply({ data: { projectCreateEvents: { items: [{ txHash: tx(7), timestamp: 1 }] } } })
      }),
    )
    const outcome = indexedStickyCreateTx(84532, 37n)

    await vi.advanceTimersByTimeAsync(7_999)

    expect(await outcome).toBe(tx(7))
  })

  it('leaves no timer running once a read has ended, whether it answered or failed', async () => {
    vi.useFakeTimers()
    indexer({ StickyCreate: () => ({ data: { projectCreateEvents: { items: [] } } }) })
    await indexedStickyCreateTx(84532, 37n)
    expect(vi.getTimerCount()).toBe(0)

    indexer({ StickyCreate: () => ({ errors: [{ message: 'down' }] }) })
    await expect(indexedStickyCreateTx(84532, 37n)).rejects.toThrow('down')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives each read its own 8 s', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 6_000))
        return reply({ data: { projectCreateEvents: { items: [] } } })
      }),
    )
    const first = indexedStickyCreateTx(84532, 37n)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(await first).toBeNull()

    const second = indexedStickyCreateTx(84532, 38n)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(await second).toBeNull()
  })
})

describe('a caller\'s AbortSignal', () => {
  it.each(readers)('%s sends nothing when the signal is already aborted, and rejects with its reason', async (_name, read) => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const reason = new Error('left the page')
    const controller = new AbortController()
    controller.abort(reason)

    await expect(read(controller.signal)).rejects.toBe(reason)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(readers)('%s rejects at once with the reason when the signal aborts while the indexer is silent', async (_name, read) => {
    vi.useFakeTimers()
    hang()
    const controller = new AbortController()
    const outcome = failure(read(controller.signal))
    await vi.advanceTimersByTimeAsync(1_000)
    const reason = new Error('left the page')

    controller.abort(reason)

    expect(await outcome).toBe(reason)
  })

  it('rejects with the signal\'s own AbortError when it aborts with no reason', async () => {
    vi.useFakeTimers()
    hang()
    const controller = new AbortController()
    const outcome = failure(indexedStickyCreateTx(84532, 37n, controller.signal))

    controller.abort()

    expect(await outcome).toBe(controller.signal.reason)
    expect(controller.signal.reason).toMatchObject({ name: 'AbortError' })
  })

  it('stops asking for pages once the signal aborts', async () => {
    const controller = new AbortController()
    const reason = new Error('left the page')
    const sent = indexer({
      StickyIndex: ({ after }) => {
        if (after !== null) controller.abort(reason)
        return indexOf(TESTNET_CHAINS, [project(84532, 37)], 'more')
      },
    })

    await expect(indexedStickyProjects('testnet', controller.signal)).rejects.toBe(reason)
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(sent).toHaveLength(2)
  })

  it('wins over the deadline when it aborts first, and does not stop the deadline of a later read', async () => {
    vi.useFakeTimers()
    hang()
    const controller = new AbortController()
    const reason = new Error('left the page')
    const first = failure(indexedStickyCreateTx(84532, 37n, controller.signal))
    await vi.advanceTimersByTimeAsync(3_000)
    controller.abort(reason)
    expect(await first).toBe(reason)

    const second = failure(indexedStickyCreateTx(84532, 38n))
    await vi.advanceTimersByTimeAsync(8_000)
    expect(await second).toBeInstanceOf(BendystrawTimeoutError)
  })

  it('leaves no listener on the caller\'s signal once a read has ended, whether it answered or failed', async () => {
    const controller = new AbortController()

    indexer({ StickyCreate: () => ({ data: { projectCreateEvents: { items: [] } } }) })
    await indexedStickyCreateTx(84532, 37n, controller.signal)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)

    indexer({ StickyCreate: () => ({ errors: [{ message: 'down' }] }) })
    await expect(indexedStickyCreateTx(84532, 37n, controller.signal)).rejects.toThrow('down')
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('does not disturb a read that finishes before the signal aborts', async () => {
    indexer({ StickyCreate: () => ({ data: { projectCreateEvents: { items: [{ txHash: tx(7), timestamp: 1 }] } } }) })
    const controller = new AbortController()

    const found = await indexedStickyCreateTx(84532, 37n, controller.signal)
    controller.abort()

    expect(found).toBe(tx(7))
  })
})

describe('the documents', () => {
  /** Every reader against an indexer that has an empty answer for each of the seven documents. */
  async function readEverything() {
    const sent = indexer({
      StickyIndex: () => indexOf(TESTNET_CHAINS, []),
      StickyPays: () => ({ data: { payEvents: page([]) } }),
      StickyCashOuts: () => ({ data: { cashOutTokensEvents: page([]) } }),
      StickyCreate: () => ({ data: { projectCreateEvents: { items: [] } } }),
      StickyEvents: () => ({ data: { stickyEvents: page([]) } }),
      StickyPositions: () => ({ data: { stickyPositions: page([]) } }),
      StickySettings: () => ({ data: { stickySettingEvents: page([]) } }),
    })
    for (const [, read] of readers) await read()
    return sent
  }

  it('are seven, each registered under the SHA-256 of its exact text', async () => {
    const sent = await readEverything()

    const documents = new Map(sent.map(({ operation, query }) => [operation, query]))
    expect([...documents.keys()].sort()).toEqual([
      'StickyCashOuts',
      'StickyCreate',
      'StickyEvents',
      'StickyIndex',
      'StickyPays',
      'StickyPositions',
      'StickySettings',
    ])
    for (const query of documents.values()) {
      expect((registry as Record<string, string>)[createHash('sha256').update(query, 'utf8').digest('hex')]).toBe(query)
    }
  })

  it('keep the IDs the first four had in the old client\'s registry', async () => {
    const sent = await readEverything()

    const idOf = (operation: string) =>
      createHash('sha256').update(sent.find(request => request.operation === operation)!.query, 'utf8').digest('hex')
    expect(idOf('StickyIndex')).toBe('6d883ec5d783d0ca340af5ffe0ed30da99af1f0fc7f148e557cf4b844a014f45')
    expect(idOf('StickyPays')).toBe('ee745e235eef8f9a5ef97616351badc4ac2f1cb3e4e596c3e158c1057e85c741')
    expect(idOf('StickyCashOuts')).toBe('80dd411715bb2f4eab91eb0549fc69c0aaf8e1252d7f251aed0d8ceecb0d233d')
    expect(idOf('StickyCreate')).toBe('991f63433092a9e84526f9d09ad62bcbfe172488b6872089aaacdc7c2cdae6fc')
  })

  it('are read with the live cache policy', async () => {
    await readEverything()

    const revalidate = vi.mocked(fetch).mock.calls.map(([, init]) => (init as { next?: { revalidate?: number } }).next?.revalidate)
    expect(revalidate).toHaveLength(8)
    expect(new Set(revalidate)).toEqual(new Set([15]))
  })

  it('reach the indexer through the relay by operation ID alone, from the browser', async () => {
    vi.stubGlobal('window', {})
    const sent = indexer({
      StickyIndex: () => indexOf(TESTNET_CHAINS, [project(84532, 37)]),
      StickyPays: () => ({ data: { payEvents: page([pay(37)]) } }),
      StickyCashOuts: () => ({ data: { cashOutTokensEvents: page([]) } }),
      StickyCreate: () => ({ data: { projectCreateEvents: { items: [{ txHash: tx(7), timestamp: 1 }] } } }),
      StickyEvents: () => ({ data: { stickyEvents: page([staked()]) } }),
      StickyPositions: () => ({ data: { stickyPositions: page([positionRow()]) } }),
      StickySettings: () => ({ data: { stickySettingEvents: page([settingRow('granterSet', { account: OTHER, caller: CAROL })]) } }),
    })

    await indexedStickyProjects('testnet')
    await indexedStickyMoves(84532, [37n])
    await indexedStickyCreateTx(84532, 37n)
    await indexedStickyEvents({ chainId: 84532, projectId: 37n })
    await indexedStickyPositions({ chainId: 84532, projectId: 37n })
    await indexedStickySettings(84532, 37n)

    expect(new Set(sent.map(({ url }) => url))).toEqual(new Set(['/api/bendystraw/testnet/query']))
    expect(new Set(sent.map(({ operation }) => operation)).size).toBe(7)
  })
})
