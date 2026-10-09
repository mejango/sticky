# Deployment provenance and documentation review — 2026-10-09

> **Historical revision-bound record.** The later fixed project-1 raw-fee contribution changes the collector and fee-payer runtime and supersedes this record's asynchronous-refund conclusion. Preserve the evidence below for its reviewed revision; use the [current adversarial report](../ADVERSARIAL_REVIEW_2026-10-09.md), [operative hook plan](omnichain-split-hook.md) and [deployment procedure](../DEPLOYMENT.md) for current status.

This work supplements [the adversarial review](adversarial-review-20261009.md). No deployment, source split change or merge is authorized.

## Plan refinement

- **Objective:** Correct current operating instructions and prevent simulation or failed/incomplete deployment receipts from entering the client's canonical deployment registry.
- **System fit:** The deployment helpers own live verification, committed artifacts carry its evidence, and `web/scripts/sync-deployments.mjs` admits those records to client configuration. Preserve the existing six deployed identities and empty collector configuration; documentation must distinguish current setup from historical qualification.
- **Reuse and simplicity:** Extract the collector's existing receipt-shape check without changing accepted behavior, then apply it to flat singleton records alongside an explicit `kind: verified` requirement. Reuse the existing sync tests and document the separate stale-flat-manifest limitation before choosing any writer change.
- **Evidence and unknowns:** A Node reproduction accepted `kind: simulation` with a failed zero-block receipt and no transaction/block hashes. These are trusted repository inputs, so this is a publication provenance guard, not proof of an external exploit. All current committed records must pass unchanged.
- **Verification:** First run a behavior-preserving extraction against the existing sync suite, demonstrate failure-before regressions for simulation, missing/failed receipts and zero/missing hashes, then run the focused sync suite, script lint, registry check and documentation-link check. Root retains the Forge/Slither/RPC/build queue.
- **Resource budget:** One shared receipt helper, one existing test file and minimal owning-document edits. No new dependency, live service query or contract change. Replan before changing the canonical manifest writer or expanding release behavior.

## Checklist

- [x] Verify existing receipt records and extract the current collector receipt predicate without behavior change.
- [x] Add failing regressions, reject invalid flat evidence and rerun focused checks.
- [x] Correct current docs, label historical evidence and verify local links.
- [x] Return findings, trust assumptions and remaining launch gates to the main review.

## Review results

The flat registry accepted a manifest labeled `simulation` with a failed zero-block receipt and no transaction/block hashes. This is a Low publication-provenance defect at a trusted repository-input boundary. It is fixed by requiring `kind: verified`, a successful receipt, nonzero block and valid nonzero transaction/block hashes. The collector and flat paths reuse the same receipt predicate. No configured address or scan block changed.

Validation: all eight committed singleton records satisfy the stronger gate. The behavior-preserving extraction passed 42/42 existing sync tests; nine new regression cases failed before the guard and passed after it. The final focused suite passes 52/52, including a missing-receipt case. Scoped ESLint, the unchanged generated deployment-registry check, transaction inventory and whitespace checks pass. A local Markdown scan found no missing relative targets across 48 documents, excluding fenced historical code examples, after adding the adversarial report and Daybreak packet. Historical test links were repaired against a Git revision that contains those files.

Source comments were corrected without changing declarations or executable code: weekly tranche merging/latest timestamps, split-hook catch-and-burn, shrinking tenure buckets, the ERC-20-only inbound funding guard, gross receiver settlement amounts, and source-chain-only retained refund guarantees. All ten edited source files matched HEAD after stripping comments; the bounded source-style gate passed 6/6. Root owns formatting, full compilation and the six-singleton bytecode/ABI gate.

