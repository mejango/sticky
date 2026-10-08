/** jbm's groupSameTxEvents (JBM/src/components/ActivityList.tsx:303), keyed by the caller.
 * A group sits where its newest member sat. Sticky's project feed is single-chain; home/account feeds span unrelated
 * projects and carry no verified launch identity. Keep chain and project in the key instead of applying the SDK's
 * cross-chain display heuristic to those feeds. */
export function groupSameTx<T>(events: T[], key: (event: T) => string): T[][] {
  const groups = new Map<string, T[]>()
  const order: T[][] = []
  for (const event of events) {
    const id = key(event)
    const group = groups.get(id)
    if (group) group.push(event)
    else {
      const fresh = [event]
      groups.set(id, fresh)
      order.push(fresh)
    }
  }
  return order
}
