import type { Hex } from 'viem'
export type CenterWalletConfig = { issuer: string; audience: string; manifest: { id: string; revision: Hex }; maximumNetworkFee: string }
export function centerWalletConfiguration(input: {
  enabled?: string; issuer?: string; audience?: string; manifestId?: string; manifestRevision?: string; maximumNetworkFee?: string
}): CenterWalletConfig | null {
  if (input.enabled !== 'true') return null
  try {
    const issuer = input.issuer || 'https://signa.center', audience = input.audience || 'https://api.signa.center'
    for (const value of [issuer, audience]) {
      const url = new URL(value)
      if (url.origin !== value || url.username || url.password || (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) return null
    }
    if (new URL(issuer).protocol === 'https:' && (issuer !== 'https://signa.center' || audience !== 'https://api.signa.center')) return null
    if (issuer === audience || !input.manifestId || !/^[a-zA-Z0-9:_-]{1,128}$/.test(input.manifestId) ||
      !input.manifestRevision || !/^0x[0-9a-f]{64}$/.test(input.manifestRevision) || BigInt(input.manifestRevision) === 0n ||
      !input.maximumNetworkFee || !/^[1-9][0-9]{0,77}$/.test(input.maximumNetworkFee) || BigInt(input.maximumNetworkFee) >= 2n ** 256n) return null
    return { issuer, audience, manifest: { id: input.manifestId, revision: input.manifestRevision as Hex }, maximumNetworkFee: input.maximumNetworkFee }
  } catch { return null }
}
// Next inlines public configuration at build time. No callback or discovery response can
// replace these trusted issuer, audience, manifest or fee pins.
export const CENTER_WALLET_CONFIG = centerWalletConfiguration({ enabled: process.env.NEXT_PUBLIC_CENTER_WALLET_ENABLED,
  issuer: process.env.NEXT_PUBLIC_CENTER_WALLET_ISSUER, audience: process.env.NEXT_PUBLIC_CENTER_WALLET_AUDIENCE,
  manifestId: process.env.NEXT_PUBLIC_CENTER_WALLET_MANIFEST_ID, manifestRevision: process.env.NEXT_PUBLIC_CENTER_WALLET_MANIFEST_REVISION,
  maximumNetworkFee: process.env.NEXT_PUBLIC_CENTER_WALLET_MAXIMUM_NETWORK_FEE_WEI })
export const CENTER_WALLET_ENABLED = CENTER_WALLET_CONFIG !== null
