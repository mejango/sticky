// One source of truth per concept. Explorer hosts used to live in three places in this app
// (plus ~12 inline concatenations) and they DRIFTED: OP mainnet was `optimism.etherscan.io`
// here — a host that does not resolve — while a second map had the working `optimistic.` one,
// so every link built from the first was dead.
import {
  explorerAddressUrl,
  explorerOrigin,
  explorerTokenUrl,
  explorerTxUrl,
} from '@/lib/chainDisplay'
import { describe, expect, it } from 'vitest'

describe('explorer URL builders', () => {
  it('uses the OP mainnet host that actually resolves', () => {
    // `optimism.etherscan.io` does not resolve; `optimistic.` does.
    expect(explorerTxUrl(10, '0xabc')).toBe('https://optimistic.etherscan.io/tx/0xabc')
  })

  it('builds tx and address URLs for every supported chain', () => {
    for (const chainId of [1, 10, 8453, 42161, 11155111, 11155420, 84532, 421614]) {
      expect(explorerTxUrl(chainId, '0xabc')).toMatch(/^https:\/\/[^/]+\/tx\/0xabc$/)
      expect(explorerAddressUrl(chainId, '0xdef')).toMatch(/^https:\/\/[^/]+\/address\/0xdef$/)
      expect(explorerTokenUrl(chainId, '0x123')).toMatch(/^https:\/\/[^/]+\/token\/0x123$/)
    }
  })

  it('returns null for an unknown chain instead of interpolating undefined', () => {
    // The previous template produced `https://undefined/tx/…`.
    expect(explorerTxUrl(999_999, '0xabc')).toBeNull()
    expect(explorerAddressUrl(999_999, '0xdef')).toBeNull()
    expect(explorerTokenUrl(999_999, '0x123')).toBeNull()
    expect(explorerOrigin(999_999)).toBeNull()
  })

  // The local registry duplicates the SDK's chain metadata ON PURPOSE — server
  // -rendered cards must not pull the contract-heavy SDK into their bundle just
  // to spell a host. Duplication is only safe while the VALUES agree, so the
  // agreement is asserted here rather than enforced by an import.
  it('agrees with the SDK on every explorer host', async () => {
    const { JB_CHAINS } = await import('@bananapus/nana-sdk-core')
    for (const chainId of [
      1, 10, 8453, 42161, 11155111, 11155420, 84532, 421614,
    ] as const) {
      expect(explorerOrigin(chainId)).toBe(
        `https://${JB_CHAINS[chainId].etherscanHostname}`,
      )
    }
  })

  // Every explorer link in the app resolves the host from a chain id through these
  // builders. A pre-resolved `host` prop is what let the SDK's dead OP-mainnet
  // constant reach 17 render sites, so no component accepts one any more.
  it('leaves no direct reads of the SDK hostname constant in app code', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry)
        if (statSync(path).isDirectory()) {
          walk(path)
          continue
        }
        if (!/\.tsx?$/.test(path)) continue
        if (path.endsWith('lib/chainDisplay.ts')) continue
        const source = readFileSync(path, 'utf8')
        // The comment in AddressLink names the constant deliberately.
        if (/JB_CHAINS\[[^\]]+\][?]?\.etherscanHostname/.test(source)) {
          offenders.push(path)
        }
      }
    }
    walk('src')
    expect(offenders).toEqual([])
  })
})
