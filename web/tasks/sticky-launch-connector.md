# Sticky launch final wallet boundaries

## Plan refinement

- **Objective:** Refuse a launch write, funding write or listing signature when the reviewed wallet connector is replaced during an awaited step, even with the same account, chain and wallet type; also refuse a quote that expires/changes during the last journal await and explicitly bind both viem writer requests to their reviewed chain.
- **System fit:** The adapter captures active connector and payment identity before review, then verifies authority and the SDK's current payment deadline immediately before wallet calls. Supported chain objects enter each wallet request explicitly. SDK `beforeSend` continues to own known-unsent reservation cleanup; proof and durable recovery are unchanged.
- **Reuse and simplicity:** Reuse shared `wallet-core.assertReviewedWallet`, SDK `relayrPaymentDetails`, the existing quote-binding validator and `SUPPORTED_CHAINS`; extract the existing synchronous payment-snapshot comparison once and call it during revalidation and final send. Keep product-specific initial validation and reuse the SDK final callback rather than guarding inside the write.
- **Evidence and unknowns:** The connector gap is fixed and its seven fail-before regressions pass. Final review found that payment deadline/snapshot validation still precedes an awaited journal callback, and both raw viem wallet calls omit their explicit chain argument. The installed SDK owns quote deadline interpretation and viem owns its explicit-chain request check.
- **Verification:** Preserve deferred connector regressions; add deferred quote expiry/mutation during the final journal callback and assert no wallet call plus exactly-once unsent cleanup. Assert explicit reviewed chain objects on both writer calls. Run focused adapter tests, types and scoped lint, without another full suite or build.
- **Resource budget:** One adapter/test writer, no dependency changes, builds, full suites or live wallet actions; reuse the existing harness and freeze after the focused gate passes.

## Work

- [x] Capture and recheck the connector at every launch wallet boundary.
- [x] Verify same-kind replacement refusals and preserve existing success/recovery cases.
- [x] Recheck payment identity/deadline at final send and explicitly bind both wallet request chains.
- [x] Verify deferred expiry/mutation and exact-chain regressions, then freeze for production build.

## Review

Seven deferred replacement regressions failed before the change and pass afterward: direct/payment writes in both EOA and Safe modes after journal awaits, and listing authorization across review, wallet acquisition and signature awaits. No wrong wallet write/sign occurs; a replacement during signing prevents publication, and SDK final-send cleanup releases only the unsent reservation once. All 41 adapter tests pass, scoped ESLint passes, and diff whitespace checking passes. The adapter and main hook share the same wallet authority owner; no recovery/session protocol, dependency, build or live-wallet action changed. Source is frozen for parent integration gates.

Final quote/chain review added five fail-before regressions: expiry, quote binding drift and changed payment amount during the deferred journal callback, plus explicit chain arguments for direct and funding writes. The existing synchronous payment comparison was extracted with all original 41 cases green before changing behavior. It now runs in `beforeSend` after the last await, using the same SDK deadline rules and preserving exactly-once unsent cleanup. Both writer calls supply the reviewed chain from the existing supported-chain registry. Final verification: **46 adapter tests**, scoped ESLint, full nonincremental TypeScript and diff whitespace checks pass. No full-suite/build rerun or live action was performed by this owner; the parent resumes production artifact verification from this frozen source.
