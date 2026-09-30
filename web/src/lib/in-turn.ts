import type { QueryClient } from '@tanstack/react-query'

/** The read under way with each query client. */
const reading = new WeakMap<QueryClient, Promise<unknown>>()

/**
 * `read`, once the earlier reads made in turn with this client have ended, however they ended: Center has one rate
 * limit for every chain, so the home's and an account's chains, and a project's scans, are read one after another. A
 * read cancelled while it waits does not start. A read never waits on another query in its turn, or it could wait on
 * itself.
 */
export function inTurn<T>(client: QueryClient, signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  const turn = (reading.get(client) ?? Promise.resolve()).then(() => {
    if (signal.aborted) throw signal.reason
    return read()
  })
  // The next read waits for this one to settle. This one's failure goes to its own caller, through `turn`.
  reading.set(client, turn.catch(() => undefined))
  return turn
}
