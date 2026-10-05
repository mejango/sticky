import type { QueryClient } from '@tanstack/react-query'
import { line, type Line } from '@/lib/line'

/** How many reads made in turn are under way at once with each query client. Every request they send waits for one of
 * Center's slots (`center-limit.ts`), which bound what Center gets; two reads keep both slots busy while one of them
 * waits on Bendystraw, and the rest wait in order, so that what a page shows first is read first. */
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
