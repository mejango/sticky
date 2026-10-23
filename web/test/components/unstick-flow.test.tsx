// @vitest-environment jsdom

/**
 * The Unstick flow, through the real transaction engine (only wagmi is faked, so the review, the simulation and the
 * write run as they do in the app) and the real Center reader against a fake Center (sticky-reward-fixtures.ts): what
 * the flow plans, in what order it sends, what it tells when a send stops halfway, and what it refuses.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, Profiler, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, erc20Abi, getAddress, toEventSelector, toHex, UserRejectedRequestError, zeroAddress, type Abi, type Address, type Hex, type TransactionReceipt } from 'viem'
import { SAFE_EXEC_ABI } from '@bananapus/nana-sdk-core/safe-service'
import { HELD_EXIT_LABEL, registerReviewHandler, REVIEWED_ACCOUNT_CHANGED_LINE, writeExitMessage, writeHeldMessage, WRITE_HOLD_REVERTED_LINE, type ReviewModel, NETWORK_ERROR_LINE } from '@bananapus/nana-sdk-core/review'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { feelessAddressesAbi, stickyAutoStickAbi, stickyHookAbi, terminalAbi } from '@/lib/sticky-abis'
import { unstickTxs } from '@/lib/sticky-builders'
import { jbCenterPublicClient } from '@/lib/jbcenter-public-client'
import { clearViewAs, setViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import { EXTERNAL_WALLET_REQUIRED, WalletAuthContext } from '@/providers/WalletAuthContext'
import { stickyInfo } from '../home-fixtures'
import { CHAIN, HOLDER, OTHER, PROJECT, REVERT, STAKED, STICKY, deployment, rewardChain } from '../lib/sticky-reward-fixtures'

const mocks = vi.hoisted(() => ({
  wallet: { address: undefined as string | undefined, isCenterWallet: false },
  openSignIn: vi.fn(),
  publicClient: {
    chain: { id: 84532 }, waitForTransactionReceipt: vi.fn(), getChainId: vi.fn(), getTransaction: vi.fn(), getTransactionReceipt: vi.fn(), getBlock: vi.fn(),
    getBlockNumber: vi.fn(), getTransactionCount: vi.fn(), estimateGas: vi.fn(async () => 50_000n), getGasPrice: vi.fn(async () => 1n),
    readContract: vi.fn(async () => { throw new Error('no reads here') }),
    /** The chain's simulations (eth_call): each succeeds, unless the chain refuses the steps after the first. */
    request: vi.fn(),
  },
  getAccount: vi.fn(),
  /** The plan's one decoded review of every step left: the test sees its model, and answers it (confirms by default). */
  review: vi.fn(),
  /** The wallet. */
  sendTransaction: vi.fn(),
  confirming: { on: true, status: 'success' as 'success' | 'reverted' },
  safe: { on: false, execution: undefined as undefined | PromiseWithResolvers<string> },
  engine: { silent: false },
  receipts: {} as Record<string, TransactionReceipt>,
  transactions: {} as Record<string, unknown>,
  blocks: {} as Record<string, { hash: Hex; number: bigint; timestamp: bigint }>,
  proposals: {} as Record<string, Write>,
}))

vi.mock('@wagmi/core', () => ({
  getAccount: mocks.getAccount, getPublicClient: () => mocks.publicClient, switchChain: vi.fn(),
  getWalletClient: async () => ({ chain: { id: 84532 }, sendTransaction: mocks.sendTransaction }),
}))
vi.mock('wagmi', () => ({ usePublicClient: () => mocks.publicClient }))
vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({
    isConnected: mocks.wallet.address !== undefined,
    address: mocks.wallet.address,
    isCenterWallet: mocks.wallet.isCenterWallet,
    openSignIn: mocks.openSignIn,
  }),
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => mocks.safe.on,
  SAFE_NONCE_GUIDANCE: 'Safe nonce guidance',
  useSafeConnection: () => mocks.safe.on,
  waitForSafeExecutionHash: () => mocks.safe.execution!.promise,
  atOnceExecution: async () => null,
  findPendingSafeAppProposal: async () => null,
  watchSafeProposal: () => new Promise(() => {}),
}))

import { UnstickFlow } from '@/components/project/flows/UnstickFlow'

const E18 = 10n ** 18n
const HOOK = deployment.hook
const ADAPTER = deployment.autoStick
const TERMINAL = deployment.terminal
const FEELESS = getAddress(`0x${'f'.repeat(40)}`)
const RULESET = {
  cycleNumber: 1,
  id: 1,
  basedOnId: 0,
  start: 0,
  duration: 0,
  weight: 0n,
  weightCutPercent: 0,
  approvalHook: zeroAddress,
  metadata: 0n,
}

/** STICKYART on Base Sepolia, project 12: ART has 6 decimals, there is a 10% bonus, and ten shares claim 25 ART. */
const INFO = stickyInfo(CHAIN, PROJECT, {
  stToken: STICKY,
  stSymbol: 'STICKYART',
  stakedToken: STAKED,
  symbol: 'ART',
  decimals: 6,
  cashOutTaxRate: 1_000n,
  totalSupply: 10n * E18,
  backing: 25_000_000n,
})
const cashOutAbi = unstickTxs(INFO, HOLDER, 1n, 0n)[0].abi

/** What the chain says of the holder, and what the terminal would pay. The defaults are a holder of one share with
 * auto-stick off; a gross of a million at a 10% bonus nets 975,000 after the 2.5% fee. */
type World = {
  balance: bigint
  enabled: boolean
  trusted: boolean
  allowance: bigint
  gross: bigint
  tax: bigint
  unstick: bigint | typeof REVERT
}
const DEFAULTS: World = {
  balance: E18,
  enabled: false,
  trusted: false,
  allowance: 0n,
  gross: 1_000_000n,
  tax: 1_000n,
  unstick: 975_000n,
}

function world(over: Partial<World> = {}) {
  const chain = rewardChain()
  let now = { ...DEFAULTS, ...over }
  const apply = () => {
    chain.stock(STICKY, erc20Abi, 'balanceOf', now.balance)
    chain.stock(ADAPTER, stickyAutoStickAbi, 'configOf', [1_000_000n, 86_400, 0, now.enabled])
    chain.stock(HOOK, stickyHookAbi, 'isTrustedSenderOf', now.trusted)
    chain.stock(STAKED, erc20Abi, 'allowance', now.allowance)
    chain.stock(TERMINAL, terminalAbi, 'previewCashOutFrom', [RULESET, now.gross, now.tax, []])
    chain.stock(TERMINAL, terminalAbi, 'feeFreeSurplusOf', 0n)
    chain.stock(TERMINAL, terminalAbi, 'FEELESS_ADDRESSES', FEELESS)
    chain.stock(FEELESS, feelessAddressesAbi, 'isFeelessFor', false)
    chain.stock(TERMINAL, cashOutAbi, 'cashOutTokensOf', now.unstick)
  }
  apply()
  return {
    chain,
    /** The chain as it is from now on. */
    set(next: Partial<World>) {
      now = { ...now, ...next }
      apply()
    },
  }
}

let host: HTMLDivElement
let root: Root
let client: QueryClient
const closed = vi.fn()
const requestSignIn = vi.fn()

