// @vitest-environment jsdom

import { getAddress } from 'viem'
import { afterEach, describe, expect, it } from 'vitest'
import { reviewGate } from '@/components/project/flows/review-gate'
import { clearViewAs, setViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import { EXTERNAL_WALLET_REQUIRED } from '@/providers/WalletAuthContext'

// Whether a flow's review may start: every flow (stick, unstick, transfer, trust) asks this before it reads or plans
// anything, and the flows' own tests show what each does with the answer.

const ALICE = getAddress(`0x${'a1'.repeat(20)}`)
const BOB = getAddress(`0x${'b2'.repeat(20)}`)
const wallet = { address: ALICE, isConnected: true, isCenterWallet: false }

afterEach(() => clearViewAs())

describe('reviewGate', () => {
  it('lets a connected external wallet review, for its own account', () => {
    expect(reviewGate(wallet)).toEqual({ account: ALICE, refusal: null })
  })

  it('asks a visitor with no account to sign in, and a wallet that is not connected yet too', () => {
    expect(reviewGate({ ...wallet, address: undefined, isConnected: false })).toBeNull()
    expect(reviewGate({ ...wallet, isConnected: false })).toBeNull()
  })

  it("refuses Signa in the engine's own words, which bring the offer to connect a wallet", () => {
    expect(reviewGate({ ...wallet, isCenterWallet: true })).toEqual({ account: ALICE, refusal: EXTERNAL_WALLET_REQUIRED })
    expect(EXTERNAL_WALLET_REQUIRED).toBe('This action needs an external wallet.')
  })

  it('refuses View as, until it ends', () => {
    setViewAs(BOB)
    expect(reviewGate(wallet)).toEqual({ account: ALICE, refusal: VIEW_AS_WRITE_BLOCKED })
    clearViewAs()
    expect(reviewGate(wallet)).toEqual({ account: ALICE, refusal: null })
  })

  it('refuses Signa before View as, as the engine does', () => {
    setViewAs(BOB)
    expect(reviewGate({ ...wallet, isCenterWallet: true })?.refusal).toBe(EXTERNAL_WALLET_REQUIRED)
  })
})
