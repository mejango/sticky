// @vitest-environment node

import { createHash } from 'node:crypto'
import { getEventListeners } from 'node:events'
import { BendystrawTimeoutError } from '@bananapus/nana-sdk-core'
import type { Address } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import registry from '@/lib/bendystraw-operation-registry.json'
import { stickyDeployment } from '@/lib/sticky-addresses'
import {
  indexedBlocks,
  indexedStickyCreateTx,
  indexedStickyEvents,
  indexedStickyFees,
  indexedStickyFunding,
  indexedStickyMoves,
  indexedStickyPositions,
  indexedStickyProjects,
  indexedStickySettings,
} from '@/lib/sticky-indexed'

// Bendystraw is faked at its HTTP edge. The transport, the documents and the operation registry are the real
// ones, so a document the registry lacks, or a variable its contract refuses, fails here as it would against
// the relay.

const TESTNET = 'https://testnet.bendystraw.xyz/graphql'
const MAINNET = 'https://bendystraw.up.railway.app/graphql'
const DEPLOYER = stickyDeployment(84532)!.deployer.toLowerCase()
const HOLDER = `0x${'a'.repeat(40)}`
const OTHER = `0x${'b'.repeat(40)}`
const CAROL = `0x${'c'.repeat(40)}`
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}`

type Variables = Record<string, unknown>
type Answer = { data: unknown } | { errors: { message: string }[] } | Response
type Sent = {
  url: string
  operation: string
  query: string
  variables: Variables
  signal: AbortSignal | null | undefined
}

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** How fetch treats a signal: a request whose signal has aborted, or aborts, rejects with the signal's reason. */
function unlessAborted<T>(work: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return work
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    work.then(resolve, reject)
  })
}

/** Answers each document by name, as Bendystraw would, and lists what it was asked. A request for a document
 * the registry does not hold gets the relay's 400. */
function indexer(handlers: Record<string, (variables: Variables) => Answer | Promise<Answer>>): Sent[] {
  const sent: Sent[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) =>
      unlessAborted(
        (async () => {
          const body = JSON.parse(String(init.body)) as { query?: string; operation?: string; variables: Variables }
          const query = body.query ?? (registry as Record<string, string>)[body.operation ?? '']
          if (!query) return reply({ error: 'unknown or invalid operation' }, 400)
          const operation = /query (\w+)/.exec(query)![1]
          sent.push({ url, operation, query, variables: body.variables, signal: init.signal })
          const handler = handlers[operation]
          if (!handler) return reply({ errors: [{ message: `unexpected ${operation}` }] })
          const answer = await handler(body.variables)
          return answer instanceof Response ? answer : reply(answer)
        })(),
        init.signal,
      ),
    ),
  )
  return sent
}

/** An indexer that never answers, and cancels a request whose signal aborts. */
const hang = () => {
  const fetcher = vi.fn((_url: string, init: RequestInit) =>
    unlessAborted(new Promise<Response>(() => {}), init.signal),
  )
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

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

/** The answer to a list document that also selects `_meta { status }`, with the status of `chains`. */
const listed = (
  field: string,
  items: unknown[],
  next?: string,
  chains: [string, number, number][] = TESTNET_CHAINS,
) => ({ data: { _meta: { status: status(chains) }, [field]: page(items, next) } })

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
/** The indexing status each pays or cash-outs answer carries: Base Sepolia is indexed through block 500. */
const META = { status: status(TESTNET_CHAINS) }

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

/** A fee the terminal processed for a project (ProcessFee), as processFeeEvents lists it. */
const feeRow = (projectId: number, extra: Variables = {}) => ({
  chainId: 84532,
  projectId,
  version: 6,
  txHash: tx(3),
  logIndex: 3,
  timestamp: 40,
  amount: '25',
  wasHeld: false,
  ...extra,
})
/** An addition to a project's balance (AddToBalance), as addToBalanceEvents lists it. */
const additionRow = (projectId: number, extra: Variables = {}) => ({
  chainId: 84532,
  projectId,
  version: 6,
  txHash: tx(4),
  logIndex: 4,
  timestamp: 35,
  amount: '70',
  returnedFees: '5',
  ...extra,
})

/** A Sticky token, as a page has it from the chain (checksummed), and as Bendystraw stores it. */
const STICKY_TOKEN = '0xEe528A64F4AfE524Ba220C7cF0EA0C0278d0F232'
const STICKY_HOOK = STICKY_TOKEN.toLowerCase()
const REWARD_TOKEN = `0x${'d'.repeat(40)}`
/** A funding of a Sticky token's holders' rewards (the distributor's Fund), as stickyFundEvents lists it. */
const fundRow = (extra: Variables = {}) => ({
  chainId: 84532,
  version: 6,
  txHash: tx(5),
  logIndex: 5,
  blockNumber: '400',
  hook: STICKY_HOOK,
  groupId: '0',
  token: REWARD_TOKEN,
  amount: '1000',
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
  ['indexedStickyFees', signal => indexedStickyFees(84532, 37n, signal)],
  ['indexedStickyFunding', signal => indexedStickyFunding(84532, STICKY_TOKEN, signal)],
  ['indexedStickyCreateTx', signal => indexedStickyCreateTx(84532, 37n, signal)],
  ['indexedStickyEvents', signal => indexedStickyEvents({ chainId: 84532, projectId: 37n }, signal)],
  ['indexedStickyPositions', signal => indexedStickyPositions({ chainId: 84532, projectId: 37n }, signal)],
  ['indexedStickySettings', signal => indexedStickySettings(84532, 37n, signal)],
]

/** The readers of the Sticky tables peripheralist/bendystraw#36 and #38 add that read one document, with the
 * document each runs and the root field it queries. */
const newReaders: [string, string, string, () => Promise<unknown>][] = [
  ['indexedStickyEvents', 'StickyEvents', 'stickyEvents', () => indexedStickyEvents({ chainId: 84532, projectId: 37n })],
  ['indexedStickyPositions', 'StickyPositions', 'stickyPositions', () => indexedStickyPositions({ chainId: 84532, projectId: 37n })],
  ['indexedStickySettings', 'StickySettings', 'stickySettingEvents', () => indexedStickySettings(84532, 37n)],
  ['indexedStickyFunding', 'StickyFunding', 'stickyFundEvents', () => indexedStickyFunding(84532, STICKY_TOKEN)],
]

describe('the network index: projects and indexed blocks', () => {
  it('lists the Sticky projects of the chains it has a status for, with the block each of those chains is indexed through', async () => {
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
      blocks: new Map([
        [84532, 500n],
        [11155420, 900n],
        [11155111, 7n],
      ]),
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

    expect(await indexedStickyProjects('mainnet')).toEqual({
      blocks: new Map([
        [1, 26_061_894n],
        [42161, 509_092_274n],
      ]),
      projects: [],
    })
    expect(sent.every(({ url }) => url === MAINNET)).toBe(true)
  })

  it('lists what a partly covered index has, with no block and no projects for the chain it does not cover', async () => {
    // Ethereum is covered and Arbitrum is not, so a caller reads Arbitrum from its deployment block. A row of a
    // chain without a status is not a Sticky project the index vouches for.
    const sent = indexer({
      StickyIndex: () => indexOf([['ethereum', 1, 26_061_894]], [project(1, 5), project(42161, 9)]),
    })

    const index = await indexedStickyProjects('mainnet')

    expect(index).toEqual({ blocks: new Map([[1, 26_061_894n]]), projects: [{ chainId: 1, projectId: 5n }] })
    expect(index.blocks.has(42161)).toBe(false)
    expect(sent).toHaveLength(1)
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
      blocks: new Map([[84532, 500n]]),
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
          _meta: META,
          payEvents: page([
            pay(37),
            pay(99),
            pay(37, { version: 4 }),
            pay(37, { chainId: 10 }),
            pay(37, { timestamp: 10, logIndex: 0, txHash: tx(9) }),
          ]),
        },
      }),
      StickyCashOuts: () => ({ data: { _meta: META, cashOutTokensEvents: page([cashOut(37)]) } }),
    })

    const { rows: moves, blocks } = await indexedStickyMoves(84532, [37n])

    expect(blocks).toEqual(new Map([[84532, 500n]]))
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

  it('says the block the moves are as of: the older of the two lists\' blocks, each from its own answer', async () => {
    indexer({
      StickyPays: () => listed('payEvents', [pay(37)], undefined, [['baseSepolia', 84532, 500]]),
      StickyCashOuts: () => listed('cashOutTokensEvents', [cashOut(37)], undefined, [['baseSepolia', 84532, 480]]),
    })
    const { rows, blocks } = await indexedStickyMoves(84532, [37n])
    expect(blocks).toEqual(new Map([[84532, 480n]]))
    expect(rows).toHaveLength(2)
  })

  it('leaves out the moves of a chain either answer has no status for, since nothing says what they are as of', async () => {
    const elsewhere: [string, number, number][] = [['optimismSepolia', 11155420, 900]]
    indexer({
      StickyPays: () => listed('payEvents', [pay(37)], undefined, elsewhere),
      StickyCashOuts: () => listed('cashOutTokensEvents', [cashOut(37)]),
    })
    expect(await indexedStickyMoves(84532, [37n])).toEqual({ rows: [], blocks: new Map() })

    indexer({
      StickyPays: () => listed('payEvents', [pay(37)]),
      StickyCashOuts: () => listed('cashOutTokensEvents', [cashOut(37)], undefined, elsewhere),
    })
    expect(await indexedStickyMoves(84532, [37n])).toEqual({ rows: [], blocks: new Map() })
  })

  it('rejects an answer with no usable indexing status, never answering with moves and no block', async () => {
    for (const meta of [null, { status: null }, { status: 'up' }, { status: [] }]) {
      indexer({
        StickyPays: () => ({ data: { _meta: META, payEvents: page([pay(37)]) } }),
        StickyCashOuts: () => ({ data: { _meta: meta, cashOutTokensEvents: page([]) } }),
      })
      await expect(indexedStickyMoves(84532, [37n])).rejects.toThrow('no indexing status')
    }
  })

  it('lowercases addresses and reads amounts past 2^53 exactly', async () => {
    indexer({
      StickyPays: () => ({
        data: {
          _meta: META,
          payEvents: page([
            pay(37, { caller: OTHER.toUpperCase().replace('0X', '0x'), beneficiary: HOLDER.toUpperCase().replace('0X', '0x'), amount: '123456789012345678901', newlyIssuedTokenCount: '9007199254740993' }),
          ]),
        },
      }),
      StickyCashOuts: () => ({ data: { _meta: META, cashOutTokensEvents: page([]) } }),
    })

    expect((await indexedStickyMoves(84532, [37n])).rows).toEqual([
      expect.objectContaining({ payer: OTHER, holder: HOLDER, amount: 123456789012345678901n, tokens: 9007199254740993n }),
    ])
  })

  it('reads an amount that came as a JSON number, and rejects one that is not a whole number', async () => {
    indexer({
      StickyPays: () => ({ data: { _meta: META, payEvents: page([pay(37, { amount: 5, newlyIssuedTokenCount: 50 })]) } }),
      StickyCashOuts: () => ({ data: { _meta: META, cashOutTokensEvents: page([]) } }),
    })
    expect((await indexedStickyMoves(84532, [37n])).rows).toEqual([expect.objectContaining({ amount: 5n, tokens: 50n })])

    indexer({
      StickyPays: () => ({ data: { _meta: META, payEvents: page([pay(37, { amount: 1.5 })]) } }),
      StickyCashOuts: () => ({ data: { _meta: META, cashOutTokensEvents: page([]) } }),
    })
    await expect(indexedStickyMoves(84532, [37n])).rejects.toThrow('incomplete Sticky event')
  })

  it('asks Bendystraw nothing, and answers no moves, for no projects', async () => {
    const sent = indexer({})

    expect(await indexedStickyMoves(84532, [])).toEqual({ rows: [], blocks: new Map() })
    expect(sent).toHaveLength(0)
  })

  it('names each project once', async () => {
    const sent = indexer({
      StickyPays: () => ({ data: { _meta: META, payEvents: page([]) } }),
      StickyCashOuts: () => ({ data: { _meta: META, cashOutTokensEvents: page([]) } }),
    })

    await indexedStickyMoves(84532, [37n, 38n, 37n])

    expect((sent[0].variables.where as { projectId_in: number[] }).projectId_in).toEqual([37, 38])
  })

  describe('since a time', () => {
    const SINCE = 1_700_000_000

    it('asks for the moves at or after it in the filter of both lists, and for no time otherwise', async () => {
      const sent = indexer({
        StickyPays: () => ({ data: { _meta: META, payEvents: page([]) } }),
        StickyCashOuts: () => ({ data: { _meta: META, cashOutTokensEvents: page([]) } }),
      })

      await indexedStickyMoves(84532, [37n], undefined, SINCE)
      await indexedStickyMoves(84532, [37n], undefined, 0)
      await indexedStickyMoves(84532, [37n])

      const where = (operation: string) =>
        sent.filter(request => request.operation === operation).map(({ variables }) => variables.where)
      const filter = { chainId: 84532, version: 6, projectId_in: [37] }
      const asked = [{ ...filter, timestamp_gte: SINCE }, { ...filter, timestamp_gte: 0 }, filter]
      expect(where('StickyPays')).toEqual(asked)
      expect(where('StickyCashOuts')).toEqual(asked)
    })

    it('changes no document: each is still the text its ID is the SHA-256 of', async () => {
      const sent = indexer({
        StickyPays: () => ({ data: { _meta: META, payEvents: page([]) } }),
        StickyCashOuts: () => ({ data: { _meta: META, cashOutTokensEvents: page([]) } }),
      })

      await indexedStickyMoves(84532, [37n], undefined, SINCE)

      const idOf = (query: string) => createHash('sha256').update(query, 'utf8').digest('hex')
      expect(sent.map(({ operation, query }) => [operation, idOf(query)]).sort()).toEqual([
        ['StickyCashOuts', '8497b97a5f08df0cb2f44ce7a55c255e5c67757bb144ff23dd8a606d6ac068fd'],
        ['StickyPays', '010ca8477471daaae12c1926d0ddd3b7023518dd061d0cfa23dd9455ea1c27f8'],
      ])
      expect(sent.every(({ query }) => !query.includes('timestamp_gte'))).toBe(true)
    })

    it('drops moves from before it, as an indexer that ignored the filter would send them, and keeps the one at it', async () => {
      indexer({
        StickyPays: () => ({
          data: {
            _meta: META,
            payEvents: page([
              pay(37, { timestamp: SINCE - 1, txHash: tx(1) }),
              pay(37, { timestamp: SINCE, txHash: tx(3) }),
              pay(37, { timestamp: SINCE + 5, txHash: tx(4) }),
            ]),
          },
        }),
        StickyCashOuts: () => ({
          data: {
            _meta: META,
            cashOutTokensEvents: page([
              cashOut(37, { timestamp: SINCE - 5 }),
              cashOut(37, { timestamp: SINCE + 2, txHash: tx(5) }),
            ]),
          },
        }),
      })

      const { rows: moves } = await indexedStickyMoves(84532, [37n], undefined, SINCE)

      expect(moves.map(({ kind, timestamp }) => [kind, timestamp])).toEqual([
        ['stick', SINCE],
        ['unstick', SINCE + 2],
        ['stick', SINCE + 5],
      ])
    })

    it('reads a time that is not a whole, non-negative number of seconds as a mistake, and asks nothing', async () => {
      const sent = indexer({})

      for (const since of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
        await expect(indexedStickyMoves(84532, [37n], undefined, since)).rejects.toThrow(RangeError)
      }
      expect(sent).toHaveLength(0)
    })

    it('reaches the indexer through the relay with the filter, which the operation contract accepts', async () => {
      vi.stubGlobal('window', {})
      const sent = indexer({
        StickyPays: () => ({ data: { _meta: META, payEvents: page([pay(37, { timestamp: SINCE + 1 })]) } }),
        StickyCashOuts: () => ({ data: { _meta: META, cashOutTokensEvents: page([]) } }),
      })

      const { rows: moves } = await indexedStickyMoves(84532, [37n], undefined, SINCE)

      expect(moves).toHaveLength(1)
      expect(new Set(sent.map(({ url }) => url))).toEqual(new Set(['/api/bendystraw/testnet/query']))
      const sentSince = sent.map(({ variables }) => (variables.where as { timestamp_gte: number }).timestamp_gte)
      expect(sentSince).toEqual([SINCE, SINCE])
    })
  })

  it('follows the cursors of both lists', async () => {
    const sent = indexer({
      StickyPays: ({ after }) =>
        after === null
          ? { data: { _meta: META, payEvents: page([pay(37, { txHash: tx(1) })], 'p1') } }
          : { data: { _meta: META, payEvents: page([pay(37, { txHash: tx(3), timestamp: 40 })]) } },
      StickyCashOuts: () => ({ data: { _meta: META, cashOutTokensEvents: page([cashOut(37)]) } }),
    })

    const { rows: moves } = await indexedStickyMoves(84532, [37n])

    expect(moves.map(({ txHash }) => txHash)).toEqual([tx(1), tx(2), tx(3)])
    expect(sent.filter(({ operation }) => operation === 'StickyPays').map(({ variables }) => variables.after)).toEqual([null, 'p1'])
  })

  it('stops at 20 pages of either list with an error', async () => {
    let next = 0
    indexer({
      StickyPays: () => ({ data: { _meta: META, payEvents: page([pay(37)], `p${(next += 1)}`) } }),
      StickyCashOuts: () => ({ data: { _meta: META, cashOutTokensEvents: page([]) } }),
    })
    await expect(indexedStickyMoves(84532, [37n])).rejects.toThrow('more payEvents than one page load reads')

    next = 0
    indexer({
      StickyPays: () => ({ data: { _meta: META, payEvents: page([]) } }),
      StickyCashOuts: () => ({ data: { _meta: META, cashOutTokensEvents: page([cashOut(37)], `c${(next += 1)}`) } }),
    })
    await expect(indexedStickyMoves(84532, [37n])).rejects.toThrow('more cashOutTokensEvents than one page load reads')
  })

  it('rejects when either list fails, rather than answering with half the moves', async () => {
    indexer({
      StickyPays: () => ({ errors: [{ message: 'timeout' }] }),
      StickyCashOuts: () => ({ data: { _meta: META, cashOutTokensEvents: page([]) } }),
    })
    await expect(indexedStickyMoves(84532, [37n])).rejects.toThrow('timeout')

    indexer({
      StickyPays: () => ({ data: { _meta: META, payEvents: page([pay(37)]) } }),
      StickyCashOuts: () => ({ errors: [{ message: 'database is down' }] }),
    })
    await expect(indexedStickyMoves(84532, [37n])).rejects.toThrow('database is down')
  })

  it('stops paging the other list, and cancels its request, once one fails', async () => {
    let asked = 0
    const sent = indexer({
      StickyPays: () => ({ errors: [{ message: 'timeout' }] }),
      // Slower than the failure, so its first page arrives after the read has already been given up.
      StickyCashOuts: async () => {
        asked += 1
        await new Promise(resolve => setTimeout(resolve, 10))
        return { data: { _meta: META, cashOutTokensEvents: page([cashOut(37)], `c${asked}`) } }
      },
    })

    await expect(indexedStickyMoves(84532, [37n])).rejects.toThrow('timeout')
    await new Promise(resolve => setTimeout(resolve, 40))

    expect(asked).toBe(1)
    expect(sent.find(({ operation }) => operation === 'StickyCashOuts')?.signal?.aborted).toBe(true)
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
      StickyPays: () => ({ data: { _meta: META, payEvents: page(kind === 'pay' ? [pay(37, extra)] : []) } }),
      StickyCashOuts: () => ({
        data: { _meta: META, cashOutTokensEvents: page(kind === 'cashOut' ? [cashOut(37, extra)] : []) },
      }),
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

describe('fees and additions to a balance', () => {
  it('reads a project\'s processed fees and additions on one chain at version 6, drops rows of other projects, chains and versions, and orders them by time', async () => {
    const sent = indexer({
      // Bendystraw has ignored filters before: a row outside the request must not reach the chart.
      StickyFees: () =>
        listed('processFeeEvents', [
          feeRow(37),
          feeRow(99),
          feeRow(37, { version: 5 }),
          feeRow(37, { chainId: 10 }),
          feeRow(37, { wasHeld: true, timestamp: 10, logIndex: 0, txHash: tx(9) }),
        ]),
      StickyAdditions: () => listed('addToBalanceEvents', [additionRow(37), additionRow(38)]),
    })

    const { rows, blocks } = await indexedStickyFees(84532, 37n)

    expect(blocks).toEqual(new Map([[84532, 500n]]))
    expect(sent.map(({ operation, variables }) => [operation, variables]).sort()).toEqual([
      ['StickyAdditions', { where: { chainId: 84532, projectId: 37, version: 6 }, after: null }],
      ['StickyFees', { where: { chainId: 84532, projectId: 37, version: 6 }, after: null }],
    ])
    expect(sent.every(({ url }) => url === TESTNET)).toBe(true)
    expect(rows).toEqual([
      { kind: 'fee', chainId: 84532, projectId: 37n, txHash: tx(9), logIndex: 0, timestamp: 10, amount: 25n, wasHeld: true },
      { kind: 'addition', chainId: 84532, projectId: 37n, txHash: tx(4), logIndex: 4, timestamp: 35, amount: 70n, returnedFees: 5n },
      { kind: 'fee', chainId: 84532, projectId: 37n, txHash: tx(3), logIndex: 3, timestamp: 40, amount: 25n, wasHeld: false },
    ])
  })

  it('says the block they are as of: the older of the two lists\' blocks, each from its own answer', async () => {
    indexer({
      StickyFees: () => listed('processFeeEvents', [feeRow(37)], undefined, [['baseSepolia', 84532, 470]]),
      StickyAdditions: () => listed('addToBalanceEvents', [additionRow(37)], undefined, [['baseSepolia', 84532, 500]]),
    })
    const { rows, blocks } = await indexedStickyFees(84532, 37n)
    expect(blocks).toEqual(new Map([[84532, 470n]]))
    expect(rows).toHaveLength(2)
  })

  it('leaves out the fees of a chain either answer has no status for, since nothing says what they are as of', async () => {
    const elsewhere: [string, number, number][] = [['optimismSepolia', 11155420, 900]]
    indexer({
      StickyFees: () => listed('processFeeEvents', [feeRow(37)], undefined, elsewhere),
      StickyAdditions: () => listed('addToBalanceEvents', [additionRow(37)]),
    })
    expect(await indexedStickyFees(84532, 37n)).toEqual({ rows: [], blocks: new Map() })

    indexer({
      StickyFees: () => listed('processFeeEvents', [feeRow(37)]),
      StickyAdditions: () => listed('addToBalanceEvents', [additionRow(37)], undefined, elsewhere),
    })
    expect(await indexedStickyFees(84532, 37n)).toEqual({ rows: [], blocks: new Map() })
  })

  it('rejects an answer with no usable indexing status, never answering with fees and no block', async () => {
    for (const meta of [null, { status: null }, { status: 'up' }, { status: [] }]) {
      indexer({
        StickyFees: () => ({ data: { _meta: META, processFeeEvents: page([feeRow(37)]) } }),
        StickyAdditions: () => ({ data: { _meta: meta, addToBalanceEvents: page([]) } }),
      })
      await expect(indexedStickyFees(84532, 37n)).rejects.toThrow('no indexing status')
    }
  })

  it('reads amounts past 2^53 exactly, as Bendystraw writes them', async () => {
    indexer({
      StickyFees: () => listed('processFeeEvents', [feeRow(37, { amount: '123456789012345678901' })]),
      StickyAdditions: () =>
        listed('addToBalanceEvents', [additionRow(37, { amount: '9007199254740993', returnedFees: '18014398509481985' })]),
    })

    expect((await indexedStickyFees(84532, 37n)).rows).toEqual([
      expect.objectContaining({ kind: 'addition', amount: 9007199254740993n, returnedFees: 18014398509481985n }),
      expect.objectContaining({ kind: 'fee', amount: 123456789012345678901n }),
    ])
  })

  it('follows the cursors of both lists', async () => {
    const sent = indexer({
      StickyFees: ({ after }) =>
        after === null
          ? listed('processFeeEvents', [feeRow(37, { txHash: tx(1), timestamp: 1 })], 'f1')
          : listed('processFeeEvents', [feeRow(37, { txHash: tx(5), timestamp: 50 })]),
      StickyAdditions: ({ after }) =>
        after === null
          ? listed('addToBalanceEvents', [additionRow(37, { txHash: tx(2), timestamp: 2 })], 'a1')
          : listed('addToBalanceEvents', [additionRow(37, { txHash: tx(6), timestamp: 60 })]),
    })

    const { rows } = await indexedStickyFees(84532, 37n)

    expect(rows.map(({ txHash }) => txHash)).toEqual([tx(1), tx(2), tx(5), tx(6)])
    const cursors = (operation: string) =>
      sent.filter(request => request.operation === operation).map(({ variables }) => variables.after)
    expect(cursors('StickyFees')).toEqual([null, 'f1'])
    expect(cursors('StickyAdditions')).toEqual([null, 'a1'])
  })

  it('stops at 20 pages of either list with an error', async () => {
    let next = 0
    indexer({
      StickyFees: () => listed('processFeeEvents', [feeRow(37)], `f${(next += 1)}`),
      StickyAdditions: () => listed('addToBalanceEvents', []),
    })
    await expect(indexedStickyFees(84532, 37n)).rejects.toThrow('more processFeeEvents than one page load reads')

    next = 0
    indexer({
      StickyFees: () => listed('processFeeEvents', []),
      StickyAdditions: () => listed('addToBalanceEvents', [additionRow(37)], `a${(next += 1)}`),
    })
    await expect(indexedStickyFees(84532, 37n)).rejects.toThrow('more addToBalanceEvents than one page load reads')
  })

  it('rejects when either list fails, rather than answering with half of them', async () => {
    indexer({
      StickyFees: () => ({ errors: [{ message: 'timeout' }] }),
      StickyAdditions: () => listed('addToBalanceEvents', [additionRow(37)]),
    })
    await expect(indexedStickyFees(84532, 37n)).rejects.toThrow('timeout')

    indexer({
      StickyFees: () => listed('processFeeEvents', [feeRow(37)]),
      StickyAdditions: () => ({ errors: [{ message: 'Cannot query field "addToBalanceEvents" on type "Query".' }] }),
    })
    await expect(indexedStickyFees(84532, 37n)).rejects.toThrow('Cannot query field')
  })

  it.each([
    ['a fee with no amount', 'fee', { amount: null }],
    ['a fee with a fractional amount', 'fee', { amount: '1.5' }],
    ['a fee that does not say whether it was held', 'fee', { wasHeld: 'no' }],
    ['a fee with no transaction hash', 'fee', { txHash: '0x12' }],
    ['a fee with no timestamp', 'fee', { timestamp: null }],
    ['an addition with no amount', 'addition', { amount: '-1' }],
    ['an addition with no returned fees', 'addition', { returnedFees: null }],
    ['an addition with no log index', 'addition', { logIndex: '4' }],
  ])('rejects the whole read for %s', async (_name, kind, extra) => {
    indexer({
      StickyFees: () => listed('processFeeEvents', kind === 'fee' ? [feeRow(37, extra)] : []),
      StickyAdditions: () => listed('addToBalanceEvents', kind === 'addition' ? [additionRow(37, extra)] : []),
    })

    await expect(indexedStickyFees(84532, 37n)).rejects.toThrow(/Bendystraw returned an incomplete (fee|addition)/)
  })

  it('does not read a project ID that is not one', async () => {
    const sent = indexer({})

    await expect(indexedStickyFees(84532, 0n)).rejects.toThrow(RangeError)
    await expect(indexedStickyFees(84532, 2n ** 60n)).rejects.toThrow(RangeError)
    expect(sent).toHaveLength(0)
  })
})

describe('airdrop funding', () => {
  it('reads the fundings of one Sticky token on one chain at version 6, in the order of the chain, and drops rows of other tokens, chains and versions', async () => {
    const sent = indexer({
      // Bendystraw has ignored filters before: a funding of another token must not become one of this token's pots.
      StickyFunding: () =>
        listed('stickyFundEvents', [
          fundRow({ blockNumber: '410', logIndex: 2, txHash: tx(6) }),
          fundRow({ hook: `0x${'9'.repeat(40)}` }),
          fundRow({ chainId: 10 }),
          fundRow({ version: 5 }),
          fundRow({ groupId: '4002', token: REWARD_TOKEN.toUpperCase().replace('0X', '0x') }),
          fundRow({ blockNumber: '410', logIndex: 1, txHash: tx(7), amount: '7' }),
        ]),
    })

    const { rows, blocks } = await indexedStickyFunding(84532, STICKY_TOKEN as Address)

    expect(blocks).toEqual(new Map([[84532, 500n]]))
    expect(sent.map(({ operation, variables }) => [operation, variables])).toEqual([
      ['StickyFunding', { where: { chainId: 84532, hook: STICKY_HOOK, version: 6 }, after: null }],
    ])
    expect(sent[0].url).toBe(TESTNET)
    const at = { chainId: 84532, hook: STICKY_HOOK, token: REWARD_TOKEN }
    expect(rows).toEqual([
      { ...at, txHash: tx(5), logIndex: 5, blockNumber: 400n, groupId: 4002n, amount: 1000n },
      { ...at, txHash: tx(7), logIndex: 1, blockNumber: 410n, groupId: 0n, amount: 7n },
      { ...at, txHash: tx(6), logIndex: 2, blockNumber: 410n, groupId: 0n, amount: 1000n },
    ])
  })

  it('has no block, and no fundings, for a chain the index has no status for', async () => {
    indexer({ StickyFunding: () => listed('stickyFundEvents', [fundRow()], undefined, [['optimismSepolia', 11155420, 900]]) })

    expect(await indexedStickyFunding(84532, STICKY_TOKEN as Address)).toEqual({ rows: [], blocks: new Map() })
  })

  it('reads group IDs and amounts past 2^53 exactly', async () => {
    indexer({
      StickyFunding: () =>
        listed('stickyFundEvents', [fundRow({ groupId: '520000', amount: '123456789012345678901234567890', blockNumber: '9007199254740993' })]),
    })

    expect((await indexedStickyFunding(84532, STICKY_TOKEN as Address)).rows).toEqual([
      expect.objectContaining({ groupId: 520_000n, amount: 123456789012345678901234567890n, blockNumber: 9007199254740993n }),
    ])
  })

  it('follows the cursor, and takes the block from the first page', async () => {
    const sent = indexer({
      StickyFunding: ({ after }) =>
        after === null
          ? listed('stickyFundEvents', [fundRow({ txHash: tx(1), blockNumber: '1' })], 'f1', [['baseSepolia', 84532, 450]])
          : listed('stickyFundEvents', [fundRow({ txHash: tx(2), blockNumber: '2' })], undefined, [['baseSepolia', 84532, 460]]),
    })

    const { rows, blocks } = await indexedStickyFunding(84532, STICKY_TOKEN as Address)

    expect(rows.map(({ txHash }) => txHash)).toEqual([tx(1), tx(2)])
    expect(blocks).toEqual(new Map([[84532, 450n]]))
    expect(sent.map(({ variables }) => variables.after)).toEqual([null, 'f1'])
  })

  it('stops at 20 pages with an error', async () => {
    let next = 0
    indexer({ StickyFunding: () => listed('stickyFundEvents', [fundRow()], `f${(next += 1)}`) })

    await expect(indexedStickyFunding(84532, STICKY_TOKEN as Address)).rejects.toThrow(
      'more stickyFundEvents than one page load reads',
    )
  })

  it.each([
    ['no block number', { blockNumber: null }],
    ['a block number that is not a whole number', { blockNumber: '4.5' }],
    ['no group', { groupId: null }],
    ['a reward token that is not an address', { token: 'ETH' }],
    ['a fractional amount', { amount: '0.5' }],
    ['no transaction hash', { txHash: null }],
    ['no log index', { logIndex: -1 }],
  ])('rejects the whole read for a funding with %s', async (_name, extra) => {
    indexer({ StickyFunding: () => listed('stickyFundEvents', [fundRow(extra)]) })

    await expect(indexedStickyFunding(84532, STICKY_TOKEN as Address)).rejects.toThrow(
      'Bendystraw returned an incomplete Sticky airdrop.',
    )
  })

  it('refuses a Sticky token that is not an address, and asks nothing', async () => {
    const sent = indexer({})

    await expect(indexedStickyFunding(84532, 'sticky' as Address)).rejects.toThrow(TypeError)
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
      StickyEvents: () =>
        listed('stickyEvents', [
          streakEnded({ txHash: tx(4), logIndex: 3, timestamp: 300 }),
          staked({ txHash: tx(1), logIndex: 5, timestamp: 100, payer: OTHER.toUpperCase().replace('0X', '0x') }),
          unstaked({ txHash: tx(3), logIndex: 2, timestamp: 200 }),
          streakStarted({ txHash: tx(1), logIndex: 4, timestamp: 100 }),
        ]),
    })

    const { rows } = await indexedStickyEvents({ chainId: 84532, projectId: 37n })

    expect(sent[0].url).toBe(TESTNET)
    expect(sent[0].variables).toEqual({
      where: { version: 6, chainId: 84532, projectId: 37 },
      orderDirection: 'asc',
      limit: 1000,
      after: null,
    })
    const place = { chainId: 84532, projectId: 37n, holder: HOLDER }
    expect(rows).toEqual([
      { ...place, type: 'streakStarted', txHash: tx(1), logIndex: 4, timestamp: 100 },
      { ...place, type: 'staked', txHash: tx(1), logIndex: 5, timestamp: 100, payer: OTHER, count: 10n, stakedBalance: 25n },
      { ...place, type: 'unstaked', txHash: tx(3), logIndex: 2, timestamp: 200, count: 4n, stakedBalance: 21n },
      { ...place, type: 'streakEnded', txHash: tx(4), logIndex: 3, timestamp: 300, duration: 86_400 },
    ])
  })

  it('returns, with the events, the block the asked-about chains are indexed through, from the same answer', async () => {
    const sent = indexer({ StickyEvents: () => listed('stickyEvents', [staked()]) })

    const { rows, blocks } = await indexedStickyEvents({ chainId: 84532, projectId: 37n })

    expect(sent).toHaveLength(1)
    expect(rows).toHaveLength(1)
    // Optimism Sepolia has a status too, but it was not asked about.
    expect(blocks).toEqual(new Map([[84532, 500n]]))
  })

  it('takes a block only from a status entry that is a chain with a usable block', async () => {
    indexer({
      StickyEvents: () => ({
        data: {
          _meta: {
            status: {
              nothing: null,
              text: 'up',
              noBlock: { id: 84532 },
              negative: { id: 84532, block: { number: -1, timestamp: 1 } },
              textual: { id: 84532, block: { number: '500', timestamp: 1 } },
              usable: { id: 84532, block: { number: 500, timestamp: 1 } },
            },
          },
          stickyEvents: page([staked()]),
        },
      }),
    })

    expect((await indexedStickyEvents({ chainId: 84532, projectId: 37n })).blocks).toEqual(new Map([[84532, 500n]]))
  })

  it('reads one holder\'s events on a chain', async () => {
    const sent = indexer({ StickyEvents: () => listed('stickyEvents', [staked()]) })

    await indexedStickyEvents({ chainId: 84532, holder: HOLDER.toUpperCase().replace('0X', '0x') as `0x${string}` })

    expect(sent[0].variables.where).toEqual({ version: 6, chainId: 84532, holder: HOLDER })
  })

  it('reads the newest N events of several chains with one request, filtering on chainId_in only, and hands them over oldest first', async () => {
    const sent = indexer({
      // Newest first, as the request asked; more exist than were asked for.
      StickyEvents: () =>
        listed(
          'stickyEvents',
          [
            staked({ chainId: 11155420, txHash: tx(3), timestamp: 300 }),
            unstaked({ chainId: 84532, txHash: tx(2), timestamp: 200 }),
          ],
          'more',
        ),
    })

    const { rows, blocks } = await indexedStickyEvents({ chainIds: [84532, 11155420], newest: 40 })

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
    expect(rows.map(({ txHash }) => txHash)).toEqual([tx(2), tx(3)])
    expect(blocks).toEqual(new Map([[84532, 500n], [11155420, 900n]]))
  })

  it.each([0, -1, 1.5, 1001, Number.NaN])('refuses to ask for the newest %s events', async newest => {
    const sent = indexer({})

    await expect(indexedStickyEvents({ chainId: 84532, newest })).rejects.toThrow(RangeError)
    expect(sent).toHaveLength(0)
  })

  it('reads all of the events of several chains when it is not after the newest, and takes the blocks from the first page', async () => {
    const sent = indexer({
      StickyEvents: ({ after }) =>
        after === null
          ? listed('stickyEvents', [staked({ timestamp: 100 })], 'e1', [['baseSepolia', 84532, 500], ['optimismSepolia', 11155420, 900]])
          : listed('stickyEvents', [unstaked({ timestamp: 200 })], undefined, [['baseSepolia', 84532, 640], ['optimismSepolia', 11155420, 990]]),
    })

    const { rows, blocks } = await indexedStickyEvents({ chainIds: [84532, 11155420] })

    expect(rows.map(({ type }) => type)).toEqual(['staked', 'unstaked'])
    expect(sent.map(({ variables }) => [variables.limit, variables.after])).toEqual([
      [1000, null],
      [1000, 'e1'],
    ])
    expect(blocks).toEqual(new Map([[84532, 500n], [11155420, 900n]]))
  })

  it('leaves out a chain the index has no status for, and its rows with it', async () => {
    indexer({
      StickyEvents: () =>
        listed(
          'stickyEvents',
          [staked({ txHash: tx(1) }), staked({ chainId: 11155420, txHash: tx(2) })],
          undefined,
          [['baseSepolia', 84532, 500]],
        ),
    })

    expect(await indexedStickyEvents({ chainIds: [84532, 11155420] })).toEqual({
      rows: [expect.objectContaining({ chainId: 84532, txHash: tx(1) })],
      blocks: new Map([[84532, 500n]]),
    })

    indexer({ StickyEvents: () => listed('stickyEvents', [staked()], undefined, [['elsewhere', 999, 1]]) })

    expect(await indexedStickyEvents({ chainId: 84532, projectId: 37n })).toEqual({ rows: [], blocks: new Map() })
  })

  it('answers no events, and asks nothing, for no chains', async () => {
    const sent = indexer({})

    expect(await indexedStickyEvents({ chainIds: [] })).toEqual({ rows: [], blocks: new Map() })
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
      StickyEvents: () =>
        listed('stickyEvents', [
          staked({ txHash: tx(1) }),
          staked({ txHash: tx(2), projectId: 99 }),
          staked({ txHash: tx(3), chainId: 10 }),
          staked({ txHash: tx(4), version: 5 }),
          staked({ txHash: tx(5), holder: OTHER }),
        ]),
    })

    const { rows } = await indexedStickyEvents({ chainId: 84532, projectId: 37n, holder: HOLDER as `0x${string}` })

    expect(rows.map(({ txHash }) => txHash)).toEqual([tx(1)])
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
    indexer({ StickyEvents: () => listed('stickyEvents', [staked(), row]) })

    await expect(indexedStickyEvents({ chainId: 84532, projectId: 37n })).rejects.toThrow('incomplete Sticky event')
  })

  it('stops at 20 pages with an error', async () => {
    let next = 0
    const sent = indexer({ StickyEvents: () => listed('stickyEvents', [staked()], `e${(next += 1)}`) })

    await expect(indexedStickyEvents({ chainId: 84532, projectId: 37n })).rejects.toThrow('more stickyEvents than one page load reads')
    expect(sent).toHaveLength(20)
  })
})

describe('Sticky positions', () => {
  it('reads every position of a holder across a network\'s chains, with the blocks those chains are indexed through', async () => {
    const sent = indexer({
      StickyPositions: () =>
        listed('stickyPositions', [
          positionRow(),
          positionRow({ chainId: 11155420, projectId: 5, stakedBalance: '0', streakStartedAt: null, longestCompletedStreak: 0 }),
        ]),
    })

    const { rows, blocks } = await indexedStickyPositions({ chainIds: [84532, 11155420], holder: HOLDER as `0x${string}` })

    expect(sent[0].url).toBe(TESTNET)
    expect(sent[0].variables).toEqual({
      where: { version: 6, chainId_in: [84532, 11155420], holder: HOLDER },
      after: null,
    })
    expect(rows).toEqual([
      { chainId: 84532, projectId: 37n, holder: HOLDER, stakedBalance: 25n, streakStartedAt: 1_700_000_000, longestCompletedStreak: 86_400 },
      { chainId: 11155420, projectId: 5n, holder: HOLDER, stakedBalance: 0n, streakStartedAt: null, longestCompletedStreak: 0 },
    ])
    expect(blocks).toEqual(new Map([[84532, 500n], [11155420, 900n]]))
  })

  it('reads every holder of one project, and takes the block from the first page', async () => {
    const sent = indexer({
      StickyPositions: ({ after }) =>
        after === null
          ? listed('stickyPositions', [positionRow({ holder: CAROL })], 'h1', [['baseSepolia', 84532, 500]])
          : listed('stickyPositions', [positionRow()], undefined, [['baseSepolia', 84532, 640]]),
    })

    const { rows, blocks } = await indexedStickyPositions({ chainId: 84532, projectId: 37n })

    expect(sent[0].variables.where).toEqual({ version: 6, chainId: 84532, projectId: 37 })
    expect(rows.map(({ holder }) => holder)).toEqual([CAROL, HOLDER])
    expect(sent.map(({ variables }) => variables.after)).toEqual([null, 'h1'])
    expect(blocks).toEqual(new Map([[84532, 500n]]))
  })

  it('leaves out a chain the index has no status for, and its positions with it', async () => {
    indexer({
      StickyPositions: () =>
        listed('stickyPositions', [positionRow(), positionRow({ chainId: 11155420 })], undefined, [['baseSepolia', 84532, 500]]),
    })

    expect(await indexedStickyPositions({ chainIds: [84532, 11155420], holder: HOLDER as `0x${string}` })).toEqual({
      rows: [expect.objectContaining({ chainId: 84532 })],
      blocks: new Map([[84532, 500n]]),
    })
  })

  it('refuses a question that names no chain, rather than answering for mainnet', async () => {
    const sent = indexer({})

    await expect(indexedStickyPositions({ holder: HOLDER as `0x${string}` })).rejects.toThrow(TypeError)
    expect(await indexedStickyPositions({ chainIds: [], holder: HOLDER as `0x${string}` })).toEqual({
      rows: [],
      blocks: new Map(),
    })
    expect(sent).toHaveLength(0)
  })

  it('drops rows outside the question and rejects incomplete ones', async () => {
    indexer({
      StickyPositions: () =>
        listed('stickyPositions', [
          positionRow(),
          positionRow({ projectId: 99 }),
          positionRow({ holder: OTHER }),
          positionRow({ version: 5 }),
        ]),
    })
    expect(
      (await indexedStickyPositions({ chainId: 84532, projectId: 37n, holder: HOLDER as `0x${string}` })).rows,
    ).toHaveLength(1)

    for (const extra of [
      { stakedBalance: null },
      { stakedBalance: '-1' },
      { streakStartedAt: 'today' },
      { longestCompletedStreak: null },
      { holder: null },
    ]) {
      indexer({ StickyPositions: () => listed('stickyPositions', [positionRow(extra)]) })
      await expect(indexedStickyPositions({ chainId: 84532, projectId: 37n })).rejects.toThrow('incomplete Sticky position')
    }
  })

  it('stops at 20 pages with an error', async () => {
    let next = 0
    indexer({ StickyPositions: () => listed('stickyPositions', [positionRow()], `h${(next += 1)}`) })

    await expect(indexedStickyPositions({ chainId: 84532, projectId: 37n })).rejects.toThrow('more stickyPositions than one page load reads')
  })
})

describe('Sticky settings', () => {
  it('reads a project\'s granters, trusted senders and orphaned-balance exclusions oldest first, with the block of its chain', async () => {
    const sent = indexer({
      StickySettings: () =>
        listed('stickySettingEvents', [
          settingRow('orphanedBalanceExcluded', { txHash: tx(3), timestamp: 300, amount: '5000000000000000000', caller: CAROL }),
          settingRow('trustedSenderSet', { txHash: tx(2), timestamp: 200, account: OTHER, holder: HOLDER, trusted: false }),
          settingRow('granterSet', { txHash: tx(1), timestamp: 100, account: OTHER.toUpperCase().replace('0X', '0x'), caller: CAROL }),
          settingRow('trustedSenderSet', { txHash: tx(2), logIndex: 0, timestamp: 200, account: OTHER, holder: HOLDER, trusted: true }),
        ]),
    })

    const { rows, blocks } = await indexedStickySettings(84532, 37n)

    expect(sent[0].url).toBe(TESTNET)
    expect(sent[0].variables).toEqual({ where: { chainId: 84532, projectId: 37, version: 6 }, after: null })
    const place = { chainId: 84532, projectId: 37n }
    expect(rows).toEqual([
      { ...place, type: 'granterSet', txHash: tx(1), logIndex: 1, timestamp: 100, granter: OTHER, caller: CAROL },
      { ...place, type: 'trustedSenderSet', txHash: tx(2), logIndex: 0, timestamp: 200, holder: HOLDER, sender: OTHER, trusted: true },
      { ...place, type: 'trustedSenderSet', txHash: tx(2), logIndex: 1, timestamp: 200, holder: HOLDER, sender: OTHER, trusted: false },
      { ...place, type: 'orphanedBalanceExcluded', txHash: tx(3), logIndex: 1, timestamp: 300, amount: 5_000_000_000_000_000_000n, caller: CAROL },
    ])
    expect(blocks).toEqual(new Map([[84532, 500n]]))
  })

  it('drops rows for other projects, chains and versions, follows the cursor, and takes the block from the first page', async () => {
    const sent = indexer({
      StickySettings: ({ after }) =>
        after === null
          ? listed(
              'stickySettingEvents',
              [
                settingRow('granterSet', { account: OTHER, caller: CAROL, txHash: tx(1) }),
                settingRow('granterSet', { account: OTHER, caller: CAROL, projectId: 99 }),
                settingRow('granterSet', { account: OTHER, caller: CAROL, chainId: 10 }),
              ],
              's1',
              [['baseSepolia', 84532, 500]],
            )
          : listed(
              'stickySettingEvents',
              [settingRow('granterSet', { account: HOLDER, caller: CAROL, txHash: tx(2), version: 5 })],
              undefined,
              [['baseSepolia', 84532, 640]],
            ),
    })

    const { rows, blocks } = await indexedStickySettings(84532, 37n)

    expect(rows.map(({ txHash }) => txHash)).toEqual([tx(1)])
    expect(sent.map(({ variables }) => variables.after)).toEqual([null, 's1'])
    expect(blocks).toEqual(new Map([[84532, 500n]]))
  })

  it('has no block, and no rows, for a chain the index has no status for', async () => {
    indexer({
      StickySettings: () =>
        listed('stickySettingEvents', [settingRow('granterSet', { account: OTHER, caller: CAROL })], undefined, [['elsewhere', 999, 1]]),
    })

    expect(await indexedStickySettings(84532, 37n)).toEqual({ rows: [], blocks: new Map() })
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
    indexer({ StickySettings: () => listed('stickySettingEvents', [row]) })

    await expect(indexedStickySettings(84532, 37n)).rejects.toThrow('incomplete Sticky setting')
  })

  it('stops at 20 pages with an error', async () => {
    let next = 0
    indexer({
      StickySettings: () =>
        listed('stickySettingEvents', [settingRow('granterSet', { account: OTHER, caller: CAROL })], `s${(next += 1)}`),
    })

    await expect(indexedStickySettings(84532, 37n)).rejects.toThrow('more stickySettingEvents than one page load reads')
  })
})

describe('the indexing status of the new documents', () => {
  it.each(newReaders)('%s rejects an answer with no usable indexing status, never answering with rows and no block', async (_name, operation, field, read) => {
    for (const meta of [null, { status: null }, { status: 'up' }, { status: [] }]) {
      indexer({ [operation]: () => ({ data: { _meta: meta, [field]: page([]) } }) })

      await expect(read()).rejects.toThrow('no indexing status')
    }
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
    // A 502 is retried twice, after 250 ms and 750 ms, before the transport gives up. The reads wait together, in
    // real time: the browser transport hashes each document with the platform's own crypto.
    const fetcher = vi.fn(async () => reply({ error: 'Bendystraw unavailable' }, 502))
    vi.stubGlobal('fetch', fetcher)

    const outcomes = await Promise.all(newReaders.map(([, , , read]) => failure(read())))

    for (const outcome of outcomes) expect(outcome).toMatchObject({ message: 'Bendystraw request failed (502)' })
    expect(fetcher).toHaveBeenCalledTimes(3 * newReaders.length)
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

  it.each(readers)('%s cancels its request when the deadline passes, and the transport does not retry it', async (_name, read) => {
    vi.useFakeTimers()
    const fetcher = hang()
    const outcome = failure(read())
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetcher.mock.calls.length).toBeGreaterThan(0)
    expect(fetcher.mock.calls.every(([, init]) => init.signal?.aborted === false)).toBe(true)

    await vi.advanceTimersByTimeAsync(7_000)

    expect(await outcome).toBeInstanceOf(BendystrawTimeoutError)
    expect(fetcher.mock.calls.every(([, init]) => init.signal?.aborted === true)).toBe(true)
    // The transport retries a timeout of its own after 250 ms; a read that gave up is not one.
    const asked = fetcher.mock.calls.length
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fetcher).toHaveBeenCalledTimes(asked)
  })

  it('counts the 8 s across all of a read\'s pages, and asks for no more once it has passed', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn((_url: string, init: RequestInit) =>
      unlessAborted(
        new Promise<Response>(resolve =>
          setTimeout(() => resolve(reply(indexOf(TESTNET_CHAINS, [project(84532, 1)], 'more'))), 5_000),
        ),
        init.signal,
      ),
    )
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

  it.each(readers)('%s rejects at once with the reason when the signal aborts while the indexer is silent, and cancels its request', async (_name, read) => {
    vi.useFakeTimers()
    const fetcher = hang()
    const controller = new AbortController()
    const outcome = failure(read(controller.signal))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetcher.mock.calls.length).toBeGreaterThan(0)
    expect(fetcher.mock.calls.every(([, init]) => init.signal?.aborted === false)).toBe(true)
    const reason = new Error('left the page')

    controller.abort(reason)

    expect(await outcome).toBe(reason)
    expect(fetcher.mock.calls.every(([, init]) => init.signal?.aborted === true)).toBe(true)
  })

  it('cancels a request from the browser transport too', async () => {
    vi.stubGlobal('window', {})
    const fetcher = hang()
    const controller = new AbortController()
    const reason = new Error('left the page')
    const outcome = failure(indexedStickyCreateTx(84532, 37n, controller.signal))
    // The browser transport hashes the document before it asks, in real time.
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    expect(fetcher.mock.calls[0][0]).toBe('/api/bendystraw/testnet/query')
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(false)

    controller.abort(reason)

    expect(await outcome).toBe(reason)
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true)
  })

  it('does not return an answer that arrives after the signal aborted, whatever the transport did with the signal', async () => {
    const controller = new AbortController()
    const reason = new Error('left the page')
    // A fetch that ignores its signal, and answers anyway.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        controller.abort(reason)
        return reply({ data: { projectCreateEvents: { items: [{ txHash: tx(7), timestamp: 1 }] } } })
      }),
    )

    await expect(indexedStickyCreateTx(84532, 37n, controller.signal)).rejects.toBe(reason)
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
  /** Every reader against an indexer that has an empty answer for each of the ten documents. */
  async function readEverything() {
    const sent = indexer({
      StickyIndex: () => indexOf(TESTNET_CHAINS, []),
      StickyPays: () => ({ data: { _meta: META, payEvents: page([]) } }),
      StickyCashOuts: () => ({ data: { _meta: META, cashOutTokensEvents: page([]) } }),
      StickyFees: () => listed('processFeeEvents', []),
      StickyAdditions: () => listed('addToBalanceEvents', []),
      StickyFunding: () => listed('stickyFundEvents', []),
      StickyCreate: () => ({ data: { projectCreateEvents: { items: [] } } }),
      StickyEvents: () => listed('stickyEvents', []),
      StickyPositions: () => listed('stickyPositions', []),
      StickySettings: () => listed('stickySettingEvents', []),
    })
    for (const [, read] of readers) await read()
    return sent
  }

  it('are ten, each registered under the SHA-256 of its exact text', async () => {
    const sent = await readEverything()

    const documents = new Map(sent.map(({ operation, query }) => [operation, query]))
    expect([...documents.keys()].sort()).toEqual([
      'StickyAdditions',
      'StickyCashOuts',
      'StickyCreate',
      'StickyEvents',
      'StickyFees',
      'StickyFunding',
      'StickyIndex',
      'StickyPays',
      'StickyPositions',
      'StickySettings',
    ])
    expect(Object.keys(registry)).toHaveLength(10)
    for (const query of documents.values()) {
      expect((registry as Record<string, string>)[createHash('sha256').update(query, 'utf8').digest('hex')]).toBe(query)
    }
  })

  it('are the old client\'s four documents, with the indexing status added to the pays and cash outs', async () => {
    const sent = await readEverything()

    const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
    const queryOf = (operation: string) => sent.find(request => request.operation === operation)!.query
    // The old client's registry held these IDs. The pays and cash outs also select the status, so a chart that reads
    // them can scan the terminal past the block they are as of; without that line they are the old documents exactly.
    const withoutStatus = (operation: string) => queryOf(operation).replace('\n    _meta { status }', '')
    expect(sha(queryOf('StickyIndex'))).toBe('6d883ec5d783d0ca340af5ffe0ed30da99af1f0fc7f148e557cf4b844a014f45')
    expect(sha(withoutStatus('StickyPays'))).toBe('ee745e235eef8f9a5ef97616351badc4ac2f1cb3e4e596c3e158c1057e85c741')
    expect(sha(withoutStatus('StickyCashOuts'))).toBe('80dd411715bb2f4eab91eb0549fc69c0aaf8e1252d7f251aed0d8ceecb0d233d')
    expect(sha(queryOf('StickyCreate'))).toBe('991f63433092a9e84526f9d09ad62bcbfe172488b6872089aaacdc7c2cdae6fc')
  })

  it('select the indexing status in every list document, and not in the creation lookup', async () => {
    const sent = await readEverything()

    const withStatus = sent.filter(({ query }) => query.includes('_meta { status }')).map(({ operation }) => operation)
    expect([...new Set(withStatus)].sort()).toEqual([
      'StickyAdditions',
      'StickyCashOuts',
      'StickyEvents',
      'StickyFees',
      'StickyFunding',
      'StickyIndex',
      'StickyPays',
      'StickyPositions',
      'StickySettings',
    ])
  })

  it('select no memo or metadata of an addition, which anyone who adds to a balance writes as long as they like', async () => {
    const sent = await readEverything()

    const additions = sent.find(({ operation }) => operation === 'StickyAdditions')!.query
    expect(additions).toContain('items { chainId projectId version txHash logIndex timestamp amount returnedFees }')
    expect(additions).not.toMatch(/memo|metadata/)
  })

  it('are read with the live cache policy', async () => {
    await readEverything()

    const revalidate = vi.mocked(fetch).mock.calls.map(([, init]) => (init as { next?: { revalidate?: number } }).next?.revalidate)
    expect(revalidate).toHaveLength(11)
    expect(new Set(revalidate)).toEqual(new Set([15]))
  })

  it('reach the indexer through the relay by operation ID alone, from the browser', async () => {
    vi.stubGlobal('window', {})
    const sent = indexer({
      StickyIndex: () => indexOf(TESTNET_CHAINS, [project(84532, 37)]),
      StickyPays: () => ({ data: { _meta: META, payEvents: page([pay(37)]) } }),
      StickyCashOuts: () => ({ data: { _meta: META, cashOutTokensEvents: page([]) } }),
      StickyFees: () => listed('processFeeEvents', [feeRow(37)]),
      StickyAdditions: () => listed('addToBalanceEvents', [additionRow(37)]),
      StickyFunding: () => listed('stickyFundEvents', [fundRow()]),
      StickyCreate: () => ({ data: { projectCreateEvents: { items: [{ txHash: tx(7), timestamp: 1 }] } } }),
      StickyEvents: () => listed('stickyEvents', [staked()]),
      StickyPositions: () => listed('stickyPositions', [positionRow()]),
      StickySettings: () => listed('stickySettingEvents', [settingRow('granterSet', { account: OTHER, caller: CAROL })]),
    })

    await indexedStickyProjects('testnet')
    await indexedStickyMoves(84532, [37n])
    await indexedStickyFees(84532, 37n)
    await indexedStickyFunding(84532, STICKY_TOKEN as Address)
    await indexedStickyCreateTx(84532, 37n)
    await indexedStickyEvents({ chainId: 84532, projectId: 37n })
    await indexedStickyPositions({ chainId: 84532, projectId: 37n })
    await indexedStickySettings(84532, 37n)

    expect(new Set(sent.map(({ url }) => url))).toEqual(new Set(['/api/bendystraw/testnet/query']))
    expect(new Set(sent.map(({ operation }) => operation)).size).toBe(10)
  })
})