/** Counts every hash the wallet has answered, across tests: core follows a hash it has seen once. */
let hashes = 0
/** The hashes the wallet answered in this test, in order. */
const answered: Hex[] = []
/** Counts tests: a receipt wait of a test that ended stops. */
let generation = 0
let unregister = () => {}
beforeEach(() => {
  generation += 1
  mocks.receipts = {}
  mocks.transactions = {}
  mocks.blocks = {}
  mocks.proposals = {}
  commits.length = 0
  answered.length = 0
  mocks.wallet = { address: HOLDER, isCenterWallet: false }
  mocks.confirming = { on: true, status: 'success' }
  mocks.safe = { on: false, execution: Promise.withResolvers<string>() }
  mocks.engine.silent = false
  mocks.getAccount.mockImplementation(() => ({ address: mocks.wallet.address, chainId: CHAIN }))
  mocks.review.mockReset().mockResolvedValue(true)
  unregister = registerReviewHandler(async prompt => ((await mocks.review(prompt.model)) ? prompt.confirmation : null))
  mocks.publicClient.request.mockReset().mockImplementation(async ({ method, params }: { method: string; params?: [{ data?: Hex }] }) => {
    if (method !== 'eth_call') throw new Error(`unexpected ${method}`)
    // A Safe's nonce(): the one read of a Safe's own state.
    if (params?.[0].data === '0xaffed0e0') return toHex(5n, { size: 32 })
    if (mocks.engine.silent) throw new Error('execution reverted')
    return '0x'
  })
  mocks.publicClient.getChainId.mockResolvedValue(CHAIN)
  // The head is the last mined block: a step is simulated at its prior step's block once the head has it.
  mocks.publicClient.getBlockNumber.mockImplementation(async () => 100n + BigInt(Object.keys(mocks.transactions).length))
  mocks.publicClient.getTransactionCount.mockResolvedValue(3)
  mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: string }) => {
    const transaction = mocks.transactions[hash.toLowerCase()]
    if (!transaction) throw new Error('Transaction not found')
    return transaction
  })
  const receiptOf = async ({ hash }: { hash: string }) => {
    const receipt = mocks.confirming.on && mocks.receipts[hash.toLowerCase()]
    if (!receipt) throw new Error('Receipt not found')
    return receipt
  }
  mocks.publicClient.getTransactionReceipt.mockImplementation(receiptOf)
  const mine = generation
  mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: string }) => {
    for (;;) {
      if (generation !== mine) throw new Error('The test ended.')
      const receipt = mocks.confirming.on && mocks.receipts[hash.toLowerCase()]
      if (receipt) return receipt
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  })
  mocks.publicClient.getBlock.mockImplementation(async ({ blockNumber, blockTag }: { blockNumber?: bigint; blockTag?: string } = {}) => {
    // The head (asked with no block) is the last mined block, or the one before any.
    if (blockNumber === undefined && blockTag !== 'finalized' && !Object.keys(mocks.blocks).length) {
      return { hash: toHex(99n, { size: 32 }), number: 99n, timestamp: 1_790_000_099n }
    }
    const block = blockNumber === undefined ? Object.values(mocks.blocks).at(-1) : mocks.blocks[String(blockNumber)]
    if (!block) throw new Error('Block not found')
    return block
  })
  mocks.sendTransaction.mockReset().mockImplementation(walletSends)
  mocks.openSignIn.mockResolvedValue(undefined)
  requestSignIn.mockResolvedValue(undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  unregister()
  // A run the test left going ends here, with nothing more sent: its reads fail at once (an invalid-params answer is not
  // retried, and the real fetch the setup restores would go to the network), before the next test resets its holds.
  generation += 1
  mocks.engine.silent = true
  mocks.sendTransaction.mockImplementation(async () => { throw Object.assign(new Error('The test ended.'), { code: 4001 }) })
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const { id } = JSON.parse(String(init.body)) as { id: number }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message: 'The test ended.' } }), { headers: { 'content-type': 'application/json' } })
  })
  // The paced Center limiter still holds the reads queued before the stub: one more read through it waits them out.
  await act(async () => void (await jbCenterPublicClient(CHAIN).request({ method: 'eth_blockNumber' }).catch(() => undefined)))
  // Then the run is waited out while the page still shows it: its main button stays disabled while it runs.
  const running = () => document.querySelector<HTMLButtonElement>('[data-tx-confirm] footer button:last-child')?.disabled === true
  for (let i = 0; i < 100 && running(); i += 1) await act(async () => void (await new Promise(resolve => setTimeout(resolve, 10))))
  await act(async () => void (await new Promise(resolve => setTimeout(resolve, 30))))
  await act(async () => root.unmount())
  host.remove()
  client.clear()
  clearViewAs()
})

/** What the confirmation's main button said and could do in every commit that reached the screen. */
const commits: string[] = []
function seen() {
  const button = document.querySelector<HTMLButtonElement>('[data-tx-confirm] footer button:last-child')
  if (button) commits.push(`${button.textContent}|${button.disabled ? 'disabled' : 'enabled'}`)
}

const flow = (info = INFO): ReactNode => (
  <QueryClientProvider client={client}>
    <WalletAuthContext.Provider value={{ requestSignIn }}>
      <Profiler id="unstick" onRender={seen}>
        <UnstickFlow chainId={CHAIN} projectId={Number(PROJECT)} info={info} onClose={closed} />
      </Profiler>
    </WalletAuthContext.Provider>
  </QueryClientProvider>
)
const render = (info = INFO) => act(async () => root.render(flow(info)))

/** Waits, in real time, until `check` holds: the fake Center answers as fast as promises do, and typing settles in
 * 250 ms. */
async function until(check: () => boolean, what: string, tries = 150) {
  for (let i = 0; i < tries; i += 1) {
    if (check()) return
    await act(async () => void (await new Promise(resolve => setTimeout(resolve, 10))))
  }
  throw new Error(`Timed out waiting for ${what}: ${confirm()?.textContent ?? host.textContent}`)
}

const confirm = () => document.querySelector<HTMLElement>('[data-tx-confirm]')
const buttonsOf = (within: ParentNode) => [...within.querySelectorAll('button')]
/** The buttons that name themselves in words: the icon that closes a dialog does not. */
const nameOf = (within: ParentNode) => buttonsOf(within).flatMap(each => (each.textContent ? [each.textContent] : []))
const press = async (label: string, within: ParentNode = document) => {
  const found = buttonsOf(within).find(each => each.textContent === label)
  expect(found, `a "${label}" button in ${nameOf(within)}`).toBeDefined()
  await act(async () => found!.click())
}
function type(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Amount of Sticky tokens to unstick"]')!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  return act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const form = () => host.querySelector('form')!
const formText = () => form().textContent ?? ''
/** The steps of the confirmation, by title, and which of them have gone through. */
const steps = () =>
  [...confirm()!.querySelectorAll('ol li')].map(item => ({
    title: item.textContent!.replace(/^(\d+|✓)Step \d+ of \d+: /, ''),
    state: item.getAttribute('data-state'),
  }))
const titles = () => steps().map(step => step.title)
const rowsOf = () =>
  Object.fromEntries(
    [...confirm()!.querySelectorAll('.grid > span')].reduce<string[][]>((pairs, cell, at) => {
      if (at % 2 === 0) pairs.push([cell.textContent ?? ''])
      else pairs[pairs.length - 1].push(cell.textContent ?? '')
      return pairs
    }, []),
  )
/** What the wallet was asked to write, in order, and the account it was simulated and sent as. */
type Write = { abi: Abi; functionName: string; args: unknown[]; address: Address; account: Address; value?: bigint }
/** Mine the actual reviewed wallet call once. Its receipt remains stable when the next call's outcome changes. */
function mine(hash: Hex, request: Write, proposalHash?: Hex) {
  const number = 100n + BigInt(Object.keys(mocks.transactions).length)
  const blockHash = toHex(number, { size: 32 })
  const data = encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args })
  const from = proposalHash ? OTHER : request.account
  const to = proposalHash ? request.account : request.address
  const input = proposalHash ? encodeFunctionData({
    abi: SAFE_EXEC_ABI, functionName: 'execTransaction',
    args: [request.address, request.value ?? 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'],
  }) : data
  mocks.blocks[String(number)] = { hash: blockHash, number, timestamp: 1_790_000_000n + number }
  mocks.transactions[hash.toLowerCase()] = {
    hash, chainId: CHAIN, from, to, input, value: proposalHash ? 0n : request.value ?? 0n, nonce: 3,
    blockNumber: number, blockHash, transactionIndex: 0,
  }
  mocks.receipts[hash.toLowerCase()] = {
    transactionHash: hash, blockNumber: number, blockHash, transactionIndex: 0, from, to,
    status: mocks.confirming.status, contractAddress: null, logsBloom: `0x${'0'.repeat(512)}`,
    cumulativeGasUsed: 50_000n, gasUsed: 50_000n, effectiveGasPrice: 1n, type: 'eip1559',
    logs: proposalHash ? [{
      address: request.account, topics: [toEventSelector('ExecutionSuccess(bytes32,uint256)'), proposalHash],
      data: encodeAbiParameters([{ type: 'uint256' }], [0n]),
      transactionHash: hash, blockNumber: number, blockHash, transactionIndex: 0, logIndex: 0, removed: false,
    }] : [],
  }
}
/** Every function a step of the plan calls. */
const STEP_ABI = [...stickyAutoStickAbi, ...stickyHookAbi, ...erc20Abi, ...cashOutAbi] as Abi
/** A transaction the wallet was asked to send, as the write it is. */
function asWrite(tx: { account: Address | { address: Address }; to: Address; data: Hex; value?: bigint }): Write {
  const { functionName, args } = decodeFunctionData({ abi: STEP_ABI, data: tx.data })
  const account = typeof tx.account === 'string' ? tx.account : tx.account.address
  return { abi: STEP_ABI, functionName, args: [...(args ?? [])], address: getAddress(tx.to), account: getAddress(account), ...(tx.value ? { value: tx.value } : {}) }
}
/** The wallet: it takes each write, and the chain mines it at once, unless a Safe only proposes it. */
async function walletSends(tx: Parameters<typeof asWrite>[0] | Write) {
  const request = 'data' in tx ? asWrite(tx) : tx
  const hash = toHex(hashes += 1, { size: 32 })
  answered.push(hash)
  if (mocks.safe.on) mocks.proposals[hash] = request
  else mine(hash, request)
  return hash
}
/** The wallet's `n`th write (from 1) goes to `instead`; every other one as usual. */
function onWrite(n: number, instead: (request: Write) => Promise<Hex>) {
  mocks.sendTransaction.mockImplementation((tx: Parameters<typeof asWrite>[0]) =>
    mocks.sendTransaction.mock.calls.length === n ? instead(asWrite(tx)) : walletSends(tx),
  )
}
/** A write the wallet sends and the chain never mines. */
const unmined = async () => toHex(hashes += 1, { size: 32 })
/** The first step goes through, and then the chain refuses the next step's simulation: the run stops after one step,
 * with nothing else sent. */
