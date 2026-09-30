import Link from 'next/link'
import type { ComponentProps } from 'react'
import { projectPath } from '@/lib/urn'

type ProjectLinkProps = Omit<ComponentProps<typeof Link>, 'href' | 'prefetch'> & {
  chainId: number
  projectId: number | bigint
}

/**
 * A link to a project's page, `/base:23`. It is never prefetched: Next 16.3.3 (and 16.3.8) prefetches without end
 * once more than four links to a dynamic route whose segment holds a `:` are in view, and a list of projects shows
 * that many.
 */
export function ProjectLink({ chainId, projectId, ...props }: ProjectLinkProps) {
  return <Link {...props} href={projectPath(chainId, projectId)} prefetch={false} />
}
