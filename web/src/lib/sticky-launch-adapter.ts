'use client'

import { stickyDeployerAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { JBCenterRequestError, type JBCenterIntent } from '@bananapus/nana-sdk-core/jbcenter'
import { gasWithHeadroom, waitForTrackedReceipt } from '@bananapus/nana-sdk-core/review'
import { safeExecutionRunsCalls } from '@bananapus/nana-sdk-core/safe-service'
import {
  RELAYR_API,
  RELAYR_PAYMENT_GAS,
  RELAYR_UUID_RE,
  bindRelayrQuote,
  readRelayrBundle,
  relayrBundleRequest,
  relayrDestinationHash,
  relayrDestinationRecords,
  relayrPaymentDetails,
  relayrPaymentOptions,
  requireRelayrBundleUnpaid,
  requireRelayrPaymentRetry,
  requireRelayrPaymentRuntime,
  simulateRelayrPayment,
  verifyRelayrPayment,
} from '@bananapus/nana-sdk-core/review/relayr'
import { getAccount } from '@wagmi/core'
import { isHash, type Address, type Hex } from 'viem'
import { SUPPORTED_CHAINS } from '@/lib/chains'
import { submitReviewedContractWrite } from '@/lib/contract-write'
import { isSafeConnection, readSafeAppExecution, waitForSafeExecutionHash } from '@/lib/safe-connector'
import { revalidateStickyLaunch, type LaunchPlan } from '@/lib/sticky-launch-plan'
import { validateLaunchCall, verifyFinalizedStickyCallFailure, verifyFinalizedStickyLaunchFailure, verifyStickyLaunchDeployment } from '@/lib/sticky-launch-proof'
import {
  createStickyLaunchController,
  createStickyLaunchStore,
  type StickyLaunchPorts,
  type StickyLaunchSession,
  type SubmissionCallbacks,
  type LaunchSubmission,
} from '@/lib/sticky-launch-session'
import { buildStickyEnvelope, createStickyCenterClient, publishStickyListing } from '@/lib/sticky-listing'
import { fundingChainLabel, requireFundingChainSelection, requireTransactionReview } from '@/lib/transaction-review'
import { chainName } from '@/lib/urn'
import { assertNoViewAs } from '@/lib/viewAs'
import { assertReviewedWallet, connectedWallet, publicClient } from '@/lib/wallet-core'
import { wagmiConfig } from '@/providers/Providers'

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()
const clientFor = (chainId: number) => publicClient(chainId as JBChainId)
const chainsOf = (plan: LaunchPlan) => plan.targets.map(target => target.chainId)

function reviewedChain(chainId: number) {
  const chain = SUPPORTED_CHAINS.find(candidate => candidate.id === chainId)
  if (!chain) throw new Error('The reviewed launch uses an unsupported chain.')
  return chain
}

function guard(owner: Address): void {
  assertNoViewAs()
  const connected = getAccount(wagmiConfig)
  if (connected.connector?.id === 'juicebox-center') throw new Error('Connect an external wallet to create a Sticky token.')
  if (!connected.address || !same(connected.address, owner)) throw new Error('Connect the wallet that prepared this launch.')
}

function reviewedWallet(account: Address) {
  guard(account)
  return { account, connectorUid: getAccount(wagmiConfig).connector?.uid,
    safe: isSafeConnection(wagmiConfig), allowCenter: false }
}

/** A saved quote must still describe the immutable calls reviewed by this launch. */
function boundQuote(session: StickyLaunchSession) {
  const { quote, plan } = session
  if (!quote || quote.bundle_uuid !== session.bundleUuid || !RELAYR_UUID_RE.test(quote.bundle_uuid)) {
    throw new Error('The saved launch has no authenticated payment quote. Keep it saved for recovery.')
  }
  plan.targets.forEach(target => validateLaunchCall(plan, target))
  const expected = relayrBundleRequest(plan.targets.map(target => target.call)).transactions
  const bindings = quote.expectedTransactions
  if (!Array.isArray(bindings) || bindings.length !== expected.length || new Set(bindings.map(item => item.txUuid)).size !== expected.length) {
    throw new Error('The saved payment quote does not identify every launch call.')
  }
  for (const [index, binding] of bindings.entries()) {
    const call = expected[index]
    if (!RELAYR_UUID_RE.test(binding.txUuid) || binding.chain !== call.chain || binding.entry.chain !== call.chain ||
        !same(binding.entry.target, call.target) || !same(binding.entry.data, call.data) ||
        binding.entry.value !== call.value || (binding.entry.virtual_nonce ?? 0) !== call.virtual_nonce) {
      throw new Error('The saved payment quote differs from the reviewed launch.')
    }
  }
  return quote
}

/** Center rows name candidates only. First bind their listing to this exact reviewed launch. */
function matchingIntent(session: StickyLaunchSession, intent: JBCenterIntent): JBCenterIntent {
  const expected = buildStickyEnvelope(session.plan)
  const actual = intent.envelope
  const expectedIds = [...expected.chainIds].sort((a, b) => a - b)
  if (intent.id !== session.listing.intentId || !same(intent.publisher, session.plan.owner) ||
      actual.format !== expected.format || actual.deploymentVersion !== expected.deploymentVersion ||
      JSON.stringify([...actual.chainIds].sort((a, b) => a - b)) !== JSON.stringify(expectedIds) ||
      actual.deploymentCalls.length !== expected.deploymentCalls.length ||
      expected.deploymentCalls.some(call => {
        const matches = actual.deploymentCalls.filter(item => item.chainId === call.chainId)
        return matches.length !== 1 || !same(matches[0].to, call.to) || !same(matches[0].data, call.data)
      }) || Object.entries(expected.jb).some(([key, value]) => {
        const shown = actual.jb[key]
        return (key === 'owner' || key === 'stakedToken') && typeof shown === 'string' && typeof value === 'string'
          ? !same(shown, value) : JSON.stringify(shown) !== JSON.stringify(value)
      })) throw new Error('The saved listing differs from the reviewed launch.')
  return intent
}

function reviewCalls(plan: LaunchPlan) {
  return plan.targets.map(target => ({
    chainId: target.chainId, from: plan.owner, to: target.call.target, data: target.call.data,
    value: BigInt(target.call.value), abi: stickyDeployerAbi, functionName: 'deployStickyFor',
    args: validateLaunchCall(plan, target), label: `Create ${plan.symbol}`, contractName: 'Sticky Deployer',
  }))
}

/** No destination balance or code is replaced: only the payer's native fee balance is supplied for relayed simulation. */
async function checkLaunch(plan: LaunchPlan) {
  guard(plan.owner)
  await revalidateStickyLaunch(plan)
  for (const call of reviewCalls(plan)) {
    await clientFor(call.chainId).simulateContract({ address: call.to, abi: stickyDeployerAbi,
      functionName: 'deployStickyFor', args: call.args, account: plan.owner, value: call.value,
      stateOverride: [{ address: plan.owner, balance: call.value + 100n * 10n ** 18n }] })
  }
  guard(plan.owner)
}

/** A proposal hash is saved before polling and is never mistaken for an onchain receipt hash. */
async function resolveSafe(chainId: number, hash: Hex, timeoutMs = 15_000): Promise<Hex> {
  return waitForSafeExecutionHash(chainId, hash, {
    client: clientFor(chainId), signal: AbortSignal.timeout(timeoutMs), pollingIntervalMs: 1_000,
  })
}

export function createBrowserStickyLaunchController({ changed, phase = () => {} }: {
  changed?: (session: StickyLaunchSession | null) => void
  phase?: (line: string) => void
} = {}) {
  const store = createStickyLaunchStore(window.localStorage)
  const center = createStickyCenterClient()
  const readIntent = async (session: StickyLaunchSession) => {
    if (!session.listing.intentId) throw new Error('The launch has no published listing.')
    return matchingIntent(session, await center.getIntent(session.listing.intentId))
  }
  const safeResult = async (chainId: number, hash: Hex, viaSafe: boolean, callbacks: SubmissionCallbacks) => {
    if (!isHash(hash)) throw new Error('The wallet did not return a readable submission hash. Keep the launch saved.')
    await callbacks.submitted(hash, viaSafe ? hash : undefined)
    let execution = hash
    if (viaSafe) {
      phase('Waiting for the multisig to execute. You can close this dialog and resume later.')
      execution = await resolveSafe(chainId, hash)
      await callbacks.submitted(execution, hash)
    }
    const receipt = await waitForTrackedReceipt(clientFor(chainId), execution)
    if (!isHash(receipt.transactionHash)) throw new Error('The submitted transaction has no readable receipt hash. Keep the launch saved.')
    if (!same(receipt.transactionHash, execution)) await callbacks.submitted(receipt.transactionHash, viaSafe ? hash : undefined)
    return receipt.transactionHash
  }
  const ports: StickyLaunchPorts = {
    store, guard, changed,
    async review(plan, sponsored) {
      phase('Checking the launch on every selected chain.')
      await checkLaunch(plan)
      await requireTransactionReview({ calls: reviewCalls(plan), title: 'Review Sticky launch',
        kind: sponsored ? 'authorization' : 'transaction',
        description: sponsored ? 'Approve listing and sponsored creation on the selected chains.' : 'Review creation on every selected chain before listing or payment.',
        confirmLabel: 'Continue' })
      guard(plan.owner)
    },
    async quote(plan, rememberUuid, beforePublish) {
      await checkLaunch(plan)
      phase('Getting payment options for the selected chains.')
      const request = relayrBundleRequest(plan.targets.map(target => target.call))
      guard(plan.owner)
      beforePublish()
      const response = await fetch(`${RELAYR_API}/v1/bundle/prepaid`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
        signal: AbortSignal.timeout(45_000),
      })
      // Even a response whose transaction bindings fail may have published these non-idempotent raw calls.
      if (response.ok) {
        const value: unknown = await response.clone().json()
        const uuid = value && typeof value === 'object' && 'bundle_uuid' in value ? value.bundle_uuid : undefined
        if (typeof uuid === 'string' && RELAYR_UUID_RE.test(uuid.toLowerCase())) rememberUuid(uuid.toLowerCase())
      }
      return bindRelayrQuote(response, request)
    },
    async status(session) {
      const found: Record<number, Hex[]> = Object.fromEntries(session.plan.targets.map(target => [target.chainId, []]))
      const reads: Promise<void>[] = []
      if (session.quote) reads.push((async () => {
        const quote = boundQuote(session)
        const bundle = await readRelayrBundle(quote.bundle_uuid)
        if (!Array.isArray(bundle.transactions)) throw new Error('The saved bundle has no launch transaction inventory.')
        const records = relayrDestinationRecords({ bindings: quote.expectedTransactions, records: bundle.transactions })
        for (const [index, record] of records.entries()) {
          const hash = relayrDestinationHash(record)
          if (hash) found[quote.expectedTransactions[index].chain].push(hash)
        }
      })())
      if (session.listing.intentId) reads.push((async () => {
        const intent = await readIntent(session)
        for (const row of [...intent.deployments, ...intent.deploys]) {
          if (found[row.chainId] && row.transactionHash && isHash(row.transactionHash)) found[row.chainId].push(row.transactionHash)
        }
      })())
      if (session.direct?.proposalHash) reads.push((async () => {
        const chainId = session.plan.targets[0].chainId
        found[chainId].push(await resolveSafe(chainId, session.direct!.proposalHash!, 2_000))
      })())
      const outcomes = await Promise.allSettled(reads)
      const failure = outcomes.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected' && !Object.values(found).some(hashes => hashes.length)) throw failure.reason
      return found
    },
    async choosePayment(session) {
      const quote = boundQuote(session)
      const options = relayrPaymentOptions(quote, chainsOf(session.plan))
      const selected = await requireFundingChainSelection(options.map(option => ({ chainId: option.chain,
        label: fundingChainLabel(chainName(option.chain), BigInt(option.amount)) })))
      const payment = options.find(option => option.chain === selected)
      if (!payment) throw new Error('Choose a payment option from this launch quote.')
      return payment
    },
    async sendDirect(session, callbacks) {
      const { plan } = session
      if (plan.targets.length !== 1) throw new Error('A direct launch must have exactly one chain.')
      const [target] = plan.targets
      const chain = reviewedChain(target.chainId)
      const request = { chainId: target.chainId, address: target.deployer, abi: stickyDeployerAbi,
        functionName: 'deployStickyFor' as const, args: validateLaunchCall(plan, target), value: BigInt(target.call.value) }
      const client = clientFor(target.chainId)
      const authority = reviewedWallet(plan.owner)
      const viaSafe = authority.safe
      let wallet: Awaited<ReturnType<typeof connectedWallet>>['wallet'] | undefined
      const hash = await submitReviewedContractWrite({ request, expectedAccount: plan.owner,
        currentAccount: () => getAccount(wagmiConfig).address,
        review: () => requireTransactionReview({ title: 'Review Sticky creation', calls: reviewCalls(plan).map(call => ({ ...call, ...(viaSafe ? { safeTxGas: 0n } : {}) })) }),
        switchChain: async chainId => { ({ wallet } = await connectedWallet(chainId as JBChainId, { expected: plan.owner, requireUnchanged: true, changedError: 'Connect the wallet that prepared this launch.' })) },
        reverify: () => checkLaunch(plan),
        simulate: async reviewed => {
          const simulation = { ...reviewed, account: plan.owner }
          const [{ request: simulated }, estimate] = await Promise.all([client.simulateContract(simulation), client.estimateContractGas(simulation)])
          guard(plan.owner)
          return { ...simulated, gas: viaSafe ? 0n : gasWithHeadroom(estimate) }
        },
        beforeWrite: callbacks.beforeWrite, onBeforeWriteAborted: callbacks.rejected, onWriteRejected: callbacks.rejected,
        beforeSend: () => {
          assertReviewedWallet({ ...authority, chainId: target.chainId })
          if (!wallet) throw new Error('Wallet connection changed. Review the launch again.')
        },
        write: simulated => wallet!.writeContract({ ...simulated, chain }),
        onPhase: value => phase(value === 'signing' ? 'Confirm creation in your wallet.' : 'Checking the launch transaction.'),
      })
      await safeResult(target.chainId, hash, viaSafe, callbacks)
    },
    async sendPayment(session, callbacks) {
      const quote = boundQuote(session)
      if (!session.payment) throw new Error('Choose a payment option first.')
      const details = relayrPaymentDetails(session.payment.option, { bundleUuid: quote.bundle_uuid, destinationChainIds: chainsOf(session.plan) })
      const chain = reviewedChain(details.chainId)
      const { owner } = session.plan
      const client = clientFor(details.chainId)
      const authority = reviewedWallet(owner)
      const viaSafe = authority.safe
      let wallet: Awaited<ReturnType<typeof connectedWallet>>['wallet'] | undefined
      const request = { chainId: details.chainId, from: owner, to: details.target, data: details.calldata,
        value: details.amount, gas: RELAYR_PAYMENT_GAS }
      const assertPaymentSnapshot = () => {
        boundQuote(session)
        const live = relayrPaymentDetails(session.payment!.option, { bundleUuid: quote.bundle_uuid, destinationChainIds: chainsOf(session.plan) })
        if (live.chainId !== details.chainId || live.amount !== details.amount || !same(live.calldata, details.calldata)) throw new Error('The launch payment changed. Review its original option again.')
      }
      const reverify = async () => {
        guard(owner)
        assertPaymentSnapshot()
        await checkLaunch(session.plan)
        await requireRelayrBundleUnpaid(quote.bundle_uuid)
        await requireRelayrPaymentRuntime(client)
        guard(owner)
      }
      const hash = await submitReviewedContractWrite({ request, expectedAccount: owner,
        currentAccount: () => getAccount(wagmiConfig).address,
        review: async reviewed => {
          await reverify()
          await requireTransactionReview({ title: 'Review execution payment', confirmLabel: 'Pay',
            description: 'One payment covers creation on all selected chains.', calls: [{ ...reviewed,
              ...(viaSafe ? { safeTxGas: 0n } : {}), label: `Create ${session.plan.symbol}`, contractName: 'Prepaid payment' }] })
        },
        switchChain: async chainId => { ({ wallet } = await connectedWallet(chainId as JBChainId, { expected: owner, requireUnchanged: true, changedError: 'Connect the wallet that prepared this launch.' })) },
        reverify,
        simulate: async () => {
          await simulateRelayrPayment(client, { from: owner, payment: details })
          guard(owner)
          return { account: owner, to: details.target, data: details.calldata, value: details.amount, gas: viaSafe ? 0n : RELAYR_PAYMENT_GAS }
        },
        beforeWrite: async () => { await reverify(); await callbacks.beforeWrite() },
        onBeforeWriteAborted: callbacks.rejected, onWriteRejected: callbacks.rejected,
        beforeSend: () => {
          assertReviewedWallet({ ...authority, chainId: details.chainId })
          assertPaymentSnapshot()
          if (!wallet) throw new Error('Wallet connection changed. Review the payment again.')
        },
        write: simulated => wallet!.sendTransaction({ ...simulated, chain }),
        onPhase: value => phase(value === 'signing' ? 'Confirm payment in your wallet.' : 'Checking the execution payment.'),
      })
      const execution = await safeResult(details.chainId, hash, viaSafe, callbacks)
      phase('Payment submitted. Checking execution on each chain.')
      if (!(await ports.verifyPayment({ ...session,
        payment: { ...session.payment, hash: execution, proposalHash: viaSafe ? hash : undefined },
      }))) throw new Error('The original payment is still being verified. Keep this launch saved; do not pay again.')
    },
    async verifyPayment(session) {
      const quote = boundQuote(session)
      const payment = session.payment
      if (!payment?.hash) return false
      const details = relayrPaymentDetails(payment.option, { bundleUuid: quote.bundle_uuid,
        destinationChainIds: chainsOf(session.plan), nowSeconds: 0 })
      const client = clientFor(details.chainId)
      const hash = payment.proposalHash && same(payment.hash, payment.proposalHash)
        ? await resolveSafe(details.chainId, payment.proposalHash, 2_000) : payment.hash
      if (payment.proposalHash) {
        const [receipt, transaction] = await Promise.all([client.getTransactionReceipt({ hash }), client.getTransaction({ hash })])
        const calls = [{ to: details.target, data: details.calldata, value: details.amount.toString() }]
        if (!safeExecutionRunsCalls(transaction, session.plan.owner, calls)) return false
        const proof = await readSafeAppExecution({ client, receipt, safe: session.plan.owner, proposalHash: payment.proposalHash,
          calls })
        if (proof.status !== 'success') return false
      }
      await verifyRelayrPayment(client, { hash, from: session.plan.owner, payment: details })
      return true
    },
    async requireRetry(session, kind, purpose) {
      guard(session.plan.owner)
      phase('Checking previous submissions.')
      const refused = 'Every previous submission must be proven finalized and failed. Keep this launch saved and check again.'
      const minedSubmission = async (chainId: number, submission: LaunchSubmission): Promise<LaunchSubmission> => {
        if (!submission.started || !submission.hash || !isHash(submission.hash)) throw new Error(refused)
        return submission.proposalHash && same(submission.hash, submission.proposalHash)
          ? { ...submission, hash: await resolveSafe(chainId, submission.proposalHash, 2_000) } : submission
      }
      if (kind === 'direct') {
        const [target] = session.plan.targets
        if (session.plan.targets.length !== 1) throw new Error('Only a single-chain wallet creation can be retried directly.')
        const attempts = [...(session.directAttempts ?? []), ...(session.direct?.started ? [session.direct] : [])]
        if (!attempts.length) throw new Error(refused)
        for (const attempt of attempts) {
          if (!(await verifyFinalizedStickyLaunchFailure(session, target, await minedSubmission(target.chainId, attempt), clientFor(target.chainId)))) throw new Error(refused)
        }
      } else {
        const quote = boundQuote(session)
        const attempts = [...(session.paymentAttempts ?? []), ...(session.payment?.started ? [session.payment] : [])]
        if (!attempts.length) throw new Error(refused)
        const directPayments = new Map<string, { payment: ReturnType<typeof relayrPaymentDetails>; hashes: Hex[] }>()
        for (const attempt of attempts) {
          const details = relayrPaymentDetails(attempt.option, { bundleUuid: quote.bundle_uuid,
            destinationChainIds: chainsOf(session.plan), ...(purpose === 'retire' ? { nowSeconds: 0 } : {}) })
          const submission = await minedSubmission(details.chainId, attempt)
          if (!(await verifyFinalizedStickyCallFailure({ chainId: details.chainId, owner: session.plan.owner,
            call: { to: details.target, data: details.calldata, value: details.amount }, submission }, clientFor(details.chainId)))) throw new Error(refused)
          if (!submission.proposalHash) {
            const key = `${details.chainId}:${details.target.toLowerCase()}:${details.calldata.toLowerCase()}:${details.amount}`
            const group = directPayments.get(key) ?? { payment: details, hashes: [] }
            group.hashes.push(submission.hash!)
            directPayments.set(key, group)
          }
        }
        if (purpose === 'retry') {
          // The SDK retries exact EOA reverts. Safe attempts instead need the consumed inner failure proven above.
          for (const { payment, hashes } of directPayments.values()) {
            await requireRelayrPaymentRetry(clientFor(payment.chainId), { hashes, from: session.plan.owner, payment })
          }
          // Each SDK EOA group ends with a fresh unpaid check; a Safe-only history still needs that check.
          if (!directPayments.size) await requireRelayrBundleUnpaid(quote.bundle_uuid)
        }
      }
      guard(session.plan.owner)
    },
    verifyDeployment: verifyStickyLaunchDeployment,
    async publishListing(plan) {
      const authority = reviewedWallet(plan.owner)
      const intent = await publishStickyListing(plan, async message => {
        assertReviewedWallet(authority)
        await requireTransactionReview({ title: 'Publish Sticky listing', kind: 'authorization',
          description: 'Authorize the exact saved launch calls and metadata for this listing.', confirmLabel: 'Publish',
          calls: reviewCalls(plan) })
        assertReviewedWallet(authority)
        const { wallet } = await connectedWallet(plan.targets[0].chainId as JBChainId, { expected: plan.owner, requireUnchanged: true, changedError: 'Connect the wallet that prepared this launch.' })
        assertReviewedWallet({ ...authority, chainId: plan.targets[0].chainId })
        const signature = await wallet.signMessage({ account: plan.owner, message })
        assertReviewedWallet({ ...authority, chainId: plan.targets[0].chainId })
        return signature
      })
      return intent.id
    },
    async sponsor(session, beforeRequest) {
      await checkLaunch(session.plan)
      await readIntent(session)
      guard(session.plan.owner)
      beforeRequest()
      await center.requestDeploy(session.listing.intentId!, { chainIds: chainsOf(session.plan) })
    },
    async record(session, chainId, result) {
      const target = session.plan.targets.find(item => item.chainId === chainId)
      if (!target || !session.listing.intentId) return false
      const client = clientFor(chainId)
      const receipt = await client.getTransactionReceipt({ hash: result.hash })
      const head = await client.getBlockNumber({ cacheTime: 0 })
      if (head < receipt.blockNumber + 1n) return false
      const proven = await verifyStickyLaunchDeployment(session, target, result.hash)
      if (!proven || proven.projectId !== result.projectId || !same(proven.token, result.token)) return false
      try {
        const recorded = await center.recordDeployment(session.listing.intentId, { chainId, projectId: result.projectId, transactionHash: result.hash })
        return recorded.chainId === chainId && recorded.projectId === result.projectId && same(recorded.transactionHash, result.hash)
      } catch (error) {
        if (error instanceof JBCenterRequestError && error.status === 422) return false
        throw error
      }
    },
  }
  const controller = createStickyLaunchController(ports)
  const exclusive = async <T>(run: () => Promise<T> | T): Promise<T> => {
    if (!navigator.locks) throw new Error('This browser cannot coordinate launch recovery across tabs. Use a browser with Web Locks support.')
    return await navigator.locks.request('sticky-launch-write', { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('Another tab is processing this launch. Resume it there or wait for it to finish.')
      return run()
    })
  }
  return {
    load: controller.load,
    prepare: (...args: Parameters<typeof controller.prepare>) => exclusive(() => controller.prepare(...args)),
    run: () => exclusive(controller.run),
    refresh: () => exclusive(controller.refresh),
    list: () => exclusive(controller.list),
    selfPay: () => exclusive(controller.selfPay),
    retry: () => exclusive(controller.retry),
    addHash: (...args: Parameters<typeof controller.addHash>) => exclusive(() => controller.addHash(...args)),
    clear: () => exclusive(controller.clear),
  }
}
