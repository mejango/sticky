import Image, { type StaticImageData } from 'next/image'
import arbitrumIcon from '@/assets/chains/arbitrum.svg'
import baseIcon from '@/assets/chains/base.svg'
import mainnetIcon from '@/assets/chains/mainnet.svg'
import optimismIcon from '@/assets/chains/optimism.svg'
import { chainName } from '@/lib/urn'

const CHAIN_ICON: Record<number, StaticImageData> = {
  1: mainnetIcon,
  11155111: mainnetIcon,
  10: optimismIcon,
  11155420: optimismIcon,
  8453: baseIcon,
  84532: baseIcon,
  42161: arbitrumIcon,
  421614: arbitrumIcon,
}

/**
 * A small round chain mark. Beside a visible chain name the mark is decorative —
 * naming it too would announce the chain twice — so set `standalone` only where
 * the mark is the sole chain signal (a bare table cell, an icon-only link, a
 * stack of marks) and needs to carry the name itself.
 */
export function ChainIcon({
  chainId,
  size = 18,
  className = '',
  standalone = false,
}: {
  chainId: number
  size?: number
  className?: string
  standalone?: boolean
}) {
  const src = CHAIN_ICON[chainId]
  const name = chainName(chainId)
  if (!src) {
    // No mark for this chain, so the name is rendered as visible text instead.
    return <span className={`text-xs text-muted ${className}`}>{name}</span>
  }
  return (
    <Image
      src={src}
      alt={standalone ? name : ''}
      aria-hidden={standalone ? undefined : 'true'}
      width={size}
      height={size}
      className={`inline-block rounded-full ${className}`}
    />
  )
}
