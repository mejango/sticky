import { jbControllerAbi } from '@bananapus/nana-sdk-core'
import { decodeFunctionData, encodeFunctionData, erc20Abi, zeroAddress, type Address, type Hex } from 'viem'
import { chainsForEnvironment, SUPPORTED_CHAINS, type ChainEnvironment } from '@/lib/chains'
import { jbCenterPublicClient } from '@/lib/jbcenter-rpc'
import { projectsAbi, stickyAutoStickAbi, stickyDeployerAbi, tokensAbi } from '@/lib/sticky-abis'
import { stickyDeployment } from '@/lib/sticky-addresses'

export type LaunchTarget = {
  chainId: number
  deployer: Address
  controller: Address
  projects: Address
  call: { chain: number; target: Address; data: Hex; value: string }
}

/** JSON-safe reviewed launch data, also retained for receipt recovery. */
export type LaunchPlan = {
  id: string
  owner: Address
  name: string
  symbol: string
  token: Address
  tokenName: string
  tokenSymbol: string
  tokenDecimals: number
  cashOutTaxRate: string
  soulbound: boolean
  projectUri: string
  environment: ChainEnvironment
  targets: LaunchTarget[]
}

export type LaunchInput = {
  tokenInput: string
  name?: string
  symbol?: string
  bonusChoice: string
  customBonus?: string
  trustedSenders: string
  soulbound: boolean
  chainIds: readonly number[]
  environment: ChainEnvironment
}

export const ZERO = zeroAddress
export const BONUS_PRESETS = ['0', '5', '10', '25'] as const
export const TOKEN_CHAIN_ALIASES: Readonly<Record<string, number>> = {
  eth: 1, ethereum: 1, mainnet: 1, op: 10, optimism: 10, base: 8453, arb: 42161, arbitrum: 42161,
  sepolia: 11155111, ethsepolia: 11155111, ethereumsepolia: 11155111,
  opsepolia: 11155420, optimismsepolia: 11155420, basesepolia: 84532,
  arbsepolia: 421614, arbitrumsepolia: 421614,
}
const addressPattern = /^0x[0-9a-fA-F]{40}$/
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
export const isAddress = (value: unknown): value is Address =>
  typeof value === 'string' && addressPattern.test(value) && !same(value, ZERO)
const chainName = (chainId: number) => SUPPORTED_CHAINS.find(chain => chain.id === chainId)?.name ?? `chain ${chainId}`

/** New preparation and every execution boundary require one local pool; saved evidence may still name older calls. */
export function requireSingleHomeChain(choices: readonly unknown[]): void {
  if (choices.length !== 1) throw new Error('Choose exactly one home chain for this Sticky pool. Saved launch evidence is kept for recovery.')
}

/** At 100% an unstick returns nothing, so the form stops at 99.99%. */
export function bonusBasisPoints(choice: string, custom?: string): bigint {
  const text = choice === 'custom' ? String(custom ?? '').trim() : String(choice)
  if (choice !== 'custom' && !BONUS_PRESETS.some(preset => preset === text)) throw new Error('Choose a stickiness bonus.')
  if (!/^\d{1,2}(?:\.\d{1,2})?$/.test(text)) throw new Error('Enter a bonus from 0 to 99.99%.')
  const [whole, fraction = ''] = text.split('.')
  return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2))
}

export function defaultNames(tokenName: string, tokenSymbol: string) {
  return { name: `Sticky ${tokenName}`, symbol: `STICKY${tokenSymbol.toUpperCase()}` }
}

export function parseSenders(text: string): Address[] {
  const senders: Address[] = []
  for (const value of String(text || '').split(',').map(item => item.trim()).filter(Boolean)) {
    if (!isAddress(value)) throw new Error(`Not an address: ${value}`)
    if (!senders.some(sender => same(sender, value))) senders.push(value)
  }
  return senders
}

