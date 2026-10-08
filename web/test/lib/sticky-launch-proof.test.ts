import { erc2771ForwarderAbi, jbProjectsAbi, stickyDeployerAbi } from '@bananapus/nana-sdk-core'
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAddress, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LaunchPlan } from '@/lib/sticky-launch-plan'
import type { StickyLaunchSession } from '@/lib/sticky-launch-session'
import { validateLaunchCall, verifyFinalizedStickyCallFailure, verifyFinalizedStickyLaunchFailure, verifyStickyLaunchDeployment } from '@/lib/sticky-launch-proof'
import { STICKY_LISTING_FORWARDER } from '@/lib/sticky-listing'

const safe = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@bananapus/nana-sdk-core/safe-service', async importOriginal => ({
  ...await importOriginal<typeof import('@bananapus/nana-sdk-core/safe-service')>(), readSafeAppExecution: safe.read,
}))
vi.mock('@/lib/wallet-core', () => ({ publicClient: vi.fn(() => { throw new Error('An explicit proof reader is required') }) }))
vi.mock('@/lib/jbcenter-rpc', () => ({ jbCenterPublicClient: vi.fn(() => { throw new Error('Proof must use its explicit reader') }) }))

const address = (digit: string) => getAddress(`0x${digit.repeat(40)}`)
const hash = (digit: string) => `0x${digit.repeat(64)}` as Hex
const OWNER = address('1'), DEPLOYER = address('2'), CONTROLLER = address('3'), PROJECTS = address('4')
const TOKEN = address('5'), STICKY = address('6'), ADAPTER = address('7'), SPONSOR = address('8'), OTHER = address('9')
const HASH = hash('a'), BLOCK = hash('b'), OTHER_HASH = hash('c')
const CHAIN = 84532
const safeAbi = parseAbi([
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
  'event ExecutionFailure(bytes32 txHash, uint256 payment)',
  'event ExecutionSuccess(bytes32 txHash, uint256 payment)',
])
const exec = (data: Hex, to = DEPLOYER, value = 12n) => encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction',
  args: [to, value, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x1234'] })

function fixture(mode: StickyLaunchSession['mode'] = 'direct') {
  const plan: LaunchPlan = { id: 'launch', owner: OWNER, name: 'Sticky Art', symbol: 'STICKYART', token: TOKEN,
    tokenName: 'Art', tokenSymbol: 'ART', tokenDecimals: 18, cashOutTaxRate: '1000', soulbound: true,
    projectUri: 'data:,launch', environment: 'testnet', targets: [] }
  const data = encodeFunctionData({ abi: stickyDeployerAbi, functionName: 'deployStickyFor',
    args: [TOKEN, plan.name, plan.symbol, plan.projectUri, 1000n, [ADAPTER], true] })
  const target = { chainId: CHAIN, deployer: DEPLOYER, controller: CONTROLLER, projects: PROJECTS,
    call: { chain: CHAIN, target: DEPLOYER, value: '12', data } }
  plan.targets = [target]
  const session: StickyLaunchSession = { version: 1, plan, mode, published: false, candidates: { [CHAIN]: [HASH] }, results: {},
    listing: { state: 'pending', recorded: {} }, direct: { started: true, hash: HASH } }
  const logBase = { blockNumber: 42n, blockHash: BLOCK, transactionHash: HASH, transactionIndex: 0, logIndex: 0, removed: false }
  const deployArgs = { projectId: 5n, stakedToken: TOKEN, token: STICKY, cashOutTaxRate: 1000n, soulbound: true, caller: OWNER }
  const creationArgs = { projectId: 5n, owner: DEPLOYER, caller: CONTROLLER }
  const deployLog = (overrides: Partial<typeof deployArgs> = {}) => {
    const args = { ...deployArgs, ...overrides }
    return { ...logBase, address: DEPLOYER,
      topics: encodeEventTopics({ abi: stickyDeployerAbi, eventName: 'DeploySticky', args }),
      data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }, { type: 'address' }],
        [args.token, args.cashOutTaxRate, args.soulbound, args.caller]) }
  }
  const creationLog = (overrides: Partial<typeof creationArgs> = {}) => {
    const args = { ...creationArgs, ...overrides }
    return { ...logBase, logIndex: 1, address: PROJECTS,
      topics: encodeEventTopics({ abi: jbProjectsAbi, eventName: 'Create', args }),
      data: encodeAbiParameters([{ type: 'address' }], [args.caller]) }
  }
  const transaction = { hash: HASH, chainId: CHAIN, blockHash: BLOCK, blockNumber: 42n, transactionIndex: 0,
    from: OWNER, to: DEPLOYER as Address | null, value: 12n, input: data }
  const receipt = { transactionHash: HASH, blockHash: BLOCK, blockNumber: 42n, transactionIndex: 0, status: 'success',
    from: OWNER, to: DEPLOYER as Address | null, logs: [deployLog(), creationLog()] }
  const reader = { getChainId: vi.fn(async () => CHAIN), getTransaction: vi.fn(async () => transaction), getTransactionReceipt: vi.fn(async () => receipt),
    getBlock: vi.fn(async () => ({ hash: BLOCK, number: 42n, transactions: [HASH] })) }
  const verify = () => verifyStickyLaunchDeployment(session, target, HASH, reader as unknown as PublicClient)
  return { session, plan, target, transaction, receipt, reader, deployLog, creationLog, verify }
}

