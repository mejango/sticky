import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getAddress, isAddress } from 'viem'
import { AccountActivity } from '@/components/account/AccountActivity'
import { AccountHeader } from '@/components/account/AccountHeader'
import { AccountPositions } from '@/components/account/AccountPositions'

export async function generateMetadata({ params }: PageProps<'/account/[address]'>): Promise<Metadata> {
  const { address } = await params
  if (!isAddress(address, { strict: false })) return { title: 'Account' }
  const holder = getAddress(address)
  return { title: `Account ${holder.slice(0, 6)}…${holder.slice(-4)}` }
}

/** An account: `/account/0x…` for its Sticky positions and activity on production chains, and
 * `/account/0x…?network=testnet` for testnets. */
export default async function AccountPage({ params, searchParams }: PageProps<'/account/[address]'>) {
  const [{ address }, { network }] = await Promise.all([params, searchParams])
  if (!isAddress(address, { strict: false })) notFound()
  const holder = getAddress(address)
  const chosen = network === 'testnet' ? 'testnet' : 'mainnet'
  return (
    <div className="mx-auto w-full max-w-[1068px]">
      <AccountHeader address={holder} />
      <div className="mt-5 grid items-start gap-x-3.5 gap-y-6 md:grid-cols-2">
        <AccountPositions address={holder} network={chosen} />
        <AccountActivity address={holder} network={chosen} />
      </div>
    </div>
  )
}