/** Every launch trusts AutoStick; preserve user order and include the adapter exactly once, last. */
export function launchGranters(senders: readonly Address[], adapter: unknown, name: string): Address[] {
  if (!isAddress(adapter)) throw new Error(`${name} has no auto-stick helper configured, so Sticky can't launch there.`)
  return [...senders.filter(sender => !same(sender, adapter)), adapter]
}

type TokenInput = { kind: 'empty' | 'invalid' } | { kind: 'address'; address: Address }
  | { kind: 'unknown-chain'; prefix: string } | { kind: 'project'; projectId: bigint; chainId: number | null }

export function parseTokenInput(input: string, aliases = TOKEN_CHAIN_ALIASES): TokenInput {
  const text = String(input || '').trim()
  if (!text) return { kind: 'empty' }
  if (addressPattern.test(text)) return { kind: 'address', address: text as Address }
  const match = text.match(/^(?:([a-zA-Z-]+):)?(\d{1,20})$/)
  if (!match || BigInt(match[2]) === 0n) return { kind: 'invalid' }
  const [, prefix, id] = match
  if (!prefix) return { kind: 'project', projectId: BigInt(id), chainId: null }
  const chainId = aliases[prefix.toLowerCase().replace(/[^a-z]/g, '')]
  return chainId ? { kind: 'project', projectId: BigInt(id), chainId } : { kind: 'unknown-chain', prefix }
}

function requireProjectHomeChain(chainId: number | null, homeChainId: number, name: string): void {
  if (chainId !== null && chainId !== homeChainId) throw new Error(`The project prefix must match the selected home chain, ${name}.`)
}

/** Project IDs resolve on the pool's home chain; a prefix cannot silently substitute another chain's asset. */
export async function resolveProjectToken({ projectId, chainId, targetChainIds, tokenOfAt, nameOf }: {
  projectId: bigint
  chainId: number | null
  targetChainIds: readonly number[]
  tokenOfAt: (chainId: number, projectId: bigint) => Promise<Address>
  nameOf: (chainId: number) => string
}): Promise<{ address: Address; chainIds: number[] }> {
  requireSingleHomeChain(targetChainIds)
  const [homeChainId] = targetChainIds
  requireProjectHomeChain(chainId, homeChainId, nameOf(homeChainId))
  const address = await tokenOfAt(homeChainId, projectId).catch(() => ZERO)
  if (!isAddress(address)) throw new Error(`Project #${projectId} has no ERC-20 on ${nameOf(homeChainId)}.`)
  return { address, chainIds: [homeChainId] }
}

export function checkSameToken<T extends { name: string; tokenName: string; tokenSymbol: string; tokenDecimals: number }>(reads: readonly T[]): T {
  const [first] = reads
  if (!first) throw new Error('Choose at least one chain.')
  for (const read of reads.slice(1)) {
    if (read.tokenSymbol !== first.tokenSymbol || read.tokenName !== first.tokenName || read.tokenDecimals !== first.tokenDecimals) {
      throw new Error(`${read.name}: the token differs from the one on ${first.name}.`)
    }
  }
  return first
}

export function launchChainBlocker(chainId: number): string {
  const deployment = stickyDeployment(chainId)
  if (!deployment || !isAddress(deployment.deployer)) return 'not deployed'
  return isAddress(deployment.autoStick) ? '' : 'no auto-stick helper'
}

