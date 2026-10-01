'use client'

import { useState } from 'react'
import { zeroAddress, type AbiFunction, type AbiParameter } from 'viem'
import {
  describeJBHookMetadata,
  describePermissionsData,
  describeSafeInitializer,
  describeSafeInnerCall,
  describeSplitGroups,
  describeSuckerClaim,
  describeUniversalRouterExecute,
  describeV4UnlockData,
  functionFromCall,
  knownAddressName,
  namedValue,
  nativeValue,
  readableValue,
  reviewDescription,
  type PrettyStep,
  type V4PlanStep,
} from '@bananapus/nana-sdk-core/review/decode'
import { ChainIcon } from '@/components/ChainIcon'
import {
  ModalCloseButton,
  ModalDialog,
} from '@/components/ui/ModalShell'
import {
  buildTransactionReviewPrompt,
  transactionReviewJson,
  type TransactionReviewCall,
} from '@/lib/transaction-review'
import { chainName } from '@/lib/urn'

import { FeeBuybackNotice, useFeeBuybackReview } from './FeeBuybackNotice'

import type { PendingReview, PendingFundingChainSelection, TransactionReviewDialogProps } from './TransactionReviewProvider'

function knownContractName(call: TransactionReviewCall): string | null {
  return call.contractName ?? knownAddressName(call.chainId, call.to)
}

function hasComponents(
  parameter: AbiParameter,
): parameter is AbiParameter & { components: readonly AbiParameter[] } {
  return 'components' in parameter && Array.isArray(parameter.components)
}

function ArgumentValue({
  parameter,
  value,
  chainId,
  depth = 0,
}: {
  parameter: AbiParameter
  value: unknown
  chainId: number
  depth?: number
}) {
  const arrayMatch = parameter.type.match(/^(.*)\[(\d*)\]$/)
  if (arrayMatch && Array.isArray(value)) {
    const itemParameter = {
      ...parameter,
      type: arrayMatch[1],
    } as AbiParameter
    return (
      <div className="mt-2 space-y-2 border-l border-smoke-200 pl-3">
        {value.length ? (
          value.map((item, index) => (
            <div key={index}>
              <p className="font-mono text-[11px] font-medium text-smoke-600">
                [{index}]
              </p>
              <ArgumentValue
                parameter={itemParameter}
                value={item}
                chainId={chainId}
                depth={depth + 1}
              />
            </div>
          ))
        ) : (
          <span className="font-mono text-xs text-smoke-600">[]</span>
        )}
      </div>
    )
  }

  if (hasComponents(parameter)) {
    return (
      <div className="mt-2 space-y-2 border-l border-smoke-200 pl-3">
        {parameter.components.map((component, index) => (
          <ArgumentRow
            key={`${component.name || 'field'}-${index}`}
            parameter={component}
            value={namedValue(value, component.name ?? '', index)}
            chainId={chainId}
            depth={depth + 1}
          />
        ))}
      </div>
    )
  }

  return (
    <p className="break-all font-mono text-xs leading-relaxed text-ink">
      {readableValue(parameter.type, value, chainId)}
    </p>
  )
}

/** The pay-confirm row grammar: `Label: value`, addresses resolved to known names. */
function V4PlanRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-1">
      <dt className="shrink-0 text-smoke-500">{label}:</dt>
      <dd className="min-w-0 break-all font-mono text-smoke-700">{children}</dd>
    </div>
  )
}

/** "Name | 0x…" for a known address, otherwise the address. */
function addressLabel(chainId: number, address: string): string {
  const label = knownAddressName(chainId, address)
  return label ? `${label} | ${address}` : address
}

/** A Uniswap currency, where address zero is native ETH. An owner, hook or recipient never is. */
function currencyLabel(chainId: number, currency: string): string {
  return currency.toLowerCase() === zeroAddress
    ? `native ETH | ${currency}`
    : addressLabel(chainId, currency)
}

/** Unix seconds as UTC plus the raw value, the way the decoded rows show every time. */
function utcTime(seconds: bigint): string {
  if (seconds > 8_640_000_000_000n) return `${seconds} (after year 275760)`
  const time = new Date(Number(seconds) * 1000).toISOString()
  return `${time.replace('.000Z', ' UTC').replace('T', ' ')} (${seconds})`
}

function v4Amounts(pair: { currency0: bigint; currency1: bigint }): string {
  return `${pair.currency0} (currency0) + ${pair.currency1} (currency1)`
}