const stopAfterFirst = () =>
  mocks.sendTransaction.mockImplementationOnce((tx: Parameters<typeof asWrite>[0]) => {
    mocks.engine.silent = true
    return walletSends(tx)
  })
const writes = () => mocks.sendTransaction.mock.calls.map(([tx]) => asWrite(tx))
const called = () => writes().map(request => request.functionName)
/** What each decoded review showed. */
const shown = (at = 0) => mocks.review.mock.calls[at][0] as ReviewModel
/** The steps each decoded review showed, by function, in order. */
const reviews = () => mocks.review.mock.calls.map(([model]) => (model as ReviewModel).calls.map(call => call.functionName))
/** The account each decoded review showed its steps for. */
const reviewedFor = () => mocks.review.mock.calls.map(([model]) => (model as ReviewModel).calls[0].from)
/** Holds the next decoded review open until the test answers it. */
function holdReview() {
  const open = Promise.withResolvers<boolean>()
  mocks.review.mockReturnValueOnce(open.promise)
  return { approve: () => act(async () => open.resolve(true)), cancel: () => act(async () => open.resolve(false)) }
}

/** Opens the review of `amount` and waits for the plan. */
async function review(amount: string) {
  await render()
  await type(amount)
  await press('Unstick', form())
  await until(() => confirm()?.textContent?.includes('transaction') === true && !confirm()!.textContent!.includes('Reading'), 'the plan')
}
/** Whether the confirmation lists `count` steps: it lists none while it reads the chain. */
const planned = (count: number) => () => confirm()?.querySelectorAll('ol li').length === count
/** Waits for every step to have gone through. */
const done = () => until(() => confirm()?.textContent?.includes('Unstick confirmed') === true, 'the unstick to be confirmed', 400)

describe('a full exit', () => {
  const on = { enabled: true, trusted: true, allowance: 100n }

  it('wallet-action:turn-off-auto-stick wallet-action:take-back-the-auto-stick-adapter-s-trust wallet-action:take-back-the-auto-stick-adapter-s-allowance wallet-action:unstick-sticky-tokens turns auto-stick off, takes back its trust and its allowance, and then unsticks: four transactions, one review, one after another', async () => {
    world(on)
    const open = holdReview()
    await review('1')

    expect(titles()).toEqual([
      'Turn off auto-stick',
      'Stop the auto-stick contract from sticking ART for you',
      "Remove the auto-stick contract's ART allowance",
      'Unstick',
    ])
    expect(confirm()!.textContent).toContain('4 transactions left.')
    expect(rowsOf()).toMatchObject({ 'Auto-stick': 'This unsticks everything you hold, so auto-stick is taken apart first.' })
    // One decoded review shows all four steps, with the summary rows, and nothing is sent until it is approved.
    expect(reviews()).toEqual([['setConfigFor', 'setTrustedSenderFor', 'approve', 'cashOutTokensOf']])
    expect(shown()).toMatchObject({
      title: 'Unstick ART',
      context: expect.arrayContaining([expect.objectContaining({ label: 'Unstick', value: '1 STICKYART' })]),
    })
    expect(mocks.sendTransaction).not.toHaveBeenCalled()

    await open.approve()
    await done()
    expect(called()).toEqual(['setConfigFor', 'setTrustedSenderFor', 'approve', 'cashOutTokensOf'])
    // That one review was the only confirmation: no step opened a review of its own.
    expect(mocks.review).toHaveBeenCalledOnce()
    // Each step is reviewed, simulated and sent as the holder the plan was made for.
    expect(reviewedFor()).toEqual([HOLDER])
    expect(writes().map(request => request.account)).toEqual([HOLDER, HOLDER, HOLDER, HOLDER])
    expect(writes().map(request => [request.address, request.args])).toEqual([
      [ADAPTER, [PROJECT, false, 1_000_000n, 86_400]],
      [HOOK, [PROJECT, ADAPTER, false]],
      [STAKED, [ADAPTER, 0n]],
      [TERMINAL, [HOLDER, PROJECT, E18, STAKED, 975_000n, HOLDER, '0x']],
    ])
  })

  it('ends on the confirmed unstick with a link to its transaction, and stays until Done', async () => {
    world(on)
    await review('1')
    await done()

    const dialog = confirm()!
    expect(dialog.querySelector('h2')!.textContent).toBe('Unstick confirmed')
    expect(steps().every(step => step.state === 'complete')).toBe(true)
    expect(dialog.textContent).toContain('All transactions confirmed.')
    const link = dialog.querySelector('a')!
    expect(link.textContent).toBe('View transaction ↗')
    // The link is the unstick's: the fourth and last transaction the wallet was given.
    expect(answered).toHaveLength(4)
    expect(link.href).toBe(`https://sepolia.basescan.org/tx/${answered[3]}`)
    expect(nameOf(dialog)).toEqual(['Done'])
    expect(closed).not.toHaveBeenCalled()

    await press('Done', dialog)
    expect(closed).toHaveBeenCalledOnce()
  })

  it('takes nothing apart when auto-stick is off and holds nothing of the holder\'s: the unstick alone', async () => {
    world({ enabled: false, trusted: false, allowance: 0n })
    await review('1')
    expect(titles()).toEqual(['Unstick'])
    expect(confirm()!.textContent).not.toContain('auto-stick is taken apart')
  })

  it('leaves out the trust a project granted the adapter and an allowance that is spent', async () => {
    world({ enabled: true, trusted: false, allowance: 0n })
    await review('1')
    expect(titles()).toEqual(['Turn off auto-stick', 'Unstick'])
  })

  it('takes nothing apart while auto-stick is off, however much of its trust and allowance stands, when nothing went through here', async () => {
    world({ enabled: false, trusted: true, allowance: 100n })
    await review('1')
    expect(titles()).toEqual(['Unstick'])
    expect(confirm()!.textContent).not.toContain('auto-stick is taken apart')
  })
})

