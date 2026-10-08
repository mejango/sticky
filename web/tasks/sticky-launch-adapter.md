# Sticky browser launch adapter

## Plan refinement

- **Objective:** Wire the new Sticky launch controller to reviewed external-wallet writes, exact SDK payment/quote proofs, and Center listing/recovery; restore explicit retry only after every historical and current attempt is proven finalized failed, without replacing a published raw quote or sending live transactions.
- **System fit:** The launch-plan owner prepares and revalidates runtime/token/fee evidence; the controller durably reserves publication and submissions and archives failed attempts; this adapter applies wallet authority and Web Locks, delegates exact receipt proof, and reports progress to the launch UI. Recovery retains ambiguous submissions and published raw calls. The controller rechecks retry histories before later sends and clearing; proof.ts owns canonical finalized receipt evidence.
- **Reuse and simplicity:** Reuse submitReviewedContractWrite, transaction review, wallet-core, safe-connector, SDK Relayr binding/runtime/simulation/payment proofs and the new listing/proof owners. Retry uses SDK requireRelayrPaymentRetry for exact EOA payment histories and atCanonicalFinalizedBlock through the owning proof helper; Safe failures additionally need the existing exact Safe inner execution proof. Own only browser glue and focused adapter tests, leaving form/controller/rendering changes to their assigned owner.
- **Evidence and unknowns:** sticky-launch-session.ts defines typed ports; sibling flows establish review, immutable quote and final account guards. Sticky raw deploy calls have no replay nonce, so an unknown POST cannot be retried. Shared SDK preview 2 supplies final-send guards, full Relayr binding and canonical finalized-block reads. SDK payment retry accepts exact EOA reverts, not Safe wrapper failure; Safe retry must separately prove consumed exact inner failure and finalized inclusion, then fresh unpaid bundle status. Center exposes no atomic cancellation, so sponsor-requested launches cannot self-pay. Historical funding options remain attached to their attempts.
- **Verification:** Exercise call-binding rejection, publication identity preservation, final wallet guards, simulation, rejection versus unknown send, Safe recovery, expired/funded quote refusal, runtime/getCode proof and cross-tab locking. Retry cases cover every attempt, unknown hashes, exact EOA/Safe failure, outer Safe revert, missing finality, reorg, expired/paid/running bundle and retained old options. Run focused Vitest, ESLint, nonincremental TypeScript and combined launch suites after shared interfaces exist.
- **Resource budget:** One writer for this adapter and its test; bounded SDK/sibling reads, no live wallet calls or dependency mutations. Coordinate signature changes before edits; hand off combined browser/release gates to the root owner.

## Work

- [x] Implement browser ports and Web Locks around mutating controller methods.
- [x] Exercise critical review, quote, submission and recovery boundaries.
- [x] Run focused checks and report any integration limitations.
- [x] Implement retry proof adapter and Web Locks wrapper against the coordinated history/proof interfaces.
- [x] Verify finalized retry refusals and re-run combined launch checks.

## Review

The adapter delegates immutable launch construction, fresh runtime evidence, wallet review, payment/quote proofs and canonical deployment proof to their existing owners. Synchronous publication callbacks reserve raw calls immediately before POST, after preflight; unknown POSTs and wallet sends preserve their journals. The SDK final-send guard checks account, view-as, external-wallet status, chain and Safe connection after asynchronous journal writes. Safe proposals are saved separately from execution hashes. Listing signatures always have their own authorization review without rerunning deployment-fee checks on completed-launch recovery. All mutation paths require Web Locks.

Explicit retry checks every archived/current recorded attempt with the proof owner's canonical finalized receipt helper. EOA payments additionally use SDK retry checks grouped by their original funding options; Safe payments require exact consumed inner failure plus unpaid bundle evidence. Recovery candidates cannot substitute for recorded submission hashes. Retirement rechecks historical failures without requiring an expired or already-funded quote to remain unpaid. Safe success also independently binds the exact saved inner call before accepting its execution event. The independent review found no retry semantics blocker.

Verified on the physical shared SDK preview 2: five launch/listing Vitest files pass (93 tests, including 34 browser-adapter tests), full `tsc --noEmit --incremental false --pretty false` passes, focused adapter/test ESLint passes, and `git diff --check` passes. No live wallet requests or external writes were made. Root owns the combined browser/coverage/release gates and publishing the SDK artifact; this record does not claim those gates or release are complete.