A separate full-source inventory used existing compiler ASTs, without a new build, across all 24 `src/` files: 20 contract/interface/library declarations, 82 errors, 68 state variables, 210 functions, 18 events, three structs, one enum and one modifier. Named parameters/returns, mapping keys, struct fields and declaration notices were documented; four overrides use inherited documentation for intentionally unused arguments. `delegateBySig` leaves five unused inputs unnamed and identifies nonce, expiry and signature components together in `@dev`; the review preserves that convention rather than adding no-op code to silence unused-argument warnings. The canonical V6 guide explicitly requires `@notice` for errors and illustrates an error argument without `@param`, so their lack of argument tags is not a canonical-style violation. Receiver/factory/collector/fee-payer interfaces cover their complete public function/event surfaces; `IStickyToken` owns the token's extra bindings, and the price feed intentionally uses `IJBPriceFeed`. The temporary inventory file was not retained in the repository; the counts and conclusions above are the durable review record.

### Documentation inventory

| Owning surface | Review and corrections |
| --- | --- |
| `README.md`, `ARCHITECTURE.md`, `USER_JOURNEYS.md` | Current pool identity, custody/accounting, weekly tranches, user actions, verified receiver bindings and direct-route limitations; corrected independent-deposit timestamp claims. |
| `ADMINISTRATION.md`, `RISKS.md`, `INVARIANTS.md` | Permanent authority, canonical dependencies, source receipt/finality/recovery states and limitations; added incident-response actions, corrected cross-factory nested-token scope and asynchronous-refund boundaries. |
| `DEPLOYMENT.md`, `web/README.md` | Required forwarder, family identity, trusted artifacts, explicit release/merge authority, exact verification and registry publication; stated empty collector configuration and the canonical-manifest limitation below. REV's reserve-bearing issuance base is explicit. |
| `AUDIT_INSTRUCTIONS.md`, `STYLE_GUIDE.md`, canonical V6 guide | Review scope and requested evidence/style checked against helpers, interfaces and workflow gates; no change to authority or verification commands. |
| `test/fork/README.md`, `web/test/TRANSACTION_COVERAGE.md`, `web/COPIED.md` | Fork consensus-model boundaries, action inventory and shared ownership; updated current SDK version and clarified the retained multichain action label describes blocked Sticky plans. |
| `AUDIT_REPORT.md`, `DEPLOYMENT-READINESS.md`, `AUDIT_REMEDIATION.md`, `SOURCE_COLLECTOR_AUDIT.md`, `OMNICHAIN_SPLIT_HOOK_REVIEW.md`, JBX qualification | Historical evidence retained and distinguished from current release verification. Added explicit historical banners to September records and the fixed-route JBX record; removed obsolete setup instructions in favor of current attributed collector operations. The main review owns new findings/evidence. |
| Accepted home-chain/hook plans and dated specs/port plans | Classified implementation ownership versus historical proposals; repaired the superseded distributor plan's owning-design link. Historical pass counts, pins and experimental designs are not promoted to current release evidence. |

### Remaining boundaries

- The deployment reader authenticates the canonical CREATE2 factory and complete Sticky executable runtimes/immutable occurrences. Core and sucker artifact addresses remain trust inputs: code existence and matching cross-bindings are not independent authentication of an upstream release. Operator review must establish those release identities and receiver-factory parity.
- Family manifest chain/destination/kind/address checks do not establish revision freshness. The documented operator gate must match the recorded revision to the reviewed checkout; the artifact reader still accepts stale or unrecorded revision text. Local receipt validation does not independently prove canonical finality.
- Current publication deliberately preserves flat six-singleton manifests. A future change to those identities needs a reviewed canonical-manifest migration writer; updating a deployer artifact alone makes sync fail against the preserved manifest. This collector-family release retains all six identities, so that future-release limitation is not a current deployment blocker.
- The native Ethereum-to-Arbitrum collector lane is unqualified because its asynchronous retryable excess-fee refund targets the fee child's destination-chain address without recovery. Root owns the Medium finding and transport proof. Ethereum-home JBX inbound delivery does not use that direction.
- JBX launch identity/settings, selected JBP6 allocation, treatment of REV issuance bypassing reserves, executed collector identities/source splits, complete lane receipts and monitoring ownership remain live-launch gates. No deployed family or keeper is established by this review.
