import { describe, expect, it, vi } from 'vitest'
import { getJBContractAddress } from '@bananapus/nana-sdk-core'
import { buildBridgePrepareTx, suckerBranchRoot, suckerLeafHash, suckerLeafProof, SUCKER_EMPTY_TREE_ROOT } from '@bananapus/nana-sdk-core/v6'
import { createPublicClient, custom, decodeFunctionData, encodeFunctionData, getAddress, keccak256, pad, parseAbi, toEventSelector, zeroHash, type Address, type Hex, type PublicClient } from 'viem'
import { bridgeCalldata, bridgeMinimumOutput, BRIDGE_NATIVE_TOKEN, createStickyBridge, type BridgeRoute } from '@/lib/sticky-bridge'

vi.mock('@/lib/jbcenter-rpc', () => ({ jbCenterPublicClient: vi.fn() }))

const A = (value: number) => `0x${BigInt(value).toString(16).padStart(40, '0')}` as Address
const H = (value: number) => `0x${BigInt(value).toString(16).padStart(64, '0')}` as Hex
const word = (value: bigint | number | string) => typeof value === 'string' && value.startsWith('0x') ? value.slice(2).padStart(64, '0') : BigInt(value).toString(16).padStart(64, '0')
const abi = (...values: (bigint | number | string)[]) => `0x${values.map(word).join('')}` as Hex
// Independent calldata selectors from the deployed V6 contracts, preserving the legacy bridge acceptance fixture.
const SEL = {
  projectIdOf: '0x0f85421b', tokenOf: '0xea78803f', allSuckersOf: '0x49ad63cd', isSuckerOf: '0x83db9d01', DIRECTORY: '0x88bc2ef3', TOKENS: '0x1d831d5c',
  peer: '0x11cda415', peerChainId: '0xcdfceeba', projectId: '0x3fafa127', state: '0xc19d93fb', remoteTokenFor: '0x7de6fba2', accountingContextsOf: '0x515a9293',
  accountingContextForTokenOf: '0x3a01714f', primaryTerminalOf: '0x86202650', previewCashOutFrom: '0x4aa71dbc', feeFreeSurplusOf: '0xc66d192b',
  FEELESS_ADDRESSES: '0x659a2047', isFeelessFor: '0x8717d7c2', outboxOf: '0x802c8fa0', inboxOf: '0x6d9e384b', executedLeafHashOf: '0x4035d3b1',
  CCIP_ROUTER: '0xfe5f42ca', OPMESSENGER: '0xfc8fa43d', ARBINBOX: '0xb1012368', LAYER: '0xc86719b7', GATEWAYROUTER: '0xdefbb697',
  toRemoteFee: '0x42115915', toRemote: '0xb71c1179', prepare: '0xaf629bbb', claim: '0xcbb2adce', decimals: '0x313ce567', symbol: '0x95d89b41', balanceOf: '0x70a08231', allowance: '0xdd62ed3e', approve: '0x095ea7b3',
}
const initial = {
  trailingLogData: false, finalityReorg: false, safe: false, safeFailed: false, reverted: false, finalized: 100n, proposal: H(707),
  delivered: true, executed: false, membership: 1n, allowance: 0n, balance: 10_000n, mapping: BRIDGE_NATIVE_TOKEN, token: A(32), sourceChain: 1n,
  transport: 'ccip', successfulBudget: 10n ** 15n, incomplete: false, badHash: false, badBranch: false, badAddress: false, badExecution: false,
  badPeer: false, badDecimals: false, emptyCode: false, disabled: false, changedReverse: false, migratedTerminal: false, nonProject: false,
  rejectClaim: false, wrongInput: false, missingReceiptLog: false, reorged: false, wrongBlockTx: false, caller: A(40), conflict: false,
}

