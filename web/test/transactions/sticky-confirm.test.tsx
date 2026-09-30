// @vitest-environment jsdom

/**
 * What a flow's confirm dialog says as its transactions go through, ported from the old client's
 * `test/tx-status.test.cjs` and `test/review-copy.test.cjs` onto jbm's engine: a confirmed send keeps a link to its
 * transaction until the person presses Done, the steps count what is left in Sticky's words, and review values wrap
 * at spaces while only hex breaks mid-word.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { parseAbi, type Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  publicClient: { simulateContract: vi.fn(), estimateContractGas: vi.fn() },
  receipt: { data: undefined, isError: false } as {
    data?: { status: 'success' | 'reverted'; transactionHash: string }
    isError: boolean
  },
  getAccount: vi.fn(),
  requestReview: vi.fn(),
  switchChain: vi.fn(),
  writeContract: vi.fn(),
}))

vi.mock('@wagmi/core', () => ({ getAccount: mocks.getAccount }))
vi.mock('wagmi', () => ({
  usePublicClient: () => mocks.publicClient,
  useSwitchChain: () => ({ switchChainAsync: mocks.switchChain }),
  useWaitForTransactionReceipt: () => mocks.receipt,
  useWriteContract: () => ({ writeContractAsync: mocks.writeContract }),
}))
vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ isConnected: true, address: ALICE, isCenterWallet: false }),
}))
vi.mock('@/lib/transaction-review', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/transaction-review')>()),
  requestContractTransactionReview: mocks.requestReview,
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/safe-connector', () => ({
  isSafeConnection: () => false,
  SAFE_NONCE_GUIDANCE: 'Safe nonce guidance',
  useSafeConnection: () => false,
  waitForSafeExecutionHash: vi.fn(),
}))

import { TxConfirmDialog } from '@/components/ui/TxConfirmDialog'
import { stepsIntro, transactionsLeft, ViewTransactionLink } from '@/components/ui/TxProgress'
import { useSafeTx } from '@/hooks/useSafeTx'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const HOOK = '0x2222222222222222222222222222222222222222' as Address
const ADAPTER = '0x9B091e21d25c424De67751F4b6Ae8494351218C5'
const HASH = `0x${'a'.repeat(64)}` as const
const request = {
  chainId: 8453,
  address: HOOK,
  abi: parseAbi(['function setTrustedSenderFor(uint256 projectId, address sender, bool trusted)']),
  functionName: 'setTrustedSenderFor',
  args: [23n, ALICE, true] as const,
  label: 'Trust a sender',
}
const STEPS = [{ title: 'Trust the sender' }]

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  mocks.receipt = { data: undefined, isError: false }
  mocks.getAccount.mockImplementation(() => ({ address: ALICE, chainId: 8453 }))
  mocks.requestReview.mockResolvedValue(true)
  mocks.switchChain.mockResolvedValue(undefined)
  mocks.publicClient.simulateContract.mockResolvedValue({ request: { address: HOOK, functionName: 'setTrustedSenderFor' } })
  mocks.publicClient.estimateContractGas.mockResolvedValue(50_000n)
  mocks.writeContract.mockResolvedValue(HASH)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

/** A flow as the write flows build theirs: the plan, then the send, then the confirmed transaction. */
function TrustFlow({ onDone }: { onDone: () => void }) {
  const tx = useSafeTx(8453)
  const [open, setOpen] = useState(true)
  if (!open) return null
  const complete = tx.phase === 'success'
  return (
    <TxConfirmDialog
      open
      onClose={() => {
        setOpen(false)
        onDone()
      }}
      title={complete ? 'Sender trusted' : 'Trust this sender'}
      rows={[{ label: 'Sender', value: ALICE, mono: true }]}
      steps={STEPS}
      activeIndex={tx.busy ? 0 : -1}
      stepsIntro={stepsIntro(STEPS.length, complete ? STEPS.length : 0)}
      complete={complete}
      busy={tx.busy}
      action="Confirm & trust"
      onConfirm={() => void tx.send(request)}
      status={complete ? <ViewTransactionLink chainId={8453} hash={tx.hash} /> : undefined}
      error={tx.error}
    />
  )
}

