/**
 * What this browser keeps of a project's logs on its chain's terminal (`keptLogs`), so that a return visit, and a read
 * again after a send, scans only the blocks since. Only public events are kept, and nothing that belongs to a wallet.
 */

import { decodeEventLog, encodeAbiParameters, getAbiItem, type AbiEvent } from 'viem'
import type { ScannedLog } from '@/lib/hook-logs'
import { terminalEventsAbi } from '@/lib/sticky-abis'

/**
 * The key each of a project's terminal histories is kept under: its `fees`, the fees and additions to its balance over
 * its life, and its `moves`, its pays and cash outs over its life, which its chart reads when Bendystraw cannot answer
 * for them; and its `feed`, its pays and cash outs from the oldest event its Latest list shows, where that list finds
 * what each stick took in and each unstick paid out. Each is one filter's history.
 */
export function terminalHistoryKey(
  chainId: number,
  terminal: string,
  projectId: bigint,
  history: 'fees' | 'moves' | 'feed',
): string {
  return `${chainId}:${terminal.toLowerCase()}:${projectId}:${history}`
}

/** The fields of an event that are not topics, in order. */
const dataOf = (name: 'Pay' | 'CashOutTokens' | 'AddToBalance') =>
  (getAbiItem({ abi: terminalEventsAbi, name }) as AbiEvent).inputs.filter(input => !input.indexed)
const PAY_DATA = dataOf('Pay')
const CASH_OUT_DATA = dataOf('CashOutTokens')
const ADDITION_DATA = dataOf('AddToBalance')

/**
 * What a kept history holds of a terminal log: all of it but what anyone who pays a project, or adds to its balance, may
 * write as long as they like, which a pay's and an addition's memo and metadata and a cash out's metadata are. A history
 * longer than its size cap is not kept at all, so one long memo would otherwise keep a project's history out of every
 * browser. What is read from a kept log stays as it was: the amounts, the holder, the beneficiary and the counts. A log
 * of another event, a fee, or one that does not decode, is kept as it is.
 */
export function withoutMemo(log: ScannedLog): ScannedLog {
  let decoded: ReturnType<typeof decodeEventLog<typeof terminalEventsAbi>>
  try {
    decoded = decodeEventLog({ abi: terminalEventsAbi, topics: log.topics, data: log.data })
  } catch {
    return log
  }
  const { eventName, args } = decoded
  switch (eventName) {
    case 'Pay': {
      const { payer, beneficiary, amount, newlyIssuedTokenCount, caller } = args
      return { ...log, data: encodeAbiParameters(PAY_DATA, [payer, beneficiary, amount, newlyIssuedTokenCount, '', '0x', caller]) }
    }
    case 'CashOutTokens': {
      const { holder, beneficiary, cashOutCount, cashOutTaxRate, reclaimAmount, caller } = args
      const data = encodeAbiParameters(CASH_OUT_DATA, [holder, beneficiary, cashOutCount, cashOutTaxRate, reclaimAmount, '0x', caller])
      return { ...log, data }
    }
    case 'AddToBalance': {
      const { amount, returnedFees, caller } = args
      return { ...log, data: encodeAbiParameters(ADDITION_DATA, [amount, returnedFees, '', '0x', caller]) }
    }
    default:
      return log
  }
}