function fixture(changes: Partial<typeof initial> = {}) {
  const state = { ...initial, ...changes }
  const owner = A(40), receiver = A(41), metadata = H(99), sourceHash = H(1001), blockHash = H(1002)
  const terminal = getJBContractAddress('JBMultiTerminal', 6, 1)
  const route: BridgeRoute = {
    source: { chainId: 1 }, destination: { chainId: 10 }, sourceSucker: A(11), destinationSucker: A(12), sourceProjectId: '21', destinationProjectId: '22',
    sourceToken: A(31), rewardToken: A(32), backingToken: BRIDGE_NATIVE_TOKEN, remoteBackingToken: BRIDGE_NATIVE_TOKEN, terminal,
    sourceMeta: { symbol: 'TOK', decimals: 18 }, rewardMeta: { symbol: 'TOK', decimals: 18 }, backingMeta: { symbol: 'ETH', decimals: 18 }, canPrepare: true,
  }
  const leaf = { index: 0n, beneficiary: pad(receiver), projectTokenCount: 1000n, terminalTokenAmount: 500n, metadata }
  const prepareData = `${SEL.prepare}${word(1000)}${word(receiver)}${word(965)}${word(BRIDGE_NATIVE_TOKEN)}${word(metadata)}` as Hex
  const safeAbi = parseAbi(['function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool)'])
  const safeData = () => encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [route.sourceSucker, 0n, state.wrongInput ? '0x12345678' : prepareData, 0, 0n, 0n, 0n, A(0), A(0), '0x'] })
  const safeEvent = () => ({ ...event(), address: owner, topics: [toEventSelector(`event Execution${state.safeFailed ? 'Failure' : 'Success'}(bytes32 txHash,uint256 payment)`)], data: abi(state.proposal, 0) })
  const calls: { chainId: number; method: string; params: readonly unknown[] }[] = []
  const root = () => suckerBranchRoot(suckerLeafHash(leaf), suckerLeafProof([suckerLeafHash(leaf)], 0), 0)
  const event = () => ({
    address: route.sourceSucker, topics: ['0xc92fa1150c24ee5470c272112539aab52450a5e05573e7ea7bdfb98829b89321', leaf.beneficiary, pad(BRIDGE_NATIVE_TOKEN)],
    data: `${abi(state.badHash ? zeroHash : suckerLeafHash(leaf), 0, root(), leaf.projectTokenCount, leaf.terminalTokenAmount, leaf.metadata, state.caller)}${state.trailingLogData ? word(0) : ''}`,
    transactionHash: sourceHash, transactionIndex: '0x0', blockNumber: '0x64', blockHash, logIndex: '0x0', removed: false,
  })
  const clients = new Map<number, PublicClient>()
  const clientFor = (chainId: number) => {
    if (!clients.has(chainId)) clients.set(chainId, createPublicClient({ transport: custom({ request: async ({ method, params }) => {
      const parameters = (params ?? []) as readonly unknown[]
      calls.push({ chainId, method, params: parameters })
      const source = chainId === route.source.chainId
      if (method === 'eth_chainId') return `0x${(source ? state.sourceChain : BigInt(route.destination.chainId)).toString(16)}`
      if (method === 'eth_blockNumber') return '0x64'
      if (method === 'eth_getCode') return state.emptyCode || String(parameters[0]).toLowerCase() === BRIDGE_NATIVE_TOKEN ? '0x' : '0x60006000'
      if (method === 'eth_getTransactionByHash') return { hash: sourceHash, blockHash, blockNumber: '0x64', from: state.safe ? A(999) : owner, to: state.safe ? owner : route.sourceSucker, chainId: `0x${route.source.chainId.toString(16)}`, value: '0x0', input: state.safe ? safeData() : state.wrongInput ? '0x12345678' : prepareData, transactionIndex: '0x0', nonce: '0x0', gas: '0x100000', gasPrice: '0x1', type: '0x0', r: H(1), s: H(2), v: '0x1b' }
      if (method === 'eth_getTransactionReceipt') return { transactionHash: sourceHash, blockHash, blockNumber: '0x64', from: state.safe ? A(999) : owner, to: state.safe ? owner : route.sourceSucker, status: state.reverted ? '0x0' : '0x1', transactionIndex: '0x0', gasUsed: '0x1', cumulativeGasUsed: '0x1', effectiveGasPrice: '0x1', logsBloom: '0x', type: '0x0', logs: state.missingReceiptLog ? [] : state.safe ? [event(), safeEvent()] : [event()] }
      if (method === 'eth_getBlockByNumber') return { hash: state.reorged || (parameters[0] === 'finalized' && state.finalityReorg) ? H(1234) : blockHash, number: parameters[0] === 'finalized' ? `0x${state.finalized.toString(16)}` : '0x64', transactions: [state.wrongBlockTx ? H(1235) : sourceHash], timestamp: '0x64', gasLimit: '0x100000', gasUsed: '0x1', size: '0x1', difficulty: '0x0', totalDifficulty: '0x0' }
      if (method === 'eth_getLogs') return state.incomplete ? [] : state.conflict ? [event(), { ...event(), transactionHash: H(1111) }] : [{ ...event(), address: state.badAddress ? A(999) : route.sourceSucker }]
      if (method !== 'eth_call') throw new Error(`Unexpected ${method}`)
      const tx = parameters[0] as { data: Hex; value?: Hex }
      const selector = tx.data.slice(0, 10)
      if (selector === SEL.isSuckerOf) return abi(state.membership)
      if (selector === SEL.peer) return abi(source ? route.destinationSucker : state.badPeer ? A(555) : route.sourceSucker)
      if (selector === SEL.peerChainId) return abi(source ? route.destination.chainId : route.source.chainId)
      if (selector === SEL.projectId) return abi(source ? 21 : 22)
      if (selector === SEL.projectIdOf) return abi(state.nonProject ? 0 : 21)
      if (selector === SEL.tokenOf) return abi(source ? route.sourceToken : state.token)
      if (selector === SEL.TOKENS) return abi(getJBContractAddress('JBTokens', 6, source ? route.source.chainId : route.destination.chainId))
      if (selector === SEL.DIRECTORY) return abi(getJBContractAddress('JBDirectory', 6, source ? route.source.chainId : route.destination.chainId))
      if (selector === SEL.remoteTokenFor) return abi(state.disabled ? 0 : 1, 0, 200_000, !source && state.changedReverse ? A(999) : state.mapping)
      if (selector === SEL.primaryTerminalOf) return abi(state.migratedTerminal ? A(800) : terminal)
      if (selector === SEL.accountingContextForTokenOf) return abi(BRIDGE_NATIVE_TOKEN, !source && state.badDecimals ? 6 : 18, 61166)
      if (selector === SEL.accountingContextsOf) return abi(32, 1, BRIDGE_NATIVE_TOKEN, 18, 61166)
      if (selector === SEL.allSuckersOf) return abi(32, 1, route.sourceSucker)
      if (selector === SEL.state) return abi(0)
      if (selector === SEL.decimals) return abi(18)
      if (selector === SEL.symbol) return `${abi(32, 3)}${Buffer.from('TOK').toString('hex').padEnd(64, '0')}`
      if (selector === SEL.balanceOf) return abi(state.balance)
      if (selector === SEL.allowance) return abi(state.allowance)
      if (selector === SEL.previewCashOutFrom) return abi(...Array<number>(9).fill(0), 1000, 1000, 384, 0)
      if (selector === SEL.feeFreeSurplusOf) return abi(0)
      if (selector === SEL.FEELESS_ADDRESSES) return abi(A(60))
      if (selector === SEL.isFeelessFor) return abi(0)
      if (selector === SEL.outboxOf) return abi(1, state.delivered ? 1 : 0, 500, state.badBranch ? zeroHash : suckerLeafHash(leaf), ...Array<Hex>(31).fill(zeroHash), 1)
      if (selector === SEL.inboxOf) return abi(state.delivered ? 1 : 0, state.delivered ? root() : zeroHash)
      if (selector === SEL.executedLeafHashOf) return state.badExecution ? H(9000) : state.executed ? suckerLeafHash(leaf) : zeroHash
      if ([SEL.CCIP_ROUTER, SEL.OPMESSENGER, SEL.ARBINBOX, SEL.LAYER, SEL.GATEWAYROUTER].includes(selector)) {
        if (state.transport === 'ccip' && selector === SEL.CCIP_ROUTER) return abi(A(70))
        if (state.transport === 'native' && selector === SEL.OPMESSENGER) return abi(A(71))
        if (state.transport.startsWith('arbitrum')) {
          if (selector === SEL.LAYER) return abi(state.transport === 'arbitrum-l1' ? 0 : 1)
          if (selector === SEL.GATEWAYROUTER) return abi(A(72))
          if (selector === SEL.ARBINBOX) return state.transport === 'arbitrum-l1' ? abi(A(73)) : zeroHash
        }
        throw new Error('No transport probe')
      }
      if (selector === SEL.toRemoteFee) return abi(100)
      if (selector === SEL.toRemote) { if (BigInt(tx.value ?? 0) < 100n + state.successfulBudget) throw new Error('Insufficient transport value'); return '0x' }
      if (selector === SEL.claim) { if (state.rejectClaim) throw new Error('Claim reverted'); return '0x' }
      throw new Error(`Unexpected selector ${selector}`)
    } }, { retryCount: 0 }) }) as PublicClient)
    return clients.get(chainId)!
  }
  return { api: createStickyBridge(clientFor), route, state, calls, owner, receiver, metadata, leaf, sourceHash, prepareData }
}

