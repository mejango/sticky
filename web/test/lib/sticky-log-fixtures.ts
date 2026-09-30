import { pad, toHex, type Address, type Hex } from 'viem'
import type { ScannedLog } from '@/lib/hook-logs'
import { stickyDeployment } from '@/lib/sticky-addresses'

// Hook and deployer logs written by hand, for the sticky-events tests.

export const CHAIN = 8453
export const deployment = stickyDeployment(CHAIN)!
export const HOOK = deployment.hook
export const DEPLOYER = deployment.deployer
export const HOLDER = `0x${'a'.repeat(40)}` as Address
export const OTHER = `0x${'b'.repeat(40)}` as Address
export const SENDER = `0x${'c'.repeat(40)}` as Address
export const GRANTER = `0x${'d'.repeat(40)}` as Address
export const STAKED_TOKEN = `0x${'e'.repeat(40)}` as Address
/** Where project 23 was created in these tests. A log is ten blocks later unless it says otherwise. */
export const CREATED = 51_900_000n

// The topics the old client read these events by, precomputed with `cast keccak` (webclient/app.js:82-98).
// The logs are written from them by hand, so decoding is checked against the old client's field layout
// rather than against the encoder of the library that decodes.
export const TOPIC = {
  DeploySticky: '0xc00d5094bed981d0f08872f495cb40cf20020621153d33b7b379d10c953e59a1',
  Staked: '0xd6d3230e3db876114bd3eea9c8a9b54a70c8263b762d4086170e2089e4506aa9',
  Unstaked: '0x169f9c267fbc671daf3188c40c7ac44f00fbd8d51133fe23364b771c207297cc',
  StreakStarted: '0xbf35648fc2c3b2611046bd0e40788ec1f1ccec09ab1d1188dd0ce73b8683009d',
  StreakEnded: '0x633ff8e26572566ae370cee18c8b3c0a5370f533bb490764ab6586c0a404e4ea',
  SetGranter: '0xb1493c7092cfd1c7e27c08ccd5e2f65f3408075032bdcc2983702abb376f9521',
  SetTrustedSender: '0x19cb6ea1a683846f033314fc7883a280ffee4abf9e75f0c699a947575f182e69',
  ExcludeOrphanedBalance: '0xa0b9b2db99d31a6b0fbb43cedfc627f78ae7c1b1f39d286ed7c61b5c9bba83fa',
} as const satisfies Record<string, Hex>
// The old client's filters, in its order (app.js:1079 and 1112).
export const POSITION_TOPICS = [TOPIC.Staked, TOPIC.Unstaked, TOPIC.StreakStarted, TOPIC.StreakEnded]
export const PROJECT_TOPICS = [...POSITION_TOPICS, TOPIC.SetGranter, TOPIC.SetTrustedSender, TOPIC.ExcludeOrphanedBalance]
/** SetToken, which the hook also emits and which is nobody's history. */
export const SET_TOKEN = '0x768e177d7f9dac714049e6d43d9ac533cf0c6cc23cddcfe642bfd7a18bee3772'

export const word = (value: bigint | string | boolean) =>
  BigInt(typeof value === 'boolean' ? Number(value) : value)
    .toString(16)
    .padStart(64, '0')
export const topic = (value: bigint | string): Hex => `0x${word(value)}`
export const words = (...values: (bigint | string | boolean)[]): Hex => `0x${values.map(word).join('')}`

export type At = {
  txHash?: string
  logIndex?: number
  blockNumber?: bigint
  address?: Address
  project?: bigint
  /** The block's time, or null for a log that came without one. */
  time?: bigint | null
}

/** A log as the scanner hands it back: in a block, with that block's time, which Center sends with every log. */
export function raw(topics: Hex[], data: Hex, at: At = {}): ScannedLog {
  const blockNumber = at.blockNumber ?? CREATED + 10n
  const logIndex = at.logIndex ?? 0
  return {
    address: at.address ?? HOOK,
    blockHash: pad(toHex(blockNumber + 0x1000n), { size: 32 }),
    blockNumber,
    ...(at.time === null ? {} : { blockTimestamp: at.time ?? 1_000_000n + blockNumber }),
    data,
    logIndex,
    removed: false,
    topics: topics as ScannedLog['topics'],
    transactionHash: (at.txHash ?? pad(toHex(blockNumber * 1_000n + BigInt(logIndex)), { size: 32 })) as Hex,
    transactionIndex: 0,
  }
}

const of = (at: At) => topic(at.project ?? 23n)
// Each event's fields that are not topics, in order. Each ends with the caller the hook recorded.
export const staked = (holder: Address, payer: Address, count: bigint, balance: bigint, at: At = {}) =>
  raw([TOPIC.Staked, of(at), topic(holder)], words(payer, count, balance, DEPLOYER), at)
export const unstaked = (holder: Address, count: bigint, balance: bigint, at: At = {}) =>
  raw([TOPIC.Unstaked, of(at), topic(holder)], words(count, balance, holder), at)
export const streakStarted = (holder: Address, at: At = {}) =>
  raw([TOPIC.StreakStarted, of(at), topic(holder)], words(DEPLOYER), at)
export const streakEnded = (holder: Address, length: bigint, at: At = {}) =>
  raw([TOPIC.StreakEnded, of(at), topic(holder)], words(length, holder), at)
export const granterSet = (granter: Address, at: At = {}) =>
  raw([TOPIC.SetGranter, of(at), topic(granter)], words(DEPLOYER), at)
export const trustSet = (holder: Address, sender: Address, trusted: boolean, at: At = {}) =>
  raw([TOPIC.SetTrustedSender, of(at), topic(holder), topic(sender)], words(trusted), at)
export const orphanExcluded = (amount: bigint, at: At = {}) =>
  raw([TOPIC.ExcludeOrphanedBalance, of(at)], words(amount, OTHER), at)
/** A DeploySticky, from the deployer unless `at` says otherwise: the project and its staked token as topics, then
 * its Sticky token, bonus, transfer mode and caller. */
export const deploySticky = (projectId: bigint, at: At = {}) =>
  raw([TOPIC.DeploySticky, topic(projectId), topic(STAKED_TOKEN)], words(OTHER, 500n, false, HOLDER), {
    address: DEPLOYER,
    ...at,
  })
