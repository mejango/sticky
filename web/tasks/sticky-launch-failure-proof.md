# Finalized Sticky launch failure proof

## Plan refinement

- **Objective:** Restore bounded retry after an exact recorded wallet submission is proven to have failed at finality, while keeping unknown hashes, live Safe proposals, and unrelated same-call failures locked.
- **System fit:** The existing launch store owns submission identity; the adapter resolves only that identity; the proof module verifies the exact call, receipt and canonical chain; the controller may then release the recorded attempt. The same proof seam serves deployment and payment calls. Signing, publication and retry authorization remain with their existing owners.
- **Reuse and simplicity:** First extract the current canonical transaction reader without changing success behavior and run its existing tests. Then share that reader in `verifyFinalizedStickyCallFailure`, use SDK `atCanonicalFinalizedBlock`, `safeExecutionRunsCalls` and `readSafeAppExecution`, and wrap it with the existing pure launch validator. Independently bind every Safe success and failure to exact reviewed inner calls, including delayed proposals. Do not duplicate finality or Safe execution logic in the adapter.
- **Evidence and unknowns:** Current proof source and legacy canonical receipt tests establish exact hash/chain/from/index/block inclusion. Only an EOA's exact recorded reverted transaction or an exact proposal's Safe failure under a successful outer receipt can end that submission. The adapter must bind submitted hashes to current records rather than UI recovery candidates; an outer Safe revert cannot consume a proposal.
- **Verification:** Run the existing proof suite after the behavior-preserving extraction; add regressions for finalized EOA failure, exact Safe failure, newer receipt than finalized, changed finalized hash, receipt reorg or change during finality, wrong call/owner/hash, unknown submission, old same-call hash and unresolved/outer-reverted Safe execution. Run scoped lint and TypeScript checks, report unrelated concurrent integration failures separately.
- **Resource budget:** One proof-module writer owns this bounded extraction and API, with adapter and controller integration parallel elsewhere. No external calls, no submissions, no new dependencies. Replan if the SDK cannot bracket the required finality evidence or recorded submission identity cannot be established.

## Checklist

- [x] Extract canonical transaction reading and prove unchanged existing behavior (existing proof suite: 9 passed).
- [x] Add shared finalized failure API and direct launch wrapper.
- [x] Cover identity, finality and Safe failure/recovery boundaries.
- [x] Run scoped verification and hand off the exact APIs.

## Review

The behavior-preserving canonical-reader extraction passed all 9 existing proof tests before failure behavior was added. The final focused proof suite passes 17 tests, including actual SDK Safe call decoding and execution-event parsing, finalized EOA/Safe failures, unknown and unrelated submissions, archived attempt identity, unfinalized receipts, final-head changes and receipt reorgs. Scoped ESLint and the full TypeScript check pass. Shared APIs were handed to the adapter owner; no signing, sending or retry state transitions were added to the proof module.

Standing resources: `/Users/jango/Documents/jb/v6/evm/AGENTS.md`, `workflow/ponytail/SKILL.md`, `workflow/ponytail/README.md`, `docs/PLAN_REFINEMENT.md`, relevant `tasks/lessons.md`, and this checkout's `web/AGENTS.md`.
