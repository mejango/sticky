import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import * as review from '@bananapus/nana-sdk-core/review'
import { describe, expect, it } from 'vitest'
import { sourcesUnder } from './source-gates'

/**
 * No app-local hold or recovery logic: every held write is the SDK's (useHeldWrite, useHeldWrites, HeldWritesNotice) and
 * every saved attempt's recovery is the SDK's (createSavedAttemptRecovery, useSavedAttempt). The app keeps its journals as
 * domain data and supplies its domain checks; it decides nothing about whether a write may be sent again, and it shows
 * the SDK's own copy.
 */
const SRC = join(__dirname, '..', 'src')
const sources = sourcesUnder(SRC).map(file => ({ file: relative(SRC, file), text: readFileSync(file, 'utf8') }))
const offenders = (pattern: RegExp, allowed: readonly string[] = []) =>
  sources.filter(({ file, text }) => pattern.test(text) && !allowed.includes(file)).map(({ file }) => file)

describe('the hold and recovery gate', () => {
  it.each([
    ['an app copy of the shown-exit rule', /\b(?:function|const|let)\s+hidesShownExit\b/],
    ['an app copy of the settlement line', /\b(?:function|const|let)\s+settledLine\b/],
    ['an app recovery of a held write', /\b(?:recoverFromHold|holdOutcome|recoverSavedLaunch|releaseLaunch|launchHold(?:State|View)|sponsorUnknown|exitHold|forceExit)\b/],
    ['an app follower of a held write or Safe proposal', /\b(?:PendingWriteExit|storedHold|exitStored|adoptStored|reconcileProposal|retireProposal|followProposal|startFollowingProposal|proposalKey|watchSafeProposal)\b/],
    ['an app copy of the check-required copy', /\bCHECK_REQUIRED_\w*|lib\/check-required/],
    ['an app exit or adoption of a hold', /\bcheckedWallet\b|\.(?:adopt|onUnproven|onExecuted|attachHash|attachSafeNonce|acknowledge)\(/],
    ['an app read of the SDK hold storage', /nana-sdk:/],
  ])('has no %s', (_what, pattern) => {
    expect(offenders(pattern)).toEqual([])
  })

  it('binds the SDK view and recovery in one swappable file only (until SDK 2.40 ships the hooks in core)', () => {
    expect(offenders(/\b(?:createHeldWriteView|followHeldWrite)\b/, ['lib/held-write-react.ts'])).toEqual([])
  })

  it('hands a receipt to the hold in one place only: the engine, which then reads its settlement', () => {
    expect(offenders(/\.onReceipt\(/, ['hooks/useSafeTx.ts'])).toEqual([])
  })

  it('shows the SDK\'s lines, labels and warnings, never an app copy of one', () => {
    const lines = Object.entries(review)
      .filter(([name, value]) => typeof value === 'string' && /^(?:WRITE_HOLD_|WRITE_EXIT_|HELD_|SAVED_ATTEMPT_|SAFE_PROPOSAL_|RELAYR_PAYMENT_RELEASED)/.test(name))
      .map(([, value]) => value as string)
    const labels = [review.checkedItLabel(), review.checkedItLabel('Create again')]
    expect(lines.length).toBeGreaterThan(10)
    const copied = sources.flatMap(({ file, text }) =>
      [...lines, ...labels].filter(line => text.includes(`'${line}'`) || text.includes(`"${line}"`) || text.includes(`\`${line}\``)).map(line => `${file}: ${line}`))
    expect(copied).toEqual([])
  })

  it('catches what it looks for', () => {
    expect(/\b(?:function|const|let)\s+settledLine\b/.test('const settledLine = () => 1')).toBe(true)
    expect(/\.(?:adopt|onUnproven|onExecuted|attachHash|attachSafeNonce|acknowledge)\(/.test('handle.adopt(state, evidence)')).toBe(true)
  })
})
