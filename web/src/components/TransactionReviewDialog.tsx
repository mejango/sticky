'use client'

import {
  useState,
} from 'react'
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  toFunctionSelector,
  zeroAddress,
  type Abi,
  type AbiFunction,
  type AbiParameter,
  type Address,
  type Hex,
} from 'viem'
import { safeSetupAbi, safeToL2SetupAbi } from '@/lib/cross-chain-authority'
import {
  jbControllerAbi,
  jbDirectoryAbi,
  jbMultiTerminalAbi,
  jbPermissionsAbi,
  jbProjectsAbi,
  jbSplitsAbi,
  jbTokensAbi,
  SPLITS_TOTAL_PERCENT,
} from '@bananapus/nana-sdk-core'
import { JBPermissionCatalogV6, describeStickySplit } from '@bananapus/nana-sdk-core/v6'
import {
  USDC_ADDRESSES,
  jbContractAddress,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { uniswapV4Deployment } from '@bananapus/nana-sdk-core/v6/uniswap-v4-deployments'
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
import { isStickyHook } from '@/lib/sticky'
import { stickyContractName } from '@/lib/sticky-addresses'

import { FeeBuybackNotice, useFeeBuybackReview } from './FeeBuybackNotice'

import type { PendingReview, PendingFundingChainSelection, TransactionReviewDialogProps } from './TransactionReviewProvider'

function knownAddressName(chainId: number, value: unknown): string | null {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/iu.test(value)) return null
  const address = value.toLowerCase()
  const sticky = stickyContractName(chainId, address)
  if (sticky) return sticky
  try {
    const deployment = uniswapV4Deployment(chainId as JBChainId)
    if (deployment?.permit2?.toLowerCase() === address) return 'Permit2'
    if (deployment?.universalRouter?.toLowerCase() === address) {
      return 'Uniswap Universal Router'
    }
  } catch {
    // Unsupported chains can still be reviewed as raw addresses below.
  }
  if (USDC_ADDRESSES[chainId as JBChainId]?.toLowerCase() === address) return 'USDC'
  const contracts = jbContractAddress['6'] as unknown as Record<
    string,
    Partial<Record<number, Address>>
  >
  return (
    Object.entries(contracts).find(
      ([, addresses]) => addresses[chainId]?.toLowerCase() === address,
    )?.[0] ?? null
  )
}

function knownContractName(call: TransactionReviewCall): string | null {
  return call.contractName ?? knownAddressName(call.chainId, call.to)
}

function stringify(value: unknown): string {
  try {
    return (
      JSON.stringify(
        value,
        (_, item) => (typeof item === 'bigint' ? item.toString() : item),
        2,
      ) ?? String(value)
    )
  } catch {
    return String(value)
  }
}

function readableValue(type: string, value: unknown, chainId: number): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (typeof value === 'string') {
    if (type === 'address') {
      const name = knownAddressName(chainId, value)
      return name ? `${name} | ${value}` : value
    }
    if (type.startsWith('bytes') && value.length > 50) {
      return `${value.slice(0, 22)}…${value.slice(-12)}`
    }
    return value
  }
  return stringify(value)
}

function namedValue(value: unknown, name: string, index: number): unknown {
  if (Array.isArray(value)) return value[index]
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return row[name] ?? row[index]
  }
  return undefined
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

export type V4PlanStep =
  | {
      action: 'INCREASE_LIQUIDITY'
      position: string
      liquidity: bigint
      maximumIn: { currency0: bigint; currency1: bigint }
    }
  | {
      action: 'DECREASE_LIQUIDITY'
      position: string
      liquidity: bigint
      minimumOut: { currency0: bigint; currency1: bigint }
    }
  | {
      action: 'MINT_POSITION'
      owner: string
      pool: { currency0: string; currency1: string; fee: number; tickSpacing: number; hook: string }
      ticks: { lower: number; upper: number }
      liquidity: bigint
      maximumIn: { currency0: bigint; currency1: bigint }
    }
  | {
      action: 'BURN_POSITION'
      position: string
      minimumOut: { currency0: bigint; currency1: bigint }
    }
  | { action: 'TAKE_PAIR'; currency0: string; currency1: string; recipient: string }
  | { action: 'CLOSE_CURRENCY'; currency: string }
  | { action: 'SWEEP'; currency: string; recipient: string }

/**
 * Decode a Uniswap V4 PositionManager `unlockData` plan into typed steps.
 * Covers only the actions this app builds (increase/decrease/mint/burn/take/
 * close/sweep); anything unrecognized falls back to the raw argument view — a
 * pretty rendering must never paper over bytes it can't fully account for.
 * Amounts stay in raw token units on purpose: this dialog shows the exact
 * payload. Addresses stay raw here; the renderer resolves known names.
 */
