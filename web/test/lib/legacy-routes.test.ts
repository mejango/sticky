import { describe, expect, it } from 'vitest'
import { legacyRoute } from '@/lib/legacy-routes'

const HOLDER = '0x1234567890abcdef1234567890abcdef12345678'

describe('old links', () => {
  it.each([
    ['?chain=8453', '#/project/23', '/base:23'],
    ['?chain=8453', '#/project/23/tokens', '/base:23#tokens'],
    ['?chain=8453', '#/project/23/airdrops', '/base:23#airdrops'],
    ['?chain=8453', '#/project/23/latest', '/base:23#latest'],
    ['?chain=8453', '#/project/23/overview', '/base:23'],
    ['', '#/project/5', '/eth:5'],
    ['?chain=11155420', '#/project/7', '/opsep:7'],
    ['', '#/@banny', '/@banny'],
    ['', '#/@banny/tokens', '/@banny#tokens'],
    // The old client never resolved a handle on a testnet, and the handle route reads production chains only.
    ['?chain=84532', '#/@banny', '/@banny'],
    ['', `#/account/${HOLDER}`, `/account/${HOLDER}`],
    // An account and the home name no chain, so a testnet link keeps its network.
    ['?chain=84532', `#/account/${HOLDER}`, `/account/${HOLDER}?network=testnet`],
    ['?chain=84532', '#/', '/?network=testnet'],
    ['?chain=84532', '', '/?network=testnet'],
    ['?network=testnet', '', null],
    ['?chain=8453', '#/', null],
    ['', '', null],
    ['', '#tokens', null],
    ['', '#/project/abc', null],
  ])('%s%s → %s', (search, hash, expected) => {
    expect(legacyRoute(search, hash)).toBe(expected)
  })
})

describe('old links that name no chain themselves', () => {
  it('keep the testnet network of the link, whichever testnet it names', () => {
    for (const chain of [11155111, 11155420, 84532, 421614]) {
      expect(legacyRoute(`?chain=${chain}`, '#/')).toBe('/?network=testnet')
      expect(legacyRoute(`?chain=${chain}`, `#/account/${HOLDER}`)).toBe(`/account/${HOLDER}?network=testnet`)
    }
    expect(legacyRoute('?chain=421614', '#/some/other/hash')).toBe('/?network=testnet')
  })

  it('stay on the production chains for a production chain or none', () => {
    for (const search of ['?chain=1', '?chain=10', '?chain=8453', '?chain=42161', '?chain=', '']) {
      expect(legacyRoute(search, `#/account/${HOLDER}`), search).toBe(`/account/${HOLDER}`)
    }
  })

  it('read a handle the same way whatever chain the link names', () => {
    for (const search of ['?chain=84532', '?chain=8453', '']) {
      expect(legacyRoute(search, '#/@banny/airdrops')).toBe('/@banny#airdrops')
    }
  })
})

describe('the parts of an old link', () => {
  it('names the project by the chain of ?chain=, whichever way the number is written', () => {
    expect(legacyRoute('?chain=10', '#/project/3')).toBe('/op:3')
    expect(legacyRoute('?chain=42161', '#/project/3')).toBe('/arb:3')
    expect(legacyRoute('?chain=11155111', '#/project/3')).toBe('/sep:3')
    expect(legacyRoute('?chain=421614', '#/project/3')).toBe('/arbsep:3')
    expect(legacyRoute('?chain=084532', '#/project/3')).toBe('/basesep:3')
    expect(legacyRoute('?x=1&chain=8453&y=2', '#/project/3')).toBe('/base:3')
  })

  it('reads the default chain, Ethereum, when ?chain= is empty or missing', () => {
    expect(legacyRoute('?chain=', '#/project/9')).toBe('/eth:9')
    expect(legacyRoute('?other=1', '#/project/9')).toBe('/eth:9')
  })

  it.each(['?chain=999', '?chain=abc', '?chain=-1', '?chain=8453.5'])(
    'leaves a project link on the chain "%s" alone: no chain of ours is named',
    search => {
      expect(legacyRoute(search, '#/project/23')).toBeNull()
    },
  )

  it('takes the project number as a number', () => {
    expect(legacyRoute('?chain=8453', '#/project/023')).toBe('/base:23')
  })

  it('accepts a trailing slash where the old client did', () => {
    expect(legacyRoute('?chain=8453', '#/project/23/')).toBe('/base:23')
    expect(legacyRoute('?chain=8453', '#/project/23/tokens/')).toBe('/base:23#tokens')
    expect(legacyRoute('', '#/@banny/')).toBe('/@banny')
    expect(legacyRoute('', '#/@banny/latest/')).toBe('/@banny#latest')
  })

  it('leaves what the old client showed as the home alone', () => {
    for (const hash of ['#/project/23/unknown', '#/project/23/tokens/x', '#/project/', '#/project', '#/@banny/foo', '#/@', '#/account/0x12', `#/account/${HOLDER}/x`, '#/other']) {
      expect(legacyRoute('?chain=8453', hash)).toBeNull()
    }
  })

  it('keeps an account address as it was written', () => {
    const mixed = '0xABCDEFabcdef1234567890ABCDEF1234567890ab'
    expect(legacyRoute('', `#/account/${mixed}`)).toBe(`/account/${mixed}`)
  })

  it('spells a handle as a path segment, whatever it holds', () => {
    expect(legacyRoute('', '#/@Banny.eth')).toBe('/@Banny.eth')
    expect(legacyRoute('', '#/@b%C3%A4nny')).toBe('/@b%C3%A4nny')
    expect(legacyRoute('', '#/@a%3Fb%23c')).toBe('/@a%3Fb%23c')
    // A `?` or `#` written into the hash is part of the handle, never a query or a fragment of the new path.
    expect(legacyRoute('', '#/@a?b=1#c')).toBe('/@a%3Fb%3D1%23c')
    // A stray percent is not an escape: it stays a character of the name, and the handle route finds no such name.
    expect(legacyRoute('', '#/@100%')).toBe('/@100%25')
  })
})

describe('the address an old link is sent to', () => {
  const CASES: [string, string][] = [
    ['?chain=8453', '#/project/23'],
    ['?chain=8453', '#/project/23/tokens'],
    ['?chain=11155420', '#/project/7/airdrops'],
    ['', '#/project/5/latest'],
    ['', '#/@banny'],
    ['?chain=84532', '#/@banny/tokens'],
    ['', `#/account/${HOLDER}`],
    ['?chain=84532', `#/account/${HOLDER}`],
    ['?chain=84532', '#/'],
    ['?chain=84532', ''],
    ['?chain=421614&x=1', '#/whatever'],
  ]

  // The redirect runs on the home page and replaces the address, so the address it lands on must never read as an
  // old link itself, or the home would send the visitor round again.
  it.each(CASES)('is no old link itself, from %s%s', (search, hash) => {
    const target = legacyRoute(search, hash)
    expect(target).not.toBeNull()
    const url = new URL(target!, 'https://sticky.center')
    expect(legacyRoute(url.search, url.hash)).toBeNull()
    expect(url.searchParams.has('chain')).toBe(false)
  })
})

describe('hostile old links', () => {
  it.each([
    ['', '#//evil.com', null],
    ['', '#/project/1/../../x', null],
    ['', '#/@//evil.com', null],
    ['', '#/project/9007199254740993', null],
    ['', '#/project/9007199254740991', '/eth:9007199254740991'],
    ['', '#/@\uD800', null],
  ])('%s%s → %s', (search, hash, expected) => {
    expect(legacyRoute(search, hash)).toBe(expected)
  })
})
