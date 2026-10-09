import { getJBContractAddress, type JBChainId } from '@bananapus/nana-sdk-core'
import {
  buildBridgeClaimTx, buildBridgePrepareTx, buildToRemoteTx, cashOutProtocolFee,
  CCIP_SUCKER_TRANSPORT_VALUES, classifySuckerMovement, findSuckerTransportValue,
  insertToSuckerOutboxEvent, jbSuckerV6ViewAbi, suckerBranchRoot, suckerBytes32ToAddress,
  suckerHashPair, suckerLeafHash, suckerLeafProof, suckerZeroHashes,
  verifySuckerDestinationMint,
  type JBLeaf, type JBLeafProof,
} from '@bananapus/nana-sdk-core/v6'
import { readSafeAppExecution, safeExecutionRunsCalls } from '@bananapus/nana-sdk-core/safe-service'
import {
  decodeEventLog, encodeFunctionData, erc20Abi, isAddress, isHash, pad, parseAbi,
  toEventSelector, zeroAddress, zeroHash,
  type Address, type Hex, type Log, type PublicClient,
} from 'viem'
import type { TxRequest } from '@/hooks/useSafeTx'
import { environmentForChainIds, SUPPORTED_CHAINS } from '@/lib/chains'
import { scanLogs } from '@/lib/hook-logs'
import { jbCenterPublicClient } from '@/lib/jbcenter-rpc'
import { feelessAddressesAbi, terminalAbi, tokensAbi } from '@/lib/sticky-abis'
import { approveSteps } from '@/lib/sticky-builders'

export type BridgeToken = { symbol: string; decimals: number }
export type BridgeChain = { chainId: JBChainId }
export type BridgeRoute = {
  source: BridgeChain
  destination: BridgeChain
  sourceSucker: Address
  destinationSucker: Address
  sourceProjectId: string
  destinationProjectId: string
  sourceToken: Address
  rewardToken: Address
  backingToken: Address
  remoteBackingToken: Address
  terminal: Address
  sourceMeta: BridgeToken
  rewardMeta: BridgeToken
  backingMeta: BridgeToken
  canPrepare: boolean
}
export type BridgeMovement = {
  leaf: JBLeaf
  leafHash: Hex
  root: Hex
  sourceHash: Hex
  blockNumber: bigint
  caller: Address
  event: Log<bigint, number, false>
  status: 'queued' | 'in-flight' | 'claimable' | 'claimed'
  proof: JBLeafProof | null
}
export type BridgePreparation = { steps: TxRequest[]; net: bigint; minimum: bigint }
export const BRIDGE_NATIVE_TOKEN = '0x000000000000000000000000000000000000eeee' as Address

const views = parseAbi([
  'function isSuckerOf(uint256 projectId, address sucker) view returns (bool)',
  'function allSuckersOf(uint256 projectId) view returns (address[])',
  'function primaryTerminalOf(uint256 projectId, address token) view returns (address)',
  'function accountingContextsOf(uint256 projectId) view returns ((address token, uint8 decimals, uint32 currency)[])',
  'function accountingContextForTokenOf(uint256 projectId, address token) view returns ((address token, uint8 decimals, uint32 currency))',
  'function TOKENS() view returns (address)',
  'function DIRECTORY() view returns (address)',
  'function state() view returns (uint8)',
  'function CCIP_ROUTER() view returns (address)',
  'function OPMESSENGER() view returns (address)',
  'function ARBINBOX() view returns (address)',
  'function GATEWAYROUTER() view returns (address)',
  'function LAYER() view returns (uint8)',
  'function toRemoteFee() view returns (uint256)',
])
const readAbi = [...views, ...jbSuckerV6ViewAbi, ...tokensAbi, ...terminalAbi, ...feelessAddressesAbi, ...erc20Abi] as const
type Mapping = { enabled: boolean; emergencyHatch: boolean; minGas: number; addr: Hex }
type Context = { token: Address; decimals: number; currency: number }
type Outbox = { nonce: bigint; numberOfClaimsSent: bigint; balance: bigint; tree: { branch: readonly Hex[]; count: bigint } }
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()
const address = (value: string): Address => {
  if (!isAddress(value, { strict: false }) || same(value, zeroAddress)) throw new Error('A valid nonzero address is required.')
  return value.toLowerCase() as Address
}
const count = (value: bigint): number => {
  if (value < 0n || value > 20_000n) throw new Error('The bridge history exceeds the supported scan size.')
  return Number(value)
}
const contracts = (chainId: JBChainId) => ({
  tokens: getJBContractAddress('JBTokens', 6, chainId),
  directory: getJBContractAddress('JBDirectory', 6, chainId),
  registry: getJBContractAddress('JBSuckerRegistry', 6, chainId),
  terminal: getJBContractAddress('JBMultiTerminal', 6, chainId),
})
export const bridgeRouteId = (route: BridgeRoute) =>
  `${route.source.chainId}:${route.destination.chainId}:${route.sourceSucker.toLowerCase()}:${route.backingToken.toLowerCase()}`