export function describeV4UnlockData(value: unknown): V4PlanStep[] | null {
  if (typeof value !== 'string' || !value.startsWith('0x')) return null
  try {
    const [actions, params] = decodeAbiParameters(
      [{ type: 'bytes' }, { type: 'bytes[]' }],
      value as Hex,
    )
    const codes = actions.slice(2).match(/.{2}/g) ?? []
    if (!codes.length || codes.length !== params.length) return null
    const steps: V4PlanStep[] = []
    for (const [index, byte] of codes.entries()) {
      const data = params[index]
      switch (parseInt(byte, 16)) {
        case 0x00: {
          const [tokenId, liquidity, amount0Max, amount1Max] = decodeAbiParameters(
            [
              { type: 'uint256' },
              { type: 'uint256' },
              { type: 'uint128' },
              { type: 'uint128' },
              { type: 'bytes' },
            ],
            data,
          )
          steps.push({
            action: 'INCREASE_LIQUIDITY',
            position: `#${tokenId}`,
            liquidity,
            maximumIn: { currency0: amount0Max, currency1: amount1Max },
          })
          break
        }
        case 0x01: {
          // The liquidity word is a uint256 in the PositionManager's decoder.
          const [tokenId, liquidity, amount0Min, amount1Min] = decodeAbiParameters(
            [
              { type: 'uint256' },
              { type: 'uint256' },
              { type: 'uint128' },
              { type: 'uint128' },
              { type: 'bytes' },
            ],
            data,
          )
          steps.push({
            action: 'DECREASE_LIQUIDITY',
            position: `#${tokenId}`,
            liquidity,
            minimumOut: { currency0: amount0Min, currency1: amount1Min },
          })
          break
        }
        case 0x02: {
          const [key, tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner] =
            decodeAbiParameters(
              [
                {
                  type: 'tuple',
                  components: [
                    { type: 'address' },
                    { type: 'address' },
                    { type: 'uint24' },
                    { type: 'int24' },
                    { type: 'address' },
                  ],
                },
                { type: 'int24' },
                { type: 'int24' },
                { type: 'uint256' },
                { type: 'uint128' },
                { type: 'uint128' },
                { type: 'address' },
                { type: 'bytes' },
              ],
              data,
            )
          steps.push({
            action: 'MINT_POSITION',
            owner,
            pool: {
              currency0: key[0],
              currency1: key[1],
              fee: key[2],
              tickSpacing: key[3],
              hook: key[4],
            },
            ticks: { lower: tickLower, upper: tickUpper },
            liquidity,
            maximumIn: { currency0: amount0Max, currency1: amount1Max },
          })
          break
        }
        case 0x03: {
          const [tokenId, amount0Min, amount1Min] = decodeAbiParameters(
            [{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
            data,
          )
          steps.push({
            action: 'BURN_POSITION',
            position: `#${tokenId}`,
            minimumOut: { currency0: amount0Min, currency1: amount1Min },
          })
          break
        }
        case 0x11: {
          const [currency0, currency1, recipient] = decodeAbiParameters(
            [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
            data,
          )
          steps.push({ action: 'TAKE_PAIR', currency0, currency1, recipient })
          break
        }
        case 0x12: {
          const [currency] = decodeAbiParameters([{ type: 'address' }], data)
          steps.push({ action: 'CLOSE_CURRENCY', currency })
          break
        }
        case 0x14: {
          const [currency, recipient] = decodeAbiParameters(
            [{ type: 'address' }, { type: 'address' }],
            data,
          )
          steps.push({ action: 'SWEEP', currency, recipient })
          break
        }
        default:
          return null
      }
    }
    return steps
  } catch {
    return null
  }
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

function v4AddressLabel(chainId: number, address: string): string {
  if (address.toLowerCase() === zeroAddress) return `native ETH | ${address}`
  const label = knownAddressName(chainId, address)
  return label ? `${label} | ${address}` : address
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
                <V4PlanRow label="Owner">{v4AddressLabel(chainId, step.owner)}</V4PlanRow>
                <V4PlanRow label="Currency0">
                  {v4AddressLabel(chainId, step.pool.currency0)}
                </V4PlanRow>
                <V4PlanRow label="Currency1">
                  {v4AddressLabel(chainId, step.pool.currency1)}
                </V4PlanRow>
                <V4PlanRow label="Fee">
                  {step.pool.fee} ({step.pool.fee / 10_000}%) | tick spacing {step.pool.tickSpacing}
                </V4PlanRow>
                <V4PlanRow label="Hook">{v4AddressLabel(chainId, step.pool.hook)}</V4PlanRow>
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
                  {v4AddressLabel(chainId, step.currency0)}
                </V4PlanRow>
                <V4PlanRow label="Currency1">
                  {v4AddressLabel(chainId, step.currency1)}
                </V4PlanRow>
                <V4PlanRow label="Recipient">{v4AddressLabel(chainId, step.recipient)}</V4PlanRow>
              </dl>
            )
          case 'CLOSE_CURRENCY':
            return (
              <dl key={index} className="space-y-0.5">
                {title('Close currency — settle the net; leftovers return to the caller')}
                <V4PlanRow label="Currency">{v4AddressLabel(chainId, step.currency)}</V4PlanRow>
              </dl>
            )
          case 'SWEEP':
            return (
              <dl key={index} className="space-y-0.5">
                {title('Sweep — refund unused balance')}
                <V4PlanRow label="Currency">{v4AddressLabel(chainId, step.currency)}</V4PlanRow>
                <V4PlanRow label="Recipient">{v4AddressLabel(chainId, step.recipient)}</V4PlanRow>
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

/** Universal Router sentinels the direct-pay swap builders use. */
const UR_MSG_SENDER = "0x0000000000000000000000000000000000000001";
const UR_ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
const UR_CONTRACT_BALANCE = 1n << 255n;

export type UrStep = { title: string; rows: [string, string][] };

function urRecipient(chainId: number, address: string): string {
  if (address.toLowerCase() === UR_MSG_SENDER) return "you (msg.sender)";
  if (address.toLowerCase() === UR_ADDRESS_THIS) return "the router (kept for the next step)";
  return v4AddressLabel(chainId, address);
}

function urAmount(value: bigint): string {
  if (value === UR_CONTRACT_BALANCE) return "the router's entire balance from the previous step";
  if (value === 0n) return "0 (the open amount from the previous step)";
  return value.toString();
}

/** A packed V3 path: 20-byte token, 3-byte fee, 20-byte token, … */
function urV3Path(chainId: number, path: string): string | null {
  const raw = path.slice(2);
  if (raw.length < 86 || (raw.length - 40) % 46 !== 0) return null;
  const parts: string[] = [v4AddressLabel(chainId, `0x${raw.slice(0, 40)}`)];
  for (let offset = 40; offset < raw.length; offset += 46) {
    const fee = parseInt(raw.slice(offset, offset + 6), 16);
    parts.push(`-${fee / 10_000}%→`, v4AddressLabel(chainId, `0x${raw.slice(offset + 6, offset + 46)}`));
  }
  return parts.join(" ");
}

/** The V4_SWAP command's inner action plan (the shapes the pay builders emit). */
function urV4SwapSteps(chainId: number, input: Hex): UrStep[] | null {
  const [actions, params] = decodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    input,
  );
  const codes = actions.slice(2).match(/.{2}/g) ?? [];
  if (!codes.length || codes.length !== params.length) return null;
  const steps: UrStep[] = [];
  for (const [index, byte] of codes.entries()) {
    const data = params[index];
    switch (parseInt(byte, 16)) {
      case 0x06: {
        const [swap] = decodeAbiParameters(
          [
            {
              type: "tuple",
              components: [
                {
                  type: "tuple",
                  components: [
                    { type: "address" },
                    { type: "address" },
                    { type: "uint24" },
                    { type: "int24" },
                    { type: "address" },
                  ],
                },
                { type: "bool" },
                { type: "uint128" },
                { type: "uint128" },
                { type: "bytes" },
              ],
            },
          ],
          data,
        );
        const [key, zeroForOne, amountIn, minimumOut] = swap;
        const currencyIn = zeroForOne ? key[0] : key[1];
        const currencyOut = zeroForOne ? key[1] : key[0];
        steps.push({
          title: "Swap in the project's V4 pool (exact input)",
          rows: [
            ["Sell", v4AddressLabel(chainId, currencyIn)],
            ["Buy", v4AddressLabel(chainId, currencyOut)],
            ["Amount in", urAmount(amountIn)],
            ["Minimum out", `${minimumOut} — reverts below this`],
            ["Fee", `${key[2]} (${key[2] / 10_000}%) | tick spacing ${key[3]}`],
            ["Hook", v4AddressLabel(chainId, key[4])],
          ],
        });
        break;
      }
      case 0x0b: {
        const [currency, amount] = decodeAbiParameters(
          [{ type: "address" }, { type: "uint256" }, { type: "bool" }],
          data,
        );
        steps.push({
          title: "Pay the pool",
          rows: [
            ["Currency", v4AddressLabel(chainId, currency)],
            ["Amount", urAmount(amount)],
          ],
        });
        break;
      }
      case 0x0c: {
        const [currency, maximum] = decodeAbiParameters(
          [{ type: "address" }, { type: "uint256" }],
          data,
        );
        steps.push({
          title: "Pay the pool everything owed",
          rows: [
            ["Currency", v4AddressLabel(chainId, currency)],
            ["At most", maximum.toString()],
          ],
        });
        break;
      }
      case 0x0e: {
        const [currency, recipient, amount] = decodeAbiParameters(
          [{ type: "address" }, { type: "address" }, { type: "uint256" }],
          data,
        );
        steps.push({
          title: "Take the swap output",
          rows: [
            ["Currency", v4AddressLabel(chainId, currency)],
            ["Recipient", urRecipient(chainId, recipient)],
            ["Amount", urAmount(amount)],
          ],
        });
        break;
      }
      default:
        return null;
    }
  }
  return steps;
}

/**
 * Decode a Uniswap Universal Router `execute(commands, inputs, deadline)` into
 * readable steps. Covers only the command shapes the pay flow builds (Permit2
 * permit, wrap, V3 hop, unwrap, V4 swap); anything unrecognized falls back to
 * the raw argument view — a pretty rendering must never paper over bytes it
 * can't fully account for.
 */
export function describeUniversalRouterExecute(
  chainId: number,
  args: readonly unknown[] | undefined,
): UrStep[] | null {
  if (!args || args.length < 2) return null;
  const [commands, inputs] = args as [unknown, unknown];
  if (typeof commands !== "string" || !commands.startsWith("0x") || !Array.isArray(inputs)) {
    return null;
  }
  try {
    const codes = commands.slice(2).match(/.{2}/g) ?? [];
    if (!codes.length || codes.length !== inputs.length) return null;
    const steps: UrStep[] = [];
    for (const [index, byte] of codes.entries()) {
      const data = inputs[index] as Hex;
      switch (parseInt(byte, 16)) {
        case 0x00: {
          const [recipient, amountIn, minimumOut, path, payerIsUser] = decodeAbiParameters(
            [
              { type: "address" },
              { type: "uint256" },
              { type: "uint256" },
              { type: "bytes" },
              { type: "bool" },
            ],
            data,
          );
          const route = urV3Path(chainId, path);
          if (!route) return null;
          steps.push({
            title: "Swap through a V3 pool (exact input)",
            rows: [
              ["Route", route],
              ["Amount in", urAmount(amountIn)],
              ["Minimum out", minimumOut === 0n ? "0 — the final V4 minimum below is the real floor" : minimumOut.toString()],
              ["Paid by", payerIsUser ? "you (via Permit2)" : "the router's balance"],
              ["Recipient", urRecipient(chainId, recipient)],
            ],
          });
          break;
        }
        case 0x0a: {
          const [permit] = decodeAbiParameters(
            [
              {
                type: "tuple",
                components: [
                  {
                    type: "tuple",
                    components: [
                      { type: "address" },
                      { type: "uint160" },
                      { type: "uint48" },
                      { type: "uint48" },
                    ],
                  },
                  { type: "address" },
                  { type: "uint256" },
                ],
              },
              { type: "bytes" },
            ],
            data,
          );
          const [details, spender, sigDeadline] = permit;
          steps.push({
            title: "Apply your signed Permit2 authorization",
            rows: [
              ["Token", v4AddressLabel(chainId, details[0])],
              ["Amount", details[1].toString()],
              ["Spender", v4AddressLabel(chainId, spender)],
              ["Expires", new Date(Number(details[2]) * 1000).toLocaleString()],
              ["Signature deadline", new Date(Number(sigDeadline) * 1000).toLocaleString()],
            ],
          });
          break;
        }
        case 0x0b: {
          const [recipient, amount] = decodeAbiParameters(
            [{ type: "address" }, { type: "uint256" }],
            data,
          );
          steps.push({
            title: "Wrap ETH into WETH",
            rows: [
              ["Amount", urAmount(amount)],
              ["Recipient", urRecipient(chainId, recipient)],
            ],
          });
          break;
        }
        case 0x0c: {
          const [recipient, minimum] = decodeAbiParameters(
            [{ type: "address" }, { type: "uint256" }],
            data,
          );
          steps.push({
            title: "Unwrap WETH back to ETH",
            rows: [
              ["Minimum", urAmount(minimum)],
              ["Recipient", urRecipient(chainId, recipient)],
            ],
          });
          break;
        }
        case 0x10: {
          const inner = urV4SwapSteps(chainId, data);
          if (!inner) return null;
          steps.push(...inner);
          break;
        }
        default:
          return null;
      }
    }
    return steps;
  } catch {
    return null;
  }
}

/** A decoded Universal Router plan in the same row grammar as everything else. */
function UrPlanView({ steps, deadline }: { steps: UrStep[]; deadline?: unknown }) {
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
      {deadline != null ? (
        <dl className="space-y-0.5">
          <V4PlanRow label="Deadline">
            {new Date(Number(deadline) * 1000).toLocaleString()}
          </V4PlanRow>
        </dl>
      ) : null}
      <p className="text-smoke-500">The exact bytes are in the raw payload below.</p>
    </div>
  )
}

// ── Precise decoders for the remaining opaque arguments ──────────────────────
// Every decoder is strict: it re-encodes what it decoded and compares bytes
// (or validates the full structure) before claiming an interpretation, and
// returns null on ANY mismatch so the raw argument view shows instead — a
// pretty rendering must never paper over bytes it can't fully account for.

export type PrettyStep = { title: string; rows: [string, string][] };

const bigintJson = (value: unknown) =>
  JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item));

/** Strict decode + byte-exact re-encode round trip, else null. */
function roundTripDecode<T extends readonly unknown[]>(
  types: Parameters<typeof decodeAbiParameters>[0],
  payload: Hex,
): T | null {
  try {
    const decoded = decodeAbiParameters(types, payload);
    const reencoded = encodeAbiParameters(types, decoded);
    if (reencoded.toLowerCase() !== payload.toLowerCase()) return null;
    return decoded as unknown as T;
  } catch {
    return null;
  }
}

// ── 1. JB hook metadata (JBMetadataResolver envelope) ────────────────────────

/**
 * Parse the JBMetadataResolver layout exactly as `getDataFor` reads it: a
 * 32-byte reserved word, a word-padded table of `(bytes4 id, uint8 wordOffset)`
 * entries, then word-aligned payload segments. Offsets must be strictly
 * increasing and the segments must tile the remainder of the bytes.
 */
function parseHookMetadataEnvelope(
  value: unknown,
): { reserved: Hex; entries: { id: Hex; payload: Hex }[] } | null {
  if (typeof value !== "string" || !/^0x([0-9a-fA-F]{2})+$/.test(value)) return null;
  const body = value.slice(2).toLowerCase();
  if (body.length % 64 !== 0) return null;
  const totalWords = body.length / 64;
  if (totalWords < 3) return null; // reserved word + table word + ≥1 payload word
  const firstOffset = parseInt(body.slice(64 + 8, 64 + 10), 16);
  const tableWords = firstOffset - 1;
  if (tableWords < 1 || firstOffset >= totalWords) return null;
  const tableArea = body.slice(64, 64 + tableWords * 64);
  const entries: { id: Hex; offset: number }[] = [];
  let cursor = 0;
  while (cursor + 10 <= tableArea.length) {
    const chunk = tableArea.slice(cursor, cursor + 10);
    if (/^0+$/.test(chunk)) break;
    const id = chunk.slice(0, 8);
    const offset = parseInt(chunk.slice(8, 10), 16);
    if (/^0+$/.test(id)) return null; // a zero id with a nonzero offset is malformed
    entries.push({ id: `0x${id}`, offset });
    cursor += 10;
  }
  if (!entries.length) return null;
  // The rest of the table must be pure zero padding.
  if (!/^0*$/.test(tableArea.slice(cursor))) return null;
  // The declared entry count must be what sized the table.
  if (Math.ceil((entries.length * 5) / 32) !== tableWords) return null;
  // Offsets must ascend and the payloads must tile the remaining bytes exactly.
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].offset >= totalWords) return null;
    if (i > 0 && entries[i].offset <= entries[i - 1].offset) return null;
  }
  if (entries[0].offset !== firstOffset) return null;
  const segments = entries.map((entry, i) => {
    const start = entry.offset * 64;
    const end = i + 1 < entries.length ? entries[i + 1].offset * 64 : body.length;
    return { id: entry.id, payload: `0x${body.slice(start, end)}` as Hex };
  });
  return { reserved: `0x${body.slice(0, 64)}`, entries: segments };
}

