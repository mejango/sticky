import type { Address } from 'viem'
import { describe, expect, it } from 'vitest'
import type { TransactionReviewRequest } from '@bananapus/nana-sdk-core/review'
import { buildTransactionReviewPrompt, transactionReviewJson } from '@/lib/transaction-review'

const TARGET = '0x1111111111111111111111111111111111111111' as Address
const RECIPIENT = '0x2222222222222222222222222222222222222222' as Address

describe('review serialization', () => {
  const request: TransactionReviewRequest = {
    title: 'Review bundle',
    authorization: { nonce: 4n },
    calls: [
      {
        chainId: 1,
        from: RECIPIENT,
        to: TARGET,
        value: 15n,
        data: '0x1234',
      },
      {
        chainId: 10,
        to: RECIPIENT,
        data: '0xabcd',
      },
    ],
  }

  it('serializes bigint authorization and exact RPC fields without loss', () => {
    expect(JSON.parse(transactionReviewJson(request))).toEqual({
      authorization: { nonce: '4' },
      resultingCall: {
        transactions: [
          {
            chainId: 1,
            from: RECIPIENT,
            to: TARGET,
            value: '0xf',
            data: '0x1234',
          },
          {
            chainId: 10,
            to: RECIPIENT,
            value: '0x0',
            data: '0xabcd',
          },
        ],
      },
    })
  })

  it('builds a v6-specific audit prompt containing every onchain target', () => {
    const prompt = buildTransactionReviewPrompt(request)

    expect(prompt).toContain('nana V6 / revnet V6')
    expect(prompt).toContain(`https://etherscan.io/address/${TARGET}`)
    expect(prompt).toContain(`https://optimistic.etherscan.io/address/${RECIPIENT}`)
    expect(prompt).toContain('SAFE TO SIGN / DO NOT SIGN / NEEDS MORE INFO')
  })
})

import { buildTransactionDebugPrompt as buildDebugPrompt } from '@/lib/transaction-review'

describe('buildTransactionDebugPrompt', () => {
  it('links each tx on its own explorer and points at the Etherscan debugger skill', () => {
    const prompt = buildDebugPrompt([
      { chainId: 1, txHash: '0xabc' },
      { chainId: 8453, txHash: '0xdef' },
    ])
    expect(prompt).toContain('https://etherscan.io/tx/0xabc')
    expect(prompt).toContain('https://basescan.org/tx/0xdef')
    expect(prompt).toContain('etherscan-transaction-debugger')
    expect(prompt).toContain('Bananapus/version-6')
  })
})
