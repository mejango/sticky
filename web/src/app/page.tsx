import Image, { type StaticImageData } from 'next/image'
import type { ReactNode } from 'react'
import { LegacyHashRedirect } from '@/components/LegacyHashRedirect'
import { HomeLists } from '@/components/home/HomeLists'
import cone from '../../public/assets/cone.png'
import jar from '../../public/assets/jar.png'
import juicebox from '../../public/assets/juicebox.png'

function Explainer({
  image,
  width,
  height,
  maxWidth,
  title,
  children,
}: {
  image: StaticImageData
  width: number
  height: number
  maxWidth: string
  title: string
  children: ReactNode
}) {
  return (
    <section className="mx-auto mt-11 max-w-[68ch] text-[17px] leading-[1.65] [&+&]:mt-[clamp(88px,9vw,128px)]">
      <Image
        src={image}
        alt=""
        width={width}
        height={height}
        sizes={`${width}px`}
        className={`mx-auto mb-[26px] block h-auto ${maxWidth}`}
        style={{ width }}
      />
      <h2 className="mb-3.5 font-agrandir-wide text-[26px] leading-tight">{title}</h2>
      {children}
    </section>
  )
}

const points = 'mt-3.5 list-decimal pl-[30px] marker:font-bold marker:text-accent [&>li]:my-2.5 [&>li]:pl-1.5'

/** The home: `/` for Sticky on production chains, `/?network=testnet` for Sticky on testnets. It is also where every
 * link from the old client lands (`/?chain=8453#/project/23`), and sends it on. */
export default async function Home({ searchParams }: PageProps<'/'>) {
  const { network } = await searchParams
  return (
    <>
      <LegacyHashRedirect />
      <HomeLists network={network === 'testnet' ? 'testnet' : 'mainnet'} />
      <div className="mt-11 border-t border-line" />
      <Explainer image={jar} width={260} height={500} maxWidth="max-w-[70%]" title="Dip one in, get a sticky one out">
        <ol className={points}>
          <li>Deposit a supported token for sticky shares of its backing.</li>
          <li>Stick more anytime, unstick anytime too.</li>
          <li>
            Anyone can fund weekly rewards for sticky holders. After each round, start unlocking your share over four
            rounds.
          </li>
          <li>Sticky tokens can have a bonus: partial unsticks leave backing for the remaining holders.</li>
          <li>Sticky token rules are set when the token is made, and can&apos;t be changed.</li>
        </ol>
      </Explainer>
      <Explainer image={cone} width={210} height={616} maxWidth="max-w-[60%]" title="Worth it">
        <ol className={points}>
          <li>The ledger remembers who has stuck around — stickiness we can attest to.</li>
          <li>Airdrops from anyone, and bonuses paid by unsticking, go to those who stick around.</li>
          <li>Unstick anytime to take your share, minus any stickiness bonus tax you leave behind.</li>
          <li>
            No Sticky administrator can change your project&apos;s rules. The underlying token and Juicebox core retain
            their own controls.
          </li>
          <li>
            Supports standard ERC-20 tokens on Ethereum, Arbitrum, Base, and Optimism. Tokens that rebase or charge
            transfer fees are unsupported.
          </li>
        </ol>
      </Explainer>
      <Explainer image={juicebox} width={180} height={305} maxWidth="max-w-[55%]" title="Juicy insides">
        <p>
          Every sticky token uses{' '}
          <a
            className="text-accent underline decoration-amber"
            href="https://juicebox.money"
            target="_blank"
            rel="noopener noreferrer"
          >
            Juicebox V6
          </a>{' '}
          for its project, token issuance, and backing accounting. Rewards and supported bridge routes connect it to other
          Juicebox projects.
        </p>
      </Explainer>
    </>
  )
}
