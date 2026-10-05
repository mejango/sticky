'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { Address } from 'viem'
import { AddressInput, EnsName, parseAddress } from '@/components/project/flows/AddressInput'
import { reviewGate } from '@/components/project/flows/review-gate'
import { ModalShell } from '@/components/ui/ModalShell'
import { TxConfirmDialog } from '@/components/ui/TxConfirmDialog'
import { TxError } from '@/components/ui/TxError'
import { confirmAction, sendingStatus, stepsIntro, ViewTransactionLink } from '@/components/ui/TxProgress'
import { useSafeTx, type TxRequest } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { stickyHookAbi } from '@/lib/sticky-abis'
import { trustTx } from '@/lib/sticky-builders'
import { stickyLabel } from '@/lib/sticky-format'
import type { Answer, StickyProjectInfo } from '@/lib/sticky-project'
import { refreshAfterTrust } from '@/lib/sticky-refresh'
import { need, readAt } from '@/lib/sticky-rewards'
import { chainName } from '@/lib/urn'

const ALREADY_TRUSTED = 'This sender is already trusted.'
const NOT_TRUSTED = 'This sender is not trusted.'
const TRUST_UNREADABLE = 'Could not read whether this sender is trusted. Try again.'

/** Whether the hook has `holder` trusting `sender` to stick for them in the project, asked of the hook the plan
 * calls: a read that cannot be made is an error, never "not trusted". */
async function trustedBy(chainId: number, projectId: number, hook: Address, holder: Address, sender: Address): Promise<boolean> {
  try {
    const [answer] = await readAt(
      chainId,
      [{ address: hook, abi: stickyHookAbi, functionName: 'isTrustedSenderOf', args: [BigInt(projectId), holder, sender] }],
      undefined,
      undefined,
    )
    return need(answer as Answer<boolean>, 'Whether this sender is trusted')
  } catch (cause) {
    console.warn('Could not read whether a sender is trusted before changing it.', { chainId, projectId }, cause)
    throw new Error(TRUST_UNREADABLE, { cause })
  }
}

/** A change of trust under review, for the account that asked for it: another account's is never shown or sent. */
type Review = { account: Address; plan: TxRequest | null; preparing: boolean; error: string | null }

/**
 * Letting a sender stick tokens for the holder, or taking that back, in a modal. Trusting asks for the sender's address;
 * untrusting is for one of the senders the holder's list shows. Either way the address is a whole one, in one case or
 * with its checksum right, and not the zero address. The review asks the hook whether the sender is trusted now, refuses
 * a change that changes nothing, plans the one call, and its confirm replaces the form in the same card; the hook is
 * asked again just before the wallet is. A wallet that cannot send, Signa or View as, is refused when the review
 * starts. Once the change is confirmed, what it changed is read again.
 */
