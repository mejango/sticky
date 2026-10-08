# Sticky launch completion

## Plan refinement

- **Objective:** Complete the missing Next launch flow: validated form, direct and multichain self-paid launches, Center listing/sponsorship, and durable canonical recovery without duplicate deployment or payment.
- **System fit:** Sticky deployment records and onchain runtime/token reads prepare immutable deploy calls; shared review and wallet guards authorize each signature/send; SDK Relayr/Center primitives authenticate external evidence; the saved launch retains publication, funding and per-chain receipt candidates. The user confirmed nobody uses Sticky yet, so no legacy journal compatibility is needed.
- **Reuse and simplicity:** Reuse SDK ABIs, Relayr binding/payment proofs and Center intent publication; port only Sticky-specific launch form/runtime/receipt rules from the existing legacy controller. Keep React rendering in create components and state transitions in a typed injected controller. Preserve the non-idempotent legacy launch policy rather than copying Safe quote replacement rules.
- **Evidence and unknowns:** Current web has no launch/create/session modules; HomeHero's launch button is disabled. Legacy launch-plan.js, launch-session.js and their tests establish behavior. Current main deployStickyFor has no replay nonce; a POST timeout remains published forever pending receipt recovery. Center configuration and actual hosting remain independently verified by root.
- **Verification:** Add runnable rules, controller and component tests for exact call binding, publication before POST, one payment, rejected/unknown sends, changed account, corrupt storage, canonical DeploySticky/Create receipts, reorg downgrade, listing failure/retry and sponsored recovery; update transaction inventory; run focused Vitest, types/lint and root's final production/browser gates.
- **Resource budget:** Disjoint writers own form/runtime/listing rules, browser adapters, and controller/UI integration. Bound reads per configured chain, avoid live submissions, and reuse existing SDK implementations. Replan on a mismatch between a shared primitive and Sticky's stronger durable-lock semantics. Funding uses shared SDK selection semantics: a sole option may be preselected, followed by explicit review and payment.

## Finalized failure recovery refinement

- Legacy `tx-engine.js` supports a retry only after exact failure and canonical finality. Preserve that supported flow with durable direct/payment attempt histories; no submitted attempt is forgotten when its latest slot is reset.
- An explicit retry releases only the actual recorded known hash (or the execution resolved from its recorded Safe proposal), never a manually entered same-call candidate. Recheck every archived failure before each new send and before retiring the journal. Unknown, pending, unreadable or reorged evidence holds the session.
- The shared SDK owns exact Safe failure, canonical finalized-block bracketing and Relayr payment/bundle proof. A local shared receipt reader binds Sticky's exact raw call, chain, sender, block inclusion and events. Same-quote funding retry proves all historical options failed and Relayr is freshly unpaid/pending; raw deployment quotes are never replaced. A Safe outer revert cannot release a still-executable proposal.
- Self-payment is chosen before requesting sponsorship. A persisted sponsor request has no authoritative atomic cancellation, so it cannot switch to direct/Relayr execution after publication.
- Tests cover known finalized EOA and bound Safe failures, nonfinal/reorged or changed-hash refusals, retained histories across reload, final proof before repeat sends/clear, different funding options and permanent no-republication after raw quote timeout.

## Checklist

- [x] Port pure form rules and verified chain/token preparation.
- [x] Implement typed durable launch lifecycle and exact canonical deployment verification.
- [x] Wire SDK Relayr and Center adapters through reviewed wallet boundaries.
- [x] Add create/recovery UI and integrate HomeLists plus global recovery banner.
- [x] Cover regression cases and register transaction sites.
- [x] Run focused verification and hand off final production/browser checks.

## Review

- Eight targeted launch/listing/proof/controller/adapter/create/host/project-link suites pass: **109 tests** against the reconciled SDK preview. Scoped ESLint and `git diff --check` pass; the adapter/proof owners separately passed full nonincremental TypeScript checking.
- Transaction inventory passes with the new reviewed deployment, funding and listing signature sites registered. The launch helper and failure-proof refinements also pass the workspace plan checker.
- Independent security/acceptance review by `sdk_final_review` found no blocking issue. It checked exact Safe call/event binding, finality, retained attempt history, unknown-hash refusal, unchanged raw quote identity and final guards before writes.
- Preparation and receipt tests cover chain/runtime/token/fee drift, original calls, canonical block inclusion, ambiguous/malformed event bytes, Safe calls, forwarder decoding and reorg downgrade. Controller tests cover storage failure, all publication boundaries, Safe proposal persistence, user rejection versus unknown submission, listing retry, sponsor timeout and every retained failed attempt.
- UI tests cover the lazy-host first click, saved recovery before create, corrupt storage, visible-only polling, explicit sponsorship/self-payment choice and a separate review after failure recovery. Protocol documentation review corrected the form copy: launch granters permanently authorize staking for others; bonus economics depend on the fraction of supply unstuck.
- The parent Sticky integration owner owns final production build/browser/visual gates and cutover. No live wallet transaction or deployment was sent; no legacy journal compatibility was added, as the user explicitly confirmed there are no existing Sticky users.