const dialog = () => host.ownerDocument.querySelector('dialog')
const button = (name: string) =>
  [...(dialog()?.querySelectorAll('button') ?? [])].find(item => item.textContent === name)

describe('a confirmed send', () => {
  it('links its transaction on the chain’s explorer and stays open until Done', async () => {
    vi.useFakeTimers()
    const onDone = vi.fn()
    await act(async () => root.render(<TrustFlow onDone={onDone} />))
    await act(async () => button('Confirm & trust')!.click())
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(dialog()!.querySelector('a')).toBeNull()

    mocks.receipt = { data: { status: 'success', transactionHash: HASH }, isError: false }
    await act(async () => root.render(<TrustFlow onDone={onDone} />))

    const link = dialog()!.querySelector('a')!
    expect(link.textContent).toBe('View transaction ↗')
    expect(link.href).toBe(`https://basescan.org/tx/${HASH}`)
    expect(link.rel).toBe('noopener noreferrer')
    expect(link.target).toBe('_blank')
    expect(dialog()!.textContent).toContain('All transactions confirmed.')
    // Done is the one way on: no Cancel, no action to press again.
    expect([...dialog()!.querySelectorAll('footer button')].map(item => item.textContent)).toEqual(['Done'])

    // The old client faded every other notice after 8 s; a confirmation with its link waits.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000)
    })
    expect(dialog()!.querySelector('a')!.textContent).toBe('View transaction ↗')
    expect(onDone).not.toHaveBeenCalled()

    await act(async () => button('Done')!.click())
    expect(onDone).toHaveBeenCalledOnce()
    expect(dialog()).toBeNull()
  })

  it('shows no link without a transaction, or on a chain without an explorer', async () => {
    await act(async () =>
      root.render(
        <>
          <ViewTransactionLink chainId={8453} hash={null} />
          <ViewTransactionLink chainId={999_999} hash={HASH} />
        </>,
      ),
    )
    expect(host.innerHTML).toBe('')
  })
})

describe('the steps intro', () => {
  it('counts what is left in plain words', () => {
    expect(transactionsLeft(1)).toBe('1 transaction left')
    expect(transactionsLeft(3)).toBe('3 transactions left')
    expect(stepsIntro(3, 0)).toBe('3 transactions left.')
    expect(stepsIntro(3, 2)).toBe('1 transaction left.')
    expect(stepsIntro(3, 3)).toBe('All transactions confirmed.')
  })

  it('shows the count above the steps', async () => {
    await act(async () =>
      root.render(
        <TxConfirmDialog
          open
          onClose={() => {}}
          title="Stick"
          steps={[{ title: 'Approve' }, { title: 'Stick' }]}
          activeIndex={1}
          stepsIntro={stepsIntro(2, 1)}
          action="Confirm & stick"
          onConfirm={() => {}}
        />,
      ),
    )
    expect(dialog()!.textContent).toContain('1 transaction left.')
  })

  it('never says a transaction remains, anywhere in the app', () => {
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
        entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : [],
      )
    const saying = files(resolve('src')).filter(file => /transactions? remains?\b/i.test(readFileSync(file, 'utf8')))
    expect(saying).toEqual([])
  })
})

describe('review values', () => {
  it('wrap prose at spaces, and break only hex mid-word', async () => {
    await act(async () =>
      root.render(
        <TxConfirmDialog
          open
          onClose={() => {}}
          title="Unstick"
          rows={[
            { label: 'Tax', value: '5% cash out tax. Part of each unstick stays with the holders who remain.' },
            { label: 'Adapter', value: ADAPTER, mono: true },
          ]}
          steps={STEPS}
          activeIndex={-1}
          action="Confirm & unstick"
          onConfirm={() => {}}
        />,
      ),
    )
    const value = (label: string) =>
      [...dialog()!.querySelectorAll('span')].find(span => span.previousElementSibling?.textContent === label)!
    expect(value('Tax').className).toContain('break-words')
    expect(value('Tax').className).not.toMatch(/break-all|wrap-anywhere/)
    expect(value('Adapter').textContent).toBe(ADAPTER)
    expect(value('Adapter').className).toContain('break-all')
  })
})
