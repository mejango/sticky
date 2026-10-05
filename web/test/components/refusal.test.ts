import { describe, expect, it } from 'vitest'
import { Refusal, refusalOf } from '@/components/project/flows/refusal'

describe('refusalOf', () => {
  it('takes an error with no cause for an answer, and keeps its words', () => {
    const answer = refusalOf(new Error('this amount is too small'))
    expect(answer).toBeInstanceOf(Refusal)
    expect((answer as Error).message).toBe('this amount is too small')
  })

  it('leaves a read that failed to be made, which keeps its cause, and a refusal, as they are', () => {
    const lost = new Error('the balance could not be read.', { cause: new Error('429') })
    expect(refusalOf(lost)).toBe(lost)
    const refusal = new Refusal('That is more than you hold.')
    expect(refusalOf(refusal)).toBe(refusal)
    expect(refusalOf('text')).toBe('text')
  })
})