/** A decoded unlockData plan in the same row grammar the pay confirm uses. */
function V4PlanView({ steps, chainId }: { steps: V4PlanStep[]; chainId: number }) {
  return (
    <div className="mt-1 space-y-3 text-xs">
      {steps.map((step, index) => {
        const title = (text: string) => (
          <p className="font-medium text-ink">
            {index + 1}. {text}
          </p>
        )
        switch (step.action) {
          case 'INCREASE_LIQUIDITY':
            return (
              <dl key={index} className="space-y-0.5">
                {title(`Increase position ${step.position}`)}
                <V4PlanRow label="Liquidity added">{String(step.liquidity)}</V4PlanRow>
                <V4PlanRow label="Maximum in">
                  {v4Amounts(step.maximumIn)} — reverts above this
                </V4PlanRow>
              </dl>
            )
          case 'BURN_POSITION':
            return (
              <dl key={index} className="space-y-0.5">
                {title(`Burn position ${step.position}`)}
                <V4PlanRow label="Minimum out">
                  {v4Amounts(step.minimumOut)} — reverts below this
                </V4PlanRow>
              </dl>
            )
          case 'DECREASE_LIQUIDITY':
            return (
              <dl key={index} className="space-y-0.5">
                {title(
                  step.liquidity === 0n
                    ? `Collect fees on position ${step.position} (liquidity untouched)`
                    : `Decrease position ${step.position}`,
                )}
                {step.liquidity !== 0n ? (
                  <>
                    <V4PlanRow label="Liquidity">{String(step.liquidity)}</V4PlanRow>
                    <V4PlanRow label="Minimum out">
                      {v4Amounts(step.minimumOut)} — reverts below this
                    </V4PlanRow>
                  </>
                ) : null}
              </dl>
            )
          case 'MINT_POSITION':
            return (
              <dl key={index} className="space-y-0.5">
                {title('Mint a new position')}
                <V4PlanRow label="Owner">{addressLabel(chainId, step.owner)}</V4PlanRow>
                <V4PlanRow label="Currency0">
                  {currencyLabel(chainId, step.pool.currency0)}
                </V4PlanRow>
                <V4PlanRow label="Currency1">
                  {currencyLabel(chainId, step.pool.currency1)}
                </V4PlanRow>
                <V4PlanRow label="Fee">
                  {step.pool.fee} ({step.pool.fee / 10_000}%) | tick spacing {step.pool.tickSpacing}
                </V4PlanRow>
                <V4PlanRow label="Hook">{addressLabel(chainId, step.pool.hook)}</V4PlanRow>
                <V4PlanRow label="Ticks">
                  {step.ticks.lower} → {step.ticks.upper}
                </V4PlanRow>
                <V4PlanRow label="Liquidity">{String(step.liquidity)}</V4PlanRow>
                <V4PlanRow label="Maximum in">{v4Amounts(step.maximumIn)}</V4PlanRow>
              </dl>
            )
          case 'TAKE_PAIR':
            return (
              <dl key={index} className="space-y-0.5">
                {title('Take both currencies')}
                <V4PlanRow label="Currency0">
                  {currencyLabel(chainId, step.currency0)}
                </V4PlanRow>
                <V4PlanRow label="Currency1">
                  {currencyLabel(chainId, step.currency1)}
                </V4PlanRow>
                <V4PlanRow label="Recipient">{addressLabel(chainId, step.recipient)}</V4PlanRow>
              </dl>
            )
          case 'CLOSE_CURRENCY':
            return (
              <dl key={index} className="space-y-0.5">
                {title('Close currency — settle the net; leftovers return to the caller')}
                <V4PlanRow label="Currency">{currencyLabel(chainId, step.currency)}</V4PlanRow>
              </dl>
            )
          case 'SWEEP':
            return (
              <dl key={index} className="space-y-0.5">
                {title('Sweep — refund unused balance')}
                <V4PlanRow label="Currency">{currencyLabel(chainId, step.currency)}</V4PlanRow>
                <V4PlanRow label="Recipient">{addressLabel(chainId, step.recipient)}</V4PlanRow>
              </dl>
            )
        }
      })}
      <p className="text-smoke-500">The exact bytes are in the raw payload below.</p>
    </div>
  )
}

