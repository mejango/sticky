import { describe, expect, it } from 'vitest'
import { centerWalletConfiguration } from '@/providers/wallet-config'
const configured = { enabled: 'true', manifestId: 'reviewed-base-passkey', manifestRevision: '0x' + '11'.repeat(32), maximumNetworkFee: '100000000000000' }
describe('optional Center configuration', () => {
  it('requires explicit activation and every reviewed pin', () => {
    expect(centerWalletConfiguration({})).toBeNull()
    expect(centerWalletConfiguration(configured)).toMatchObject({ issuer: 'https://signa.center', audience: 'https://api.signa.center' })
    for (const change of [{ enabled: 'false' }, { manifestId: '' }, { manifestRevision: '0x' + '00'.repeat(32) }, { maximumNetworkFee: '0' }, { maximumNetworkFee: String(2n ** 256n) }, { issuer: 'ftp://localhost' }, { issuer: 'https://api.signa.center' }, { issuer: 'https://my.juicebox.center' }, { audience: 'https://juicebox.center' }])
      expect(centerWalletConfiguration({ ...configured, ...change })).toBeNull()
  })
  it('allows configured loopback test origins without trusting callbacks as configuration', () => {
    expect(centerWalletConfiguration({ ...configured, issuer: 'http://localhost:4200', audience: 'http://localhost:4300' })?.issuer).toBe('http://localhost:4200')
    for (const issuer of ['http://evil.example', 'https://my.juicebox.center/', 'https://my.juicebox.center/path', 'https://user:password@wallet.juicebox.center'])
      expect(centerWalletConfiguration({ ...configured, issuer })).toBeNull()
  })
})
