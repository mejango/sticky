# Sticky adversarial review — 2026-10-09

Baseline: `74dc08798976f2a78a560ee5b2c2c98656affc4b`, PR #58. This is an independent agent review, not an external audit certification. Prior reports are evidence to challenge rather than findings to inherit.

## Plan refinement

- **Objective:** Review all Sticky custody, share and reward accounting, permissionless source delivery, client authorization and deployment assumptions; establish the concrete readiness and remaining release gates for Ethereum-home Sticky JBX funded by V6 fee project 1 and REV project 3, and test supported generic uses. Complete current documentation and fix demonstrated defects.
- **System fit:** Trace creation and source split configuration through attributed custody, bridge submission/claim, receiver settlement and holder collection or exit. Contracts own accounting; the published SDK owns shared route/identity rules; the web client owns presentation and persisted recovery; deployment manifests own verified identities. Prepare evidence and reviewable fixes only: deployment, launch, source split changes and contract PR merge retain separate authority.
- **Reuse and simplicity:** Reuse existing Foundry, deployment Node, SDK and client tests and canonical V6 interfaces/style. Give independent reviewers disjoint domains; add regressions only for uncovered security properties or demonstrated failures. Keep current operating instructions in their existing owners and label historical evidence instead of duplicating mechanisms.
- **Evidence and unknowns:** Start from the exact baseline and pinned dependencies, with fresh source analysis before consulting historical conclusions. Existing CI passes do not establish live deployment, keeper operation, native finality, route readiness or the unchosen JBP6 allocation. JBX settings are provisional zero stickiness tax, transferable shares and group 0; REV target is about 10% of total issuance.
- **Verification:** Require concrete attack sequences, impacted invariants and executable reproductions for defects; review adversarial coverage, real dependency behavior and fork-harness assumptions. Root serializes all Forge/Slither/RPC runs. Run scoped proofs and relevant full gates after fixes, check all current docs/links/NatSpec and exact-source identities, then publish findings, residual assumptions and launch gates against the reviewed revision.
- **Resource budget:** Parallelize six bounded source reviews, not builds or RPC traffic. Root integrates findings and executes one shared test queue. Reuse successful unchanged baseline gates; repeat only after changes or unresolved concerns. Replan on architecture changes, deployment identity changes or new trust assumptions. No dependency upgrades, new service or on-chain mutation merely to perform the review.

## Checklist

- [x] Independently review backing, pricing, share/tranche accounting and core callbacks.
- [x] Independently review distributor, receiver and automatic compounding/consent.
- [x] Independently review collector and fee-child custody and adversarial callbacks.
- [x] Qualify JBX and generic routes against real dependencies; challenge fork test assumptions.
- [x] Review client/SDK authorization, one-home identity and recovery.
- [x] Review deployment identities, V6 interfaces/style and complete current documentation.
- [ ] Reproduce and resolve findings, add meaningful missing security proofs, and run required gates.
- [ ] Publish exact-revision findings and launch prerequisites in the unmerged PR; update root task tracking.

## Review results

Pending independent review. No deployment, source configuration or merge is authorized by this task.

## Plan refinement

- **Objective:** Resolve independently reproduced manual-bridge mint-readiness, ambiguous-wallet retry, and deployment-provenance gaps; establish the exact impact and repair boundary of Arbitrum-home retryable refunds while completing the original whole-suite audit.
- **System fit:** Mint readiness belongs with the SDK's existing sucker route helpers and all four client consumers. Ambiguous broadcast recovery belongs at the shared wallet boundary, with durable value-movement recovery in callers. Collector source fee ledgers do not own refunds credited on a destination chain; qualify that transport separately and retain a release blocker if it requires upstream capability/deployment.
- **Reuse and simplicity:** Extract the existing collector mint probe before reusing it for manual preparation, reuse existing wallet unknown-submission handling and receipt predicates, and correct owning documentation/NatSpec rather than adding parallel rules. Keep six-suite deployment migration outside this collector-family release.
- **Evidence and unknowns:** Source-first review reproduced a manual prepare despite destination mint rejection, two transfers after a lost first wallet reply, and simulation/failed-receipt acceptance by flat deployment sync. Arbitrum Inbox source credits excess retryable gas to the fee child; a real transport calldata proof is being added. These are separate from Ethereum-home JBX route viability.
- **Verification:** Require regressions before fixes, all affected shared-helper consumers, uncertain-submission versus explicit-rejection cases, real Inbox recipient proof, current manifest acceptance and invalid-manifest rejection. Re-run scoped/full gates after final changes and keep evidence attached to final revisions. Publishing a required SDK patch remains a distinct release step.
- **Resource budget:** Existing six review owners handle disjoint fixes and tests; root keeps one Forge/RPC queue. Do not introduce new cross-chain custody to hide a finding. Report architecture-dependent blockers explicitly rather than claiming full generic readiness or silently dropping accepted support.
