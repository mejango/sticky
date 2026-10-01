import { describe, expect, it } from 'vitest'

const libraryPath = '../../scripts/lib/test-titles.mjs'
const { provingTitleWords } = await import(libraryPath)

const marker = 'wallet-action:send'
const proves = (source: string) =>
  (provingTitleWords(source, 'proof.test.ts') as Set<string>).has(marker)

describe('test titles that can prove a wallet action', () => {
  it('counts it and test titles, .each tables included, under a running suite', () => {
    for (const source of [
      `describe('suite', () => { it('${marker} proves', () => {}) })`,
      `test('${marker} proves', () => {})`,
      `it.each([1, 2])('${marker} proves %s', () => {})`,
      `describe.each([1])('suite %s', () => { it.concurrent('${marker} proves', () => {}) })`,
      `suite('suite', () => { it('${marker} proves', () => {}) })`,
    ]) {
      expect(proves(source), source).toBe(true)
    }
  })

  it('ignores suite titles and anything skipped, conditional or expected to fail', () => {
    for (const source of [
      `describe('${marker} suite', () => { it('proves', () => {}) })`,
      `describe.skip('suite', () => { it('${marker} proves', () => {}) })`,
      `describe.skipIf(true)('suite', () => { it('${marker} proves', () => {}) })`,
      `describe.runIf(ci)('suite', () => { it('${marker} proves', () => {}) })`,
      `it.skip('${marker} proves', () => {})`,
      `it.todo('${marker} proves')`,
      `it.skipIf(true)('${marker} proves', () => {})`,
      `it.fails('${marker} proves', () => {})`,
      `test.skip.each([1])('${marker} proves %s', () => {})`,
      `suite('${marker} suite', () => { it('proves', () => {}) })`,
      `suite.skip('suite', () => { it('${marker} proves', () => {}) })`,
      `describe['skip']('suite', () => { it('${marker} proves', () => {}) })`,
      `it['skip']('${marker} proves', () => {})`,
    ]) {
      expect(proves(source), source).toBe(false)
    }
  })
})
