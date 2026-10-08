import type { QueryClient } from '@tanstack/react-query'
import { line, type Line } from '@/lib/line'

/** Bound whole scan workloads per query client, keeping their requested order so the page's first sections start
 * first. Individual RPC starts are independently paced across every reader and chain (`jbcenter-rpc.ts`); slow
 * responses in these two scan lanes do not hold up wallet, review or other readers' requests. */
export const READ_LANES = 2

/** The reads under way and waiting with each query client. */
const lines = new WeakMap<QueryClient, Line>()

/**
 * `read`, once one of the READ_LANES of this client is free: reads start in the order they are asked for, and at most
 * that many are under way at once, however they end. A read cancelled while it waits leaves the line at once and never
 * starts. A read never waits on another query in its turn, or it could wait on itself (`test/in-turn-waits.test.ts`).
 */
export function inTurn<T>(client: QueryClient, signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  let own = lines.get(client)
  if (!own) lines.set(client, (own = line(READ_LANES)))
  return own.join(read, { signal })
}
