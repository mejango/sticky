import { describe, expect, it } from 'vitest'
import {
  isMobileDevice,
  mobileWalletLinks,
  walletDappUrl,
} from '@/lib/walletLinks'

const CID = 'bafybeif2pn5x3mxfhin4cflqyeu3spqlanc3r6nutyufh7ijw54gggtdra'

describe('mobile wallet links', () => {
  it('rewrites every deployed IPFS subdomain gateway for a wallet browser', () => {
    for (const gateway of ['inbrowser.link', 'dweb.link', 'w3s.link']) {
      expect(walletDappUrl(`https://${CID}.ipfs.${gateway}/project#pay`)).toBe(
        `https://${CID}.eth.sucks/project#pay`,
      )
    }
  })

  it('creates a MetaMask dapp handoff without losing the current route', () => {
    const page = `https://juicebox.money/base:1?tab=pay#checkout`
    const metamask = mobileWalletLinks(page)[0]
    expect(metamask.name).toBe('MetaMask')
    expect(decodeURIComponent(metamask.url.split('/dapp/')[1])).toBe(
      page.replace(/^https?:\/\//, ''),
    )
  })

  it('recognizes phone and touch-iPad browsers', () => {
    expect(isMobileDevice({ userAgent: 'Mozilla/5.0 (iPhone)' })).toBe(true)
    expect(
      isMobileDevice({
        userAgent: 'Mozilla/5.0 (Macintosh)',
        platform: 'MacIntel',
        maxTouchPoints: 5,
      }),
    ).toBe(true)
    expect(
      isMobileDevice({
        userAgent: 'Mozilla/5.0 (Macintosh)',
        platform: 'MacIntel',
        maxTouchPoints: 0,
      }),
    ).toBe(false)
  })
})