/** Aggregate repeated tier ids into "2× #4" form, preserving first-seen order. */
function tierIdCounts(tierIds: readonly number[]): string {
  const counts = new Map<number, number>();
  for (const id of tierIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()]
    .map(([id, count]) => (count > 1 ? `${count}× #${id}` : `#${id}`))
    .join(", ");
}

/**
 * Decode a `pay`/`addToBalanceOf`/`cashOutTokensOf` `metadata` argument into
 * its hook entries, with typed interpretations for the payload shapes this
 * ecosystem's builders produce (721 mints/redeems, buyback routing).
 */
export function describeJBHookMetadata(
  context: "pay" | "cashOut",
  value: unknown,
): PrettyStep[] | null {
  const envelope = parseHookMetadataEnvelope(value);
  if (!envelope) return null;
  const steps: PrettyStep[] = [];
  if (!/^0x0+$/.test(envelope.reserved)) {
    steps.push({
      title: "Protocol-reserved word (nonzero)",
      rows: [["Value", envelope.reserved]],
    });
  }
  for (const entry of envelope.entries) {
    const payloadWords = (entry.payload.length - 2) / 64;
    const base: [string, string][] = [["Hook lookup id", entry.id]];
    // Collect EVERY known shape that byte-exactly round-trips. Exactly one
    // match is an interpretation; several (degenerate payloads like empty
    // arrays) are reported as ambiguous rather than picking one.
    const readings: PrettyStep[] = [];
    if (context === "pay") {
      const mint = roundTripDecode<readonly [boolean, readonly number[]]>(
        [{ type: "bool" }, { type: "uint16[]" }],
        entry.payload,
      );
      if (mint) {
        readings.push({
          title: "721 shop mint instructions",
          rows: [
            ...base,
            ["Tier IDs to mint", mint[1].length ? tierIdCounts(mint[1]) : "none (credits only)"],
            [
              "Allow overspending",
              mint[0] ? "yes — excess becomes pay credits" : "no — any excess reverts",
            ],
          ],
        });
      }
      if (payloadWords === 3) {
        const buyback = roundTripDecode<readonly [bigint, bigint, boolean]>(
          [{ type: "uint256" }, { type: "uint256" }, { type: "bool" }],
          entry.payload,
        );
        if (buyback) {
          readings.push({
            title: "Buyback hook swap instructions",
            rows: [
              ...base,
              ["Amount to swap", buyback[0].toString()],
              ["Minimum swap output", `${buyback[1]} — reverts below this`],
              ["Skip splits on swapped tokens", buyback[2] ? "yes" : "no"],
            ],
          });
        }
      }
    } else {
      if (payloadWords === 2) {
        const buyback = roundTripDecode<readonly [bigint, boolean]>(
          [{ type: "uint256" }, { type: "bool" }],
          entry.payload,
        );
        if (buyback) {
          readings.push({
            title: "Buyback hook cash-out routing",
            rows: [
              ...base,
              ["Minimum swap output", buyback[0].toString()],
              [
                "Force the direct terminal path",
                buyback[1] ? "yes — never route through the pool" : "no",
              ],
            ],
          });
        }
      }
      const redeem = roundTripDecode<readonly [readonly bigint[]]>(
        [{ type: "uint256[]" }],
        entry.payload,
      );
      if (redeem) {
        readings.push({
          title: "721 shop items to redeem",
          rows: [
            ...base,
            ["Token IDs", redeem[0].length ? redeem[0].map((id) => `#${id}`).join(", ") : "none"],
          ],
        });
      }
    }
    if (readings.length === 1) {
      steps.push(readings[0]);
    } else if (readings.length > 1) {
      steps.push({
        title: "Payload matches multiple known shapes — verify against the raw bytes",
        rows: [
          ...base,
          ...readings.map(
            (reading, i) =>
              [
                `Reading ${i + 1}`,
                `${reading.title}: ${reading.rows
                  .slice(base.length)
                  .map(([label, val]) => `${label.toLowerCase()}: ${val}`)
                  .join("; ")}`,
              ] as [string, string],
          ),
        ],
      });
    } else {
      steps.push({
        title: `Unrecognized hook payload (${payloadWords} word${payloadWords === 1 ? "" : "s"})`,
        rows: [...base, ["Payload", entry.payload]],
      });
    }
  }
  return steps;
}

