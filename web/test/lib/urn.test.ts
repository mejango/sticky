import { describe, expect, it } from 'vitest'
import { chainName, parseUrn, projectPath, toUrn } from '@/lib/urn'

describe('route identity', () => {
  it('round-trips canonical chain slugs and positive integer project IDs', () => {
    expect(parseUrn(toUrn(1, 42))).toEqual({ chainId: 1, projectId: 42 })
    expect(parseUrn('eth%3A42')).toEqual({ chainId: 1, projectId: 42 })
  })

  it.each([
    ['eth', 1],
    ['op', 10],
    ['base', 8453],
    ['arb', 42161],
    ['sep', 11155111],
    ['opsep', 11155420],
    ['basesep', 84532],
    ['arbsep', 421614],
  ])('names %s as chain %i, both ways', (slug, chainId) => {
    expect(parseUrn(`${slug}:23`)).toEqual({ chainId, projectId: 23 })
    expect(toUrn(chainId, 23)).toBe(`${slug}:23`)
  })

  it.each(['unknown:42', 'eth:0', 'eth:-1', 'eth:1.5', 'eth:not-a-number', 'eth', ':42', ''])(
    'rejects an invalid route identity (%s)',
    urn => {
      expect(parseUrn(urn)).toBeNull()
    },
  )

  it.each(['%', '100%', 'eth%3A%', '%E0%A4%A', 'eth:1%zz'])(
    'rejects text with a malformed percent escape instead of throwing (%s)',
    urn => {
      expect(parseUrn(urn)).toBeNull()
    },
  )

  it('keeps unknown chain display fallbacks explicit', () => {
    expect(toUrn(999, 7)).toBe('999:7')
    expect(chainName(999)).toBe('Chain 999')
  })

  it('builds a project path from a number, a bigint or the text of an ID', () => {
    expect(projectPath(8453, 23)).toBe('/base:23')
    expect(projectPath(8453, 23n)).toBe('/base:23')
    expect(projectPath(11155111, '5')).toBe('/sep:5')
    expect(parseUrn(projectPath(84532, 9).slice(1))).toEqual({ chainId: 84532, projectId: 9 })
  })
})