/** Runtime addresses are read from the deployed contracts, never inferred from a project ID. */
async function loadStickyRuntime(chainId: number) {
  const deployment = stickyDeployment(chainId)
  const name = chainName(chainId)
  const blocker = launchChainBlocker(chainId)
  if (!deployment || blocker) throw new Error(`${name} can't launch Sticky: ${blocker}.`)
  const client = jbCenterPublicClient(chainId)
  const actualChainId = await client.getChainId()
  if (actualChainId !== chainId) throw new Error(`${name}'s configured RPC returned chain ${actualChainId}`)
  const requireCode = async (address: Address) => {
    if (!isAddress(address)) throw new Error(`A required Sticky contract is missing on ${name}`)
    const code = await client.getCode({ address })
    if (!code || code === '0x') throw new Error(`A required Sticky contract is missing at ${address} on ${name}`)
  }
  await requireCode(deployment.deployer)
  const controller = await client.readContract({ address: deployment.deployer, abi: stickyDeployerAbi, functionName: 'CONTROLLER' })
  const [projects, tokens] = await Promise.all([
    client.readContract({ address: controller, abi: jbControllerAbi, functionName: 'PROJECTS' }),
    client.readContract({ address: controller, abi: jbControllerAbi, functionName: 'TOKENS' }),
  ])
  await Promise.all([controller, projects, tokens, deployment.autoStick].map(requireCode))
  const [fee, adapterDeployer, adapterDistributor, hook, adapterHook] = await Promise.all([
    client.readContract({ address: projects, abi: projectsAbi, functionName: 'creationFee' }),
    client.readContract({ address: deployment.autoStick, abi: stickyAutoStickAbi, functionName: 'DEPLOYER' }),
    client.readContract({ address: deployment.autoStick, abi: stickyAutoStickAbi, functionName: 'DISTRIBUTOR' }),
    client.readContract({ address: deployment.deployer, abi: stickyDeployerAbi, functionName: 'HOOK' }),
    client.readContract({ address: deployment.autoStick, abi: stickyAutoStickAbi, functionName: 'HOOK' }),
  ])
  if (!same(adapterDeployer, deployment.deployer) || !same(hook, adapterHook) || !same(adapterDistributor, deployment.distributor)) {
    throw new Error(`The auto-stick adapter on ${name} does not match this Sticky deployment and distributor.`)
  }
  return { ...deployment, name, controller, projects, tokens, fee }
}