// ── 2. Sucker bridge claim ───────────────────────────────────────────────────

/** A bytes32 that is a left-padded address renders as the address. */
function paddedAddress(value: string): string {
  if (/^0x000000000000000000000000[0-9a-fA-F]{40}$/.test(value)) {
    return `0x${value.slice(26)}`;
  }
  return value;
}

export function describeSuckerClaim(chainId: number, value: unknown): PrettyStep[] | null {
  const claim = value as {
    token?: unknown;
    leaf?: {
      index?: unknown;
      beneficiary?: unknown;
      projectTokenCount?: unknown;
      terminalTokenAmount?: unknown;
      metadata?: unknown;
    };
    proof?: unknown;
  } | null;
  if (
    !claim ||
    typeof claim.token !== "string" ||
    !claim.leaf ||
    typeof claim.leaf.beneficiary !== "string" ||
    typeof claim.leaf.index !== "bigint" ||
    typeof claim.leaf.projectTokenCount !== "bigint" ||
    typeof claim.leaf.terminalTokenAmount !== "bigint" ||
    !Array.isArray(claim.proof) ||
    claim.proof.length !== 32 ||
    !claim.proof.every((hash) => typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash))
  ) {
    return null;
  }
  const rows: [string, string][] = [
    ["Terminal token", v4AddressLabel(chainId, claim.token)],
    ["Leaf index", claim.leaf.index.toString()],
    ["Beneficiary", paddedAddress(claim.leaf.beneficiary)],
    ["Project tokens", claim.leaf.projectTokenCount.toString()],
    ["Terminal token amount", claim.leaf.terminalTokenAmount.toString()],
  ];
  if (typeof claim.leaf.metadata === "string" && !/^0x0+$/.test(claim.leaf.metadata)) {
    rows.push(["Leaf metadata", claim.leaf.metadata]);
  }
  rows.push(["Merkle proof", "32 hashes — exact bytes in the raw payload below"]);
  return [{ title: "Claim a bridged balance from the sucker's inbox tree", rows }];
}

