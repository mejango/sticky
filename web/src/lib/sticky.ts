import type { JBChainId } from '@bananapus/nana-sdk-core'
import { isStickySplit } from '@bananapus/nana-sdk-core/v6'
import type { Address } from 'viem'

/** Whether `hook` is the StickyDistributor on `chainId` (false where Sticky is not deployed). */
export function isStickyHook(hook: string, chainId: number): boolean {
  try {
    return isStickySplit({ hook: hook as Address }, chainId as JBChainId)
  } catch {
    return false
  }
}
