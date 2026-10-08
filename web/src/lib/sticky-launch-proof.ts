import {
  erc2771ForwarderAbi,
  jbProjectsAbi,
  stickyDeployerAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { atCanonicalFinalizedBlock } from '@bananapus/nana-sdk-core/review/relayr'
import { readSafeAppExecution, safeExecutionRunsCalls } from '@bananapus/nana-sdk-core/safe-service'
import { decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAbiItem, isAddressEqual, isHash, zeroAddress, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { validateLaunchCall, type LaunchTarget } from '@/lib/sticky-launch-plan'
import type { LaunchResult, LaunchSubmission, StickyLaunchSession } from '@/lib/sticky-launch-session'
import { STICKY_LISTING_FORWARDER } from '@/lib/sticky-listing'
import { publicClient } from '@/lib/wallet-core'

const same = (a: string | null | undefined, b: string | null | undefined) =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

export { validateLaunchCall } from '@/lib/sticky-launch-plan'
const DEPLOY_TOPIC = encodeEventTopics({ abi: stickyDeployerAbi, eventName: 'DeploySticky' })[0]
const CREATE_TOPIC = encodeEventTopics({ abi: jbProjectsAbi, eventName: 'Create' })[0]
const DEPLOY_DATA = getAbiItem({ abi: stickyDeployerAbi, name: 'DeploySticky' }).inputs.filter(input => !input.indexed)
const CREATE_DATA = getAbiItem({ abi: jbProjectsAbi, name: 'Create' }).inputs.filter(input => !input.indexed)

/** A sponsor may use execute or executeBatch; only a canonical exact inner launch identifies its caller. */
function forwardedCaller(transaction: { to: Address | null; input: Hex }, target: LaunchTarget): Address | null {
  if (!same(transaction.to, STICKY_LISTING_FORWARDER)) return null
  try {
    const decoded = decodeFunctionData({ abi: erc2771ForwarderAbi, data: transaction.input })
    const requests = decoded.functionName === 'execute' ? [decoded.args[0]]
      : decoded.functionName === 'executeBatch' ? decoded.args[0] : []
    const matches = requests.filter(request => same(request.to, target.deployer) && same(request.data, target.call.data) && request.value === BigInt(target.call.value))
    if (matches.length !== 1) return null
    const encoded = decoded.functionName === 'execute'
      ? encodeFunctionData({ abi: erc2771ForwarderAbi, functionName: 'execute', args: decoded.args })
      : decoded.functionName === 'executeBatch'
        ? encodeFunctionData({ abi: erc2771ForwarderAbi, functionName: 'executeBatch', args: decoded.args }) : null
    return same(encoded, transaction.input) ? matches[0].from : null
  } catch { return null }
}

/** Read one exact included transaction; callers choose the receipt outcome their proof requires. */
async function canonicalTransaction(
  client: PublicClient,
  expectedChainId: number,
  hash: Hex,
  status: 'success' | 'reverted',
) {
  const [transaction, receipt, chainId] = await Promise.all([
    client.getTransaction({ hash }), client.getTransactionReceipt({ hash }), client.getChainId(),
  ])
  if (chainId !== expectedChainId || !same(transaction.hash, hash) || !same(receipt.transactionHash, hash) || transaction.chainId !== expectedChainId ||
      receipt.status !== status || !same(transaction.blockHash, receipt.blockHash) ||
      transaction.blockNumber !== receipt.blockNumber || !same(receipt.to, transaction.to) || !same(receipt.from, transaction.from) ||
      transaction.transactionIndex !== receipt.transactionIndex) return null
  const includesReceipt = (block: Awaited<ReturnType<PublicClient['getBlock']>>) => same(block.hash, receipt.blockHash) &&
    block.number === receipt.blockNumber && same(block.transactions[receipt.transactionIndex] as Hex | undefined, hash)
  const block = await client.getBlock({ blockNumber: receipt.blockNumber })
  if (!includesReceipt(block)) return null
  return { transaction, receipt, includesReceipt }
}

const canonicalLog = (log: TransactionReceipt['logs'][number], receipt: TransactionReceipt) =>
  !log.removed && same(log.transactionHash, receipt.transactionHash) && same(log.blockHash, receipt.blockHash) && log.blockNumber === receipt.blockNumber

/** Prove only this recorded attempt failed; the caller must account for every other published or submitted attempt. */
export async function verifyFinalizedStickyCallFailure({ chainId, owner, call, submission }: {
  chainId: number
  owner: Address
  call: { to: Address; data: Hex; value: bigint }
  submission: LaunchSubmission
}, client: PublicClient): Promise<boolean> {
  const { hash, proposalHash, started } = submission
  if (!started || !hash || !isHash(hash) || (proposalHash !== undefined && !isHash(proposalHash))) return false
  const { to, data, value } = call
  const calls = [{ to, data, value }]
  const status = proposalHash ? 'success' : 'reverted'
  const proveFailure = async (evidence: NonNullable<Awaited<ReturnType<typeof canonicalTransaction>>>) => {
    const { transaction, receipt } = evidence
    if (!proposalHash) return same(transaction.from, owner) && same(transaction.to, to) &&
      same(transaction.input, data) && transaction.value === value
    // An outer revert leaves a Safe proposal live. A consumed failure must also run exactly the reviewed inner call.
    if (!safeExecutionRunsCalls(transaction, owner, calls) ||
      receipt.logs.some(log => same(log.address, owner) && !canonicalLog(log, receipt))) return false
    return (await readSafeAppExecution({ client, receipt, safe: owner, proposalHash, calls })).status === 'failed'
  }
  try {
    const initial = await canonicalTransaction(client, chainId, hash, status)
    if (!initial || !(await proveFailure(initial))) return false
    const finalized = await atCanonicalFinalizedBlock(client, async blockNumber => {
      if (initial.receipt.blockNumber > blockNumber) return false
      // Re-read the exact receipt after the finalized head: a reorg or provider disagreement never releases the attempt.
      const current = await canonicalTransaction(client, chainId, hash, status)
      if (!current || !same(current.receipt.blockHash, initial.receipt.blockHash) ||
        current.receipt.blockNumber !== initial.receipt.blockNumber || current.receipt.transactionIndex !== initial.receipt.transactionIndex) return false
      return proveFailure(current)
    })
    return finalized?.value === true
  } catch { return false }
}

/** A UI recovery candidate cannot stand in for a saved submission, even if it ran identical launch calldata. */
export async function verifyFinalizedStickyLaunchFailure(
  session: StickyLaunchSession,
  target: LaunchTarget,
  submission: LaunchSubmission,
  client: PublicClient = publicClient(target.chainId as JBChainId),
): Promise<boolean> {
  if (session.mode !== 'direct' || !submission.started) return false
  const attempts = [...(session.directAttempts ?? []), ...(session.direct ? [session.direct] : [])]
  const recorded = attempts.some(saved => saved.started && (saved.proposalHash
    ? same(saved.proposalHash, submission.proposalHash) && (!saved.hash || same(saved.hash, saved.proposalHash) || same(saved.hash, submission.hash))
    : !submission.proposalHash && same(saved.hash, submission.hash)))
  if (!recorded) return false
  try {
    validateLaunchCall(session.plan, target)
    return verifyFinalizedStickyCallFailure({ chainId: target.chainId, owner: session.plan.owner,
      call: { to: target.call.target, data: target.call.data, value: BigInt(target.call.value) }, submission }, client)
  } catch { return false }
}

/** A candidate hash is only a hint. Exact call, canonical inclusion and both creation events prove completion. */
export async function verifyStickyLaunchDeployment(
  session: StickyLaunchSession,
  target: LaunchTarget,
  hash: Hex,
  client: PublicClient = publicClient(target.chainId as JBChainId),
): Promise<LaunchResult | null> {
  validateLaunchCall(session.plan, target)
  const evidence = await canonicalTransaction(client, target.chainId, hash, 'success')
  if (!evidence) return null
  const { transaction, receipt, includesReceipt } = evidence
  let caller: Address | null = null
  if (same(transaction.to, target.deployer) && same(transaction.input, target.call.data) && transaction.value === BigInt(target.call.value)) {
    if (session.mode === 'direct' && !same(transaction.from, session.plan.owner)) return null
    caller = transaction.from
  } else if (session.mode === 'center') {
    caller = forwardedCaller(transaction, target)
  } else if (session.mode === 'direct' && same(transaction.to, session.plan.owner)) {
    const calls = [{ to: target.deployer, data: target.call.data, value: target.call.value }]
    if (!safeExecutionRunsCalls(transaction, session.plan.owner, calls)) return null
    const result = await readSafeAppExecution({
      client, receipt, safe: session.plan.owner,
      proposalHash: session.direct?.proposalHash ?? hash,
      calls,
    })
    if (result.status === 'success') caller = session.plan.owner
  }
  if (!caller) return null
  const deployed = receipt.logs.filter(log => same(log.address, target.deployer) && same(log.topics[0], DEPLOY_TOPIC))
  if (deployed.length !== 1 || !canonicalLog(deployed[0], receipt) || deployed[0].topics.length !== 3 || !/^0x[0-9a-f]{256}$/i.test(deployed[0].data)) return null
  let event
  try { event = decodeEventLog({ abi: stickyDeployerAbi, eventName: 'DeploySticky', topics: deployed[0].topics, data: deployed[0].data, strict: true }).args }
  catch { return null }
  const deployTopics = encodeEventTopics({ abi: stickyDeployerAbi, eventName: 'DeploySticky', args: event })
  if (deployTopics.some((topic, index) => !same(topic as Hex, deployed[0].topics[index])) ||
      !same(encodeAbiParameters(DEPLOY_DATA, [event.token, event.cashOutTaxRate, event.soulbound, event.caller]), deployed[0].data)) return null
  if (event.projectId <= 0n || isAddressEqual(event.token, zeroAddress) || !same(event.stakedToken, session.plan.token) ||
      event.cashOutTaxRate.toString() !== session.plan.cashOutTaxRate || event.soulbound !== session.plan.soulbound ||
      !same(event.caller, caller)) return null
  const created = receipt.logs.filter(log => same(log.address, target.projects) && same(log.topics[0], CREATE_TOPIC))
  if (created.length !== 1 || !canonicalLog(created[0], receipt) || created[0].topics.length !== 3 || !/^0x[0-9a-f]{64}$/i.test(created[0].data)) return null
  let creation
  try { creation = decodeEventLog({ abi: jbProjectsAbi, eventName: 'Create', topics: created[0].topics, data: created[0].data, strict: true }).args }
  catch { return null }
  const createTopics = encodeEventTopics({ abi: jbProjectsAbi, eventName: 'Create', args: creation })
  if (createTopics.some((topic, index) => !same(topic as Hex, created[0].topics[index])) ||
      !same(encodeAbiParameters(CREATE_DATA, [creation.caller]), created[0].data)) return null
  if (creation.projectId !== event.projectId || !same(creation.owner, target.deployer) || !same(creation.caller, target.controller)) return null
  // Bracket the asynchronous wrapper proof and event reads with canonicality.
  if (!includesReceipt(await client.getBlock({ blockNumber: receipt.blockNumber }))) return null
  return { hash, projectId: event.projectId.toString(), token: event.token }
}
