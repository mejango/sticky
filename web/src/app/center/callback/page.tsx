'use client'
import { useEffect, useRef, useState } from 'react'
import { connect } from '@wagmi/core'
import { wagmiConfig } from '@/providers/Providers'
import { capturedCenterCallback, clearCenterCallbackUrl } from '@/providers/center-callback'

let completing: Promise<string | null> | null = null
let callbackResolved = false
async function complete(): Promise<string | null> {
  const callback = capturedCenterCallback()
  const { centerWalletClient, originalCenterPage } = await import('@/providers/center-runtime')
  clearCenterCallbackUrl()
  if (!callbackResolved && callback && new URL(callback.url).search) {
    // Framed by a Sticky page (a sign-in or payment review shown inline) or opened as a popup: that page finishes
    // the sign-in or payment and removes the frame or closes the window.
    const { deliverCenterCallback } = await import('@bananapus/nana-sdk-connect/core')
    if (await deliverCenterCallback(callback.url, { window })) { callbackResolved = true; return null }
  }
  const wallet = centerWalletClient()
  if (!callbackResolved && callback && new URL(callback.url).search) {
    if (new URL(callback.url).searchParams.has('review')) await wallet.payments().completePayment(callback.url)
    else await wallet.completeConnection(callback.url)
    callbackResolved = true
  } else if (wallet.payments().pendingPayment()) await wallet.payments().refreshPayment()
  else await wallet.retryConnection()
  const connector = wagmiConfig.connectors.find(item => item.id === 'juicebox-center')
  if (!connector) throw new Error('Signa is not configured for this site.')
  if (wagmiConfig.state.current !== connector.uid) await connect(wagmiConfig, { connector })
  return originalCenterPage()
}
export default function CenterCallbackPage() {
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [delivered, setDelivered] = useState(false)
  const [framed, setFramed] = useState(false)
  const [contextKnown, setContextKnown] = useState(false)
  const content = useRef<HTMLElement>(null)
  useEffect(() => {
    const main = content.current
    const inFrame = window.parent !== window
    setFramed(inFrame)
    setContextKnown(true)
    if (!inFrame || !main) return
    const report = () => window.parent.postMessage({ type: 'juicebox-center:size',
      height: Math.ceil(main.getBoundingClientRect().height) }, window.location.origin)
    const resize = new ResizeObserver(report)
    resize.observe(main)
    return () => resize.disconnect()
  }, [])
  useEffect(() => {
    let active = true
    completing ??= complete().catch(cause => { completing = null; throw cause })
    void completing.then(path => { if (!active) return; if (path === null) setDelivered(true); else window.location.replace(path) }, cause => {
      if (active) setError(cause instanceof Error ? cause.message : 'The wallet connection could not be restored.')
    })
    return () => { active = false }
  }, [attempt])
  return <main ref={content} style={{ visibility: contextKnown && (!framed || delivered || error) ? 'visible' : 'hidden' }} className={`mx-auto max-w-xl px-6 ${framed ? 'py-5' : 'py-16'}`}>{/* Framed, the page that opened the frame still exchanges the sign-in, then closes the frame itself. */}<h1 className={`font-agrandir-wide ${framed ? 'text-lg' : 'text-2xl'}`}>{framed && delivered && !error ? 'Signing you in…' : 'Your Signa account'}</h1>
    {framed && delivered && !error ? null : <p role="status" className="mt-5 break-words">{error ?? (delivered ? 'Done. You can close this window.' :'Restoring your wallet and original page…')}</p>}
    {error ? <button type="button" className="btn-primary mt-5 px-4 py-3" onClick={() => { setError(null); setAttempt(value => value + 1) }}>Retry</button> : null}
  </main>
}
