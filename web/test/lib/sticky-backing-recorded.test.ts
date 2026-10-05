import { isDeepStrictEqual } from 'node:util'
import type { Hex, PublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import registry from '@/lib/bendystraw-operation-registry.json'
import { backingFlows } from '@/lib/sticky-backing'
import recorded from './recorded/fees-basesep-45.json'

// A V6 project's balance history on Base Sepolia (basesep:45: six pays, a cash out, a processed fee and six additions
// to its balance), recorded live on 2026-10-05: testnet Bendystraw's answers to the chart's four documents, and JB
// Center's eth_getLogs of the terminal for the same events, from the project's creation through the block Bendystraw
// was indexed through, 500 blocks a request. Only the two services are stood in for: the readers, the scanner and the
// merge are the real ones. The chart draws the same flows from either source.

const center = vi.hoisted(() => ({ client: vi.fn() }))
vi.mock('@/lib/jbcenter-rpc', () => ({ jbCenterPublicClient: center.client }))

const CHAIN = recorded.chainId
const PROJECT = BigInt(recorded.projectId)
const CREATED = BigInt(recorded.creationBlock)
/** The block Bendystraw was indexed through, and the head the recording's Center answers at. */
const THROUGH = BigInt(recorded.through)

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

/** Bendystraw through the site's relay: the recorded answer to each document, asked by its registered ID with the
 * recorded variables, or an error for every document when it is down. */
function recordedBendystraw({ up }: { up: boolean }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const { operation, variables } = JSON.parse(String(init.body)) as { operation: string; variables: unknown }
      const name = /^query (\w+)/.exec((registry as Record<string, string>)[operation] ?? '')?.[1]
      const answer = recorded.answers[name as keyof typeof recorded.answers]
      if (!up) return reply({ errors: [{ message: 'Bendystraw is down' }] })
      if (!answer || !isDeepStrictEqual(variables, answer.variables)) throw new Error(`nothing recorded for ${name}`)
      return reply({ data: answer.data })
    }),
  )
}

beforeEach(() => {
  localStorage.clear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('basesep:45\'s recorded balance history', () => {
  it('draws the same flows from Bendystraw and two short tails as from a scan of the whole history', async () => {
    recordedBendystraw({ up: true })
    const tails = recordedCenter()
    const indexed = await backingFlows(CHAIN, PROJECT, CREATED)

    localStorage.clear()
    recordedBendystraw({ up: false })
    const windows = recordedCenter()
    const scanned = await backingFlows(CHAIN, PROJECT, CREATED)

    expect(indexed).toEqual(scanned)
    // Every one of the fourteen events moved the balance, the fee and the additions among them.
    expect(indexed).toHaveLength(14)
    expect(indexed).toContainEqual({ timestamp: 1_791_095_062, delta: -14_250_000_000_000n })
    expect(indexed.filter(flow => flow.delta > 0n)).toHaveLength(12)
    // From Bendystraw, a request for each history past its block; from the chain alone, the whole history in windows.
    const tail = { fromBlock: `0x${(THROUGH + 1n - 64n).toString(16)}`, toBlock: `0x${THROUGH.toString(16)}` }
    expect(tails.map(({ fromBlock, toBlock }) => ({ fromBlock, toBlock }))).toEqual([tail, tail])
    expect(windows).toHaveLength(2 * Math.ceil(Number(THROUGH - CREATED + 1n) / 500))
    expect(console.warn).toHaveBeenCalledTimes(2)
  })
})
