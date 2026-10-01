import { decodeEventLog, encodeAbiParameters, getAddress, parseAbiParameters, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { terminalEventsAbi } from '@/lib/sticky-abis'
import { terminalHistoryKey, withoutMemo } from '@/lib/terminal-history'
import { CHAIN, HOLDER, OTHER, deployment, raw, topic, words } from './sticky-log-fixtures'

// What this browser keeps of a project's terminal logs: the key each history has, and what a kept log holds. The
// histories themselves are kept by `keptLogs` (test/lib/hook-logs.test.ts), and read by the chart and Latest
// (sticky-backing-center.test.ts and sticky-feed-center.test.ts).

const TERMINAL = deployment.terminal
// JBMultiTerminal's events by the topics the old client filtered on, from `cast keccak`.
const PAY = '0x133161f1c9161488f777ab9a26aae91d47c0d9a3fafb398960f138db02c73797'
const CASH_OUT = '0xfaf1d4bf1b08470c7ed8c351c5065f51af70b36b237723173f898453b9724142'
const PROCESS_FEE = '0xb514e730b3f8ad3aa94b6857bcc5ff4a46954bdcf8c4b0346705b1d0ac7a4325'
const ADD_TO_BALANCE = '0x9ecaf7fc3dfffd6867c175d6e684b1f1e3aef019398ba8db2c1ffab4a09db253'
const at = { address: TERMINAL, blockNumber: 1_000n, time: 7_000n }

const PAY_DATA = parseAbiParameters('address, address, uint256, uint256, string, bytes, address')
const CASH_OUT_DATA = parseAbiParameters('address, address, uint256, uint256, uint256, bytes, address')
const ADDITION_DATA = parseAbiParameters('uint256, uint256, string, bytes, address')
const LONG = 'x'.repeat(100_000)
const BYTES: Hex = `0x${'ab'.repeat(5_000)}`

const decoded = (log: { topics: [Hex, ...Hex[]] | []; data: Hex }) =>
  decodeEventLog({ abi: terminalEventsAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data })

describe('terminalHistoryKey', () => {
  it("names a project's history on a chain's terminal, whatever the case of the terminal's address", () => {
    expect(terminalHistoryKey(CHAIN, TERMINAL, 42n, 'fees')).toBe(`${CHAIN}:${TERMINAL.toLowerCase()}:42:fees`)
    expect(terminalHistoryKey(CHAIN, TERMINAL.toLowerCase(), 42n, 'moves')).toBe(`${CHAIN}:${TERMINAL.toLowerCase()}:42:moves`)
    expect(terminalHistoryKey(CHAIN, TERMINAL, 42n, 'feed')).toBe(`${CHAIN}:${TERMINAL.toLowerCase()}:42:feed`)
  })
})

describe('withoutMemo', () => {
  it("keeps a pay without its memo and metadata, and everything else of it as it was", () => {
    const pay = raw([PAY, topic(1n), topic(2n), topic(42n)], encodeAbiParameters(PAY_DATA, [OTHER, HOLDER, 5n, 6n, LONG, BYTES, OTHER]), at)
    const kept = withoutMemo(pay)
    expect({ ...kept, data: pay.data }).toEqual(pay)
    expect(kept.data).toBe(encodeAbiParameters(PAY_DATA, [OTHER, HOLDER, 5n, 6n, '', '0x', OTHER]))
    expect(decoded(kept)).toMatchObject({
      eventName: 'Pay',
      args: {
        projectId: 42n,
        payer: getAddress(OTHER),
        beneficiary: getAddress(HOLDER),
        amount: 5n,
        newlyIssuedTokenCount: 6n,
        caller: getAddress(OTHER),
      },
    })
  })

  it('keeps a cash out without its metadata, and everything else of it as it was', () => {
    const cashOut = raw(
      [CASH_OUT, topic(1n), topic(2n), topic(42n)],
      encodeAbiParameters(CASH_OUT_DATA, [HOLDER, OTHER, 40n, 1_000n, 39n, BYTES, HOLDER]),
      at,
    )
    const kept = withoutMemo(cashOut)
    expect({ ...kept, data: cashOut.data }).toEqual(cashOut)
    expect(kept.data).toBe(encodeAbiParameters(CASH_OUT_DATA, [HOLDER, OTHER, 40n, 1_000n, 39n, '0x', HOLDER]))
    expect(decoded(kept)).toMatchObject({
      eventName: 'CashOutTokens',
      args: {
        projectId: 42n,
        holder: getAddress(HOLDER),
        beneficiary: getAddress(OTHER),
        cashOutCount: 40n,
        cashOutTaxRate: 1_000n,
        reclaimAmount: 39n,
      },
    })
  })

  it('keeps an addition to a balance without its memo and metadata', () => {
    const addition = raw([ADD_TO_BALANCE, topic(42n)], encodeAbiParameters(ADDITION_DATA, [5n, 2n, LONG, BYTES, HOLDER]), at)
    const kept = withoutMemo(addition)
    expect(kept.data).toBe(encodeAbiParameters(ADDITION_DATA, [5n, 2n, '', '0x', HOLDER]))
    expect({ ...kept, data: addition.data }).toEqual(addition)
  })

  it('keeps a fee, which has nothing free-form, and a log that does not decode, as they are', () => {
    const fee = raw([PROCESS_FEE, topic(42n), topic(HOLDER), topic(1n)], words(false, HOLDER, HOLDER), at)
    expect(withoutMemo(fee)).toBe(fee)
    const broken = raw([PAY, topic(1n), topic(2n), topic(42n)], '0x1234', at)
    expect(withoutMemo(broken)).toBe(broken)
  })
})