export const bridgeWriteHasUniqueReference = (data: Hex) => ['0xaf629bbb', '0xcbb2adce'].includes(data.slice(0, 10).toLowerCase())
export const bridgeCalldata = (request: TxRequest) => encodeFunctionData({ ...request })

/** Same protected output as the legacy flow, with protocol fee math owned by the SDK. */
export function bridgeMinimumOutput(gross: bigint, tax: bigint, feeFree: bigint, feeless: boolean, slippageBps = 100n) {
  if (gross <= 0n || tax < 0n || tax > 10_000n || feeFree < 0n || slippageBps < 0n || slippageBps > 500n) {
    throw new Error('A nonzero live bridge quote and at most 5% slippage are required.')
  }
  const net = gross - cashOutProtocolFee({ reclaimAmount: gross, cashOutTaxRate: tax, feeFreeSurplus: feeFree, beneficiaryIsFeeless: feeless })
  const minimum = net * (10_000n - slippageBps) / 10_000n
  if (minimum <= 0n) throw new Error('The protected bridge output rounds to zero.')
  return { net, minimum }
}

/** Live bridge evidence and reviewable requests. This owner never contacts a wallet. */
export function createStickyBridge(clientFor: (chainId: number) => PublicClient = jbCenterPublicClient) {
  const client = (chain: BridgeChain) => clientFor(chain.chainId)
  const read = <T>(chain: BridgeChain, target: Address, functionName: string, args: readonly unknown[] = []) =>
    client(chain).readContract({ address: target, abi: readAbi, functionName, args } as never) as Promise<T>
  const verifyChain = async (chain: BridgeChain) => {
    if (!SUPPORTED_CHAINS.some(item => item.id === chain.chainId) || await client(chain).getChainId() !== chain.chainId) {
      throw new Error('The bridge RPC is connected to the wrong chain.')
    }
  }
  const verifyCode = async (chain: BridgeChain, target: Address) => {
    const code = await client(chain).getCode({ address: address(target) })
    if (!code || /^0x0*$/.test(code)) throw new Error('A required bridge contract is not deployed on this chain.')
  }
  async function tokenMeta(chain: BridgeChain, token: Address): Promise<BridgeToken> {
    if (same(token, BRIDGE_NATIVE_TOKEN)) return { symbol: 'ETH', decimals: 18 }
    await verifyCode(chain, token)
    const decimals = Number(await read<number>(chain, token, 'decimals'))
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("The reward token's decimals are unsupported.")
    const symbol = await read<string>(chain, token, 'symbol').catch(() => token.slice(0, 8))
    return { symbol: symbol || token.slice(0, 8), decimals }
  }
  async function validateRoute(route: BridgeRoute, { sending = false, preparing = false } = {}) {
    const { source, destination, sourceSucker, destinationSucker, sourceProjectId, destinationProjectId } = route
    if (source.chainId === destination.chainId || environmentForChainIds([source.chainId]) !== environmentForChainIds([destination.chainId])) {
      throw new Error('A bridge route must connect different chains in the same environment.')
    }
    const sc = contracts(source.chainId), dc = contracts(destination.chainId)
    await Promise.all([verifyChain(source), verifyChain(destination), verifyCode(source, sourceSucker), verifyCode(destination, destinationSucker)])
    const checked = await Promise.all([
      read<boolean>(source, sc.registry, 'isSuckerOf', [BigInt(sourceProjectId), sourceSucker]),
      read<boolean>(destination, dc.registry, 'isSuckerOf', [BigInt(destinationProjectId), destinationSucker]),
      read<Hex>(source, sourceSucker, 'peer').then(suckerBytes32ToAddress),
      read<Hex>(destination, destinationSucker, 'peer').then(suckerBytes32ToAddress),
      read<bigint>(source, sourceSucker, 'peerChainId'), read<bigint>(destination, destinationSucker, 'peerChainId'),
      read<bigint>(source, sourceSucker, 'projectId'), read<bigint>(destination, destinationSucker, 'projectId'),
      read<Address>(source, sc.tokens, 'tokenOf', [BigInt(sourceProjectId)]), read<Address>(destination, dc.tokens, 'tokenOf', [BigInt(destinationProjectId)]),
      read<Address>(source, sourceSucker, 'TOKENS'), read<Address>(destination, destinationSucker, 'TOKENS'),
      read<Address>(source, sourceSucker, 'DIRECTORY'), read<Address>(destination, destinationSucker, 'DIRECTORY'),
    ])
    const expected = [true, true, destinationSucker, sourceSucker, BigInt(destination.chainId), BigInt(source.chainId), BigInt(sourceProjectId), BigInt(destinationProjectId), route.sourceToken, route.rewardToken, sc.tokens, dc.tokens, sc.directory, dc.directory]
    if (checked.some((value, index) => !same(String(value), String(expected[index])))) throw new Error('The bridge peer, project token, or registry does not match the selected route.')
    const mapping = await read<Mapping>(source, sourceSucker, 'remoteTokenFor', [route.backingToken])
    if (mapping.addr !== zeroHash && !same(suckerBytes32ToAddress(mapping.addr), route.remoteBackingToken)) throw new Error('The bridge source backing-token mapping changed.')
    if (sending && (!mapping.enabled || mapping.emergencyHatch || await read<number>(source, sourceSucker, 'state') > 1)) throw new Error('This bridge route no longer accepts new transfers.')
    if (preparing) {
      const reverse = await read<Mapping>(destination, destinationSucker, 'remoteTokenFor', [route.remoteBackingToken])
      if (mapping.addr === zeroHash || reverse.addr === zeroHash || !same(suckerBytes32ToAddress(reverse.addr), route.backingToken)) throw new Error('The bridge backing-token mappings do not match in both directions.')
      const primary = await read<Address>(source, sc.directory, 'primaryTerminalOf', [BigInt(sourceProjectId), route.backingToken])
      if (!same(primary, route.terminal)) throw new Error("The source project's backing terminal changed. Find routes again.")
      const remotePrimary = await read<Address>(destination, dc.directory, 'primaryTerminalOf', [BigInt(destinationProjectId), route.remoteBackingToken])
      const [localContext, remoteContext] = await Promise.all([
        read<Context>(source, primary, 'accountingContextForTokenOf', [BigInt(sourceProjectId), route.backingToken]),
        read<Context>(destination, remotePrimary, 'accountingContextForTokenOf', [BigInt(destinationProjectId), route.remoteBackingToken]),
      ])
      if (!same(localContext.token, route.backingToken) || !same(remoteContext.token, route.remoteBackingToken) || localContext.decimals !== remoteContext.decimals) throw new Error("The bridge's backing accounting contexts are inconsistent.")
    }
    return route
  }
  async function discover(input: { source: BridgeChain; destination: BridgeChain } & ({ sourceToken: Address } | { sourceProjectId: bigint })) {
    const { source, destination } = input
    await Promise.all([verifyChain(source), verifyChain(destination)])
    const sc = contracts(source.chainId), dc = contracts(destination.chainId)
    await Promise.all([verifyCode(source, sc.tokens), verifyCode(source, sc.registry), verifyCode(destination, dc.tokens), verifyCode(destination, dc.registry)])
    const sourceProjectId = 'sourceToken' in input ? await read<bigint>(source, sc.tokens, 'projectIdOf', [address(input.sourceToken)]) : input.sourceProjectId
    if (sourceProjectId <= 0n) throw new Error('This is not a Juicebox V6 project token on the origin chain.')
    const sourceToken = 'sourceToken' in input ? address(input.sourceToken) : (await read<Address>(source, sc.tokens, 'tokenOf', [sourceProjectId])).toLowerCase() as Address
    const locals = await read<Address[]>(source, sc.registry, 'allSuckersOf', [sourceProjectId])
    const contexts = await read<Context[]>(source, sc.terminal, 'accountingContextsOf', [sourceProjectId])
    if (locals.length > 256 || contexts.length > 256) throw new Error('The bridge returned too many routes.')
    const routes: BridgeRoute[] = []
    for (const sourceSucker of locals) {
      if (await read<bigint>(source, sourceSucker, 'peerChainId') !== BigInt(destination.chainId)) continue
      const destinationSucker = suckerBytes32ToAddress(await read<Hex>(source, sourceSucker, 'peer'))
      const destinationProjectId = await read<bigint>(destination, destinationSucker, 'projectId')
      const rewardToken = address(await read<Address>(destination, dc.tokens, 'tokenOf', [destinationProjectId]))
      for (const context of contexts) {
        const backingToken = address(context.token)
        const mapping = await read<Mapping>(source, sourceSucker, 'remoteTokenFor', [backingToken])
        if (mapping.addr === zeroHash) continue
        const remoteBackingToken = suckerBytes32ToAddress(mapping.addr)
        const terminal = await read<Address>(source, sc.directory, 'primaryTerminalOf', [sourceProjectId, backingToken])
        const [rewardMeta, backingMeta, state] = await Promise.all([tokenMeta(destination, rewardToken), tokenMeta(source, backingToken), read<number>(source, sourceSucker, 'state')])
        // A collector can accept project credits before an ERC-20 exists. Discovery and claims remain readable;
        // its send boundary requires deployment before the contract can materialize those credits.
        const sourceMeta = same(sourceToken, zeroAddress) ? { symbol: `Project #${sourceProjectId} credits`, decimals: rewardMeta.decimals } : await tokenMeta(source, sourceToken)
        if (sourceMeta.decimals !== rewardMeta.decimals) throw new Error('The source and destination project token decimals do not match.')
        const route: BridgeRoute = { source, destination, sourceSucker, destinationSucker, sourceProjectId: String(sourceProjectId), destinationProjectId: String(destinationProjectId), sourceToken, rewardToken, backingToken, remoteBackingToken, terminal, sourceMeta, rewardMeta, backingMeta, canPrepare: mapping.enabled && !mapping.emergencyHatch && state < 2 }
        await validateRoute(route, { preparing: true })
        routes.push(route)
      }
    }
    return routes
  }
  async function movements(route: BridgeRoute, receiver: Address): Promise<BridgeMovement[]> {
    await validateRoute(route)
    const outbox = await read<Outbox>(route.source, route.sourceSucker, 'outboxOf', [route.backingToken])
    const total = count(outbox.tree.count), sent = count(outbox.numberOfClaimsSent)
    if (sent > total) throw new Error('The bridge reports more sent leaves than exist.')
    if (!total) return []
    const source = client(route.source)
    const latest = await source.getBlockNumber({ cacheTime: 0 })
    const query = { address: route.sourceSucker, topics: [toEventSelector(insertToSuckerOutboxEvent), null, pad(route.backingToken.toLowerCase() as Address)], fromBlock: '0x0', toBlock: `0x${latest.toString(16)}` }
    // Raw topics preserve the complete receipt evidence. A rejected wide scan falls back to bounded ranges.
    let logs: (Log<Hex, Hex> | Log<bigint, number, false>)[]
    try { logs = await source.request({ method: 'eth_getLogs', params: [query] } as never) as Log<Hex, Hex>[] } catch {
      logs = await scanLogs(source, { address: route.sourceSucker, topics: query.topics, fromBlock: 0n, toBlock: latest })
    }
    const leaves = new Map<number, Omit<BridgeMovement, 'status' | 'proof'>>()
    for (const log of logs) {
      if (log.removed) continue
      if (!same(log.address, route.sourceSucker) || !same(log.topics[0] ?? '', query.topics[0]!) || !same(log.topics[2] ?? '', query.topics[2]!)) throw new Error('The RPC returned an unrelated bridge event.')
      if (log.topics.length !== 3 || !/^0x[0-9a-f]{448}$/i.test(log.data)) throw new Error('The RPC returned malformed bridge event data.')
      const { args } = decodeEventLog({ abi: [insertToSuckerOutboxEvent], data: log.data, topics: log.topics, strict: true })
      const index = count(args.index)
      if (index >= total) continue
      const leaf: JBLeaf = { index: args.index, beneficiary: args.beneficiary, projectTokenCount: args.projectTokenCount, terminalTokenAmount: args.terminalTokenAmount, metadata: args.metadata }
      const leafHash = suckerLeafHash(leaf)
      if (!same(leafHash, args.hashed)) throw new Error('A bridge event does not match its committed leaf.')
      if (!log.transactionHash || !isHash(log.transactionHash) || !log.blockHash || !isHash(log.blockHash) || log.blockNumber === null || log.logIndex === null || log.transactionIndex === null) throw new Error('The bridge returned an incomplete source event.')
      const event: Log<bigint, number, false> = { ...log, blockTimestamp: log.blockTimestamp == null ? undefined : BigInt(log.blockTimestamp), removed: false, transactionHash: log.transactionHash, blockHash: log.blockHash, blockNumber: BigInt(log.blockNumber), logIndex: Number(BigInt(log.logIndex)), transactionIndex: Number(BigInt(log.transactionIndex)) }
      const item = { leaf, leafHash, root: args.root, sourceHash: log.transactionHash, blockNumber: event.blockNumber, caller: address(args.caller), event }
      const previous = leaves.get(index)
      if (previous && (previous.sourceHash !== item.sourceHash || previous.event.blockHash !== event.blockHash || previous.event.logIndex !== event.logIndex || previous.event.data !== event.data || previous.leafHash !== leafHash)) throw new Error('The RPC returned conflicting bridge leaves.')
      leaves.set(index, item)
    }
    if (leaves.size !== total) throw new Error('The RPC returned incomplete bridge history. Use an archive RPC to recover this transfer.')
    const dense = Array.from({ length: total }, (_, index) => leaves.get(index)!)
    if (dense.some(item => !item)) throw new Error('The bridge history has a missing leaf.')
    const hashes = dense.map(item => item.leafHash)
    const emittedRoot = dense[total - 1].root
    if (!same(suckerBranchRoot(hashes[total - 1], suckerLeafProof(hashes, total - 1), total - 1), emittedRoot)) throw new Error('The reconstructed bridge tree does not match its emitted root.')
    let root: Hex = zeroHash
    let size = total
    const zeros = suckerZeroHashes()
    for (let depth = 0; depth < 32; depth++) {
      root = size % 2 ? suckerHashPair(outbox.tree.branch[depth], root) : suckerHashPair(root, zeros[depth])
      size = Math.floor(size / 2)
    }
    if (!same(root, emittedRoot)) throw new Error('The reconstructed bridge tree does not match the source contract.')
    const inbox = await read<{ nonce: bigint; root: Hex }>(route.destination, route.destinationSucker, 'inboxOf', [route.remoteBackingToken])
    const delivered = inbox.root === zeroHash ? 0 : dense.findIndex(item => same(item.root, inbox.root)) + 1
    if (inbox.root !== zeroHash && !delivered) throw new Error('The destination root is absent from the verified source history.')
    return Promise.all(dense.filter(item => same(item.leaf.beneficiary, pad(receiver.toLowerCase() as Address))).map(async item => {
      const executed = await read<Hex>(route.destination, route.destinationSucker, 'executedLeafHashOf', [route.remoteBackingToken, item.leaf.index])
      if (executed !== zeroHash && !same(executed, item.leafHash)) throw new Error('The destination executed a different bridge leaf.')
      const index = Number(item.leaf.index)
      const classified = classifySuckerMovement({ executed: executed !== zeroHash, index, deliveredCount: delivered, sentCount: sent })
      const status = classified.status === 'pending' ? classified.canExecute ? 'queued' : 'in-flight' : classified.status
      const proof = status === 'claimable' ? suckerLeafProof(hashes.slice(0, delivered), index) : null
      if (proof && !same(suckerBranchRoot(item.leafHash, proof, index), inbox.root)) throw new Error('The bridge claim proof does not match the destination root.')
      return { ...item, status, proof }
    }))
  }
  async function prepare({ route, amount, owner, receiver, metadata }: { route: BridgeRoute; amount: bigint; owner: Address; receiver: Address; metadata: Hex }): Promise<BridgePreparation> {
    address(owner); address(receiver)
    if (amount <= 0n || !isHash(metadata) || metadata === zeroHash) throw new Error('A positive bridge amount and unique transfer reference are required.')
    await validateRoute(route, { sending: true, preparing: true })
    await verifySuckerDestinationMint(client(route.destination), {
      chainId: route.destination.chainId, projectId: BigInt(route.destinationProjectId),
      sucker: route.destinationSucker, beneficiary: receiver, tokenCount: amount,
    })
    await movements(route, receiver)
    const { source, sourceSucker, sourceToken, backingToken, terminal } = route
    const projectId = BigInt(route.sourceProjectId)
    const [balance, allowance, preview, feeFree, feelessRegistry] = await Promise.all([
      read<bigint>(source, sourceToken, 'balanceOf', [owner]), read<bigint>(source, sourceToken, 'allowance', [owner, sourceSucker]),
      client(source).readContract({ address: terminal, abi: terminalAbi, functionName: 'previewCashOutFrom', args: [sourceSucker, projectId, amount, backingToken, sourceSucker, '0x'], account: sourceSucker }),
      read<bigint>(source, terminal, 'feeFreeSurplusOf', [projectId, backingToken]), read<Address>(source, terminal, 'FEELESS_ADDRESSES'),
    ])
    if (balance < amount) throw new Error('The origin wallet does not have enough project tokens.')
    const feeless = await read<boolean>(source, feelessRegistry, 'isFeelessFor', [sourceSucker, projectId, sourceSucker])
    const quote = bridgeMinimumOutput(preview[1], preview[2], feeFree, feeless)
    const steps = [
      ...approveSteps(source.chainId, sourceToken, sourceSucker, allowance, amount, { ...route.sourceMeta, mode: 'covering', label: 'Approve bridge transfer' }),
      { ...buildBridgePrepareTx({ chainId: source.chainId, sucker: sourceSucker, projectTokenCount: amount, beneficiary: receiver, minTokensReclaimed: quote.minimum, token: backingToken, metadata }), label: 'Queue cross-chain rewards' },
    ]
    return { steps, ...quote }
  }
  const simulate = (chain: BridgeChain, owner: Address, request: TxRequest) => client(chain).call({ account: owner, to: request.address, data: bridgeCalldata(request), value: request.value ?? 0n })
  /** Quote the existing bounded transport budgets by simulating the exact caller's complete transaction. */
  async function transportValue(route: BridgeRoute, owner: Address, request: (value: bigint) => TxRequest): Promise<bigint> {
    let transport: 'unknown' | 'native' | 'funded' = 'unknown'
    for (const probe of ['CCIP_ROUTER', 'OPMESSENGER']) {
      try { address(await read<Address>(route.source, route.sourceSucker, probe)); transport = probe === 'CCIP_ROUTER' ? 'funded' : 'native'; break } catch { /* A failed probe cannot identify a transport. */ }
    }
    if (transport === 'unknown') {
      try {
        const layer = await read<number>(route.source, route.sourceSucker, 'LAYER')
        address(await read<Address>(route.source, route.sourceSucker, 'GATEWAYROUTER'))
        if (layer === 0 && [1, 11155111].includes(route.source.chainId) && [42161, 421614].includes(route.destination.chainId)) {
          address(await read<Address>(route.source, route.sourceSucker, 'ARBINBOX')); transport = 'funded'
        } else if (layer === 1 && [42161, 421614].includes(route.source.chainId) && [1, 11155111].includes(route.destination.chainId)) transport = 'native'
      } catch { /* Unfamiliar or unavailable transport remains unverified. */ }
    }
    if (transport === 'unknown') throw new Error('This bridge transport cannot be verified. The queued transfer is saved for recovery.')
    const fee = await read<bigint>(route.source, contracts(route.source.chainId).registry, 'toRemoteFee')
    const value = await findSuckerTransportValue((transport === 'funded' ? CCIP_SUCKER_TRANSPORT_VALUES : [0n]).map(budget => fee + budget), candidate => simulate(route.source, owner, request(candidate)))
    if (value === null) throw new Error('The bridge transport could not be quoted. The queued rewards remain recoverable; refresh and try again.')
    return value
  }
  async function flush(route: BridgeRoute, owner: Address, receiver: Address): Promise<TxRequest> {
    await validateRoute(route, { sending: true })
    if (!(await movements(route, receiver)).some(row => row.status === 'queued')) throw new Error('No rewards are waiting to leave the origin chain. Refresh their status.')
    const request = (value: bigint): TxRequest => ({ ...buildToRemoteTx({ chainId: route.source.chainId, sucker: route.sourceSucker, token: route.backingToken, value }), label: 'Send queued rewards across chains' })
    return request(await transportValue(route, owner, request))
  }
  async function claim(route: BridgeRoute, row: BridgeMovement, owner: Address, receiver: Address): Promise<TxRequest> {
    const live = (await movements(route, receiver)).find(item => item.leaf.index === row.leaf.index && same(item.leafHash, row.leafHash))
    if (!live || live.status !== 'claimable' || !live.proof) throw new Error('This transfer is not ready to claim. Refresh its bridge status.')
    const request = { ...buildBridgeClaimTx({ chainId: route.destination.chainId, sucker: route.destinationSucker, claim: { token: route.remoteBackingToken, leaf: live.leaf, proof: live.proof } }), label: 'Claim arriving rewards' }
    await simulate(route.destination, owner, request)
    return request
  }
  async function verifyWrite(chain: BridgeChain, owner: Address, hash: Hex, request: { address: Address; data: Hex; value: bigint }, submission?: { hash: Hex; safeProposal?: boolean }) {
    if (!submission && !bridgeWriteHasUniqueReference(request.data)) throw new Error('This unknown wallet attempt cannot be identified from a repeated approval or transport call. Keep its pending reference until the original submission is known.')
    if (submission && !submission.safeProposal && !same(submission.hash, hash)) throw new Error('This is not the saved bridge transaction. Recover its original transaction hash.')
    await verifyChain(chain)
    const source = client(chain)
    const [transaction, receipt] = await Promise.all([source.getTransaction({ hash }), source.getTransactionReceipt({ hash })])
    if (!same(receipt.transactionHash, hash) || !same(transaction.hash, hash) || transaction.blockNumber !== receipt.blockNumber || !transaction.blockHash || !same(transaction.blockHash, receipt.blockHash) || (transaction.chainId !== undefined && transaction.chainId !== chain.chainId) || !same(transaction.from, receipt.from) || !same(transaction.to ?? '', receipt.to ?? '') || transaction.transactionIndex !== receipt.transactionIndex) throw new Error('The source transaction is not proven in its recorded block.')
    const block = await source.getBlock({ blockNumber: receipt.blockNumber, includeTransactions: false })
    if (!block.hash || !same(block.hash, receipt.blockHash) || block.number !== receipt.blockNumber || !same(String(block.transactions[receipt.transactionIndex]), hash)) throw new Error('The source bridge transaction is no longer canonical.')
    const direct = same(transaction.from, owner) && same(transaction.to ?? '', request.address) && same(transaction.input, request.data) && transaction.value === request.value
    let success = receipt.status === 'success'
    if (!direct) {
      if (!safeExecutionRunsCalls(transaction, owner, [{ to: request.address, data: request.data, value: request.value }], false)) throw new Error('The source transaction does not match the exact saved bridge call.')
      const safe = await readSafeAppExecution({ client: { getTransaction: async () => transaction }, receipt, safe: owner, proposalHash: submission?.hash ?? receipt.transactionHash, calls: [{ to: request.address, data: request.data, value: request.value }], batch: false })
      if (safe.status !== 'success' && safe.status !== 'failed') throw new Error('The source transaction does not match the exact saved bridge call.')
      success = safe.status === 'success'
    }
    if (!success) {
      if (!submission) throw new Error('A failed transaction cannot identify this unknown wallet attempt. Keep the pending transfer until its original transaction is known.')
      const finalized = await source.getBlock({ blockTag: 'finalized' })
      if (finalized.number === null || finalized.number < receipt.blockNumber) throw new Error('The failed bridge transaction is not finalized. Keep its pending reference and check again.')
      const canonical = finalized.number === receipt.blockNumber ? finalized : await source.getBlock({ blockNumber: receipt.blockNumber, includeTransactions: false })
      if (!canonical.hash || !same(canonical.hash, receipt.blockHash)) throw new Error('The failed bridge transaction changed before finality. Keep its pending reference and check again.')
    }
    return { receipt, success }
  }
  async function verifySource(route: BridgeRoute, row: BridgeMovement, owner: Address, expectedData: Hex, submission?: { hash: Hex; safeProposal?: boolean }) {
    if (!same(row.caller, owner) || !expectedData.startsWith('0xaf629bbb')) throw new Error('The source bridge event is not the saved wallet transfer.')
    const { receipt, success } = await verifyWrite(route.source, owner, row.sourceHash, { address: route.sourceSucker, data: expectedData, value: 0n }, submission)
    if (!success || receipt.blockNumber !== row.blockNumber || !same(row.event.blockHash, receipt.blockHash)) throw new Error('The source transaction is not proven successful in its recorded block.')
    const included = receipt.logs.some(log => !log.removed && same(log.address, route.sourceSucker) && same(log.data, row.event.data) && log.logIndex === row.event.logIndex && same(log.transactionHash, row.sourceHash) && same(log.blockHash, receipt.blockHash) && log.blockNumber === row.blockNumber && log.topics.length === row.event.topics.length && log.topics.every((topic, index) => same(topic, row.event.topics[index])))
    if (!included) throw new Error('The source receipt does not include this bridge event.')
    return receipt
  }
  return { discover, validateRoute, tokenMeta, movements, prepare, transportValue, flush, claim, verifySource, verifyWrite }
}