export function TrustFlow({
  chainId,
  projectId,
  info,
  sender,
  onClose,
}: {
  chainId: number
  projectId: number
  /** The project, which the confirmation names: its Sticky token's symbol, once the page has read it. */
  info: StickyProjectInfo | undefined
  /** The sender to stop trusting. With none, the holder names one to trust. */
  sender: Address | null
  onClose: () => void
}) {
  const trusting = sender === null
  const { address, isConnected, isCenterWallet, openSignIn } = useWallet()
  const tx = useSafeTx(chainId)
  const client = useQueryClient()
  const [typed, setTyped] = useState('')
  const [review, setReview] = useState<Review | null>(null)
  const attempt = useRef(0)

  const current = review && review.account === address ? review : null
  const plan = current?.plan ?? null
  const sending = tx.busy || tx.phase === 'review'
  const complete = tx.phase === 'success'
  const shown = sender === null ? null : parseAddress(sender)

  useEffect(() => {
    if (complete) refreshAfterTrust(client, chainId, projectId)
  }, [complete, client, chainId, projectId])

  async function startReview() {
    const gate = reviewGate({ address, isConnected, isCenterWallet })
    if (!gate) return void openSignIn()
    const { account } = gate
    const refuse = (error: string) => setReview({ account, plan: null, preparing: false, error })
    if (gate.refusal) return refuse(gate.refusal)
    const target = trusting ? parseAddress(typed) : shown
    if (!target) return refuse('Enter a valid sender address.')

    const mine = ++attempt.current
    tx.reset()
    setReview({ account, plan: null, preparing: true, error: null })
    try {
      const request = trustTx(chainId, BigInt(projectId), target, trusting)
      if ((await trustedBy(chainId, projectId, request.address, account, target)) === trusting) {
        if (attempt.current === mine) refuse(trusting ? ALREADY_TRUSTED : NOT_TRUSTED)
        return
      }
      if (attempt.current === mine) setReview({ account, plan: request, preparing: false, error: null })
    } catch (reason) {
      if (attempt.current === mine) refuse(reason instanceof Error ? reason.message : TRUST_UNREADABLE)
    }
  }

  async function send() {
    if (!plan || !current || sending) return
    const [, target] = plan.args as readonly [bigint, Address, boolean]
    await tx.send(plan, {
      reviewedAccount: current.account,
      reverify: async () => {
        if ((await trustedBy(chainId, projectId, plan.address, current.account, target)) === trusting) {
          throw new Error(trusting ? ALREADY_TRUSTED : NOT_TRUSTED)
        }
      },
    })
  }

  function closeReview() {
    attempt.current += 1
    setReview(null)
    if (complete) onClose()
    else tx.reset()
  }

  const planSender = plan ? (plan.args as readonly [bigint, Address, boolean])[1] : null

  return (
    <ModalShell title={trusting ? 'Trust a sender' : 'Untrust sender'} onClose={onClose} busy={sending} maxWidth="max-w-md">
      <div className="space-y-4">
        <p className="text-sm text-muted">
          {trusting ? 'This address will be able to stick tokens for you.' : 'This address will no longer be able to stick tokens for you.'}
        </p>
        {trusting ? (
          <AddressInput
            label="Sender address"
            value={typed}
            onChange={text => {
              setTyped(text)
              setReview(null)
            }}
            chainId={chainId}
          />
        ) : (
          <div className="min-w-0">
            <p className="break-all font-mono text-xs">{shown ?? sender}</p>
            <EnsName address={shown ?? undefined} chainId={chainId} />
          </div>
        )}
        <TxError error={plan || current?.preparing ? null : current?.error} />
        <div className="flex justify-end">
          <button
            type="button"
            className="btn-primary min-h-[44px] px-5 text-sm"
            disabled={sending || current?.preparing}
            onClick={() => void startReview()}
          >
            {!isConnected ? (trusting ? 'Sign in to trust' : 'Sign in to untrust') : trusting ? 'Review trust' : 'Review untrust'}
          </button>
        </div>
      </div>
      {plan || current?.preparing ? (
        <TxConfirmDialog
          open
          preparing={!plan}
          onClose={closeReview}
          title={complete ? (trusting ? 'Sender trusted' : 'Sender untrusted') : trusting ? 'Trust this sender' : 'Untrust this sender'}
          rows={
            planSender
              ? [
                  { label: 'Project', value: info ? `${stickyLabel(info)} #${projectId}` : `#${projectId}` },
                  { label: 'Sender', value: planSender, mono: true },
                  {
                    label: 'Trusted',
                    value: trusting ? 'Yes, they can add stakes to your position.' : 'No, they can no longer add stakes to your position.',
                    strong: true,
                  },
                  { label: 'On', value: chainName(chainId) },
                ]
              : undefined
          }
          steps={[{ title: plan?.label ?? (trusting ? 'Trust sender' : 'Untrust sender') }]}
          activeIndex={0}
          stepsIntro={stepsIntro(1, complete ? 1 : 0)}
          complete={complete}
          busy={sending}
          action={confirmAction(tx.phase, tx.phase === 'error' ? 'Retry' : trusting ? 'Confirm & trust' : 'Confirm & untrust')}
          onConfirm={() => void send()}
          status={
            complete ? (
              <ViewTransactionLink chainId={chainId} hash={tx.hash} />
            ) : !plan ? (
              'Checking whether this sender is trusted…'
            ) : (
              (sendingStatus(tx) ?? undefined)
            )
          }
          error={tx.error}
        />
      ) : null}
    </ModalShell>
  )
}