beforeEach(() => { safe.read.mockResolvedValue({ status: 'success' }) })

describe('canonical Sticky launch proof', () => {
  it('proves the raw reviewed call and both creation events, with canonicality checked twice', async () => {
    const proof = fixture()
    expect(await proof.verify()).toEqual({ hash: HASH, projectId: '5', token: STICKY })
    expect(proof.reader.getBlock).toHaveBeenCalledTimes(2)
    expect(safe.read).not.toHaveBeenCalled()
    for (const mode of ['relayr', 'center'] as const) {
      const sponsored = fixture(mode)
      sponsored.transaction.from = SPONSOR
      sponsored.receipt.from = SPONSOR
      sponsored.receipt.logs[0] = sponsored.deployLog({ caller: SPONSOR })
      expect(await sponsored.verify()).toEqual({ hash: HASH, projectId: '5', token: STICKY })
    }
  })

  it('requires exact reviewed calldata, value and direct owner', async () => {
    for (const change of [{ value: 13n }, { from: OTHER }, { input: '0x1234' as Hex }, { to: OTHER }]) {
      const proof = fixture()
      Object.assign(proof.transaction, change)
      proof.receipt.to = proof.transaction.to
      expect(await proof.verify()).toBeNull()
    }
    const changed = fixture()
    changed.plan.name = 'Changed'
    await expect(changed.verify()).rejects.toThrow('reviewed configuration')
    const suffixed = fixture()
    suffixed.target.call.data = `${suffixed.target.call.data}00`
    expect(() => validateLaunchCall(suffixed.plan, suffixed.target)).toThrow('reviewed configuration')
  })

  it('rejects inconsistent transaction and receipt identities, reverted receipts and either reorg observation', async () => {
    const transactionChanges = [{ hash: OTHER_HASH }, { chainId: 1 }, { blockHash: OTHER_HASH }, { blockNumber: 43n }]
    for (const change of transactionChanges) {
      const proof = fixture()
      Object.assign(proof.transaction, change)
      expect(await proof.verify()).toBeNull()
    }
    for (const change of [{ transactionHash: OTHER_HASH }, { status: 'reverted' }, { to: OTHER }, { from: OTHER }, { transactionIndex: 1 }]) {
      const proof = fixture()
      Object.assign(proof.receipt, change)
      expect(await proof.verify()).toBeNull()
    }
    for (const late of [false, true]) {
      const proof = fixture()
      if (late) proof.reader.getBlock.mockResolvedValueOnce({ hash: BLOCK, number: 42n, transactions: [HASH] })
      proof.reader.getBlock.mockResolvedValueOnce({ hash: OTHER_HASH, number: 42n, transactions: [HASH] })
      expect(await proof.verify()).toBeNull()
    }
    const unreadable = fixture()
    unreadable.reader.getTransactionReceipt.mockRejectedValueOnce(new Error('RPC unavailable'))
    await expect(unreadable.verify()).rejects.toThrow('RPC unavailable')
  })

  it('binds the RPC chain and exact transaction position within the canonical block', async () => {
    const wrongChain = fixture()
    wrongChain.reader.getChainId.mockResolvedValueOnce(1)
    expect(await wrongChain.verify()).toBeNull()
    for (const block of [{ hash: BLOCK, number: 43n, transactions: [HASH] },
      { hash: BLOCK, number: 42n, transactions: [] }, { hash: BLOCK, number: 42n, transactions: [OTHER_HASH, HASH] }]) {
      const proof = fixture()
      proof.reader.getBlock.mockResolvedValueOnce(block)
      expect(await proof.verify()).toBeNull()
    }
  })

  it('requires both uniquely matching creation events with exact economics, token and caller', async () => {
    for (const change of [{ projectId: 0n }, { token: zeroAddress }, { stakedToken: OTHER }, { cashOutTaxRate: 1001n },
      { soulbound: false }, { caller: OTHER }]) {
      const proof = fixture()
      proof.receipt.logs[0] = proof.deployLog(change)
      expect(await proof.verify()).toBeNull()
    }
    for (const change of [{ projectId: 6n }, { owner: OTHER }, { caller: OTHER }]) {
      const proof = fixture()
      proof.receipt.logs[1] = proof.creationLog(change)
      expect(await proof.verify()).toBeNull()
    }
    for (const logIndex of [0, 1]) {
      const missing = fixture()
      missing.receipt.logs.splice(logIndex, 1)
      expect(await missing.verify()).toBeNull()
      const duplicate = fixture()
      duplicate.receipt.logs.push(duplicate.receipt.logs[logIndex])
      expect(await duplicate.verify()).toBeNull()
      for (const change of [{ removed: true }, { blockHash: OTHER_HASH }, { blockNumber: 43n }, { transactionHash: OTHER_HASH }, { address: OTHER }]) {
        const proof = fixture()
        Object.assign(proof.receipt.logs[logIndex], change)
        expect(await proof.verify()).toBeNull()
      }
    }
  })

  it('fails closed on malformed event bytes and conflicting noncanonical same-signature logs', async () => {
    for (const logIndex of [0, 1]) {
      for (const extra of ['00', '0'.repeat(64)]) {
        const proof = fixture()
        proof.receipt.logs[logIndex].data = `${proof.receipt.logs[logIndex].data}${extra}`
        expect(await proof.verify()).toBeNull()
      }
      const padding = fixture()
      padding.receipt.logs[logIndex].data = `0x01${padding.receipt.logs[logIndex].data.slice(4)}`
      expect(await padding.verify()).toBeNull()
      const topicPadding = fixture()
      topicPadding.receipt.logs[logIndex].topics[2] = `0x01${(topicPadding.receipt.logs[logIndex].topics[2] as Hex).slice(4)}`
      expect(await topicPadding.verify()).toBeNull()
      for (const change of [{ removed: true }, { blockHash: OTHER_HASH }, { data: '0x' as Hex }]) {
        const proof = fixture()
        proof.receipt.logs.push({ ...proof.receipt.logs[logIndex], ...change })
        expect(await proof.verify()).toBeNull()
      }
    }
  })
})