describe('a partial exit', () => {
  it('is a single unstick, whatever auto-stick is doing, and says what the holder keeps', async () => {
    world({ enabled: true, trusted: true, allowance: 100n })
    const open = holdReview()
    await review('0.4')

    expect(titles()).toEqual(['Unstick'])
    expect(confirm()!.textContent).toContain('1 transaction left.')
    expect(rowsOf()).toMatchObject({ Unstick: '0.4 STICKYART', 'You keep': '0.6 STICKYART' })

    await open.approve()
    await done()
    expect(called()).toEqual(['cashOutTokensOf'])
    expect(writes()[0].args).toEqual([HOLDER, PROJECT, 4n * 10n ** 17n, STAKED, 975_000n, HOLDER, '0x'])
  })

  it('does not depend on what auto-stick keeps being readable', async () => {
    const { chain } = world()
    chain.stock(ADAPTER, stickyAutoStickAbi, 'configOf', REVERT)
    await review('0.5')
    expect(titles()).toEqual(['Unstick'])
  })

  it('refuses to plan a full exit it cannot read auto-stick for, and says so', async () => {
    const { chain } = world()
    chain.stock(ADAPTER, stickyAutoStickAbi, 'configOf', REVERT)
    await render()
    await type('1')
    await press('Unstick', form())
    await until(() => formText().includes('could not be read'), 'the refusal')
    expect(formText()).toContain('Your auto-stick settings could not be read.')
    expect(confirm()).toBeNull()
    expect(mocks.review).not.toHaveBeenCalled()
    expect(mocks.sendTransaction).not.toHaveBeenCalled()
  })
})

describe('the minimum', () => {
  const priced = { gross: 2_000_000n, tax: 1_000n, unstick: 1_950_000n }

  it('is the net of the quote the form showed: the terminal\'s payout less its fee, in the request and in the review', async () => {
    world(priced)
    await render()
    await type('1')
    await until(() => formText().includes('You get 1.95 ART.'), 'the quote')
    expect(formText()).toContain(
      'You get 1.95 ART. 0.5 ART stays with the holders who remain. 0.05 ART goes to the protocol fee. The review uses this as your minimum.',
    )

    await press('Unstick', form())
    await until(() => confirm()?.textContent?.includes('transaction') === true, 'the plan')
    expect(rowsOf()).toMatchObject({ 'Minimum you receive': '1.95 ART', 'Protocol fee': '0.05 ART', On: 'Base Sepolia' })

    await done()
    expect(writes()[0].functionName).toBe('cashOutTokensOf')
    expect(writes()[0].args[4]).toBe(1_950_000n)
    // What the wallet is asked to approve is the request the review showed.
    expect(shown().calls[0].args![4]).toMatchObject({ name: 'minTokensReclaimed', text: expect.stringContaining('1950000') })
  })

  it('says when an unstick returns nothing, names it so, and skips the quote for a full bonus', async () => {
    const { chain } = world({ gross: 0n, tax: 10_000n, unstick: 0n })
    const info = stickyInfo(CHAIN, PROJECT, { ...INFO, cashOutTaxRate: 10_000n })
    await render(info)
    await type('1')
    await act(async () => void (await new Promise(resolve => setTimeout(resolve, 300))))
    expect(formText()).toContain('100% stickiness bonus: unsticking burns your Sticky tokens and returns nothing.')
    expect(chain.reads().filter(read => read.functionName === 'previewCashOutFrom')).toHaveLength(0)

    await press('Unstick', form())
    await until(() => confirm()?.textContent?.includes('transaction') === true, 'the plan')
    expect(titles()).toEqual(['Unstick without reclaiming tokens'])
    expect(rowsOf()).toMatchObject({
      'Minimum you receive': '0 ART',
      Effect: 'Your Sticky tokens are burned and no underlying tokens come back.',
    })
  })
})

describe('the preflight', () => {
  it('asks a node for the unstick, as the holder and exactly as the review shows it, before the plan is shown', async () => {
    const { chain } = world()
    let shown: boolean | undefined
    chain.stock(TERMINAL, cashOutAbi, 'cashOutTokensOf', () => {
      shown = confirm()?.textContent?.includes('Minimum you receive')
      return 975_000n
    })
    await review('1')

    const asked = chain.requests.filter(request => request.reads?.[0]?.functionName === 'cashOutTokensOf')
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({
      method: 'eth_call',
      from: HOLDER,
      reads: [{ target: TERMINAL, args: [HOLDER, PROJECT, E18, STAKED, 975_000n, HOLDER, '0x'] }],
    })
    expect(shown).toBe(false)
    // The request it asked about is the one the wallet is then given.
    await done()
    expect(writes()[0].args).toEqual(asked[0].reads![0].args)
  })

  it('stops the review when the unstick would revert: the error shows under the button and the wallet is never asked', async () => {
    world({ unstick: REVERT })
    await render()
    await type('1')
    await press('Unstick', form())
    await until(() => formText().includes('The terminal would refuse this unstick'), 'the refusal')

    expect(form().querySelector('p.text-red-700')!.textContent).toContain('The terminal would refuse this unstick:')
    expect(confirm()).toBeNull()
    expect(mocks.review).not.toHaveBeenCalled()
    expect(mocks.publicClient.request).not.toHaveBeenCalled()
    expect(mocks.sendTransaction).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('plan'), { chainId: CHAIN, projectId: 12 }, expect.any(Error))
  })

  it('stops the review when the terminal cannot be asked for a quote', async () => {
    const { chain } = world()
    chain.stock(TERMINAL, terminalAbi, 'feeFreeSurplusOf', REVERT)
    await render()
    await type('1')
    await press('Unstick', form())
    await until(() => formText().includes('could not be read'), 'the refusal')
    expect(formText()).toContain('The fee-free surplus could not be read.')
    expect(confirm()).toBeNull()
    expect(mocks.sendTransaction).not.toHaveBeenCalled()
  })
})

describe('an amount', () => {
  it('more than the holder has on the chain is refused before anything is asked of the terminal', async () => {
    const { chain } = world({ balance: E18 })
    await render()
    await type('2')
    await press('Unstick', form())
    await until(() => formText().includes('less than the amount to unstick'), 'the refusal')
    expect(formText()).toContain('You hold 1 STICKYART, less than the amount to unstick.')
    expect(confirm()).toBeNull()
    expect(chain.reads().filter(read => read.functionName === 'previewCashOutFrom')).toHaveLength(0)
    // The holder's own mistake, and nothing for the console.
    expect(console.warn).not.toHaveBeenCalled()
  })

  it.each(['', '0', '-1', '1e3', 'one', '1.0000000000000000001', '0x10'])('%j is no amount, so nothing is reviewed', async text => {
    const { chain } = world()
    await render()
    await type(text)
    const button = buttonsOf(form()).find(each => each.textContent === 'Unstick')!
    expect(button.disabled).toBe(true)
    expect(chain.requests).toHaveLength(0)
  })

  it('fills in the holder\'s whole balance from the chain with max, to the last digit', async () => {
    world({ balance: 1_234_567_890_123_456_789n, enabled: true })
    await render()
    await press('max', form())
    await until(() => document.querySelector<HTMLInputElement>('input')!.value !== '', 'the balance')
    expect(document.querySelector<HTMLInputElement>('input')!.value).toBe('1.234567890123456789')
  })
})