function ArgumentRow({
  parameter,
  value,
  chainId,
  depth = 0,
}: {
  parameter: AbiParameter
  value: unknown
  chainId: number
  depth?: number
}) {
  return (
    <div className={depth ? '' : 'rounded-lg bg-grey-25 px-3 py-2.5'}>
      <p className="text-xs font-medium text-smoke-700">
        {parameter.name || 'argument'}{' '}
        <span className="font-mono font-normal text-smoke-500">
          {parameter.type}
        </span>
      </p>
      <ArgumentValue parameter={parameter} value={value} chainId={chainId} depth={depth} />
    </div>
  )
}

/** A decoded Universal Router plan in the same row grammar as everything else. */
function UrPlanView({ steps, deadline }: { steps: PrettyStep[]; deadline?: unknown }) {
  return (
    <div className="mt-3 space-y-3 text-xs">
      {steps.map((step, index) => (
        <dl key={index} className="space-y-0.5">
          <p className="font-medium text-ink">
            {index + 1}. {step.title}
          </p>
          {step.rows.map(([label, value]) => (
            <V4PlanRow key={label} label={label}>
              {value}
            </V4PlanRow>
          ))}
        </dl>
      ))}
      {typeof deadline === 'bigint' || typeof deadline === 'number' ? (
        <dl className="space-y-0.5">
          <V4PlanRow label="Deadline">{utcTime(BigInt(deadline))}</V4PlanRow>
        </dl>
      ) : null}
      <p className="text-smoke-500">The exact bytes are in the raw payload below.</p>
    </div>
  )
}

/** Route an argument to its precise decoded view, or null for the raw default. */
function specialArgumentView(
  call: TransactionReviewCall,
  fn: AbiFunction,
  inputName: string,
  argumentIndex: number,
): React.ReactNode | null {
  const value = call.args?.[argumentIndex]
  if (fn.name === 'modifyLiquidities' && inputName === 'unlockData') {
    const steps = describeV4UnlockData(value)
    if (steps) return <V4PlanView steps={steps} chainId={call.chainId} />
  }
  if ((fn.name === 'pay' || fn.name === 'addToBalanceOf') && inputName === 'metadata') {
    const steps = describeJBHookMetadata('pay', value)
    if (steps) return <UrPlanView steps={steps} />
  }
  if (fn.name === 'cashOutTokensOf' && inputName === 'metadata') {
    const steps = describeJBHookMetadata('cashOut', value)
    if (steps) return <UrPlanView steps={steps} />
  }
  if (fn.name === 'claim') {
    const steps = describeSuckerClaim(call.chainId, value)
    if (steps) return <UrPlanView steps={steps} />
  }
  if (fn.name === 'execTransaction' && inputName === 'data') {
    const steps = describeSafeInnerCall(call.chainId, call.args?.[0], value)
    if (steps) return <UrPlanView steps={steps} />
  }
  if (fn.name === 'execTransaction' && inputName === 'operation') {
    return (
      <pre className="mt-1 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-smoke-700">
        {value === 1 || value === 1n
          ? "1 — DELEGATECALL: runs foreign code with the Safe's own storage and funds"
          : value === 0 || value === 0n
            ? '0 — CALL'
            : String(value)}
      </pre>
    )
  }
  if (fn.name === 'createProxyWithNonce' && inputName === 'initializer') {
    const steps = describeSafeInitializer(call.chainId, value)
    if (steps) return <UrPlanView steps={steps} />
  }
  if (fn.name === 'setPermissionsFor' && inputName === 'permissionsData') {
    const steps = describePermissionsData(call.chainId, value)
    if (steps) return <UrPlanView steps={steps} />
  }
  if (fn.name === 'setSplitGroupsOf' && inputName === 'splitGroups') {
    const steps = describeSplitGroups(call.chainId, value)
    if (steps) return <UrPlanView steps={steps} />
  }
  if (inputName === 'transactions' && nestsCallsInArgument(fn) && call.calls?.length) {
    return <NestedCalls calls={call.calls} />
  }
  return null
}

/** MultiSend's `transactions` argument is where its decoded calls show. */
function nestsCallsInArgument(fn: AbiFunction | null): boolean {
  return fn?.name === 'multiSend' && fn.inputs.some(input => input.name === 'transactions')
}

function NestedCalls({ calls }: { calls: readonly TransactionReviewCall[] }) {
  return (
    <div className="mt-2 space-y-3">
      {calls.map((inner, index) => (
        <PrettyCall key={index} call={inner} index={index} total={calls.length} nested />
      ))}
    </div>
  )
}

