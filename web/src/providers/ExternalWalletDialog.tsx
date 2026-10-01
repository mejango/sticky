'use client'

import { useEffect, useRef, useState } from 'react'
import { createConnectController, passkeyOption, type ConnectOption } from '@bananapus/nana-sdk-connect/core'
import { JBConnectModal, passkeyLabel } from '@bananapus/nana-sdk-connect/react'
import { WalletFallbackMark } from '@/components/BrandMarks'
import { ViewAsForm } from '@/components/ViewAsForm'
import { useWallet } from '@/hooks/useWallet'
import { useMobileWallet } from '@/hooks/useMobileWallet'
import { useViewAs } from '@/lib/viewAs'
import { mobileWalletLinks } from '@/lib/walletLinks'
import { CENTER_WALLET_CONFIG, CENTER_WALLET_ENABLED } from './wallet-config'

/** A wallet tile shows only an inline image: a remote icon URL would tell its host that this page was opened. */
const safeIcon = (icon: string | undefined) =>
  icon && /^data:image\/(?:png|svg\+xml|webp|jpeg|gif)[;,]/i.test(icon) ? icon : undefined

/** The way to look without signing in: an address to view the site as. */
function ViewAsAddress({ onDone }: { onDone: () => void }) {
  const { viewAs } = useViewAs()
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-4 text-[13px]">
      {open ? (
        <ViewAsForm onDone={onDone} />
      ) : (
        <button type="button" className="btn-link" onClick={() => setOpen(true)}>
          {viewAs ? 'View as another account' : 'View as an address'}
        </button>
      )}
    </div>
  )
}

/** Two ways in: a passkey account at Signa, or an external wallet through the
 * shared wagmi stack. Keep the SDK's connection and dismissal behavior with Sticky's typography.
 * `walletsOnly` offers the external wallets alone and waits for one of them: a write from a Signa session needs one. */