/** The wallet refuses its `n`th write. */
const refuseWrite = (n: number) =>
  onWrite(n, async () => {
    throw new UserRejectedRequestError(new Error('The wallet did not send it.'))
  })
/** Waits for the first step to go through and the run to stop at the next (see `stopAfterFirst`). */
const firstThrough = () =>
  until(() => steps()[0]?.state === 'complete' && nameOf(confirm()!).includes('Retry'), 'the first step to go through')

describe('a send that stops halfway', () => {
  const on = { enabled: true, trusted: true, allowance: 100n }

  it('closes on a wallet that refused a later step, says what went through, and plans again from the chain, never sending one twice', async () => {
    const { set } = world(on)
    // The wallet refuses the second: the refusal closes the confirmation, as a cancel does.
    refuseWrite(2)
    await review('1')
    await until(() => confirm() === null, 'the close')

    // The form says what went through; the steps after it were never sent.
    expect(formText()).toContain(
      "Went through: Turn off auto-stick. Not sent yet: Stop the auto-stick contract from sticking ART for you; Remove the auto-stick contract's ART allowance; Unstick.",
    )
    expect(called()).toEqual(['setConfigFor', 'setTrustedSenderFor'])

    // The chain says the first went through: auto-stick is off, its trust and allowance stand.
    set({ enabled: false })
    const open = holdReview()
    await press('Unstick', form())
    await until(() => mocks.review.mock.calls.length === 2, 'the new review')
    expect(titles()).toEqual([
      'Turn off auto-stick',
      'Stop the auto-stick contract from sticking ART for you',
      "Remove the auto-stick contract's ART allowance",
      'Unstick',
    ])
    expect(steps().map(step => step.state)).toEqual(['complete', 'active', 'pending', 'pending'])
    expect(confirm()!.textContent).toContain('3 transactions left.')
    // The new review shows only what is left.
    expect(reviews()[1]).toEqual(['setTrustedSenderFor', 'approve', 'cashOutTokensOf'])

    await open.approve()
    await done()
    // Turning auto-stick off was sent once, and the refused trust step was tried again.
    expect(called()).toEqual(['setConfigFor', 'setTrustedSenderFor', 'setTrustedSenderFor', 'approve', 'cashOutTokensOf'])
    expect(mocks.review).toHaveBeenCalledTimes(2)
  })

  it('never sends a step again that went through, even when the node it asks has not caught up with it', async () => {
    // The chain keeps saying auto-stick is on, as a node one block behind would.
    world(on)
    refuseWrite(2)
    await review('1')
    await until(() => confirm() === null, 'the close')
    const open = holdReview()
    await press('Unstick', form())
    await until(() => mocks.review.mock.calls.length === 2, 'the new review')

    expect(steps().map(step => step.state)).toEqual(['complete', 'active', 'pending', 'pending'])
    expect(reviews()[1]).toEqual(['setTrustedSenderFor', 'approve', 'cashOutTokensOf'])
    await open.approve()
    await done()
    expect(called().filter(name => name === 'setConfigFor')).toHaveLength(1)
  })

  it('holds an uncertain wallet reply after reopening the review without repeating the attempted step, until the person says they checked their wallet', async () => {
    const { set } = world(on)
    onWrite(2, async () => {
      throw new Error('Connection lost after sending')
    })
    await review('1')
    await until(() => nameOf(confirm()!).includes('Done'), 'the uncertain send')

    expect(confirm()!.textContent).toContain(writeHeldMessage())
    expect(confirm()!.textContent).toContain(writeExitMessage({ value: 0n }))
    expect(nameOf(confirm()!)).toContain(HELD_EXIT_LABEL)
    expect(nameOf(confirm()!)).not.toContain('Retry')
    expect(steps().map(step => step.state)).toEqual(['complete', 'active', 'pending', 'pending'])
    expect(called()).toEqual(['setConfigFor', 'setTrustedSenderFor'])

    // Unstick again runs into the hold before any review opens: nothing is reviewed or goes out.
    await press('Done', confirm()!)
    set({ enabled: false })
    await press('Unstick', form())
    await until(() => confirm() !== null && nameOf(confirm()!).includes('Done'), 'the saved uncertain send')

    expect(confirm()!.textContent).toContain(writeHeldMessage())
    expect(mocks.review).toHaveBeenCalledOnce()
    expect(called()).toEqual(['setConfigFor', 'setTrustedSenderFor'])

    // The exit is the person's: they checked their wallet, so the step can go out again.
    await press(HELD_EXIT_LABEL, confirm()!)
    await until(() => nameOf(confirm()!).includes('Review again'), 'the step offered again')
    expect(confirm()!.textContent).not.toContain(writeHeldMessage())
    await press('Review again', confirm()!)
    await until(() => called().length === 3, 'the step sent again')
    expect(called().slice(0, 3)).toEqual(['setConfigFor', 'setTrustedSenderFor', 'setTrustedSenderFor'])
  })

  it('counts a transaction that went through once, however often the page renders again after it', async () => {
    world(on)
    // The second is sent and never mined.
    onWrite(2, unmined)
    await review('1')
    await until(() => called().length === 2, 'the second send')
    // A new query client renders the flow again while the confirmed send still stands.
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await render()
    await render()
    expect(steps().map(step => step.state)).toEqual(['complete', 'active', 'pending', 'pending'])
    expect(confirm()!.textContent).toContain('3 transactions left.')
    expect(called()).toEqual(['setConfigFor', 'setTrustedSenderFor'])
  })

  it('counts a step only once the engine has taken it: a send that answers nothing counts nothing, however the page renders after it', async () => {
    world(on)
    // After the first, the engine's lock is still held: its send answers nothing and changes nothing.
    stopAfterFirst()
    await review('1')
    await firstThrough()
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await render()
    await render()
    expect(steps().map(step => step.state)).toEqual(['complete', 'active', 'pending', 'pending'])
    expect(confirm()!.textContent).toContain('3 transactions left.')
    expect(called()).toEqual(['setConfigFor'])

    // Nothing was skipped, and nothing is sent twice; the dropped review is asked again for what is left.
    mocks.engine.silent = false
    await press('Retry', confirm()!)
    await done()
    expect(called()).toEqual(['setConfigFor', 'setTrustedSenderFor', 'approve', 'cashOutTokensOf'])
    expect(reviews()).toEqual([
      ['setConfigFor', 'setTrustedSenderFor', 'approve', 'cashOutTokensOf'],
      ['setTrustedSenderFor', 'approve', 'cashOutTokensOf'],
    ])
  })

  it('keeps the main button disabled while a step is out, and sends each step once', async () => {
    world(on)
    commits.length = 0
    await review('1')
    await done()

    // No commit offers a press while a step is being checked, signed or confirmed.
    const out = commits.filter(commit => /^(Double-checking|Confirm in your wallet|Confirming)/.test(commit))
    expect(out.length).toBeGreaterThan(0)
    expect(out.filter(commit => commit.endsWith('|enabled'))).toEqual([])
    expect(called()).toEqual(['setConfigFor', 'setTrustedSenderFor', 'approve', 'cashOutTokensOf'])
    expect(mocks.review).toHaveBeenCalledOnce()
  })

  it('opens no second review for a press while its one review is open, and sends every step once', async () => {
    world(on)
    const open = holdReview()
    await review('1')
    await press('Review again', confirm()!)
    await open.approve()
    await done()
    expect(mocks.review).toHaveBeenCalledOnce()
    expect(called()).toEqual(['setConfigFor', 'setTrustedSenderFor', 'approve', 'cashOutTokensOf'])
  })

  it('says what went through for the old account when the account changes partway', async () => {
    world(on)
    stopAfterFirst()
    await review('1')
    await firstThrough()
    mocks.wallet = { address: OTHER, isCenterWallet: false }
    await render()
    await until(() => confirm() === null, 'the plan to go')
    expect(formText()).toContain('Connected account changed. Review the unstick again.')
    expect(formText()).toContain(
      "Went through: Turn off auto-stick. Not sent yet: Stop the auto-stick contract from sticking ART for you; Remove the auto-stick contract's ART allowance; Unstick.",
    )
    expect(mocks.sendTransaction).toHaveBeenCalledOnce()
  })

  it('stops saying it unsticks everything once a new plan keeps some of the tokens', async () => {
    const { set } = world(on)
    // Tokens come in once the first step is out: the same amount is now part of what the holder has.
    onWrite(1, request => {
      set({ balance: 2n * E18 })
      return walletSends(request)
    })
    const open = holdReview()
    await review('1')
    expect(confirm()!.textContent).toContain('This unsticks everything you hold')
    await open.approve()
    await until(() => nameOf(confirm()!).includes('Retry'), 'the stop')
    expect(confirm()!.textContent).toContain('This unsticks everything you hold')
    expect(called()).toEqual(['setConfigFor'])

    await press('Retry', confirm()!)
    await until(planned(2), 'the new plan')
    expect(rowsOf()).toMatchObject({ 'You keep': '1 STICKYART' })
    expect(confirm()!.textContent).not.toContain('This unsticks everything you hold')
  })

  it('says which transaction it is waiting for, and which are still to send', async () => {
    world(on)
    onWrite(2, unmined)
    await review('1')
    await until(() => confirm()!.textContent!.includes('Waiting for confirmation'), 'the wait')
    expect(confirm()!.textContent).toContain(
      "Went through: Turn off auto-stick. Waiting for: Stop the auto-stick contract from sticking ART for you. Not sent yet: Remove the auto-stick contract's ART allowance; Unstick.",
    )
  })

  it('goes on from the one that failed when the unstick itself is what the terminal refuses at the end', async () => {
    const { set } = world(on)
    // The preflight passed; now the terminal refuses: the simulation stops the send.
    const simulate = mocks.publicClient.request.getMockImplementation()!
    let refusing = true
    mocks.publicClient.request.mockImplementation(async (request: { method: string; params: [{ to?: string }] }) => {
      if (refusing && request.method === 'eth_call' && request.params[0].to?.toLowerCase() === TERMINAL.toLowerCase()) {
        throw new Error('execution reverted: JBMultiTerminal_UnderMinTokensReclaimed')
      }
      return simulate(request)
    })
    await review('1')
    await until(() => nameOf(confirm()!).includes('Retry'), 'the failure')
    // A node's revert text is never shown: the line says to try again.
    expect(confirm()!.textContent).toContain(NETWORK_ERROR_LINE)
    expect(confirm()!.textContent).toContain(
      'Went through: Turn off auto-stick; Stop the auto-stick contract from sticking ART for you; Remove the auto-stick contract\'s ART allowance. Did not go through: Unstick.',
    )
    expect(called()).toEqual(['setConfigFor', 'setTrustedSenderFor', 'approve'])

    // Everything is taken apart now, and the terminal pays what it did.
    refusing = false
    set({ enabled: false, trusted: false, allowance: 0n })
    const open = holdReview()
    await press('Retry', confirm()!)
    await until(() => mocks.review.mock.calls.length === 2, 'the new review')
    expect(titles()).toEqual([
      'Turn off auto-stick',
      'Stop the auto-stick contract from sticking ART for you',
      "Remove the auto-stick contract's ART allowance",
      'Unstick',
    ])
    expect(steps().map(step => step.state)).toEqual(['complete', 'complete', 'complete', 'active'])
    expect(reviews()[1]).toEqual(['cashOutTokensOf'])
    await open.approve()
    await done()
    expect(called()).toEqual(['setConfigFor', 'setTrustedSenderFor', 'approve', 'cashOutTokensOf'])
  })

  it('tells what went through when the confirmation is closed before the rest', async () => {
    world(on)
    stopAfterFirst()
    await review('1')
    await firstThrough()
    await press('Close', confirm()!)
    expect(confirm()).toBeNull()
    expect(formText()).toContain(
      "Went through: Turn off auto-stick. Not sent yet: Stop the auto-stick contract from sticking ART for you; Remove the auto-stick contract's ART allowance; Unstick.",
    )
  })

  it('takes Escape as closing the confirmation first, which brings the form back, and the flow only after that', async () => {
    world(on)
    stopAfterFirst()
    await review('1')
    await firstThrough()
    const escape = () =>
      act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      })

    await escape()
    expect(confirm()).toBeNull()
    expect(closed).not.toHaveBeenCalled()
    expect(formText()).toContain('Went through: Turn off auto-stick. Not sent yet:')
    await escape()
    expect(closed).toHaveBeenCalledOnce()
  })

  // The confirm holds the shell while it is busy (JBM's ModalShell hold), and the flow refuses to close a review mid-send:
  // either keeps the send's tracking on screen.
  it('stays open on Escape while a step is being sent', async () => {
    world(on)
    mocks.confirming.on = false
    await review('1')
    await until(() => confirm()!.textContent!.includes('Waiting for confirmation'), 'the wait')

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(confirm()).not.toBeNull()
    expect(closed).not.toHaveBeenCalled()
    expect(called()).toEqual(['setConfigFor'])
  })

  it('closes on a review the holder cancelled, sends nothing, and reviews the same steps again on the next Unstick', async () => {
    world(on)
    const open = holdReview()
    await review('1')
    await open.cancel()
    await until(() => confirm() === null, 'the review to close')
    expect(mocks.sendTransaction).not.toHaveBeenCalled()
    expect(formText()).not.toContain('Went through')

    await press('Unstick', form())
    await done()
    expect(reviews()).toEqual([
      ['setConfigFor', 'setTrustedSenderFor', 'approve', 'cashOutTokensOf'],
      ['setConfigFor', 'setTrustedSenderFor', 'approve', 'cashOutTokensOf'],
    ])
    expect(called()).toEqual(['setConfigFor', 'setTrustedSenderFor', 'approve', 'cashOutTokensOf'])
  })

  it('counts a step that reverted onchain as not gone through, and plans again from the chain', async () => {
    const { set } = world(on)
    // The second is mined, and reverts.
    onWrite(2, async request => {
      mocks.confirming.status = 'reverted'
      const hash = await walletSends(request)
      mocks.confirming.status = 'success'
      return hash
    })
    await review('1')
    await until(() => nameOf(confirm()!).includes('Retry'), 'the revert')

    // A revert says so, with the SDK's line for it.
    expect(confirm()!.textContent).toContain(WRITE_HOLD_REVERTED_LINE)
    expect(confirm()!.textContent).toContain(
      "Went through: Turn off auto-stick. Did not go through: Stop the auto-stick contract from sticking ART for you. Not sent yet: Remove the auto-stick contract's ART allowance; Unstick.",
    )
    expect(steps().map(step => step.state)).toEqual(['complete', 'active', 'pending', 'pending'])

    set({ enabled: false })
    await press('Retry', confirm()!)
    await done()
    expect(called()).toEqual(['setConfigFor', 'setTrustedSenderFor', 'setTrustedSenderFor', 'approve', 'cashOutTokensOf'])
  })

  it('waits on a Safe proposal without going on, and the SDK follows it with Safe\'s service: no transaction to link yet', async () => {
    mocks.safe.on = true
    world(on)
    const asked: string[] = []
    const center = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      if (!String(input).includes('/multisig-transactions/')) return center(input, init)
      // The Safe's queue, read before a proposal: nothing is queued yet.
      if (String(input).includes('/safes/')) return new Response(JSON.stringify({ count: 0, results: [] }), { headers: { 'content-type': 'application/json' } })
      asked.push(String(input))
      return new Promise<Response>(() => {})
    }))
    await review('1')
    await until(() => nameOf(confirm()!).includes('Done'), 'the proposal')

    // A proposal is not a confirmed step: it can be dismissed, but no dependent step can be sent.
    expect(confirm()!.querySelector('a')).toBeNull()
    expect(confirm()!.textContent).toContain('Proposed to your Safe. Its other signers can approve it there.')
    expect(buttonsOf(confirm()!).find(each => each.textContent === 'Done')!.disabled).toBe(false)
    expect(steps().map(step => step.state)).toEqual(['active', 'pending', 'pending', 'pending'])
    expect(called()).toEqual(['setConfigFor'])
    const [proposalHash] = Object.keys(mocks.proposals)
    await until(() => asked.some(url => url.includes(proposalHash)), 'the follower')
  })

  it('does not go on while a send is unconfirmed, and never sends its step again', async () => {
    world(on)
    mocks.confirming.on = false
    await review('1')
    await until(() => confirm()!.textContent!.includes('Waiting for confirmation'), 'the wait')
    const dialog = confirm()!
    expect(dialog.querySelector('a')).not.toBeNull()
    expect(buttonsOf(dialog).find(each => each.textContent === 'Confirming…')!.disabled).toBe(true)
    expect(buttonsOf(dialog).find(each => each.textContent === 'Cancel')!.disabled).toBe(true)
    expect(called()).toEqual(['setConfigFor'])
    expect(dialog.textContent).not.toContain('Went through')
  })
})