function PrettyCall({
  call,
  index,
  total,
  nested = false,
}: {
  call: TransactionReviewCall
  index: number
  total: number
  /** One call inside a batch: numbered as a call, no chain chip of its own. */
  nested?: boolean
}) {
  const fn = functionFromCall(call)
  const args = call.args ?? []
  const byteLength = Math.max(0, (call.data.length - 2) / 2)
  const contractName = knownContractName(call)
  // Decoded calls show in MultiSend's `transactions` argument, and below any other call.
  const batched = call.calls?.length && !nestsCallsInArgument(fn) ? call.calls : null
  return (
    <section className="rounded-xl border border-smoke-200 bg-white p-4 sm:p-5">
      {total > 1 ? (
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-smoke-500">
          {nested ? 'Call' : 'Transaction'} {index + 1} of {total}
        </p>
      ) : null}
      {nested ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="chip flex items-center gap-1.5 bg-bluebs-50 text-bluebs-700">
            <ChainIcon chainId={call.chainId} size={16} />
            {chainName(call.chainId)}
          </span>
          <span className="font-mono text-[11px] text-smoke-500">
            chain {call.chainId}
          </span>
        </div>
      )}

      {call.label ? (
        <h3 className="mt-3 font-agrandir text-base font-medium text-ink">
          {call.label}
        </h3>
      ) : null}

      <dl className="mt-4 space-y-3 text-sm">
        {call.from ? (
          <div>
            <dt className="text-xs font-medium text-smoke-600">From</dt>
            <dd className="mt-1 break-all font-mono text-xs text-ink">
              {call.from}
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="text-xs font-medium text-smoke-600">
            Destination{contractName ? ` | ${contractName}` : ''}
          </dt>
          <dd className="mt-1 break-all font-mono text-xs text-ink">{call.to}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-smoke-600">Native value</dt>
          <dd className="mt-1 font-mono text-xs text-ink">
            {nativeValue(call.value)}
          </dd>
        </div>
        {call.safeTxGas !== undefined ? (
          <div>
            <dt className="text-xs font-medium text-smoke-600">Safe gas</dt>
            <dd className="mt-1 font-mono text-xs text-ink">
              {call.safeTxGas.toLocaleString('en-US')}
            </dd>
            {call.safeTxGas !== 0n ? (
              <dd className="mt-1 text-xs text-split-800">
                If this call fails, the Safe still executes and uses this nonce.
              </dd>
            ) : null}
          </div>
        ) : null}
        {call.gas !== undefined ? (
          <div>
            <dt className="text-xs font-medium text-smoke-600">Gas limit</dt>
            <dd className="mt-1 font-mono text-xs text-ink">
              {call.gas.toLocaleString('en-US')}
            </dd>
          </div>
        ) : null}
      </dl>

      {fn ? (
        <div className="mt-5 border-t border-smoke-200 pt-4">
          <p className="text-xs font-medium text-smoke-600">Contract function</p>
          <p className="mt-1 break-all font-mono text-sm font-medium text-ink">
            {fn.name}(
            {fn.inputs.map(input => input.type).join(', ')})
          </p>
          {fn.name === 'execute' &&
          describeUniversalRouterExecute(call.chainId, args) ? (
            <UrPlanView
              steps={describeUniversalRouterExecute(call.chainId, args)!}
              deadline={args[2]}
            />
          ) : fn.inputs.length ? (
            <div className="mt-3 space-y-2">
              {fn.inputs.map((parameter, argumentIndex) => {
                const special = specialArgumentView(
                  call,
                  fn,
                  parameter.name ?? '',
                  argumentIndex,
                )
                if (special) {
                  return (
                    <div
                      key={`${parameter.name || 'argument'}-${argumentIndex}`}
                      className="rounded-lg bg-grey-25 px-3 py-2.5"
                    >
                      <p className="text-xs font-medium text-smoke-700">
                        {parameter.name}{' '}
                        <span className="font-mono font-normal text-smoke-500">
                          {parameter.type}, decoded
                        </span>
                      </p>
                      {special}
                    </div>
                  )
                }
                return (
                  <ArgumentRow
                    key={`${parameter.name || 'argument'}-${argumentIndex}`}
                    parameter={parameter}
                    value={args[argumentIndex]}
                    chainId={call.chainId}
                  />
                )
              })}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-5 rounded-lg bg-split-50 p-3 text-xs leading-relaxed text-split-800">
          <p className="font-medium">
            This call’s ABI is not available in this flow. Check the complete
            calldata in Raw before continuing.
          </p>
          <p className="mt-1 font-mono">
            {call.data === '0x' ? 'No calldata' : `Selector ${call.data.slice(0, 10)}`}
          </p>
        </div>
      )}

      {batched ? (
        <div className="mt-5 border-t border-smoke-200 pt-4">
          <p className="text-xs font-medium text-smoke-600">Calls it makes, in order</p>
          <NestedCalls calls={batched} />
        </div>
      ) : null}

      <p className="mt-3 text-[11px] text-smoke-500">
        Calldata: {byteLength.toLocaleString('en-US')} byte{byteLength === 1 ? '' : 's'}
      </p>
    </section>
  )
}

function ReviewModal({
  pending,
  onFinish,
}: {
  pending: PendingReview
  onFinish: (approved: boolean) => void
}) {
  const { request } = pending
  const feeReview = useFeeBuybackReview(request.calls)
  const [agreed, setAgreed] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(buildTransactionReviewPrompt(request))
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
    window.setTimeout(() => setCopyState('idle'), 2200)
  }

  const titleId = `transaction-review-title-${pending.id}`
  const descriptionId = `transaction-review-description-${pending.id}`
  const isAuthorization = request.kind === 'authorization'
  /** Some authorizations are signed as a plain message rather than typed data. */
  const signsMessage =
    (request.authorization as { kind?: string } | undefined)?.kind === 'message'

  return (
    <ModalDialog
      onClose={() => onFinish(false)}
      labelledBy={titleId}
      describedBy={descriptionId}
      className="items-start justify-center px-3 py-4 sm:px-6 sm:py-8"
    >
      <div
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-smoke-300 bg-bone shadow-2xl sm:max-h-[calc(100vh-4rem)]"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-smoke-200 bg-white px-4 py-4 sm:px-6">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-bluebs-600">
              Client safety check
            </p>
            <h2
              id={titleId}
              className="mt-1 font-agrandir text-xl font-medium text-ink"
            >
              {request.title ??
                (isAuthorization ? 'Review authorization' : 'Review transaction')}
            </h2>
          </div>
          <ModalCloseButton
            onClick={() => onFinish(false)}
            aria-label="Cancel transaction review"
            className="-mr-2 -mt-2"
          />
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          <div className="rounded-xl border border-bluebs-100 bg-bluebs-25 px-4 py-3">
            <p
              id={descriptionId}
              className="whitespace-pre-line text-sm leading-relaxed text-bluebs-800"
            >
              {reviewDescription(request)}
            </p>
          </div>
          {request.authorization ? (
            <div className="mt-3 rounded-xl border border-bluebs-100 bg-bluebs-25 px-4 py-3 text-xs leading-relaxed text-bluebs-700">
              {signsMessage
                ? 'The Raw view also includes the exact message your signature commits to.'
                : 'The Raw view also includes the exact typed-data domain and message your signature commits to.'}
            </div>
          ) : null}

          <div className="mt-5 flex justify-end">
            <button
              type="button"
              onClick={copyPrompt}
              className="btn-link min-h-[36px] text-xs"
            >
              {copyState === 'copied'
                ? 'Prompt copied — paste into your LLM'
                : copyState === 'failed'
                  ? 'Could not copy prompt'
                  : '[copy tx audit prompt]'}
            </button>
          </div>

          <div className="mt-4 space-y-4">
            {request.calls.map((call, index) => (
              <PrettyCall
                key={`${call.chainId}-${call.to}-${index}`}
                call={call}
                index={index}
                total={request.calls.length}
              />
            ))}
          </div>

          <details className="mt-4 overflow-hidden rounded-xl border border-smoke-200 bg-white">
            <summary className="cursor-pointer px-4 py-3 text-xs font-medium text-smoke-700 hover:bg-grey-25">
              Raw transaction payload
            </summary>
            <div className="border-t border-smoke-200 p-4">
              <p className="mb-2 text-xs leading-relaxed text-smoke-600">
                {request.authorization
                  ? signsMessage
                    ? 'The exact message your signature commits to, plus the resulting app-controlled call. Hex value is the native token amount; data is the complete calldata.'
                    : 'Exact typed data plus the resulting app-controlled call. Hex value is the native token amount; data is the complete calldata.'
                  : 'Exact app-controlled JSON-RPC call fields. Hex value is the native token amount; data is the complete calldata.'}
              </p>
              <pre className="max-h-[28rem] overflow-auto rounded-xl border border-smoke-200 bg-grey-900 p-4 font-mono text-[11px] leading-relaxed text-grey-25">
                {transactionReviewJson(request)}
              </pre>
            </div>
          </details>
        </div>

        <footer className="shrink-0 border-t border-smoke-200 bg-white px-4 py-4 sm:px-6">
          <FeeBuybackNotice review={feeReview} />
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-smoke-200 bg-grey-25 p-3 text-sm leading-relaxed text-ink">
            <input
              type="checkbox"
              checked={agreed}
              onChange={event => setAgreed(event.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0"
            />
            <span>
              I reviewed the chain, destination, native value, and calldata
              {request.authorization
                ? signsMessage
                  ? ', plus the exact message your signature commits to'
                  : ', plus the exact typed data'
                : ''}. I
              agree to {isAuthorization ? 'authorize' : 'send'} this exact call.
            </span>
          </label>
          <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => onFinish(false)}
              className="btn-secondary min-h-[44px] px-5 text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={async () => { if (await feeReview.confirm()) onFinish(true) }}
              disabled={!agreed || feeReview.busy}
              className="btn-primary min-h-[44px] px-5 text-sm"
            >
              {feeReview.confirmLabel ?? request.confirmLabel ??
                (isAuthorization ? 'Agree & authorize' : 'Agree & continue')}
            </button>
          </div>
        </footer>
      </div>
    </ModalDialog>
  )
}

function FundingChainSelectionModal({
  pending,
  onFinish,
}: {
  pending: PendingFundingChainSelection
  onFinish: (chainId: number | null) => void
}) {
  const [selected, setSelected] = useState(String(pending.initialChainId ?? ''))
  const selectedOption = pending.options.find(
    option => String(option.chainId) === selected,
  )
  const titleId = `funding-chain-title-${pending.id}`
  const descriptionId = `funding-chain-description-${pending.id}`
  const selectId = `funding-chain-select-${pending.id}`

  return (
    <ModalDialog
      onClose={() => onFinish(null)}
      labelledBy={titleId}
      describedBy={descriptionId}
      className="items-start justify-center px-3 py-5 sm:px-6 sm:py-10"
    >
      <div className="card w-full max-w-lg overflow-hidden shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-smoke-200 px-5 py-4 sm:px-6">
          <h2 id={titleId} className="font-agrandir text-xl font-medium text-ink">
            Choose where to pay
          </h2>
          <ModalCloseButton
            onClick={() => onFinish(null)}
            aria-label="Cancel funding chain selection"
            className="-mr-2 -mt-2"
          />
        </header>
        <div className="px-5 py-5 sm:px-6">
          <p id={descriptionId} className="text-sm leading-relaxed text-smoke-700">
            One payment covers every chain. You’ll review it before your wallet sends it.
          </p>
          <label
            htmlFor={selectId}
            className="mt-5 block text-sm font-medium text-ink"
          >
            Pay on
          </label>
          <select
            id={selectId}
            value={selected}
            onChange={event => setSelected(event.target.value)}
            className="select-caret mt-2 min-h-[44px] w-full rounded-lg border border-smoke-300 bg-white px-3 py-2 pr-9 text-sm text-ink"
          >
            <option value="" disabled>Choose a chain</option>
            {pending.options.map(option => (
              <option key={option.chainId} value={option.chainId}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <footer className="flex justify-end gap-2 border-t border-smoke-200 bg-white px-5 py-4 sm:px-6">
          <button
            type="button"
            onClick={() => onFinish(null)}
            className="btn-secondary min-h-[44px] px-5 text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!selectedOption}
            onClick={() => {
              if (selectedOption) onFinish(selectedOption.chainId)
            }}
            className="btn-primary min-h-[44px] px-5 text-sm"
          >
            Continue to payment review
          </button>
        </footer>
      </div>
    </ModalDialog>
  )
}

export function TransactionReviewDialog({ pending, onFinish }: TransactionReviewDialogProps) {
  return pending.kind === 'review' ? (
    <ReviewModal key={pending.id} pending={pending} onFinish={onFinish} />
  ) : (
    <FundingChainSelectionModal key={pending.id} pending={pending} onFinish={onFinish} />
  )
}
