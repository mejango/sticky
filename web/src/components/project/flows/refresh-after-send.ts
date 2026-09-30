import type { QueryClient, QueryKey } from '@tanstack/react-query'

/** When a confirmed send's reads are made again: at once, and as the index catches up with the chain. */
const REFRESH_AFTER_MS = [0, 4_000, 12_000]

/**
 * Reads `keys` again now, at +4 s and at +12 s. Each key names the reads a send changed and no others: a project's
 * whole prefix would requeue the Overview's scans ahead of its holders and Latest list.
 */
function refreshAfterSend(client: QueryClient, keys: readonly QueryKey[]): void {
  const again = () => {
    for (const queryKey of keys) void client.invalidateQueries({ queryKey })
  }
  for (const delay of REFRESH_AFTER_MS) {
    if (delay === 0) again()
    else setTimeout(again, delay)
  }
}

/** A transfer leaves a project's supply and backing as they are: what it changes is who holds what, the history that
 * says so, and the holders' and the viewer's streaks, tranches and rewards. */
export function refreshAfterTransfer(client: QueryClient, chainId: number, projectId: number): void {
  const project = (...rest: string[]) => ['sticky-project', chainId, projectId, ...rest]
  refreshAfterSend(client, [
    project('events'),
    project('holders'),
    project('sticks'),
    project('latest'),
    project('page-balances'),
    ['sticky-position', chainId, projectId],
    ['sticky-tranches', chainId, projectId],
    ['sticky-rewards', chainId, projectId],
    ['sticky-account'],
  ])
}

/** Trusting or untrusting a sender is one hook event: the list of trusted senders is read from the history and
 * confirmed with the hook, and the auto-stick card reads whether the holder trusts the adapter. */
export function refreshAfterTrust(client: QueryClient, chainId: number, projectId: number): void {
  refreshAfterSend(client, [
    ['sticky-project', chainId, projectId, 'events'],
    ['sticky-trusted', chainId, projectId],
    ['sticky-autostick', chainId, projectId],
  ])
}