describe('a confirmation that was closed partway', () => {
  const on = { enabled: true, trusted: true, allowance: 100n }
  /** The first step goes through and the confirmation is closed before the rest; the engine answers again after. */
  async function closedAfterFirst() {
    stopAfterFirst()
    await review('1')
    await firstThrough()
    await press('Close', confirm()!)
    expect(confirm()).toBeNull()
    mocks.engine.silent = false
  }

  it.each([
    ['has caught up with it', { enabled: false }],
    ['is still behind it', {}],
  ])('keeps what went through: Unstick again plans only what is left when the chain %s', async (_when, chain) => {
    const { set } = world(on)
    await closedAfterFirst()

    set(chain)
    const open = holdReview()
    await press('Unstick', form())
    await until(() => mocks.review.mock.calls.length === 2, 'the new review')
    expect(steps()).toEqual([
      { title: 'Turn off auto-stick', state: 'complete' },
      { title: 'Stop the auto-stick contract from sticking ART for you', state: 'active' },
      { title: "Remove the auto-stick contract's ART allowance", state: 'pending' },
      { title: 'Unstick', state: 'pending' },
    ])
    expect(confirm()!.textContent).toContain('3 transactions left.')
    expect(reviews()[1]).toEqual(['setTrustedSenderFor', 'approve', 'cashOutTokensOf'])

    await open.approve()
    await done()
    expect(called()).toEqual(['setConfigFor', 'setTrustedSenderFor', 'approve', 'cashOutTokensOf'])
  })

  it('does not carry it to another account', async () => {
    world(on)
    await closedAfterFirst()

    mocks.wallet = { address: OTHER, isCenterWallet: false }
    await render()
    holdReview()
    await press('Unstick', form())
    await until(() => mocks.review.mock.calls.length === 2, 'the review for the other account')
    expect(steps().map(step => step.state)).toEqual(['active', 'pending', 'pending', 'pending'])
    expect(titles()[0]).toBe('Turn off auto-stick')
    expect(reviewedFor()).toEqual([HOLDER, OTHER])
  })

  it('forgets it when the account changes, even if the first account comes back', async () => {
    world(on)
    await closedAfterFirst()

    mocks.wallet = { address: OTHER, isCenterWallet: false }
    await render()
    mocks.wallet = { address: HOLDER, isCenterWallet: false }
    await render()
    holdReview()
    await press('Unstick', form())
    await until(() => mocks.review.mock.calls.length === 2, 'the new review')
    // The chain still says auto-stick is on, and nothing is known to have gone through for this account now.
    expect(steps().map(step => step.state)).toEqual(['active', 'pending', 'pending', 'pending'])
  })

  it('starts again once the unstick itself is confirmed and the confirmation is done', async () => {
    world({ enabled: false })
    await review('1')
    await done()
    await press('Done', confirm()!)
    expect(closed).toHaveBeenCalledOnce()
    // The flow is still mounted here, as a host that keeps it open would leave it: nothing went through for it now.
    expect(formText()).not.toContain('Went through')
    holdReview()
    await press('Unstick', form())
    await until(() => mocks.review.mock.calls.length === 2, 'the new review')
    expect(steps().map(step => step.state)).toEqual(['active'])
  })
})