describe('wrapped launch proof', () => {
  const request = (data: Hex) => ({ from: SPONSOR, to: DEPLOYER, value: 12n, gas: 1_000_000n,
    deadline: 123456, data, signature: '0x1234' as Hex })
  function forwarded(batch = false) {
    const proof = fixture('center')
    proof.transaction.from = OTHER
    proof.transaction.to = STICKY_LISTING_FORWARDER
    proof.receipt.to = STICKY_LISTING_FORWARDER
    proof.receipt.from = OTHER
    proof.receipt.logs[0] = proof.deployLog({ caller: SPONSOR })
    const call = request(proof.target.call.data)
    proof.transaction.input = batch
      ? encodeFunctionData({ abi: erc2771ForwarderAbi, functionName: 'executeBatch', args: [[call], OTHER] })
      : encodeFunctionData({ abi: erc2771ForwarderAbi, functionName: 'execute', args: [call] })
    return proof
  }

  it('decodes exact execute and executeBatch calls and binds the event caller to the sponsor', async () => {
    for (const batch of [false, true]) expect(await forwarded(batch).verify()).toEqual({ hash: HASH, projectId: '5', token: STICKY })
    const proof = forwarded()
    proof.receipt.logs[0] = proof.deployLog({ caller: OWNER })
    expect(await proof.verify()).toBeNull()
  })

  it('rejects substring-only matches, different forwarders, wrong inner values and duplicate exact requests', async () => {
    const extra = forwarded()
    extra.transaction.input = `${extra.transaction.input}00`
    expect(await extra.verify()).toBeNull()
    const wrongForwarder = forwarded()
    wrongForwarder.transaction.to = OTHER
    wrongForwarder.receipt.to = OTHER
    expect(await wrongForwarder.verify()).toBeNull()
    for (const change of [{ value: 13n }, { to: OTHER }, { data: '0x1234' as Hex }]) {
      const proof = forwarded()
      proof.transaction.input = encodeFunctionData({ abi: erc2771ForwarderAbi, functionName: 'execute',
        args: [{ ...request(proof.target.call.data), ...change }] })
      expect(await proof.verify()).toBeNull()
    }
    const duplicate = forwarded()
    const call = request(duplicate.target.call.data)
    duplicate.transaction.input = encodeFunctionData({ abi: erc2771ForwarderAbi, functionName: 'executeBatch', args: [[call, call], OTHER] })
    expect(await duplicate.verify()).toBeNull()
    const nonCenter = forwarded()
    nonCenter.session.mode = 'relayr'
    expect(await nonCenter.verify()).toBeNull()
  })

  it('delegates Safe exact-call proof to the shared SDK and only accepts its success', async () => {
    const proof = fixture()
    proof.transaction.to = OWNER
    proof.transaction.from = OTHER
    proof.transaction.input = exec(proof.target.call.data)
    proof.receipt.to = OWNER
    proof.receipt.from = OTHER
    proof.session.direct = { started: true, hash: HASH, proposalHash: OTHER_HASH }
    expect(await proof.verify()).toEqual({ hash: HASH, projectId: '5', token: STICKY })
    expect(safe.read).toHaveBeenCalledWith(expect.objectContaining({ safe: OWNER, proposalHash: OTHER_HASH,
      calls: [{ to: DEPLOYER, data: proof.target.call.data, value: '12' }] }))
    for (const status of ['failure', 'unresolved', 'pending']) {
      safe.read.mockResolvedValueOnce({ status })
      expect(await proof.verify()).toBeNull()
    }
    proof.session.direct = { started: true, hash: HASH }
    await proof.verify()
    expect(safe.read).toHaveBeenLastCalledWith(expect.objectContaining({ proposalHash: HASH }))
    safe.read.mockClear()
    proof.session.direct.proposalHash = OTHER_HASH
    proof.transaction.input = exec('0x1234')
    expect(await proof.verify()).toBeNull()
    expect(safe.read).not.toHaveBeenCalled()
  })
})

