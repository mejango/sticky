// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FeeBuybackNotice,
  useFeeBuybackReview,
} from '../src/components/FeeBuybackNotice'
const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  block: undefined as undefined | (() => void),
  stop: vi.fn(),
}))
vi.mock('../src/lib/fee-buyback-client', () => ({
  feeBuybackContext: () => ({
    client: {
      watchBlockNumber: (o: { onBlockNumber: () => void }) => {
        mocks.block = o.onBlockNumber
        return mocks.stop
      },
    },
    options: {},
  }),
}))
vi.mock('@bananapus/nana-sdk-core/v6/fee-buyback', async importOriginal => ({
  ...(await importOriginal<object>()),
  checkFeeBuyback: (...args: unknown[]) => mocks.check(...args),
}))
const calls = [
  {
    chainId: 8453,
    from: '0x3333333333333333333333333333333333333333' as const,
    to: '0x1111111111111111111111111111111111111111' as const,
    data: '0x1234' as const,
    functionName: 'borrowFrom',
  },
]
const fee = {
  key: 'base:6',
  projectId: 6n,
  received: 9429n * 10n ** 18n,
  route: 'fallback',
}
const batch = [
  { ...calls[0], functionName: 'sendPayoutsOf' },
  { ...calls[0], chainId: 10, functionName: 'sendPayoutsOf' },
  { ...calls[0], chainId: 10, functionName: 'transfer' },
]
function Host({ sent, reviewed = calls }: { sent: () => void; reviewed?: typeof calls }) {
  const review = useFeeBuybackReview(reviewed)
  return (
    <>
      <FeeBuybackNotice review={review} />
      <button
        disabled={review.busy}
        onClick={async () => {
          if (await review.confirm()) sent()
        }}
      >
        {review.confirmLabel ?? 'Confirm'}
      </button>
    </>
  )
}
let root: Root | undefined
let host: HTMLDivElement
afterEach(() => {
  if (root) act(() => root!.unmount())
  host?.remove()
  vi.clearAllMocks()
})
async function render(sent: () => void, reviewed = calls) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<Host sent={sent} reviewed={reviewed} />))
}
function button(label: string) {
  const found = [...host.querySelectorAll('button')].find(
    b => b.textContent === label,
  )
  expect(found, label).toBeTruthy()
  return found!
}
describe('actionable fee review', () => {
  it('waits in place, refreshes on blocks, and never auto-submits when ready', async () => {
    mocks.check.mockResolvedValue({
      status: 'fallback',
      fees: [fee],
      checkedAt: Date.now(),
    })
    const sent = vi.fn()
    await render(sent)
    expect(host.textContent).toContain('9,429')
    await act(async () => button('Wait for better rate').click())
    expect(host.textContent).toContain('Checking new blocks automatically')
    mocks.check.mockResolvedValue({
      status: 'ready',
      fees: [{ ...fee, route: 'swap' }],
      checkedAt: Date.now(),
    })
    await act(async () => mocks.block?.())
    expect(sent).not.toHaveBeenCalled()
    await act(async () => button('Review and submit').click())
    expect(sent).toHaveBeenCalledOnce()
    act(() => root!.unmount())
    root = undefined
    expect(mocks.stop).toHaveBeenCalled()
  })
  it('shows retry when unavailable and makes submitting without an estimate explicit', async () => {
    mocks.check.mockResolvedValue({ status: 'unknown', fees: [] })
    await render(vi.fn())
    button('Retry now')
    button('Submit without estimate')
  })
  it('keeps review open when the submit-time recheck falls back', async () => {
    mocks.check
      .mockResolvedValueOnce({
        status: 'ready',
        fees: [{ ...fee, route: 'swap' }],
      })
      .mockResolvedValue({ status: 'fallback', fees: [fee] })
    const sent = vi.fn()
    await render(sent)
    await act(async () => button('Review and submit').click())
    expect(sent).not.toHaveBeenCalled()
    button('Submit anyway')
    await act(async () => button('Submit anyway').click())
    expect(sent).toHaveBeenCalledOnce()
  })
  it('estimates every fee-paying call in a batch and shows the worst result', async () => {
    mocks.check.mockImplementation(async (_client: unknown, call: { chainId: number }) =>
      call.chainId === 8453
        ? { status: 'ready', fees: [{ ...fee, route: 'swap' }], checkedAt: 1 }
        : { status: 'fallback', fees: [fee], checkedAt: 2 },
    )
    const sent = vi.fn()
    await render(sent, batch)
    expect(mocks.check).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('issuance rate')
    expect(host.textContent!.match(/9,429/g)).toHaveLength(2)
    await act(async () => button('Submit anyway').click())
    expect(sent).toHaveBeenCalledOnce()
  })
})
