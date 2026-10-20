// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'

const getEnsName = vi.hoisted(() => vi.fn())
vi.mock('@/lib/ens-client', () => ({ ensClient: { getEnsName } }))

import { lookupEnsName } from '@/lib/ens'

const ALICE = '0x1111111111111111111111111111111111111111'
const BOB = '0x2222222222222222222222222222222222222222'

describe('lookupEnsName', () => {
  it('loads the mainnet reader on a lookup, and asks once per address', async () => {
    getEnsName.mockResolvedValueOnce('alice.eth')
    expect(await lookupEnsName(ALICE, 1)).toBe('alice.eth')
    expect(await lookupEnsName(ALICE.toUpperCase().replace('0X', '0x'), 10)).toBe('alice.eth')
    expect(getEnsName).toHaveBeenCalledTimes(1)
    expect(getEnsName).toHaveBeenCalledWith({ address: ALICE })
  })

  it('answers null for a failed lookup, a testnet account or something that is not an address, asking nothing', async () => {
    getEnsName.mockClear()
    getEnsName.mockRejectedValueOnce(new Error('down'))
    expect(await lookupEnsName(BOB, 8453)).toBeNull()
    expect(await lookupEnsName(ALICE, 84532)).toBeNull()
    expect(await lookupEnsName('nope', 1)).toBeNull()
    expect(getEnsName).toHaveBeenCalledTimes(1)
  })
})
