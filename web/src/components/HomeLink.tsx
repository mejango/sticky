'use client'

import Link from 'next/link'
import { Suspense, type ComponentProps } from 'react'
import { useTestnetInView } from '@/hooks/useProjectInView'

type HomeLinkProps = Omit<ComponentProps<typeof Link>, 'href'>

function NetworkHomeLink(props: HomeLinkProps) {
  const testnet = useTestnetInView()
  return <Link href={testnet ? '/?network=testnet' : '/'} {...props} />
}

/**
 * A link to the home of the network the page in view is on, so a visitor on the testnets stays on them. A prerendered
 * page does not know its address bar, and reading it suspends: until the browser does, this is the link to the home
 * on the production chains.
 */
export function HomeLink(props: HomeLinkProps) {
  return (
    <Suspense fallback={<Link href="/" {...props} />}>
      <NetworkHomeLink {...props} />
    </Suspense>
  )
}
