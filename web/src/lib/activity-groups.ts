/** jbm's groupSameTxEvents (JBM/src/components/ActivityList.tsx:303), keyed by the caller.
 * A group sits where its newest member sat. */
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
