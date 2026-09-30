import type { Metadata } from 'next'
import localFont from 'next/font/local'
import type { ReactNode } from 'react'
import './globals.css'
import { SiteChrome } from '@/components/SiteChrome'
import { jbCenterAppOrigin } from '@/lib/jbcenter-config'
import { ProjectRouteProvider } from '@/providers/ProjectRouteContext'
import { Providers } from '@/providers/Providers'

// Body and UI text: Beatrice. Its Medium face serves every weight from 500 up,
// so bold text never gets a synthesized bold.
const beatrice = localFont({
  src: [
    {
      path: '../../public/fonts/Beatrice-Regular.woff2',
      weight: '400',
      style: 'normal',
    },
    {
      path: '../../public/fonts/Beatrice-Medium.woff2',
      weight: '500 700',
      style: 'normal',
    },
  ],
  variable: '--font-beatrice',
  display: 'swap',
  fallback: ['Helvetica Neue', 'Arial', 'sans-serif'],
})

// Headings: PP Agrandir Wide Bold.
const agrandirWide = localFont({
  src: '../../public/fonts/PPAgrandir-WideBold.woff2',
  weight: '700',
  variable: '--font-agrandir-wide',
  display: 'swap',
  fallback: ['Helvetica Neue', 'Arial', 'sans-serif'],
})

const description =
  'Stick a Juicebox token, hold your streak, and share the bonus left behind by everyone who unsticks.'

export const metadata: Metadata = {
  metadataBase: new URL(jbCenterAppOrigin()),
  title: 'Sticky',
  description,
  icons: { icon: '/assets/drip-corner.png' },
  openGraph: {
    type: 'website',
    title: 'Sticky',
    description,
    images: ['/assets/hero.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Sticky',
    description,
    images: ['/assets/hero.png'],
  },
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${beatrice.variable} ${agrandirWide.variable}`}
    >
      <body>
        <Providers>
          <ProjectRouteProvider>
            <SiteChrome>{children}</SiteChrome>
          </ProjectRouteProvider>
        </Providers>
      </body>
    </html>
  )
}
