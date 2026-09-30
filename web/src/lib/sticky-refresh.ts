import type { QueryClient } from '@tanstack/react-query'

/** When a refresh reads again: now, and twice more, since the index and the nodes behind Center can be a few seconds
 * behind the block that was just confirmed. */
const REFRESH_AFTER_MS = [0, 4_000, 12_000]

/** The parts of a project's page that a write changes: its figures, and what its holders and Latest are read from. */
const PROJECT_PARTS = ['info', 'events', 'holders', 'sticks', 'latest', 'page-balances']
/** What the page reads of a viewer, under the keys that follow the chain and the project. */
const VIEWER_READS = ['sticky-position', 'sticky-tranches', 'sticky-rewards']

/**
 * Reads again what a confirmed write to a Sticky project changed: the project's figures, its history, holders and Latest
 * list, the viewer's stick, tranches and rewards, and the account pages' positions and activity, now and at +4 s and
 * +12 s. Only those: the keys that start with the chain and the project also hold the Overview's scans, which a write
 * must not queue ahead of the holders and Latest, and the account pages' list of every project on a chain is a scan too.
 */
export function refreshStickyProject(client: QueryClient, chainId: number, projectId: number): void {
  const again = () => {
    for (const part of PROJECT_PARTS) void client.invalidateQueries({ queryKey: ['sticky-project', chainId, projectId, part] })
    for (const read of VIEWER_READS) void client.invalidateQueries({ queryKey: [read, chainId, projectId] })
    void client.invalidateQueries({ queryKey: ['sticky-account'], predicate: query => query.queryKey[2] !== 'deployed' })
  }
  for (const delay of REFRESH_AFTER_MS) {
    if (delay === 0) again()
    else setTimeout(again, delay)
  }
}
