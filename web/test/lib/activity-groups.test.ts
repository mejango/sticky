import { describe, expect, it } from 'vitest'
import { groupSameTx } from '@/lib/activity-groups'

// From juicebox.money's test/activity-same-tx-grouping.test.tsx ("groupSameTxEvents"), with the key given by
// the caller instead of built from a Bendystraw event.

type Item = { id: string; tx: string; project?: number; chain?: number }
const key = ({ tx, project = 1, chain = 8453 }: Item) => `${chain}:${project}:${tx}`

describe('groupSameTx', () => {
  it('folds events sharing one key and keeps the others apart', () => {
    const groups = groupSameTx(
      [
        { id: 'pay', tx: '0xa' },
        { id: 'swap', tx: '0xa' },
        { id: 'mint', tx: '0xa' },
        { id: 'other', tx: '0xb' },
      ],
      key,
    )
    expect(groups.map(group => group.map(item => item.id))).toEqual([['pay', 'swap', 'mint'], ['other']])
  })

  it('keeps one transaction\'s events apart across projects and chains', () => {
    const groups = groupSameTx(
      [
        { id: 'a', tx: '0xa' },
        { id: 'b', tx: '0xa', project: 2 },
        { id: 'c', tx: '0xa', chain: 1 },
      ],
      key,
    )
    expect(groups).toHaveLength(3)
  })

  it('puts a group where its first event sat, which for a newest-first list is where its newest member sat', () => {
    // Newest first: the transaction 0xa has a member at the top and another below the 0xb event.
    const groups = groupSameTx(
      [
        { id: 'a-new', tx: '0xa' },
        { id: 'b', tx: '0xb' },
        { id: 'a-old', tx: '0xa' },
        { id: 'c', tx: '0xc' },
      ],
      key,
    )
    expect(groups.map(group => group.map(item => item.id))).toEqual([['a-new', 'a-old'], ['b'], ['c']])
  })

  it('leaves the list it was given as it was', () => {
    const events = [
      { id: '1', tx: '0xa' },
      { id: '2', tx: '0xb' },
      { id: '3', tx: '0xa' },
    ]
    const snapshot = structuredClone(events)
    groupSameTx(events, key)
    expect(events).toEqual(snapshot)
  })

  it('is empty for no events', () => {
    expect(groupSameTx([], key)).toEqual([])
  })
})
