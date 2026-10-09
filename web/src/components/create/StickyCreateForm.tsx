'use client'

import { useState, type FormEvent } from 'react'
import { useChainId } from 'wagmi'
import { useWallet } from '@/hooks/useWallet'
import { chainsForEnvironment, type ChainEnvironment } from '@/lib/chains'
import { BONUS_PRESETS, launchChainBlocker, prepareStickyLaunch, type LaunchPlan } from '@/lib/sticky-launch-plan'
import { listingCapability } from '@/lib/sticky-listing'
import { useViewAs } from '@/lib/viewAs'
import { useWalletAuth } from '@/providers/WalletAuthContext'

const inputClass = 'w-full rounded-lg border border-line bg-card px-3 py-2 text-ink'

export function StickyCreateForm({ environment, busy, prepare, working, failed }: {
  environment: ChainEnvironment
  busy: boolean
  prepare: (plan: LaunchPlan, capability: 'sponsored' | 'self-paid' | 'unavailable') => Promise<void>
  working: (value: boolean) => void
  failed: (error: unknown) => void
}) {
  const wallet = useWallet()
  const connectedChainId = useChainId()
  const { requestSignIn } = useWalletAuth()
  const { viewAs } = useViewAs()
  const [network, setNetwork] = useState(environment)
  const selectable = (value: ChainEnvironment) => chainsForEnvironment(value).filter(chain => !launchChainBlocker(chain.id)).map(chain => chain.id)
  const defaultChain = (value: ChainEnvironment) => {
    const available = selectable(value)
    return wallet.address && available.some(chainId => chainId === connectedChainId) ? connectedChainId
      : available.includes(1) ? 1 : available[0]
  }
  const [homeChainId, setHomeChainId] = useState<number | undefined>(() => defaultChain(environment))
  const [token, setToken] = useState('')
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [bonus, setBonus] = useState('10')
  const [customBonus, setCustomBonus] = useState('')
  const [senders, setSenders] = useState('')
  const [soulbound, setSoulbound] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!wallet.address || wallet.isCenterWallet || busy || viewAs || homeChainId === undefined) return
    working(true)
    try {
      const plan = await prepareStickyLaunch({ tokenInput: token, name, symbol, bonusChoice: bonus,
        customBonus, trustedSenders: senders, soulbound, chainIds: [homeChainId], environment: network }, wallet.address)
      const capability = await listingCapability(plan)
      await prepare(plan, capability)
    } catch (error) { failed(error) } finally { working(false) }
  }

  return <form onSubmit={submit} className="space-y-4">
    <p className="text-sm text-muted">Create a Sticky pool on one home chain, backed by an existing ERC-20 there. Its holders share rewards while they stay stuck.</p>
    <fieldset disabled={busy} className="space-y-4">
      <label className="block space-y-1 text-sm font-medium">Token address or Juicebox project ID
        <input className={inputClass} value={token} onChange={event => setToken(event.target.value)} placeholder="0x… or base:5" required />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1 text-sm font-medium">Name (optional)
          <input className={inputClass} value={name} onChange={event => setName(event.target.value)} placeholder="Sticky Token" />
        </label>
        <label className="block space-y-1 text-sm font-medium">Symbol (optional)
          <input className={inputClass} value={symbol} onChange={event => setSymbol(event.target.value)} placeholder="STICKYTOKEN" />
        </label>
      </div>
      <p className="text-xs text-muted">Blank names use the backing token’s name and symbol.</p>
      <label className="block space-y-1 text-sm font-medium">Stickiness bonus
        <select className={inputClass} value={bonus} onChange={event => setBonus(event.target.value)}>
          {BONUS_PRESETS.map(value => <option key={value} value={value}>{value}%</option>)}
          <option value="custom">Custom</option>
        </select>
      </label>
      {bonus === 'custom' ? <label className="block space-y-1 text-sm font-medium">Custom bonus (%)
        <input className={inputClass} inputMode="decimal" value={customBonus} onChange={event => setCustomBonus(event.target.value)} placeholder="0 to 99.99" required />
      </label> : null}
      <p className="text-xs text-muted">A higher bonus leaves more backing for holders who remain. The exact amount depends on the share of total supply being unstuck.</p>
      <label className="block space-y-1 text-sm font-medium">Networks
        <select className={inputClass} value={network} onChange={event => {
          const next = event.target.value as ChainEnvironment
          setNetwork(next); setHomeChainId(defaultChain(next))
        }}><option value="production">Mainnets</option><option value="testnet">Testnets</option></select>
      </label>
      <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">Home chain</legend>
        {chainsForEnvironment(network).map(chain => {
          const blocker = launchChainBlocker(chain.id)
          return <label key={chain.id} className="flex items-center gap-2 text-sm">
            <input type="radio" name="home-chain" disabled={!!blocker} checked={homeChainId === chain.id} onChange={() => setHomeChainId(chain.id)} />
            {chain.name}{blocker ? <span className="text-muted">— {blocker}</span> : null}
          </label>
        })}
      </fieldset>
      <p className="text-xs text-muted">Shares, backing and rewards stay on this chain. Supported bridges can bring rewards from other chains.</p>
      <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={soulbound} onChange={event => setSoulbound(event.target.checked)} />
        Lock transfers. Holders can still stick and unstick, but cannot send Sticky tokens to another wallet.
      </label>
      <label className="block space-y-1 text-sm font-medium">Permanent granters (optional)
        <textarea className={inputClass} value={senders} onChange={event => setSenders(event.target.value)} placeholder="Comma-separated wallet addresses" rows={2} />
      </label>
      <p className="text-xs text-muted">Granters can stick tokens for any holder without that holder’s permission. These permissions cannot be revoked. Auto-stick is included automatically.</p>
      <p className="text-xs text-muted">The bonus and transfer setting are also permanent.</p>
    </fieldset>
    {viewAs ? <p role="alert" className="text-sm text-err">Exit View as to create a token.</p>
      : !wallet.address || wallet.isCenterWallet ? <button type="button" className="btn-primary px-4 py-2" disabled={busy} onClick={() => void requestSignIn({ walletsOnly: true })}>Connect an external wallet</button>
        : <button type="submit" className="btn-primary px-4 py-2" disabled={busy || homeChainId === undefined}>{busy ? 'Checking launch…' : 'Prepare launch'}</button>}
  </form>
}