describe('before each send', () => {
  const on = { enabled: true, trusted: true, allowance: 100n }

  it('reads the balance again, and stops with nothing sent when it is no longer the one reviewed', async () => {
    const { set } = world(on)
    const open = holdReview()
    await review('1')
    set({ balance: 2n * E18 })
    await open.approve()
    await until(() => nameOf(confirm()!).includes('Retry'), 'the stop')
    expect(confirm()!.textContent).toContain('Your Sticky token balance changed. Review the unstick again.')
    expect(mocks.publicClient.request).not.toHaveBeenCalled()
    expect(mocks.sendTransaction).not.toHaveBeenCalled()

    // Planned again, one share of two is a partial exit: auto-stick stays as it is.
    await press('Retry', confirm()!)
    await until(planned(1), 'the new plan')
    expect(titles()).toEqual(['Unstick'])
    expect(rowsOf()).toMatchObject({ 'You keep': '1 STICKYART' })
  })

  it('reads the quote again for the unstick, and stops when the terminal now pays less than the minimum', async () => {
    const { set } = world({ enabled: false })
    const open = holdReview()
    await review('1')
    set({ gross: 900_000n })
    await open.approve()
    await until(() => nameOf(confirm()!).includes('Retry'), 'the stop')
    expect(confirm()!.textContent).toContain('The terminal now pays 0.8775 ART, less than the 0.975 you reviewed. Review the unstick again.')
    expect(mocks.sendTransaction).not.toHaveBeenCalled()

    set({ unstick: 877_500n })
    await press('Retry', confirm()!)
    await until(() => rowsOf()['Minimum you receive'] === '0.8775 ART', 'the new minimum')
    await done()
    expect(writes()[0].args[4]).toBe(877_500n)
  })

  it('takes a payout that rose as a reason to send the reviewed minimum, which it still beats', async () => {
    const { set } = world({ enabled: false })
    const open = holdReview()
    await review('1')
    set({ gross: 1_100_000n })
    await open.approve()
    await done()
    expect(writes()[0].args[4]).toBe(975_000n)
  })
})