// ── 3. Safe execTransaction inner call ───────────────────────────────────────

const SAFE_INNER_ABIS: { name: string; abi: Abi }[] = [
  { name: "JBController", abi: jbControllerAbi as Abi },
  { name: "JBMultiTerminal", abi: jbMultiTerminalAbi as Abi },
  { name: "JBDirectory", abi: jbDirectoryAbi as Abi },
  { name: "JBTokens", abi: jbTokensAbi as Abi },
  { name: "JBPermissions", abi: jbPermissionsAbi as Abi },
  { name: "JBSplits", abi: jbSplitsAbi as Abi },
  { name: "JBProjects", abi: jbProjectsAbi as Abi },
  { name: "ERC-20", abi: erc20Abi as Abi },
];

export function describeSafeInnerCall(value: unknown): PrettyStep[] | null {
  if (typeof value !== "string" || !value.startsWith("0x") || value.length < 10) return null;
  for (const candidate of SAFE_INNER_ABIS) {
    try {
      const decoded = decodeFunctionData({ abi: candidate.abi, data: value as Hex });
      const item = candidate.abi.find(
        (entry) => entry.type === "function" && entry.name === decoded.functionName,
      ) as AbiFunction | undefined;
      const rows: [string, string][] = (decoded.args ?? []).map((argument, index) => [
        item?.inputs[index]?.name || `argument ${index + 1}`,
        bigintJson(argument),
      ]);
      return [
        {
          title: `Queued call — ${candidate.name}.${decoded.functionName}(…)`,
          rows: rows.length ? rows : [["Arguments", "none"]],
        },
      ];
    } catch {
      // try the next candidate ABI
    }
  }
  return null;
}