describe('finalized recorded submission failure', () => {
  const FINAL = hash('d')
  const PROPOSAL = hash('e')
  beforeEach(async () => {
    const original = await vi.importActual<typeof import('@bananapus/nana-sdk-core/safe-service')>('@bananapus/nana-sdk-core/safe-service')
    safe.read.mockImplementation(original.readSafeAppExecution)
  })

  function failure(viaSafe = false) {
    const proof = fixture()
    proof.receipt.status = 'reverted'
    proof.receipt.logs = []
    if (viaSafe) {
      proof.session.direct!.proposalHash = PROPOSAL
      proof.transaction.to = OWNER
      proof.transaction.from = OTHER
      proof.transaction.value = 0n
      proof.transaction.input = exec(proof.target.call.data)
      proof.receipt.to = OWNER
      proof.receipt.from = OTHER
      proof.receipt.status = 'success'
      proof.receipt.logs = [{ ...proof.deployLog(), address: OWNER,
        topics: encodeEventTopics({ abi: safeAbi, eventName: 'ExecutionFailure' }),
        data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [PROPOSAL, 0n]) }]
    }
    const finalized = { hash: FINAL, number: 100n, timestamp: 200n, transactions: [] as Hex[] }
    const included = { hash: BLOCK, number: 42n, timestamp: 100n, transactions: [HASH] }
    const reader = { ...proof.reader, getBlock: vi.fn(async (args: { blockNumber?: bigint; blockTag?: string }) =>
      args.blockTag === 'finalized' || args.blockNumber === 100n ? finalized : included) }
    const client = reader as unknown as PublicClient
    const verify = () => verifyFinalizedStickyLaunchFailure(proof.session, proof.target, proof.session.direct!, client)
    const verifyCall = () => verifyFinalizedStickyCallFailure({ chainId: CHAIN, owner: OWNER,
      call: { to: DEPLOYER, data: proof.target.call.data, value: 12n }, submission: proof.session.direct! }, client)
    return { ...proof, reader, client, finalized, included, verify, verifyCall }
  }

  it('proves an exact reverted EOA attempt only after finality and a fresh canonical receipt read', async () => {
    const proof = failure()
    expect(await proof.verify()).toBe(true)
    expect(proof.reader.getTransactionReceipt).toHaveBeenCalledTimes(2)
    expect(proof.reader.getChainId).toHaveBeenCalledTimes(2)
    expect(proof.reader.getBlock.mock.calls).toEqual([
      [{ blockNumber: 42n }], [{ blockTag: 'finalized' }], [{ blockNumber: 42n }], [{ blockNumber: 100n }],
    ])
    expect(safe.read).not.toHaveBeenCalled()
    expect(await proof.verifyCall()).toBe(true)
  })

  it('does not release an unknown submission, UI candidate, unrecorded old same-call hash or unstarted submission', async () => {
    const proof = failure()
    for (const submission of [{ started: true }, { started: false, hash: HASH }, { started: true, hash: OTHER_HASH }]) {
      expect(await verifyFinalizedStickyLaunchFailure(proof.session, proof.target, submission, proof.client)).toBe(false)
    }
    expect(proof.reader.getTransaction).not.toHaveBeenCalled()
    proof.session.direct = { started: true }
    expect(await proof.verify()).toBe(false)
    proof.session.direct = { started: true, hash: HASH }
    proof.session.mode = 'relayr'
    expect(await proof.verify()).toBe(false)
  })

  it('reproves recorded archived submissions without treating an unrelated hash as one', async () => {
    const proof = failure()
    const archived = { ...proof.session.direct! }
    proof.session.directAttempts = [archived]
    proof.session.direct = { started: true, hash: OTHER_HASH }
    expect(await verifyFinalizedStickyLaunchFailure(proof.session, proof.target, archived, proof.client)).toBe(true)
    expect(await verifyFinalizedStickyLaunchFailure(proof.session, proof.target, { started: true, hash: hash('f') }, proof.client)).toBe(false)
  })

  it('requires exact EOA caller, target, input, value, failed status and canonical transaction identity', async () => {
    for (const change of [{ from: OTHER }, { to: OTHER }, { input: '0x1234' as Hex }, { value: 13n },
      { hash: OTHER_HASH }, { chainId: 1 }, { transactionIndex: 1 }]) {
      const proof = failure()
      Object.assign(proof.transaction, change)
      proof.receipt.from = proof.transaction.from
      proof.receipt.to = proof.transaction.to
      expect(await proof.verify()).toBe(false)
    }
    for (const change of [{ status: 'success' }, { from: OTHER }, { blockHash: OTHER_HASH }, { transactionHash: OTHER_HASH }]) {
      const proof = failure()
      Object.assign(proof.receipt, change)
      expect(await proof.verify()).toBe(false)
    }
    const wrongChain = failure()
    wrongChain.reader.getChainId.mockResolvedValueOnce(1)
    expect(await wrongChain.verify()).toBe(false)
    const unincluded = failure()
    unincluded.included.transactions = [OTHER_HASH]
    expect(await unincluded.verify()).toBe(false)
  })

  it('keeps unfinalized, unavailable and reorged evidence locked', async () => {
    const unfinalized = failure()
    unfinalized.finalized.number = 41n
    expect(await unfinalized.verify()).toBe(false)
    const unavailable = failure()
    unavailable.reader.getBlock.mockImplementation(async args => {
      if (args.blockTag) throw new Error('finalized tag unavailable')
      return unavailable.included
    })
    expect(await unavailable.verify()).toBe(false)
    const malformed = failure()
    malformed.finalized.hash = '0x1234'
    expect(await malformed.verify()).toBe(false)
    const reorg = failure()
    reorg.reader.getBlock.mockImplementation(async args => args.blockTag === 'finalized' ? reorg.finalized
      : args.blockNumber === 100n ? { ...reorg.finalized, hash: OTHER_HASH } : reorg.included)
    expect(await reorg.verify()).toBe(false)
    const lost = failure()
    lost.reader.getTransactionReceipt.mockRejectedValueOnce(new Error('RPC unavailable'))
    expect(await lost.verify()).toBe(false)
  })

  it('rechecks receipt outcome, placement and the call after reading finality', async () => {
    for (const change of [{ status: 'success' }, { blockHash: OTHER_HASH }, { transactionIndex: 1 }]) {
      const proof = failure()
      proof.reader.getTransactionReceipt.mockResolvedValueOnce({ ...proof.receipt }).mockResolvedValueOnce({ ...proof.receipt, ...change })
      expect(await proof.verify()).toBe(false)
    }
    const changedCall = failure()
    changedCall.reader.getTransaction.mockResolvedValueOnce({ ...changedCall.transaction })
      .mockResolvedValueOnce({ ...changedCall.transaction, value: 13n })
    expect(await changedCall.verify()).toBe(false)
    const moved = failure()
    moved.reader.getTransaction.mockResolvedValueOnce({ ...moved.transaction })
      .mockResolvedValueOnce({ ...moved.transaction, blockHash: OTHER_HASH })
    moved.reader.getTransactionReceipt.mockResolvedValueOnce({ ...moved.receipt })
      .mockResolvedValueOnce({ ...moved.receipt, blockHash: OTHER_HASH })
    moved.reader.getBlock.mockResolvedValueOnce(moved.included).mockResolvedValueOnce(moved.finalized)
      .mockResolvedValueOnce({ ...moved.included, hash: OTHER_HASH }).mockResolvedValueOnce(moved.finalized)
    expect(await moved.verify()).toBe(false)
  })

  it('requires an exact consumed Safe failure and accepts only the recorded proposal’s resolved execution', async () => {
    const proof = failure(true)
    expect(await proof.verify()).toBe(true)
    expect(safe.read).toHaveBeenCalledTimes(2)
    expect(safe.read).toHaveBeenLastCalledWith(expect.objectContaining({ safe: OWNER, proposalHash: PROPOSAL,
      calls: [{ to: DEPLOYER, data: proof.target.call.data, value: 12n }] }))
    proof.session.direct!.hash = PROPOSAL
    expect(await verifyFinalizedStickyLaunchFailure(proof.session, proof.target, { started: true, hash: HASH, proposalHash: PROPOSAL }, proof.client)).toBe(true)
    expect(await verifyFinalizedStickyLaunchFailure(proof.session, proof.target, { started: true, hash: HASH, proposalHash: OTHER_HASH }, proof.client)).toBe(false)
  })

  it('keeps outer Safe reverts, missing/wrong proposals, successes and different inner calls locked', async () => {
    const reverted = failure(true)
    reverted.receipt.status = 'reverted'
    expect(await reverted.verify()).toBe(false)
    const noProposal = failure(true)
    delete noProposal.session.direct!.proposalHash
    expect(await noProposal.verify()).toBe(false)
    const wrongProposal = failure(true)
    wrongProposal.receipt.logs[0].data = encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [OTHER_HASH, 0n])
    expect(await wrongProposal.verify()).toBe(false)
    const success = failure(true)
    success.receipt.logs[0].topics = encodeEventTopics({ abi: safeAbi, eventName: 'ExecutionSuccess' })
    expect(await success.verify()).toBe(false)
    for (const [data, to, value] of [['0x1234', DEPLOYER, 12n], [undefined, OTHER, 12n], [undefined, DEPLOYER, 13n]] as const) {
      const different = failure(true)
      different.transaction.input = exec(data ?? different.target.call.data, to, value)
      expect(await different.verify()).toBe(false)
    }
    const staleLog = failure(true)
    staleLog.receipt.logs[0].blockHash = OTHER_HASH
    expect(await staleLog.verify()).toBe(false)
    const removedLog = failure(true)
    removedLog.receipt.logs[0].removed = true
    expect(await removedLog.verify()).toBe(false)
  })
})
