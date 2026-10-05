import { isDeepStrictEqual } from 'node:util'
import type { Address, Hex, PublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import registry from '@/lib/bendystraw-operation-registry.json'
import { discoverFunding, type FundedPot } from '@/lib/sticky-rewards'
import recorded from './recorded/funding-basesep.json'

// The airdrop funding of two Sticky tokens on Base Sepolia, recorded live on 2026-10-05: basesep:37's (two pots, for
// everyone and for stake-age group 1000) and basesep:42's (one pot, funded twice). Testnet Bendystraw's StickyFunding
// answers, and JB Center's eth_getLogs of every Fund the distributor logged, for any token, from basesep:37's creation
// through the block Bendystraw was indexed through, 500 blocks a request. Only the two services are stood in for: the
// reader, the scanner and the merge are the real ones. The pots are the same from either source.

const center = vi.hoisted(() => ({ client: vi.fn() }))
vi.mock('@/lib/jbcenter-rpc', () => ({ jbCenterPublicClient: center.client }))

const CHAIN = recorded.chainId
/** The block Bendystraw was indexed through, and the head the recording's Center answers at. */
const THROUGH = BigInt(recorded.through)
const E18 = 10n ** 18n

/** The pots each project's token was funded with, as the distributor's Fund logs and Bendystraw both list them. */
const POTS: Record<number, FundedPot[]> = {
  37: [
    { groupId: 0n, token: '0x8b122b7dd707f83b639a578bc0c81e75c55d34bd', funded: E18, fundedAt: 47_306_068n },
    { groupId: 1000n, token: '0x8b122b7dd707f83b639a578bc0c81e75c55d34bd', funded: E18 / 2n, fundedAt: 47_306_083n },
  ],
  42: [{ groupId: 0n, token: '0x1d9fbfedcf7b644edbaf6dcfa72a365ecad3a42e', funded: 110n * E18, fundedAt: 47_390_712n }],
}

type RpcLog = (typeof recorded.logs)[number]
type Filter = { address: string; topics: (Hex | Hex[] | null)[]; fromBlock: Hex; toBlock: Hex }

function inFilter(log: RpcLog, { address, topics, fromBlock, toBlock }: Filter): boolean {
  const block = BigInt(log.blockNumber)
  const topicsMatch = topics.every(
    (wanted, i) => wanted === null || (Array.isArray(wanted) ? wanted.includes(log.topics[i] as Hex) : wanted === log.topics[i]),
  )
  return log.address === address.toLowerCase() && block >= BigInt(fromBlock) && block <= BigInt(toBlock) && topicsMatch
}

/** Center at the recorded head, answering each eth_getLogs from the recording. Returns what each request asked for. */
function recordedCenter(): Filter[] {
  const asked: Filter[] = []
  const client = {
    getBlockNumber: vi.fn(async () => THROUGH),
    request: vi.fn(async ({ method, params }: { method: string; params: [Filter] }) => {
      if (method !== 'eth_getLogs') throw new Error(`unexpected ${method}`)
      asked.push(params[0])
      return recorded.logs.filter(log => inFilter(log, params[0]))
    }),
  }
  center.client.mockReturnValue(client as unknown as PublicClient)
  return asked
}

const reply = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

/** Bendystraw through the site's relay: the recorded StickyFunding answer for the token asked about, by its registered
 * ID with the recorded variables, or an error for every document when it is down. */
function recordedBendystraw({ up }: { up: boolean }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const { operation, variables } = JSON.parse(String(init.body)) as {
        operation: string
        variables: { where: { hook: string } }
      }
      const name = /^query (\w+)/.exec((registry as Record<string, string>)[operation] ?? '')?.[1]
      const answer = recorded.answers[variables.where.hook as keyof typeof recorded.answers]
      if (!up) return reply({ errors: [{ message: 'Bendystraw is down' }] })
      if (name !== 'StickyFunding' || !answer || !isDeepStrictEqual(variables, answer.variables)) {
        throw new Error(`nothing recorded for ${name}`)
      }
      return reply({ data: answer.data })
    }),
  )
}

beforeEach(() => {
  localStorage.clear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe.each(recorded.projects)('basesep:$projectId\'s recorded airdrop funding', ({ projectId, stickyToken, creationBlock }) => {
  const created = BigInt(creationBlock)
  const reads = { creationBlock: async () => created }

  it('lists the same pots from Bendystraw and a short tail as from a scan of the distributor since the project\'s creation', async () => {
    recordedBendystraw({ up: true })
    const tail = recordedCenter()
    const indexed = await discoverFunding(CHAIN, stickyToken as Address, BigInt(projectId), reads)
    // What Bendystraw answered for is not kept.
    expect(localStorage).toHaveLength(0)

    recordedBendystraw({ up: false })
    const windows = recordedCenter()
    const scanned = await discoverFunding(CHAIN, stickyToken as Address, BigInt(projectId), reads)

    expect(indexed).toEqual(scanned)
    expect(indexed).toEqual(POTS[projectId])
    expect(tail).toEqual([expect.objectContaining({ fromBlock: `0x${(THROUGH + 1n - 64n).toString(16)}` })])
    expect(windows).toHaveLength(Math.ceil(Number(THROUGH - created + 1n) / 500))
  })
})
