/**
 * What the terminal says a stick will mint and an unstick will pay, which a review sends as the minimum the chain must
 * keep to. Both come from the terminal's own previews, asked as the holder will send the call, and never from an
 * estimate. A quote that cannot be read rejects, naming what could not be read and keeping the cause; it is never
 * filled in as zero.
 */

import { cashOutProtocolFee } from '@bananapus/nana-sdk-core/v6'
import { encodeFunctionData, type Address, type Hex } from 'viem'
import { untilAborted } from '@/lib/hook-logs'
import { jbCenterPublicClient } from '@/lib/jbcenter-rpc'
import { feelessAddressesAbi, stickyHookAbi, terminalAbi } from '@/lib/sticky-abis'
import { stickyDeployment, type StickyDeployment } from '@/lib/sticky-addresses'
import { formatAmount } from '@/lib/sticky-format'
import { backingOfShares, capped, type Answer, type StickyProjectInfo } from '@/lib/sticky-project'
import { need, readAt } from '@/lib/sticky-rewards'

type Cancel = { signal?: AbortSignal }

function deploymentOn(chainId: number): StickyDeployment {
  const deployment = stickyDeployment(chainId)
  if (!deployment) throw new Error(`Sticky is not deployed on chain ${chainId}.`)
  return deployment
}

/** Out of 10,000: a stickiness bonus of 100%, which an unstick cannot reclaim anything under. */
const MAX_TAX = 10_000n
/** A preview answers with the nine words of a ruleset and two amounts, and then where its hook list starts: twelve
 * words in. */
const HOOK_LIST_AT = 384n

/** The `index`th 32-byte word of an answer. */
const word = (data: Hex, index: number) => BigInt(`0x${data.slice(2 + index * 64, 2 + (index + 1) * 64)}`)

/** What `work` gives, or an error that names `what` and keeps the cause. A signal that has aborted stops it before it
 * starts, and its reason, like any it aborts with, is the caller's own and goes through as it is. */
export async function asked<T>(what: string, work: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  try {
    if (signal?.aborted) throw signal.reason
    return await untilAborted(work(), signal)
  } catch (cause) {
    if (signal?.aborted) throw cause
    throw new Error(`${what} could not be read.`, { cause })
  }
}

/** The raw answer of a preview asked as `account`, which a read through Multicall3 cannot do: there the terminal sees
 * Multicall3 as its caller. Both previews depend on the caller: a stick's on the payer the hook must trust, and an
 * unstick's on whether the terminal charges the holder its fee. */
async function previewAs(
  chainId: number,
  what: string,
  request: { account: Address; to: Address; data: Hex; blockNumber?: bigint },
  signal: AbortSignal | undefined,
): Promise<Hex> {
  const { data } = await asked(what, () => jbCenterPublicClient(chainId).call(request), signal)
  return data ?? '0x'
}

/**
 * The Sticky tokens that `payer` paying `amount` of `token` into a Sticky project would mint for `beneficiary`, from
 * the terminal's `previewPayFor`, which prices with the hook and its rounding, and refuses a payer who may not stick
 * for the beneficiary. A visitor without a wallet quotes as the zero address.
 *
 * The answer must be what a Sticky project's terminal gives: the ruleset's nine words, nothing reserved, and the hook
 * list where it belongs. An amount that mints nothing is refused.
 */
export async function quoteStick(
  chainId: number,
  projectId: bigint,
  token: Address,
  amount: bigint,
  payer: Address,
  beneficiary: Address,
  { signal }: Cancel = {},
): Promise<bigint> {
  const { terminal } = deploymentOn(chainId)
  const answer = await previewAs(
    chainId,
    "the terminal's stick preview",
    {
      account: payer,
      to: terminal,
      data: encodeFunctionData({
        abi: terminalAbi,
        functionName: 'previewPayFor',
        args: [projectId, token, amount, beneficiary, '0x'],
      }),
    },
    signal,
  )
  if (!/^0x(?:[0-9a-fA-F]{64}){13,}$/.test(answer) || word(answer, 11) !== HOOK_LIST_AT || word(answer, 10) !== 0n) {
    throw new Error('the terminal did not return a valid Sticky mint quote')
  }
  const count = word(answer, 9)
  if (count === 0n) {
    throw new Error('this amount is too small or cannot be priced precisely enough at the current backing price')
  }
  return count
}

/**
 * Whether `sender` may stick for `beneficiary` in a project: they are the same, or the sender is one of the project's
 * granters, or the beneficiary trusts the sender. It rejects with why not, in words: the hook refuses any other payer
 * with a revert that says nothing a holder can act on.
 */
export async function assertCanStickFor(
  chainId: number,
  projectId: bigint,
  sender: Address,
  beneficiary: Address,
  { signal }: Cancel = {},
): Promise<void> {
  if (sender.toLowerCase() === beneficiary.toLowerCase()) return
  const { hook } = deploymentOn(chainId)
  const [granter, trusted] = (await asked(
    "the hook's record of who may stick for them",
    () =>
      readAt(
        chainId,
        [
          { address: hook, abi: stickyHookAbi, functionName: 'isGranterOf', args: [projectId, sender] },
          {
            address: hook,
            abi: stickyHookAbi,
            functionName: 'isTrustedSenderOf',
            args: [projectId, beneficiary, sender],
          },
        ],
        undefined,
        signal,
      ),
    signal,
  )) as Answer<boolean>[]
  if (!need(granter, 'your standing as a granter of the project') && !need(trusted, "the holder's trust in you")) {
    throw new Error('this holder must trust your address before you can stick for them')
  }
}

