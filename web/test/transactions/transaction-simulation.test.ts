import type { Address, Hex, PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import {
  simulateStateChangingTransaction,
  TRANSACTION_SIMULATION_GAS,
  TRANSACTION_SIMULATION_MAX_RETURN_BYTES,
} from '@/lib/transaction-simulation'

const FROM = '0x1111111111111111111111111111111111111111' as Address
const TARGET = '0x2222222222222222222222222222222222222222' as Address

describe('state-changing transaction simulation', () => {
  it('uses a raw, explicitly gas-bounded eth_call', async () => {
    const request = vi.fn().mockResolvedValue('0x')
    await simulateStateChangingTransaction(
      { request } as unknown as PublicClient,
      { from: FROM, to: TARGET, data: '0x1234', value: 7n },
    )

    expect(request).toHaveBeenCalledWith({
      method: 'eth_call',
      params: [
        {
          from: FROM,
          to: TARGET,
          data: '0x1234',
          value: '0x7',
          gas: `0x${TRANSACTION_SIMULATION_GAS.toString(16)}`,
        },
        'latest',
      ],
    })
  })

  it('never follows a target-controlled OffchainLookup URL', async () => {
    const request = vi.fn().mockRejectedValue(
      new Error(
        'execution reverted: OffchainLookup(https://127.0.0.1/private)',
      ),
    )
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(
      simulateStateChangingTransaction(
        { request, ccipRead: true } as unknown as PublicClient,
        { from: FROM, to: TARGET, data: '0x1234' },
      ),
    ).rejects.toThrow(/OffchainLookup/)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('rejects oversized returndata before a caller can decode it', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        `0x${'00'.repeat(TRANSACTION_SIMULATION_MAX_RETURN_BYTES + 1)}` as Hex,
      )
    await expect(
      simulateStateChangingTransaction(
        { request } as unknown as PublicClient,
        { from: FROM, to: TARGET, data: '0x1234' },
      ),
    ).rejects.toThrow(/too much data/)
  })
})