// ── 4. Safe proxy initializer ────────────────────────────────────────────────

export function describeSafeInitializer(chainId: number, value: unknown): PrettyStep[] | null {
  if (typeof value !== "string" || !value.startsWith("0x")) return null;
  let decoded: { functionName: string; args: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: safeSetupAbi, data: value as Hex }) as typeof decoded;
  } catch {
    return null;
  }
  if (decoded.functionName !== "setup" || !decoded.args) return null;
  // Reject noncanonical encodings so the summary can never disagree with the bytes.
  const canonical = encodeFunctionData({
    abi: safeSetupAbi,
    functionName: "setup",
    args: decoded.args as never,
  });
  if (canonical.toLowerCase() !== value.toLowerCase()) return null;
  const [owners, threshold, to, data, fallbackHandler, paymentToken, payment, paymentReceiver] =
    decoded.args as [
      readonly string[],
      bigint,
      string,
      string,
      string,
      string,
      bigint,
      string,
    ];
  const rows: [string, string][] = [
    ["Owners", owners.join(", ") || "none"],
    ["Threshold", `${threshold} of ${owners.length}`],
    ["Fallback handler", v4AddressLabel(chainId, fallbackHandler)],
  ];
  if (to.toLowerCase() === zeroAddress && data === "0x") {
    rows.push(["Setup hook", "none"]);
  } else {
    let hook = `DELEGATECALL to ${to} — data in the raw payload below`;
    try {
      const inner = decodeFunctionData({ abi: safeToL2SetupAbi, data: data as Hex });
      if (inner.functionName === "setupToL2" && inner.args) {
        const canonicalInner = encodeFunctionData({
          abi: safeToL2SetupAbi,
          functionName: "setupToL2",
          args: inner.args as never,
        });
        if (canonicalInner.toLowerCase() === data.toLowerCase()) {
          hook = `SafeToL2Setup.setupToL2(${String(inner.args[0])}) via ${to}`;
        }
      }
    } catch {
      // keep the generic delegatecall warning
    }
    rows.push(["Setup hook", hook]);
  }
  if (payment !== 0n || paymentToken.toLowerCase() !== zeroAddress) {
    rows.push([
      "Deployment payment",
      `${payment} of ${v4AddressLabel(chainId, paymentToken)} to ${paymentReceiver} — unusual, verify`,
    ]);
  }
  return [{ title: "Safe setup", rows }];
}

