import { afterEach, expect, vi, type Mock } from 'vitest'
import { undecodedCalls } from './support/review-calls'

/*
 * Every call a review shows that carries an ABI must decode with the SDK's
 * functionFromCall; one that does not reads as raw bytes, which is how a
 * builder that forgets `args` (or passes args its calldata does not carry)
 * reaches users. This checks the calls each test hands to a mock (a mocked
 * review, a relayed call and its review context, a batch) and the calls the
 * real review dialog renders, and fails the test that produced one.
 */

type Decode = typeof import('@bananapus/nana-sdk-core/review/decode')['functionFromCall']

const audit = vi.hoisted(() => ({ failures: [] as string[] }))

// The dialog's own decoding: a rendered call that falls back to raw bytes.
vi.mock('@bananapus/nana-sdk-core/review/decode', async importOriginal => {
  const decode = await importOriginal<typeof import('@bananapus/nana-sdk-core/review/decode')>()
  const functionFromCall: Decode = call => {
    const found = decode.functionFromCall(call)
    if (!found && call.abi && call.functionName) {
      const label = (call as { label?: unknown }).label ?? call.functionName
      audit.failures.push(`the review dialog rendered ${String(label)} as raw bytes`)
    }
    return found
  }
  return { ...decode, functionFromCall }
})

const { functionFromCall: decode } = await vi.importActual<
  typeof import('@bananapus/nana-sdk-core/review/decode')
>('@bananapus/nana-sdk-core/review/decode')

const tracked = new Set<Mock>()
const checked = new WeakSet<object>()

function inspect(mock: Mock) {
  for (const args of mock.mock.calls) {
    if (checked.has(args)) continue
    checked.add(args)
    for (const failure of undecodedCalls(args, decode)) {
      audit.failures.push(`${mock.getMockName()} was given ${failure}`)
    }
  }
}

// Calls are read before anything clears them, so a test's own reset cannot hide one.
const createMock = vi.fn
vi.fn = ((...args: Parameters<typeof createMock>) => {
  const mock = createMock(...args) as Mock
  tracked.add(mock)
  for (const method of ['mockClear', 'mockReset', 'mockRestore'] as const) {
    const clear = mock[method] as (this: Mock) => unknown
    mock[method] = (() => {
      inspect(mock)
      return clear.call(mock)
    }) as never
  }
  return mock
}) as typeof vi.fn
for (const method of ['clearAllMocks', 'resetAllMocks', 'restoreAllMocks'] as const) {
  const clearAll = vi[method]
  vi[method] = (() => {
    for (const mock of tracked) inspect(mock)
    return clearAll.call(vi)
  }) as never
}

/** The undecodable calls seen since the last check, which this takes. */
export function takeUndecodedReviewCalls(): string[] {
  for (const mock of tracked) inspect(mock)
  return audit.failures.splice(0)
}

afterEach(() => {
  expect(
    takeUndecodedReviewCalls(),
    'Each review call that carries an ABI must pass the args its calldata carries',
  ).toEqual([])
})