describe('the wallet', () => {
  it('refuses a Signa session when the review starts, before anything is read, and offers to connect a wallet', async () => {
    const { chain } = world()
    mocks.wallet = { address: HOLDER, isCenterWallet: true }
    await render()
    await type('1')
    await press('Unstick', form())

    expect(form().querySelector('p.text-red-700')!.textContent).toBe(`${EXTERNAL_WALLET_REQUIRED} Connect a wallet`)
    expect(confirm()).toBeNull()
    expect(chain.requests).toHaveLength(0)
    expect(mocks.review).not.toHaveBeenCalled()
    await press('Connect a wallet', form())
    expect(requestSignIn).toHaveBeenCalledWith({ walletsOnly: true })
  })

  it('plans the unstick again for the account that connects, with the amount still typed', async () => {
    const { chain } = world()
    mocks.wallet = { address: HOLDER, isCenterWallet: true }
    await render()
    await type('0.5')
    await press('Unstick', form())
    expect(confirm()).toBeNull()

    mocks.wallet = { address: OTHER, isCenterWallet: false }
    await render()
    await until(() => confirm()?.textContent?.includes('transaction') === true, 'the plan for the new account')

    const balances = chain.reads().filter(read => read.functionName === 'balanceOf')
    expect(balances.map(read => read.args[0])).toEqual([OTHER])
    expect(rowsOf()).toMatchObject({ Unstick: '0.5 STICKYART' })
    await done()
    expect(writes()[0].args).toEqual([OTHER, PROJECT, 5n * 10n ** 17n, STAKED, 975_000n, OTHER, '0x'])
  })

  it('asks a visitor with no wallet to sign in, reads nothing, and plans once one connects', async () => {
    const { chain } = world()
    mocks.wallet = { address: undefined, isCenterWallet: false }
    await render()
    expect(formText()).not.toContain('Sign in to quote')
    expect(buttonsOf(form()).find(each => each.textContent === 'max')!.disabled).toBe(true)
    await type('1')
    await until(() => formText().includes('Sign in to quote your unstick.'), 'the note')
    await press('Sign in to unstick', form())
    expect(mocks.openSignIn).toHaveBeenCalledOnce()
    expect(chain.requests).toHaveLength(0)

    mocks.wallet = { address: HOLDER, isCenterWallet: false }
    holdReview()
    await render()
    await until(() => confirm()?.textContent?.includes('1 transaction left') === true, 'the plan')
  })

  it('refuses to send as another account in View as, before anything is read', async () => {
    const { chain } = world()
    setViewAs(OTHER)
    await render()
    await type('1')
    await press('Unstick', form())
    expect(formText()).toContain(VIEW_AS_WRITE_BLOCKED)
    expect(confirm()).toBeNull()
    expect(chain.requests).toHaveLength(0)
  })

  it('drops a plan whose account has gone, and sends nothing for it, even once its open review is approved', async () => {
    world({ enabled: true, trusted: true, allowance: 100n })
    const open = holdReview()
    await review('1')
    mocks.wallet = { address: OTHER, isCenterWallet: false }
    await render()
    // ponytail: core has no way to close a review it opened (SDK request), so the plan goes once that review is answered.
    await open.approve()
    await until(() => confirm() === null, 'the plan to go')
    expect(formText()).toContain('Connected account changed. Review the unstick again.')
    expect(mocks.sendTransaction).not.toHaveBeenCalled()
  })
})

describe('an account switched after the review', () => {
  const on = { enabled: true, trusted: true, allowance: 100n }
  /** The wallet's account changes, and a send is made before the page has rendered it. */
  const switchWalletOnly = () => mocks.getAccount.mockImplementation(() => ({ address: OTHER, chainId: CHAIN }))

  it('wallet-action:turn-off-auto-stick refuses a step sent before the page shows the new account', async () => {
    world(on)
    const open = holdReview()
    await review('1')
    switchWalletOnly()
    await open.approve()
    await until(() => confirm()!.textContent!.includes(REVIEWED_ACCOUNT_CHANGED_LINE), 'the refusal')

    expect(mocks.publicClient.request).not.toHaveBeenCalled()
    expect(mocks.sendTransaction).not.toHaveBeenCalled()
  })

  it('wallet-action:unstick-sticky-tokens sends none of the later steps from an account switched to after an earlier one went through', async () => {
    world(on)
    onWrite(1, request => {
      switchWalletOnly()
      return walletSends(request)
    })
    await review('1')
    await until(() => confirm()!.textContent!.includes(REVIEWED_ACCOUNT_CHANGED_LINE), 'the refusal')

    expect(called()).toEqual(['setConfigFor'])
    expect(mocks.review).toHaveBeenCalledOnce()
    // ponytail: core reports no step's confirmation on its own (SDK request), so a run refused at the next step's
    // account check cannot yet say that the first went through.
  })

  it('wallet-action:take-back-the-auto-stick-adapter-s-trust refuses a step whose review was open while the wallet switched accounts, and drops the plan', async () => {
    world(on)
    stopAfterFirst()
    await review('1')
    await firstThrough()
    mocks.engine.silent = false
    const open = holdReview()
    await press('Retry', confirm()!)
    await until(() => mocks.review.mock.calls.length === 2, 'the review to open')

    mocks.wallet = { address: OTHER, isCenterWallet: false }
    mocks.getAccount.mockImplementation(() => ({ address: OTHER, chainId: CHAIN }))
    await render()
    await open.approve()
    await until(() => confirm() === null, 'the plan to go')

    expect(called()).toEqual(['setConfigFor'])
    expect(formText()).toContain('Connected account changed. Review the unstick again.')
  })
})

describe('after a confirmed send', () => {
  const p = ['sticky-project', CHAIN, 12]
  const PAGE = ['info', 'events', 'holders', 'sticks', 'latest', 'page balances']
  /** Reads the page and the account pages hold, by name: the holder's (the tranches keyed in lowercase, since a
   * refresh finds the holder's reads in any case), another holder's, and others that no unstick changes. */
  const KEYS: Record<string, readonly unknown[]> = {
    info: [...p, 'info', 'v1'],
    events: [...p, 'events'],
    holders: [...p, 'holders'],
    sticks: [...p, 'sticks', 'v1'],
    latest: [...p, 'latest', 'v1'],
    'page balances': [...p, 'page-balances', [HOLDER]],
    position: ['sticky-position', CHAIN, 12, HOLDER],
    tranches: ['sticky-tranches', CHAIN, 12, HOLDER.toLowerCase(), 0, '100'],
    rewards: ['sticky-rewards', CHAIN, 12, HOLDER, '0:0x'],
    'auto-stick': ['sticky-autostick', CHAIN, 12, HOLDER, '0'],
    trusted: ['sticky-trusted', CHAIN, 12, HOLDER, ''],
    'account page': ['sticky-account', 'mainnet', HOLDER.toLowerCase(), 'positions', CHAIN],
    flows: [...p, 'flows'],
    funding: [...p, 'funding'],
    'another project': ['sticky-project', CHAIN, 13, 'holders'],
    'another chain': ['sticky-project', 1, 12, 'holders'],
    "another's position": ['sticky-position', CHAIN, 12, OTHER],
    "another's auto-stick": ['sticky-autostick', CHAIN, 12, OTHER, '0'],
    "another's account page": ['sticky-account', 'mainnet', OTHER.toLowerCase(), 'positions', CHAIN],
    "a chain's projects": ['sticky-account', 'mainnet', 'deployed', CHAIN],
    home: ['sticky-home', 'mainnet', 'chain', CHAIN],
    'the whole project': p,
  }
  /** Marks every read as just made, as a refetch would. */
  const readAgain = () => Object.values(KEYS).forEach(key => client.setQueryData(key, 'read'))
  /** The reads a refresh has marked to be made again. */
  const invalidated = () => Object.keys(KEYS).filter(name => client.getQueryState(KEYS[name])?.isInvalidated)
  const UNSTICK = [...PAGE, 'position', 'tranches', 'rewards', 'auto-stick', 'account page']

  it('reads again what an unstick changed, now and at +4 s and +12 s, and nothing else: never the whole project', async () => {
    world({ enabled: false })
    readAgain()
    const timers = vi.spyOn(globalThis, 'setTimeout')
    await review('1')
    await done()
    expect(invalidated()).toEqual(UNSTICK)
    readAgain()

    // The SDK's follower also waits 4 s between its looks: only the reads again count.
    const later = timers.mock.calls.filter(([, delay]) => delay === 4_000 || delay === 12_000)
    const reads: unknown[] = []
    for (const [callback, delay] of later) {
      const again = callback as () => void
      await act(async () => again())
      if (!invalidated().length) continue
      expect(invalidated()).toEqual(UNSTICK)
      reads.push(delay)
      readAgain()
    }
    expect(reads).toEqual([4_000, 12_000])
  })

  it("reads only the holder's auto-stick again after a step that takes it apart, and everything the unstick changed after the unstick", async () => {
    world({ enabled: true })
    readAgain()
    stopAfterFirst()
    await review('1')
    await firstThrough()
    expect(invalidated()).toEqual(['auto-stick', 'trusted'])
    readAgain()

    mocks.engine.silent = false
    await press('Retry', confirm()!)
    await done()
    expect(invalidated()).toEqual(expect.arrayContaining(UNSTICK))
    expect(invalidated().filter(name => !UNSTICK.includes(name) && name !== 'trusted')).toEqual([])
  })
})