// ── 5. Permission grants ─────────────────────────────────────────────────────

const PERMISSION_NAME_BY_ID = new Map<number, string>(
  JBPermissionCatalogV6.map(({ key, id }) => [id, key]),
);

export function describePermissionsData(chainId: number, value: unknown): PrettyStep[] | null {
  const data = value as { operator?: unknown; projectId?: unknown; permissionIds?: unknown } | null;
  if (
    !data ||
    typeof data.operator !== "string" ||
    (typeof data.projectId !== "bigint" && typeof data.projectId !== "number") ||
    !Array.isArray(data.permissionIds) ||
    !data.permissionIds.every((id) => typeof id === "number" && Number.isInteger(id))
  ) {
    return null;
  }
  const projectId = BigInt(data.projectId);
  const names = (data.permissionIds as number[]).map((id) => {
    const name = PERMISSION_NAME_BY_ID.get(id);
    return name ? `${name} (${id})` : `UNKNOWN PERMISSION (${id})`;
  });
  const rows: [string, string][] = [
    ["Operator", v4AddressLabel(chainId, data.operator)],
    [
      "Scope",
      projectId === 0n
        ? "project 0 — EVERY project this account ever owns"
        : `project #${projectId}`,
    ],
    [
      "Permissions",
      names.length ? names.join(", ") : "none — revokes everything previously granted",
    ],
  ];
  if ((data.permissionIds as number[]).includes(1)) {
    rows.push(["Warning", "ROOT grants every permission across all Juicebox contracts"]);
  }
  return [{ title: "Set operator permissions", rows }];
}

// ── 6. Split groups ──────────────────────────────────────────────────────────

function splitPercent(percent: number): string {
  const share = (percent * 100) / Number(SPLITS_TOTAL_PERCENT);
  return `${Number(share.toFixed(4))}%`;
}

export function describeSplitGroups(chainId: number, value: unknown): PrettyStep[] | null {
  if (!Array.isArray(value)) return null;
  const steps: PrettyStep[] = [];
  for (const group of value as {
    groupId?: unknown;
    splits?: {
      percent?: unknown;
      projectId?: unknown;
      beneficiary?: unknown;
      preferAddToBalance?: unknown;
      lockedUntil?: unknown;
      hook?: unknown;
    }[];
  }[]) {
    if (typeof group?.groupId !== "bigint" || !Array.isArray(group.splits)) return null;
    const groupLabel =
      group.groupId === 1n
        ? "Reserved tokens"
        : group.groupId < 1n << 160n
          ? `Payouts of ${v4AddressLabel(chainId, `0x${group.groupId.toString(16).padStart(40, "0")}`)}`
          : `Group ${group.groupId}`;
    const rows: [string, string][] = [];
    let total = 0;
    for (const [index, split] of group.splits.entries()) {
      if (
        typeof split?.percent !== "number" ||
        typeof split.beneficiary !== "string" ||
        typeof split.projectId !== "bigint"
      ) {
        return null;
      }
      total += split.percent;
      // A Sticky split's projectId is its holder group and its beneficiary is the Sticky token.
      const sticky = typeof split.hook === "string" && isStickyHook(split.hook, chainId);
      const parts = [
        sticky
          ? `${describeStickySplit({ projectId: split.projectId })} → Sticky token ${v4AddressLabel(chainId, split.beneficiary)}`
          : split.projectId !== 0n
            ? `project #${split.projectId} (beneficiary ${split.beneficiary})`
            : v4AddressLabel(chainId, split.beneficiary),
      ];
      if (sticky) {
        parts.push(`via StickyDistributor ${split.hook}`);
      } else if (typeof split.hook === "string" && split.hook.toLowerCase() !== zeroAddress) {
        parts.push(`via hook ${split.hook}`);
      }
      if (split.preferAddToBalance === true) parts.push("prefers add-to-balance");
      if (typeof split.lockedUntil === "number" && split.lockedUntil > 0) {
        parts.push(`locked until ${new Date(split.lockedUntil * 1000).toLocaleString()}`);
      }
      rows.push([`Split ${index + 1} — ${splitPercent(split.percent)}`, parts.join(" | ")]);
    }
    rows.push([
      "Total",
      `${splitPercent(total)}${total === Number(SPLITS_TOTAL_PERCENT) ? "" : " — the remainder follows the ruleset's default"}`,
    ]);
    steps.push({ title: groupLabel, rows: rows.length > 1 ? rows : [["Splits", "none"]] });
  }
  return steps.length ? steps : null;
}