export function ExternalWalletDialog({ onClose, walletsOnly = false }: { onClose: () => void; walletsOnly?: boolean }) {
  const { connectors, connectWith, isConnected, isCenterWallet } = useWallet()
  const mobileWallet = useMobileWallet()
  const [deviceLabel, setDeviceLabel] = useState('Device')
  const [frameTitle, setFrameTitle] = useState('Sign in')
  useEffect(() => { setDeviceLabel(passkeyLabel(navigator.userAgent).replace(/^Continue with /, '').replace(/^a passkey$/, 'Device')) }, [])
  useEffect(() => {
    const label = () => {
      const dialog = document.querySelector('.jb-connect.sticky-connect')
      if (!dialog) return
      const status = dialog.querySelector('.jb-connect-status')
      if (status?.textContent === 'Continuing at Juicebox Center…') status.textContent = 'Connecting, just a sec...'
      const frame = dialog.querySelector('iframe.jb-connect-frame')
      if (frame?.getAttribute('title') === 'Juicebox Center') frame.setAttribute('title', 'Signa')
    }
    label()
    const observer = new MutationObserver(label)
    observer.observe(document.body, { childList: true, characterData: true, subtree: true })
    return () => observer.disconnect()
  }, [])
  const [opener] = useState(() => typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
    ? document.activeElement : null)
  useEffect(() => () => { if (opener?.isConnected) opener.focus({ preventScroll: true }) }, [opener])
  const latest = useRef({ connectWith, onClose })
  latest.current = { connectWith, onClose }
  useEffect(() => { if (isConnected && !(walletsOnly && isCenterWallet)) onClose() }, [isConnected, isCenterWallet, walletsOnly, onClose])
  // Dialogs replace each other: a dialog the chooser opens over, like a flow's confirm asking for an external wallet,
  // paints nothing until the chooser closes (`[data-covered]` in globals.css, as ModalDialog does).
  useEffect(() => {
    const covered = [...document.querySelectorAll('dialog[open]:not([data-covered])')].filter(
      dialog => !dialog.classList.contains('sticky-connect'),
    )
    covered.forEach(dialog => dialog.setAttribute('data-covered', ''))
    return () => covered.forEach(dialog => dialog.removeAttribute('data-covered'))
  }, [])
  useEffect(() => {
    const issuer = CENTER_WALLET_CONFIG?.issuer
    if (!issuer) return
    const themed = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; height?: unknown; page?: unknown } | null
      const dialog = document.querySelector<HTMLDialogElement>('.jb-connect.sticky-connect')
      const frame = dialog?.querySelector('iframe'), heading = dialog?.querySelector('h2')
      if (!dialog || !heading || !frame?.contentWindow || event.source !== frame.contentWindow || event.origin !== issuer) return
      if (data?.type === 'juicebox-center:page' && (data.page === 'signup' || data.page === 'signin')) {
        setFrameTitle(data.page === 'signup' ? 'Sign up' : 'Sign in')
        return
      }
      if (data?.type !== 'juicebox-center:size' || typeof data.height !== 'number' || !Number.isFinite(data.height)) return
      frame.contentWindow.postMessage({ type: 'juicebox-center:theme',
        theme: { headingFont: getComputedStyle(heading).fontFamily } }, issuer)
    }
    window.addEventListener('message', themed)
    return () => window.removeEventListener('message', themed)
  }, [])

  const [controller] = useState(() => {
    const framed = typeof window !== 'undefined' && window.self !== window.top
    const options: ConnectOption[] = []
    let runtime: typeof import('./center-runtime') | undefined
    if (CENTER_WALLET_ENABLED && !walletsOnly) options.push({ ...passkeyOption({
      // The option loads the runtime before it asks for the return path, so the save is synchronous.
      wallet: async () => { runtime = await import('./center-runtime'); return runtime.centerWalletClient() },
      beforeLaunch: () => runtime!.saveCenterReturnPath(),
      // Signa opens in a frame inside this dialog (Signa admits Sticky to frame its sign-in); the page inside
      // offers "Open as a page" when it cannot continue there, which is the full-page path `beforeLaunch` covers.
      frame: true,
      // A framed sign-in finished in this page: the grant is saved, so the connector can connect.
      connected: async () => { await latest.current.connectWith('juicebox-center'); latest.current.onClose() },
    }), name: 'Signa' })
    for (const connector of connectors) {
      if (connector.id === 'safe' && !framed) continue
      options.push({
        id: connector.id, name: connector.name, icon: safeIcon(connector.icon),
        async connect({ signal, handoff }) {
          const onMessage = ({ type, data }: { type: string; data?: unknown }) => {
            if (type === 'display_uri' && typeof data === 'string') handoff(data)
          }
          connector.emitter.on('message', onMessage)
          signal.addEventListener('abort', () => connector.emitter.off('message', onMessage))
          try { await latest.current.connectWith(connector.id) } finally { connector.emitter.off('message', onMessage) }
          latest.current.onClose()
        },
      })
    }
    return createConnectController(options)
  })

  return (
    <JBConnectModal open controller={controller} onClose={onClose} className="sticky-connect" title={frameTitle}
      passkeyLabel={deviceLabel}
      renderIcon={option => <WalletFallbackMark id={option.id} className="h-5 w-5" />}
      renderHandoff={uri => <PairingCode uri={uri} />}>
      {mobileWallet === 'handoff' ? (
        <div className="mt-5">
          <p className="text-sm text-muted">Or open Sticky in your wallet app.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {mobileWalletLinks(window.location.href).map(wallet => (
              <a key={wallet.name} href={wallet.url} className="btn-secondary px-3 py-2 text-sm">{wallet.name}</a>
            ))}
          </div>
        </div>
      ) : null}
      <ViewAsAddress onDone={onClose} />
    </JBConnectModal>
  )
}

function PairingCode({ uri }: { uri: string }) {
  const [image, setImage] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void import('qrcode')
      .then(qr => qr.toDataURL(uri, { margin: 1, width: 320, errorCorrectionLevel: 'M' }))
      .then(url => { if (live) setImage(url) })
      .catch(() => { /* The pairing link still works if QR rendering fails. */ })
    return () => { live = false }
  }, [uri])
  return (
    <div className="rounded-lg border border-line bg-card p-3 text-center">
      <p className="text-sm">Scan with your wallet app, or open it on this device.</p>
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={image} alt="WalletConnect pairing QR code" className="mx-auto my-3 w-full max-w-64" />
      ) : null}
      <a href={uri} className="text-sm underline">Open wallet</a>
    </div>
  )
}
