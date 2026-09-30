import type { JBChainId } from '@bananapus/nana-sdk-core'
import {
  displayChainId,
  displayChainName,
  displayChainSlug,
} from './chainDisplay'

/**
 * Parse a `<chainSlug>:<projectId>` URN (e.g. `eth:1`). V6-only site: no
 * version segment — bare URNs ARE v6.
 */
export function parseUrn(
  urn: string,
): { chainId: JBChainId; projectId: number } | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urn)
  } catch {
    // Typed or linked text with a stray `%` is not a URN, and must not throw.
    return null
  }
  const [slug, id] = decoded.split(':')
  const chainId = displayChainId(slug?.trim())
  const projectId = Number(id)
  if (chainId === null || !Number.isInteger(projectId) || projectId <= 0) {
    return null
  }
  return { chainId: chainId as JBChainId, projectId }
}

export function toUrn(chainId: number, projectId: number | bigint | string): string {
  return `${displayChainSlug(chainId) ?? chainId}:${projectId}`
}

/** A project's address on Sticky, e.g. `/base:23`. */
export function projectPath(chainId: number, projectId: number | bigint | string): string {
  return `/${toUrn(chainId, projectId)}`
}

export function chainName(chainId: number): string {
  return displayChainName(chainId)
}