describe('Sticky bridge, legacy acceptance preserved through SDK owners', () => {
  it('uses the canonical empty root and dense odd-sized fixed-depth proofs', () => {
    expect(suckerBranchRoot(zeroHash, suckerLeafProof([zeroHash], 0), 0)).toBe(SUCKER_EMPTY_TREE_ROOT)
    const hashes = [1, 2, 3].map(value => keccak256(H(value)))
    const roots = hashes.map((hash, index) => suckerBranchRoot(hash, suckerLeafProof(hashes, index), index))
    expect(new Set(roots).size).toBe(1)
    const proof = [...suckerLeafProof(hashes, 2)]; proof[0] = hashes[0]
    expect(proof).toHaveLength(32)
    expect(suckerBranchRoot(hashes[2], proof, 2)).not.toBe(roots[2])
    expect(() => suckerBranchRoot(hashes[0], [], 0)).toThrow()
  })
  it('protects net backing after only applicable fees and the one-percent floor', () => {
    expect(bridgeMinimumOutput(1000n, 1000n, 0n, false)).toEqual({ net: 975n, minimum: 965n })
    expect(bridgeMinimumOutput(1000n, 0n, 400n, false)).toEqual({ net: 990n, minimum: 980n })
    expect(bridgeMinimumOutput(1000n, 1000n, 400n, true)).toEqual({ net: 1000n, minimum: 990n })
    expect(() => bridgeMinimumOutput(0n, 0n, 0n, false)).toThrow('nonzero')
    expect(() => bridgeMinimumOutput(1n, 0n, 0n, false)).toThrow('rounds to zero')
    expect(() => bridgeMinimumOutput(100n, 0n, 0n, false, 501n)).toThrow('5%')
  })
  it('discovers differing source/destination project IDs and native backing without asking ETH for code', async () => {
    const f = fixture()
    const [route] = await f.api.discover(f.route)
    expect(route).toMatchObject({ sourceProjectId: '21', destinationProjectId: '22', rewardToken: f.route.rewardToken.toLowerCase(), backingMeta: { symbol: 'ETH', decimals: 18 }, canPrepare: true })
    expect(f.calls.filter(call => call.method === 'eth_getCode').some(call => String(call.params[0]).toLowerCase() === BRIDGE_NATIVE_TOKEN)).toBe(false)
  })
  it.each([
    ['wrong RPC chain', { sourceChain: 10n }, 'wrong chain'], ['missing deployment', { emptyCode: true }, 'not deployed'],
    ['unregistered sucker', { membership: 0n }, 'registry'], ['one-way peer', { badPeer: true }, 'peer'], ['wrong project token', { token: A(999) }, 'project token'],
    ['wrong mapping', { mapping: A(998) }, 'mapping'], ['mismatched decimals', { badDecimals: true }, 'accounting contexts'],
  ] as const)('rejects %s', async (_name, changes, message) => {
    const f = fixture(changes)
    await expect(f.api.validateRoute(f.route, { preparing: true })).rejects.toThrow(message)
  })
  it('refuses same-chain and mixed-network routes', async () => {
    const f = fixture(); f.route.destination.chainId = 11155111
    await expect(f.api.validateRoute(f.route)).rejects.toThrow('same environment')
    f.route.destination.chainId = 1
    await expect(f.api.validateRoute(f.route)).rejects.toThrow('different chains')
  })
  it('wallet-action:approve-a-bridge-transfer wallet-action:queue-cross-chain-rewards returns exact approval and protected metadata-bound queue calldata on the source chain', async () => {
    const f = fixture(); const result = await f.api.prepare({ ...f, amount: 1000n })
    expect(result.steps).toHaveLength(2)
    expect(bridgeCalldata(result.steps[0])).toBe(`${SEL.approve}${word(f.route.sourceSucker)}${word(1000)}`)
    expect(bridgeCalldata(result.steps[1])).toBe(f.prepareData)
    expect(result.steps[1]).toMatchObject({ chainId: 1, address: f.route.sourceSucker })
    const decoded = decodeFunctionData({ abi: result.steps[1].abi, data: bridgeCalldata(result.steps[1]) })
    expect(decoded.args).toEqual([1000n, pad(f.receiver), 965n, getAddress(BRIDGE_NATIVE_TOKEN), f.metadata])
  })
  it('resets nonzero insufficient allowance and skips a sufficient allowance', async () => {
    const f = fixture({ allowance: 1n }); const plan = await f.api.prepare({ ...f, amount: 1000n })
    expect(plan.steps).toHaveLength(3)
    expect(bridgeCalldata(plan.steps[0])).toBe(`${SEL.approve}${word(f.route.sourceSucker)}${word(0)}`)
    f.state.allowance = 1000n
    expect((await f.api.prepare({ ...f, amount: 1000n })).steps).toHaveLength(1)
  })
  it('refuses zero amount, missing reference, insufficient balance and disabled routes', async () => {
    const f = fixture({ balance: 0n })
    await expect(f.api.prepare({ ...f, amount: 0n })).rejects.toThrow('positive')
    await expect(f.api.prepare({ ...f, amount: 1n, metadata: zeroHash })).rejects.toThrow('unique')
    await expect(f.api.prepare({ ...f, amount: 1n })).rejects.toThrow('enough project tokens')
    f.state.disabled = true
    await expect(f.api.prepare({ ...f, amount: 1n })).rejects.toThrow('no longer accepts')
  })
  it('proves dense preimages and live source/destination roots, filtering the receiver', async () => {
    const f = fixture(); const [row] = await f.api.movements(f.route, f.receiver)
    expect(row).toMatchObject({ status: 'claimable', sourceHash: f.sourceHash })
    expect(row.proof).toHaveLength(32)
    expect(await f.api.movements(f.route, A(888))).toEqual([])
  })
  it.each([
    ['missing history', { incomplete: true }, 'incomplete bridge history'], ['forged preimage', { badHash: true }, 'committed leaf'],
    ['unrelated event', { badAddress: true }, 'unrelated bridge event'], ['wrong live root', { badBranch: true }, 'source contract'],
    ['wrong execution', { badExecution: true }, 'different bridge leaf'], ['conflicting index', { conflict: true }, 'conflicting bridge leaves'],
  ] as const)('refuses movement evidence with %s', async (_name, changes, message) => {
    const f = fixture(changes); await expect(f.api.movements(f.route, f.receiver)).rejects.toThrow(message)
  })
  it('rejects an event with trailing uncommitted data', async () => {
    const f = fixture({ trailingLogData: true })
    await expect(f.api.movements(f.route, f.receiver)).rejects.toThrow('malformed bridge event')
  })
  it('removes replayable proofs from executed leaves', async () => {
    const f = fixture({ executed: true }); const [row] = await f.api.movements(f.route, f.receiver)
    expect(row).toMatchObject({ status: 'claimed', proof: null })
    await expect(f.api.claim(f.route, row, f.owner, f.receiver)).rejects.toThrow('not ready')
  })
  it('wallet-action:claim-arriving-rewards rechecks and simulates exact static claim tuples on the destination', async () => {
    const f = fixture(); const [row] = await f.api.movements(f.route, f.receiver); const request = await f.api.claim(f.route, row, f.owner, f.receiver)
    const data = bridgeCalldata(request)
    expect(request).toMatchObject({ chainId: 10, address: f.route.destinationSucker })
    expect(data).toHaveLength(10 + 38 * 64)
    expect(data.slice(10, 10 + 6 * 64)).toBe([BRIDGE_NATIVE_TOKEN, 0, f.receiver, 1000, 500, f.metadata].map(word).join(''))
    expect(f.calls.some(call => call.chainId === 10 && call.method === 'eth_call' && (call.params[0] as { data: Hex }).data === data)).toBe(true)
    f.state.rejectClaim = true
    await expect(f.api.claim(f.route, row, f.owner, f.receiver)).rejects.toThrow('Claim reverted')
  })
  it.each(['ccip', 'arbitrum-l1'])('quotes a positive native budget plus registry fee for %s', async transport => {
    const f = fixture({ delivered: false, transport, successfulBudget: 5n * 10n ** 15n })
    if (transport === 'arbitrum-l1') f.route.destination.chainId = 42161
    expect((await f.api.flush(f.route, f.owner, f.receiver)).value).toBe(100n + 5n * 10n ** 15n)
  })
  it.each(['native', 'arbitrum-l2'])('simulates the exact registry-only fee for %s and refuses resending a delivered batch', async transport => {
    const f = fixture({ delivered: false, transport, successfulBudget: 0n })
    if (transport === 'arbitrum-l2') { f.route.source.chainId = 42161; f.route.destination.chainId = 1; f.state.sourceChain = 42161n }
    expect((await f.api.flush(f.route, f.owner, f.receiver)).value).toBe(100n)
    f.state.delivered = true
    await expect(f.api.flush(f.route, f.owner, f.receiver)).rejects.toThrow('No rewards are waiting')
  })
  it('never assumes a failed transport probe means native', async () => {
    const f = fixture({ delivered: false, transport: 'unknown' })
    await expect(f.api.flush(f.route, f.owner, f.receiver)).rejects.toThrow('cannot be verified')
  })
  it('proves the source caller, exact call, canonical block inclusion and receipt event', async () => {
    const f = fixture(); const [row] = await f.api.movements(f.route, f.receiver)
    expect((await f.api.verifySource(f.route, row, f.owner, f.prepareData)).transactionHash).toBe(f.sourceHash)
  })
  it.each([
    ['copied metadata', { caller: A(777) }, 'saved wallet transfer'], ['wrong source call', { wrongInput: true }, 'exact saved bridge call'],
    ['missing receipt event', { missingReceiptLog: true }, 'does not include'], ['reorged block', { reorged: true }, 'no longer canonical'],
    ['wrong block index', { wrongBlockTx: true }, 'no longer canonical'],
  ] as const)('refuses source recovery with %s', async (_name, changes, message) => {
    const f = fixture(changes); const [row] = await f.api.movements(f.route, f.receiver)
    await expect(f.api.verifySource(f.route, row, f.owner, f.prepareData)).rejects.toThrow(message)
  })
  it('binds recovery to the exact original direct hash', async () => {
    const f = fixture()
    await expect(f.api.verifyWrite(f.route.source, f.owner, f.sourceHash, { address: f.route.sourceSucker, data: f.prepareData, value: 0n }, { hash: H(123) })).rejects.toThrow('not the saved bridge transaction')
  })
  it('requires finalized failures and never uses an old failure to clear a hashless newer attempt', async () => {
    const f = fixture({ reverted: true, finalized: 99n }), request = { address: f.route.sourceSucker, data: f.prepareData, value: 0n }
    await expect(f.api.verifyWrite(f.route.source, f.owner, f.sourceHash, request, { hash: f.sourceHash })).rejects.toThrow('not finalized')
    f.state.finalized = 100n
    await expect(f.api.verifyWrite(f.route.source, f.owner, f.sourceHash, request)).rejects.toThrow('unknown wallet attempt')
    expect((await f.api.verifyWrite(f.route.source, f.owner, f.sourceHash, request, { hash: f.sourceHash })).success).toBe(false)
  })
  it('does not release a receipt whose finalized identity contradicts the earlier canonical read', async () => {
    const f = fixture({ reverted: true, finalityReorg: true })
    await expect(f.api.verifyWrite(f.route.source, f.owner, f.sourceHash, { address: f.route.sourceSucker, data: f.prepareData, value: 0n }, { hash: f.sourceHash })).rejects.toThrow('changed before finality')
  })
  it('does not treat historical generic success as proof of a newer unknown approval', async () => {
    const f = fixture()
    await expect(f.api.verifyWrite(f.route.source, f.owner, f.sourceHash, { address: f.route.sourceToken, data: '0x095ea7b3', value: 0n })).rejects.toThrow('repeated approval or transport call')
  })
  it('does not release a still-executable Safe proposal after its outer transaction reverted', async () => {
    const f = fixture({ safe: true, reverted: true })
    await expect(f.api.verifyWrite(f.route.source, f.owner, f.sourceHash, { address: f.route.sourceSucker, data: f.prepareData, value: 0n }, { hash: f.state.proposal, safeProposal: true })).rejects.toThrow('exact saved bridge call')
  })
  it('proves both original Safe proposal identity and exact reviewed inner calldata', async () => {
    const f = fixture({ safe: true }), request = { address: f.route.sourceSucker, data: f.prepareData, value: 0n }
    expect((await f.api.verifyWrite(f.route.source, f.owner, f.sourceHash, request, { hash: f.state.proposal, safeProposal: true })).success).toBe(true)
    await expect(f.api.verifyWrite(f.route.source, f.owner, f.sourceHash, request, { hash: H(9999), safeProposal: true })).rejects.toThrow('exact saved bridge call')
    f.state.wrongInput = true
    await expect(f.api.verifyWrite(f.route.source, f.owner, f.sourceHash, request, { hash: f.state.proposal, safeProposal: true })).rejects.toThrow('exact saved bridge call')
  })
  it('keeps an exact Safe inner failure pending until its canonical block finalizes', async () => {
    const f = fixture({ safe: true, safeFailed: true, finalized: 99n }), request = { address: f.route.sourceSucker, data: f.prepareData, value: 0n }
    await expect(f.api.verifyWrite(f.route.source, f.owner, f.sourceHash, request, { hash: f.state.proposal, safeProposal: true })).rejects.toThrow('not finalized')
    f.state.finalized = 100n
    expect((await f.api.verifyWrite(f.route.source, f.owner, f.sourceHash, request, { hash: f.state.proposal, safeProposal: true })).success).toBe(false)
  })
  it('wallet-action:send-queued-rewards-across-chains preserves queued transfers/claims after terminal migration or reverse remapping, but requires a new queue quote', async () => {
    for (const changes of [{ migratedTerminal: true }, { changedReverse: true }]) {
      const f = fixture(changes); const [row] = await f.api.movements(f.route, f.receiver)
      await f.api.claim(f.route, row, f.owner, f.receiver)
      await expect(f.api.prepare({ ...f, amount: 1n })).rejects.toThrow(changes.migratedTerminal ? 'terminal changed' : 'mappings')
      f.state.delivered = false
      await f.api.flush(f.route, f.owner, f.receiver)
    }
  })
  it('refuses a new token burn when source history cannot be reconstructed', async () => {
    const f = fixture({ incomplete: true })
    await expect(f.api.prepare({ ...f, amount: 1n })).rejects.toThrow('incomplete bridge history')
  })
  it('uses the SDK builder ABI and refuses malformed encoding instead of truncating fields', () => {
    const f = fixture()
    expect(encodeFunctionData(buildBridgePrepareTx({ chainId: 1, sucker: f.route.sourceSucker, projectTokenCount: 1000n, beneficiary: f.receiver, minTokensReclaimed: 965n, token: BRIDGE_NATIVE_TOKEN, metadata: f.metadata }))).toBe(f.prepareData)
    expect(() => decodeFunctionData({ abi: buildBridgePrepareTx({ chainId: 1, sucker: f.route.sourceSucker, projectTokenCount: 1n, beneficiary: f.receiver, token: BRIDGE_NATIVE_TOKEN }).abi, data: '0xaf629bbb' })).toThrow()
  })
})