// ── 7. Sticky reward groups ──────────────────────────────────────────────────

/** The Sticky contracts that take a reward group as `groupId` or `groupIds`. */
const STICKY_GROUP_TAKERS = new Set(["StickyDistributor", "StickyAutoStick", "StickyRewardReceiverFactory"]);

/**
 * A Sticky contract's reward group arguments, each as its number and the holders it rewards in the SDK's words
 * (`describeStickySplit` reads a group as the distributor does). Null for any other argument or contract.
 */
function describeStickyGroups(call: TransactionReviewCall, inputName: string, value: unknown): string[] | null {
  if (inputName !== "groupId" && inputName !== "groupIds") return null;
  const contract = stickyContractName(call.chainId, call.to);
  if (!contract || !STICKY_GROUP_TAKERS.has(contract)) return null;
  const groups = Array.isArray(value) ? value : [value];
  if (!groups.length || !groups.every((group) => typeof group === "bigint")) return null;
  return groups.map((group) => `${group} | ${describeStickySplit({ projectId: group })}`);
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
    const steps = describeSafeInnerCall(value)
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
  const groups = describeStickyGroups(call, inputName, value)
  if (groups) {
    return (
      <div className="mt-1 space-y-1">
        {groups.map((group, index) => (
          <p key={index} className="break-all font-mono text-xs leading-relaxed text-ink">{group}</p>
        ))}
      </div>
    )
  }
  if (nestsCallsIn(fn, inputName) && call.calls?.length) {
    return <NestedCalls calls={call.calls} />
  }
  return null
}

/** A MultiSend lists its calls under the argument that encodes them. */
function nestsCallsIn(fn: AbiFunction, inputName: string): boolean {
  return fn.name === 'multiSend' && inputName === 'transactions'
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

function functionFromCall(call: TransactionReviewCall): AbiFunction | null {
  if (!call.abi || !call.functionName) return null
  const selector = call.data.slice(0, 10)
  return (
    (call.abi.find(
      item =>
        item.type === 'function' &&
        item.name === call.functionName &&
        (selector.length !== 10 || toFunctionSelector(item) === selector),
    ) as AbiFunction | undefined) ?? null
  )
}

function nativeValue(value = 0n): string {
  return `${formatEther(value)} ETH | ${value.toString()} wei`
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
  const callsInArgument = !!fn && fn.inputs.some(input => nestsCallsIn(fn, input.name ?? ''))
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
            {call.safeTxGas ? (
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

      {call.calls?.length && !callsInArgument ? (
        <div className="mt-5 border-t border-smoke-200 pt-4">
          <p className="text-xs font-medium text-smoke-600">Calls it makes, in order</p>
          <NestedCalls calls={call.calls} />
        </div>
      ) : null}

      <p className="mt-3 text-[11px] text-smoke-500">
        Calldata: {byteLength.toLocaleString()} byte{byteLength === 1 ? '' : 's'}
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
  const defaultDescription = isAuthorization
    ? 'This authorization commits to the exact destination, native value, and calldata below. A Safe or relayer can submit that call onchain after you continue.'
    : `This is the exact destination, native value, and calldata the app will ask your wallet to send. ${
        request.calls.every(call => call.gas !== undefined || call.safeTxGas !== undefined)
          ? 'Your wallet adds the nonce and network fees.'
          : 'Your wallet shows the gas limit and network fees before you send.'
      }`

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
              {request.description ?? defaultDescription}
            </p>
          </div>
          {request.authorization ? (
            <div className="mt-3 rounded-xl border border-bluebs-100 bg-bluebs-25 px-4 py-3 text-xs leading-relaxed text-bluebs-700">
              The Raw view also includes the exact typed-data domain and message
              your signature commits to.
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
                  ? 'Exact typed data plus the resulting app-controlled call. Hex value is the native token amount; data is the complete calldata.'
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
              {request.authorization ? ', plus the exact typed data' : ''}. I
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
  const [selected, setSelected] = useState(
    pending.initialChainId === null ? '' : String(pending.initialChainId),
  )
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
            One payment covers every chain. You&apos;ll review it before your
            wallet sends it.
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