/** What unsticking some Sticky tokens pays, in the staked token's units, read at `blockNumber`. */
export type UnstickQuote = {
  /** What the terminal reclaims for the tokens, before its fee. */
  gross: bigint
  /** The stickiness bonus applied, out of 10,000. */
  tax: bigint
  fee: bigint
  /** What the holder receives: `gross` less `fee`. This is the minimum a review sends. */
  net: bigint
  /** The holder pays no fee. */
  feeless: boolean
  blockNumber: bigint
}

/**
 * What `holder` would receive for unsticking `count` Sticky tokens of a project, from the terminal's views at one
 * block: `previewCashOutFrom` gives the gross and the tax, asked as the holder, and the terminal's fee rule takes its
 * part. A feeless holder pays none. With a tax the fee is on the whole reclaim, and without one only on the part
 * `feeFreeSurplusOf` covers. The answer must be what the terminal gives: the ruleset's nine words, a tax of at most
 * 100%, and no hooks.
 */
export async function quoteUnstick(
  chainId: number,
  projectId: bigint,
  token: Address,
  holder: Address,
  count: bigint,
  { signal }: Cancel = {},
): Promise<UnstickQuote> {
  const { terminal } = deploymentOn(chainId)
  // The head is asked afresh: a quote is sent on as a minimum, and one from a cached block may be stale.
  const client = jbCenterPublicClient(chainId)
  const blockNumber = await asked('the current block', () => client.getBlockNumber({ cacheTime: 0 }), signal)
  const [answer, rule] = await Promise.all([
    previewAs(
      chainId,
      "the terminal's unstick preview",
      {
        account: holder,
        to: terminal,
        data: encodeFunctionData({
          abi: terminalAbi,
          functionName: 'previewCashOutFrom',
          args: [holder, projectId, count, token, holder, '0x'],
        }),
        blockNumber,
      },
      signal,
    ),
    asked(
      "the terminal's fee rule",
      () =>
        readAt(
          chainId,
          [
            { address: terminal, abi: terminalAbi, functionName: 'feeFreeSurplusOf', args: [projectId, token] },
            { address: terminal, abi: terminalAbi, functionName: 'FEELESS_ADDRESSES' },
          ],
          blockNumber,
          signal,
        ),
      signal,
    ),
  ])
  const feeFreeSurplus = need(rule[0] as Answer<bigint>, 'the fee-free surplus')
  const registry = need(rule[1] as Answer<Address>, "the terminal's registry of feeless addresses")
  if (!/^0x(?:[0-9a-fA-F]{64}){13}$/.test(answer) || word(answer, 11) !== HOOK_LIST_AT || word(answer, 12) !== 0n) {
    throw new Error('the terminal did not return a valid unstick quote')
  }
  const gross = word(answer, 9)
  const tax = word(answer, 10)
  if (tax > MAX_TAX) throw new Error('the terminal did not return a valid unstick quote')
  const [feelessAnswer] = await asked(
    "the holder's fee status",
    () =>
      readAt(
        chainId,
        [
          {
            address: registry,
            abi: feelessAddressesAbi,
            functionName: 'isFeelessFor',
            args: [holder, projectId, holder],
          },
        ],
        blockNumber,
        signal,
      ),
    signal,
  )
  const feeless = need(feelessAnswer as Answer<boolean>, "the holder's fee status")
  const fee = cashOutProtocolFee({
    reclaimAmount: gross,
    cashOutTaxRate: tax,
    beneficiaryIsFeeless: feeless,
    feeFreeSurplus,
  })
  return { gross, tax, fee, net: gross - fee, feeless, blockNumber }
}

/** What a stick mints at least, for the dialog: to the holder, or to `forSomeoneElse`. A full bonus adds what it means
 * for the way out. */
export function stickQuoteSentence(
  minted: bigint,
  { stSymbol, cashOutTaxRate }: Pick<StickyProjectInfo, 'stSymbol' | 'cashOutTaxRate'>,
  forSomeoneElse = false,
): string {
  return (
    `${forSomeoneElse ? 'They get' : 'You get'} at least ${formatAmount(minted, 18)} ${capped(stSymbol)}` +
    (cashOutTaxRate === MAX_TAX ? '. Unsticking returns nothing at a 100% bonus.' : '')
  )
}

/**
 * What unsticking `count` Sticky tokens pays, for the dialog: what the holder gets, what of their share stays with the
 * holders who remain (the bonus), and what the protocol fee takes or why it takes none. A `count` above the supply is
 * the whole of it.
 */
export function unstickQuoteSentence(
  { gross, fee, net, feeless }: UnstickQuote,
  count: bigint,
  info: Pick<StickyProjectInfo, 'symbol' | 'decimals' | 'totalSupply' | 'backing'>,
): string {
  const amount = (value: bigint) => `${formatAmount(value, info.decimals)} ${capped(info.symbol)}`
  const share = backingOfShares(count < info.totalSupply ? count : info.totalSupply, info)
  const stays = share > gross ? share - gross : 0n
  return (
    `You get ${amount(net)}.` +
    (stays > 0n ? ` ${amount(stays)} stays with the holders who remain.` : '') +
    (fee > 0n
      ? ` ${amount(fee)} goes to the protocol fee.`
      : feeless
        ? ' No protocol fee for this wallet.'
        : ' No protocol fee on this unstick.') +
    ' The review uses this as your minimum.'
  )
}
