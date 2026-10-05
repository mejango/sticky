import type { QueryClient } from '@tanstack/react-query'
import { line, type Line } from '@/lib/line'

/** The reads under way and waiting with each query client. */
const lines = new WeakMap<QueryClient, Line>()

/**
 * `read`, once the earlier reads made in turn with this client have ended, however they ended: Center has one rate
 * limit for every chain, so the home's and an account's chains, and a project's scans, are read one after another. A
 * read cancelled while it waits leaves the line at once and never starts. A read never waits on another query in its
 * turn, or it could wait on itself.
 */
export function inTurn<T>(client: QueryClient, signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  let own = lines.get(client)
  if (!own) lines.set(client, (own = line(1)))
  return own.join(read, { signal })
}