async function readLaunchToken(target: { chainId: number; name: string }, token: Address) {
  const client = jbCenterPublicClient(target.chainId)
  try {
    const [tokenName, tokenSymbol, tokenDecimals] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: 'name' }),
      client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
      client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
    ])
    return { tokenName, tokenSymbol, tokenDecimals }
  } catch (error) {
    throw new Error(`${target.name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

/** The persisted calls, the form's words and the SDK's decoded review must name the same immutable launch. */
export function validateLaunchCall(plan: LaunchPlan, target: LaunchTarget) {
  const decoded = decodeFunctionData({ abi: stickyDeployerAbi, data: target.call.data })
  if (decoded.functionName !== 'deployStickyFor') throw new Error('The saved call is not a Sticky launch.')
  const [token, name, symbol, uri, tax, granters, soulbound] = decoded.args
  const canonical = encodeFunctionData({ abi: stickyDeployerAbi, functionName: 'deployStickyFor', args: decoded.args })
  if (!same(canonical, target.call.data) || !same(token, plan.token) || name !== plan.name || symbol !== plan.symbol ||
      uri !== plan.projectUri || tax.toString() !== plan.cashOutTaxRate || soulbound !== plan.soulbound ||
      !granters.length || target.call.chain !== target.chainId || !same(target.call.target, target.deployer)) {
    throw new Error('The saved launch call differs from its reviewed configuration.')
  }
  return decoded.args
}

/** Reuse saved intent identity, but never stale preparation evidence at the wallet boundary. */
export async function revalidateStickyLaunch(plan: LaunchPlan): Promise<void> {
  if (!isAddress(plan.owner) || !isAddress(plan.token) || !plan.targets.length) throw new Error('The saved launch is invalid.')
  requireSingleHomeChain(plan.targets)
  const allowed = chainsForEnvironment(plan.environment)
  if (new Set(plan.targets.map(target => target.chainId)).size !== plan.targets.length
    || plan.targets.some(target => !allowed.some(chain => chain.id === target.chainId))) {
    throw new Error('The saved launch chains do not match its network environment.')
  }
  await Promise.all(plan.targets.map(async target => {
    const runtime = await loadStickyRuntime(target.chainId)
    if (target.call.chain !== target.chainId || !same(target.call.target, target.deployer)
      || !same(runtime.deployer, target.deployer) || !same(runtime.controller, target.controller)
      || !same(runtime.projects, target.projects)) throw new Error(`${runtime.name}: the Sticky deployment changed. Review the launch again.`)
    if (runtime.fee !== BigInt(target.call.value)) throw new Error(`${runtime.name}: the project creation fee changed. Review the launch again.`)
    const metadata = await readLaunchToken(runtime, plan.token)
    checkSameToken([{ name: 'the reviewed launch', tokenName: plan.tokenName, tokenSymbol: plan.tokenSymbol, tokenDecimals: plan.tokenDecimals },
      { name: runtime.name, ...metadata }])
    const [, , , , tax, granters] = validateLaunchCall(plan, target)
    if (tax > 9999n || !same(granters[granters.length - 1], runtime.autoStick)
      || granters.some(granter => !isAddress(granter)) || new Set(granters.map(granter => granter.toLowerCase())).size !== granters.length) {
      throw new Error(`${runtime.name}: the saved call does not match the reviewed launch.`)
    }
  }))
}

/** Reads and prepares exact calls only. Wallet review, publication and submission belong to the lifecycle adapter. */
export async function prepareStickyLaunch(input: LaunchInput, owner: Address): Promise<LaunchPlan> {
  if (!isAddress(owner)) throw new Error('Connect a wallet to create a Sticky token.')
  const cashOutTaxRate = bonusBasisPoints(input.bonusChoice, input.customBonus)
  const senders = parseSenders(input.trustedSenders)
  requireSingleHomeChain(input.chainIds)
  const allowed = chainsForEnvironment(input.environment)
  if (new Set(input.chainIds).size !== input.chainIds.length || input.chainIds.some(id => !allowed.some(chain => chain.id === id))) {
    throw new Error('Choose each chain once, in the selected network environment.')
  }
  const [homeChainId] = input.chainIds
  const parsed = parseTokenInput(input.tokenInput)
  if (parsed.kind === 'unknown-chain') throw new Error(`Unknown chain "${parsed.prefix}". Try eth, op, base or arb.`)
  if (parsed.kind !== 'address' && parsed.kind !== 'project') throw new Error('Enter a token address or a Juicebox project ID.')
  if (parsed.kind === 'project') requireProjectHomeChain(parsed.chainId, homeChainId, chainName(homeChainId))
  const runtime = await loadStickyRuntime(homeChainId)
  const token = parsed.kind === 'address' ? parsed.address : (await resolveProjectToken({
    projectId: parsed.projectId, chainId: parsed.chainId, targetChainIds: input.chainIds, nameOf: chainName,
    tokenOfAt: async (chainId, projectId) => jbCenterPublicClient(chainId).readContract({
      address: runtime.tokens, abi: tokensAbi, functionName: 'tokenOf', args: [projectId],
    }),
  })).address
  if (!isAddress(token)) throw new Error('Enter a token address or a Juicebox project ID.')
  const { tokenName, tokenSymbol, tokenDecimals } = await readLaunchToken(runtime, token)
  const defaults = defaultNames(tokenName, tokenSymbol)
  const name = input.name?.trim() || defaults.name
  const symbol = input.symbol?.trim() || defaults.symbol
  const id = crypto.randomUUID()
  const projectUri = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify({
    protocol: 'Sticky', version: 1, launchId: id, environment: input.environment, chains: [homeChainId],
  }))}`
  const { chainId, deployer, controller, projects, autoStick, fee, name: chain } = runtime
  const targets = [{
    chainId, deployer, controller, projects,
    call: {
      chain: chainId, target: deployer, value: fee.toString(),
      data: encodeFunctionData({ abi: stickyDeployerAbi, functionName: 'deployStickyFor', args: [
        token, name, symbol, projectUri, cashOutTaxRate, launchGranters(senders, autoStick, chain), input.soulbound,
      ] }),
    },
  }]
  return { id, owner, name, symbol, token, tokenName, tokenSymbol, tokenDecimals,
    cashOutTaxRate: cashOutTaxRate.toString(), soulbound: input.soulbound, projectUri, environment: input.environment, targets }
}
