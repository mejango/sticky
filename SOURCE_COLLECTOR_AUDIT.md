# Sticky source collector audit — 2026-10-08

> **Historical fixed-route audit; superseded design.** The findings, fingerprints and passing checks below apply to source revision `93f3bef7907e6edb086fb195ed74a81b014a2fb1`, before the [shared omnichain split-hook redesign](tasks/omnichain-split-hook.md). They do not certify the changed collector, fee helper, custody accounting or deployment integration. The [current review report](OMNICHAIN_SPLIT_HOOK_REVIEW.md) records evidence and outstanding gates for the generalized hook. The historical report is preserved in [the audited release tree](https://github.com/mejango/sticky/blob/146a72c4cc372e321929a76c35440c8c14438eb0/SOURCE_COLLECTOR_AUDIT.md). The generalized hook requires its own complete review, tests, deployment and verification; merging its final PR also requires explicit user approval.

**Status: code audit complete; local verification passed.** This is a scoped code, dependency, test and documentation review of the proposed source collector and its fee payer. It is not a third-party certification or evidence of a live deployment. No collector deployment, source split change, wallet signature, transaction broadcast or credential export was performed for this audit.

The independent custody and protocol reviews found no demonstrated Critical, High or Medium vulnerability under the authenticated-route and parent-only split assumptions below. One Low constructor-admission issue has been corrected, independently reviewed and verified by failing-before/passing-after regressions. Style, diagnostic and documentation gaps are recorded separately. Final-source contract, fork, tooling, client and static-analysis results are recorded below. Hosted CI is an additional publication gate; live deployment remains separate.

## Scope and revision identity

| Item | Reviewed identity |
| --- | --- |
| Baseline | `137e60771e5b66925773ca5d0d9b9dd87716d02b` |
| Behavior-preserving extraction | `3bbeefc8a1cd098bc2f42604b55275fcb303be9e` |
| Final audited source revision | `93f3bef7907e6edb086fb195ed74a81b014a2fb1` |
| Final collector source / creation / runtime / ABI hashes | Recorded below; runtime 4,270 bytes, creation 8,356 bytes |
| Final fee-payer source / creation / runtime / ABI hashes | Recorded below; runtime 1,701 bytes, creation 1,896 bytes |
| Live collector addresses | None established by this audit |

SHA-256 fingerprints below use file bytes for source, decoded compiler bytecode bytes for creation/runtime, and compact key-sorted JSON for the ABI. Runtime hashes describe compiler templates before immutable constructor values are patched; they are not live `EXTCODEHASH` values. Creation bytes exclude constructor arguments.

| Contract | Field | SHA-256 |
| --- | --- | --- |
| `StickySourceCollector` | Source | `0fe15e9e3a0fbab12c33c1fd7b0edd3f75a89900c40bc399a8f76f9a23f60b60` |
| `StickySourceCollector` | Creation | `a60ccf2d92315dc52a42a751aaebdd5ed4aee5dcd6555c7a7659d5b843dbbc3c` |
| `StickySourceCollector` | Runtime template | `3b2485ad6e31b1e4b87f86cb0320d621787cf65f771497595dfceea5f3104edc` |
| `StickySourceCollector` | ABI | `65522bbd98eec81882b68cf2884fd281a3889987ba134f0ec7d096f6793b6d53` |
| `StickySourceFeePayer` | Source | `2fc5773d89677e678f24f4f3af7d9f267a57a77004a7d9224c19e676942cdc0a` |
| `StickySourceFeePayer` | Creation | `72bcd51fb999e2064597d6cfbeedbbfadad640679c8e7c7ad49da7eabfc00f3e` |
| `StickySourceFeePayer` | Runtime template | `7a8c9f82e2b621e70ca158cf7e6b64061f1ff21cea953066b7fc95c7e008d023` |
| `StickySourceFeePayer` | ABI | `806aec2ab5110ea7ddb347604a8643f1271968d0c7f7d6927b664ed055a8a07f` |

The collector's new guard and error ABI change its creation/runtime bytecode. Use these artifacts for fresh constructor rehearsal and any address prediction. The fee payer and all six existing singletons retain byte-for-byte identical compiled creation/runtime bytecode and ABI. No existing contract is upgraded.

Primary scope is every declaration and executable block in [StickySourceCollector.sol](src/StickySourceCollector.sol) and [StickySourceFeePayer.sol](src/StickySourceFeePayer.sol), their [local tests](test/StickySourceCollector.t.sol), the six collector lanes in [StickyJbxOmnichain.t.sol](test/fork/StickyJbxOmnichain.t.sol), and their operational/security documentation. The original baseline defined both contracts in the collector file.

The review traced the installed implementations actually used: `@bananapus/suckers-v6` 1.1.2, core revision `feff600654aee6fb1747dded692f18068b2230a6`, distributor revision `44d6d5d2e7cca77422ee0ac4909cf42ccf7839b5`, and OpenZeppelin 5.6.1. Relevant paths include `JBSucker.prepare`, native outbox submission, lifecycle state, retained-fee claims, registry membership, native OP/Base/Arbitrum transport, terminal preview/cashout/fees, controller reserved distribution, project-token binding, and the Revnet registered-sucker cashout path. The [four-chain fixture](test/fork/fixtures/sticky-jbx-sources.json) binds deployed route identities separately from installed package source.

Dependency inspection establishes the collector's assumptions; it is not a full audit of Juicebox, Revnet or the native bridges. The [JBX qualification](tasks/sticky-jbx-qualification.md) retains its earlier deployed-contract lifecycle and route evidence. Historical destination-pocket and source-distributor designs were inspected; this collector adapts permissionless source custody to the current Sticky receiver rather than adding another reward ledger. Final repository verification also includes the complete client check required by the audit instructions.

## Findings

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| SC-01 | Low | Constructor accepts an already irreversibly sending-disabled canonical route | Fixed; three missing-guard failures reproduced before, all 41 final collector cases passed afterward |
| SC-02 | Informational | Two contracts share one file; several NatSpec units and block explanations are incomplete | Corrected; both source-style checks and isolated clean/negative controls passed |
| SC-03 | Informational | Context-free parent errors obscure which input or economic state failed | Fixed; compiled ABI inspected and exact error-payload regressions passed |
| SC-04 | Informational | Administration, journeys, invariants and audit instructions omit source-collector responsibilities | Fixed; integrated document and link checks passed |

### SC-01 — Already retired source route admitted at construction

**Starting state.** A canonical sucker has entered `SENDING_DISABLED` or `DEPRECATED`. Its registry membership and enabled native mapping may remain valid. `JBSuckerRegistry` retains membership for pending-claim authority; time-based deprecation does not have to clear the mapping. Once sending is disabled, the deprecation setter cannot restore availability because it also requires sending to be enabled.

**Sequence and impact.** Deploy the baseline collector against that already retired canonical route, then transfer or distribute reserved tokens to it. Construction can succeed, but every source send fails through canonical `prepare`'s existing sending-state guard. With no withdrawal or route change, the accepted custodian cannot deliver its inventory. This is a Low setup/liveness validation gap: it requires choosing and funding an unusable dependency, not an exploit of correctly operating canonical transport. The baseline already rejects source sends atomically; it does not burn principal into a retired route.

**Narrow repair.** The shared `_requireNativeRoute` rejects `SENDING_DISABLED` and `DEPRECATED`, matching upstream send admission. `ENABLED` and `DEPRECATION_PENDING` remain valid. Construction rejects a knowably unusable route, while the same check in `send()` reports later retirement earlier than canonical preparation would. It adds no administrator, rescue authority or alternate route. The final runtime change has been independently reviewed.

**Regression evidence.** Before the fix, `test_constructorRejectsDeprecatedSucker`, `test_constructorRejectsSendingDisabledSucker` and `test_sendRejectsRetiredSuckerAtomically` all failed with “next call did not revert as expected,” with clean compilation. After the fix, all three passed, alongside constructor acceptance and successful send in `DEPRECATION_PENDING`. The send regression uses a permissive local stub to isolate the collector guard; canonical preparation already rejected a retired send. The final 41-case collector suite passed without failures or skips.

The fix cannot prevent future retirement. Sending stops at `deprecatedAfter - _maxMessagingDelay()`, before full deprecation. A pending route must be drained while sending remains possible, and source authorities must redirect future unlocked splits before the cutoff. Already-held inventory still has no rescue after permanent retirement.

### SC-02 and SC-03 — Source organization and diagnostic completeness

The fee payer was extracted into its matching file without changing execution. Imports were updated; both structural `multi-contract-file` suppressions were removed. NatSpec now states token/native/count units, exact guard intent, constructor trust boundaries, callback custody, fee rounding, forced-donation handling and source submission versus destination finality. Statement narration follows neighboring Sticky contracts and the canonical V6 guide.

The extraction was verified before semantic fixes: compiled creation bytecode, runtime bytecode and ABI matched the baseline exactly for both collector contracts and all six existing singleton contracts (`StickyDeployer`, `StickyHook`, `StickyDistributor`, `StickyRewardReceiver`, `StickyRewardReceiverFactory`, `StickyAutoStick`). All **34 existing collector tests passed** at this behavior-preserving stage. Those results do not qualify later lifecycle or error changes.

Four baseline parent errors lacked relevant context. The revised errors identify the empty token, missing-terminal project and rejected token-count/reclaim quote. Route errors distinguish deployment domain `(chainId, sucker, receiver)`, project/registration `(sucker, projectId)`, token bindings `(sourceToken, feeToken)`, native mapping `(sucker, peerChainId, peer, remoteToken)`, and sending state `(sucker, state)`. They reuse the existing `JBRemoteToken` type, with no generic error-code protocol or extra reads solely for diagnostics. These changes alter error selectors/ABI and are separate from the equivalent extraction. The fingerprints above bind the final compiled ABI; the 41-case collector suite verifies full contextual error payloads.

### SC-04 — Documentation and operational boundaries

The current documents now cover source authority, no recurring Safe custody/signatures, the parent-only split requirement, immutable custody, numbered collector invariants, explicit attack sequences, exact units and fee-delta limitations. [DEPLOYMENT.md](DEPLOYMENT.md#source-collectors) owns the setup and verification recipe; historical qualification records link to it instead of maintaining a second procedure.

That recipe explicitly separates collectors from the singleton `Deploy.s.sol`, `Verify.s.sol` and manifests. It requires the confirmed Ethereum receiver, independent route/runtime authentication, parent/child immutable verification, all current/future split tables, and bounded live delivery receipts. A verified existing Sticky deployment does not establish a collector deployment. The baseline test counts remain attributed to their original revision; source comments describe current behavior without historical audit claims.

## Authority and custody analysis

The intended flow is reserved split → collector parent → fixed native sucker → Ethereum receiver → existing Sticky distributor. The caller separately pays the registry fee through the parent and fee child. Existing source authorities approve initial split setup; no Safe holds these allocated rewards or signs recurring delivery after setup.

| Boundary | Constraint and consequence |
| --- | --- |
| Source principal | Parent captures its actual source-token balance, grants the fixed sucker exactly that allowance, prepares a fixed-receiver leaf, and clears allowance. The caller supplies no amount, asset, route, beneficiary or metadata choice. |
| Caller fee value | Parent and child require the registry's current exact fee in wei. Supported native routes require no additional transport payment. Forced native balances are neither spent nor refunded as caller value. |
| Fee receipts | Only the parent can call the child, and the parent fixes the beneficiary to its current direct caller. The child has no allowance over parent tokens. Its same-call fee-token balance increase returns to that caller; preexisting token donations stay behind. |
| Callback reserves | Reserved distribution during fee payment reaches the parent, not the child. It stays available for a later send even when source principal and fee receipts use the same project-1 token. |
| Refunds | Child rejects preexisting retained credit, claims newly retained credit directly from the sucker to the current caller, and requires no residual credit. The canonical ledger assigns credit to the caller of `toRemote`; an unrelated caller cannot assign credit to this child through that API. |
| Reentrancy | Parent's guard spans approvals, preparation, child submission, receipt transfer, refund callbacks and final inclusion check. The child needs only its immutable parent gate because that parent exposes no unguarded submission path. |
| Outbox | Preparation must append exactly one leaf after the captured frontier; the sent count must exceed its index. Submission may include prior users' leaves without changing their beneficiaries. |
| Failure | Failed preparation, allowance cleanup, transport, receipt transfer, refund or postcondition reverts the complete source call tree. Prior outbox state, principal and caller fee state are restored. |

The positive native minimum uses the current terminal's gross preview with the sucker as holder and beneficiary, less `JBFees.standardFeeAmountFrom(gross)` (`floor(gross / 40)` in the pinned core). The qualified Revnet path recognizes the registered sucker holder and uses local proportional cashout before ordinary buyback/hook branches. This makes the bound conservative for the inspected sources despite caller-sensitive feeless checks. It is a source native-backing minimum, not a funder's market-price floor or a destination-token quote. Zero reclaim rejects before approval or burn.

No demonstrated path let an arbitrary caller divert correctly routed parent principal, seize another caller's refund, change the receiver, or persist a partially failed source send. Front-running a send can deliver funds only to the fixed destination while the front-runner pays the fee and gas; another pending caller may then revert or waste gas. This conclusion assumes the verified canonical dependencies and split configuration, not arbitrary implementations that answer the constructor's getters.

## Adversarial coverage and proof limits

Existing focused cases exercise real ERC-20 transfers, mutable outbox state, native refunds and a complete rollback digest, rather than only matching a revert. Cases cover same-token principal/fee separation, unrelated callers, prior token/native donations, exact and zero registry fees, fresh quotes, malformed leaf counts, missing own-leaf submission, reentry, rejected fee transfers/refunds, retry and preservation of a preexisting Merkle frontier.

The added test work targets the remaining combinations: a bounded three-send fuzz sequence with unrelated callers, project 1 or 3, callback-delivered reserves, prior child donations, forced ETH, successful fees, retained refunds, late failure and retry; precise transfer-from and allowance-clear failures; and constructor/send retirement-state regressions. Independent conservation equations check principal, caller receipts, child donations, native fees, fixed leaf destinations and progress. All 41 cases passed. The new sequence ran 4,096 inputs, each requiring three successful sends and three precise failed attempts before retries; it cannot pass by only reverting.

The local sucker model transfers rather than burns principal and models transport. The six existing canonical fork lanes supply deployed token burn/mint, native escrow, actual messages, destination claim, receiver settlement, vesting/collection and JBX redemption evidence. Forks model consensus-established sender/finality context and Arbitrum's unsupported precompile response. They do not prove a real withdrawal's inclusion/finality, outer Portal/outbox spent-message protection or an operating keeper. All 75 final fork cases passed, including each of the six canonical collector lanes.

## Style and documentation coverage

Every declaration and nontrivial block in both source contracts was reviewed against [STYLE_GUIDE.md](STYLE_GUIDE.md), its pinned canonical V6 guide and neighboring `StickyRewardReceiver`, `StickyRewardReceiverFactory` and `StickyAutoStick` patterns. No source sampling was used for the two audited contracts. The final declaration inventory is 31: two contracts, 15 errors with 29 parameters, one event with six fields, eight immutable properties, two constructors with four parameters, and three explicit functions with two parameters and three named returns.

| Dimension | Manual coverage and executable gate |
| --- | --- |
| File layout and ordering | One contract per matching file; exact pragma/SPDX; named imports; accepted section banners/order; alphabetized members; guide naming. The bounded [source style check](test/deployment/source-contract-style.test.mjs) enumerates both contracts and fails on unsupported declaration forms. |
| Complete NatSpec | Contracts, constructors, errors, event, immutables, functions, parameters and named returns checked individually; units and non-obvious authority/ordering/rounding rationale reviewed manually. The source gate checks notice presence and exact parameter/return tag coverage, not semantic truth. |
| Calls and comments | Multi-argument named calls, camelCase argument keys, single-argument positional calls, current-behavior prose and preserved statement narration reviewed throughout. No speculative interface or new framework added. |
| Errors and suppressions | Explicit custom reverts with relevant context; no swallowed failures. Removed structural exemptions. Remaining narrow lint annotations must retain their behavior-based rationale; final strict build/static analysis is required. |
| Formatting and repository conventions | Pinned Forge formatter controls numeric separators and multiline layout; existing compiler/CI/dependency/remapping conventions remain. Formatting is not a substitute for the semantic review above. |
| Public documents | All collector-related content in README, ARCHITECTURE, ADMINISTRATION, USER_JOURNEYS, INVARIANTS, RISKS, AUDIT_INSTRUCTIONS, DEPLOYMENT, both source/qualification task records and the fork README was reviewed. Relative links/headings and machine-specific paths are checked across the edited documents. |

The style gate is intentionally scoped to these two concrete contracts; it is not a Solidity parser or a certification of every V6 repository. Both contract checks passed. Twelve isolated control cases also behaved correctly: clean files passed and all 11 negative mutations were rejected, covering missing tags, misplaced members, added top-level types, unsupported block-comment/member/function shapes and related parser boundaries. These controls never altered the live source during compilation. Strict builds, formatting and Slither passed alongside this manual review. The final integrated document-link check is recorded below.

## Verification record

Verification used Node 22.23.1, Foundry 1.8.1 (`982849d3140c01fd3b72905759581a132df7aa98`), Solc 0.8.28, Cancun, via-IR, optimizer 200, `bytecode_hash = none`, Slither 0.11.3 and the locked dependency installation. Commands and environment handling are owned by [AUDIT_INSTRUCTIONS.md](AUDIT_INSTRUCTIONS.md) and [test/fork/README.md](test/fork/README.md).

| Check | Evidence / status |
| --- | --- |
| Behavior-preserving extraction | **PASSED:** exact creation/runtime/ABI equivalence for both collector contracts and six existing singleton contracts at `3bbeefc`; 34 collector cases passed |
| Retired-route failing-before reproduction | **PASSED:** three precise missing-guard failures before the repair; all pass after it |
| Final focused collector tests and bounded fuzz sequence | **PASSED:** 41 cases, including 4,096 three-send fuzz inputs; zero failures/skips |
| Full local contract and invariant suites | **PASSED:** 266 cases across 18 suites; seven fuzz functions at 4,096 runs each; six invariant assertions across 1,024 runs / 102,400 handler calls, plus the non-vacuous funding/collection tripwire |
| Full four-chain fork suite | **PASSED:** 75 cases across six suites, including all six OP/Base/Arbitrum project-1/3 collector lanes to Ethereum |
| Deployment/tooling checks, including source-style gate | **PASSED:** 22 deployment Solidity cases repeated by the required command; 48 Node cases including both source-style checks |
| Source-style gate and isolated controls | **PASSED:** two contract checks; one clean control accepted and all 11 negative mutations rejected |
| Complete client check required by audit instructions | **PASSED:** pinned Node 26.7.0/npm 12.0.1; zero production dependency vulnerabilities; lint, types, deployment/schema/transaction inventories, 3,604 tests with coverage, production build, both browser builds and 53 browser cases |
| Whole-tree formatting and whitespace | **PASSED:** pinned `forge fmt --check` and `git diff --check` |
| Strict production lint and runtime sizes | **PASSED:** `--deny notes --sizes`; parent 4,270 bytes, child 1,701 bytes |
| Deployment-entrypoint compilation | **PASSED:** existing deployment scripts compile |
| Slither with repository `--fail-medium` policy | **PASSED:** 130 contracts / 77 detectors, 87 existing Low findings, no collector findings; no High/Medium findings |
| Final existing-suite deployment-bytecode comparison | **PASSED:** all six existing suite contracts retain exact baseline creation/runtime bytecode and ABI; fee payer also remains identical |
| Final source, ABI and artifact fingerprints | **PASSED:** final parent changes are expected; exact fingerprints recorded above |
| Documentation file/heading links and path hygiene | **PASSED:** final independent integration check resolves all 87 relative file/heading links across 12 edited documents, with no machine-specific paths |
| Independent review of the final diff | **PASSED:** separate custody, protocol, test-adequacy and exhaustive style/documentation reviews; final runtime and conservation assertions reviewed |
| Hosted CI and publication | Require successful `forge-test`, `forge-fmt` and `analyze` checks on the published head before merge. Exact run results are attached to the pull request; this local record does not substitute for them. |

## Residual assumptions and deployment limits

- **Authenticate dependencies independently.** Constructor answers come from the supplied sucker and registries; they do not prove canonical identity or native transport family. The receiver is only checked for nonzero value, not authenticated on Ethereum by source-chain code. Bind exact route implementations, peer/core/token identities and the confirmed destination factory/token/group before funding.
- **Preserve parent custody.** Every active/future source split must name the parent. The child returns any fee-token increase during submission, including deliberately timed donations or a misconfigured split. It does not authenticate mint provenance. Correct parent routing is what protects reserved principal.
- **Accept immutable liveness limits.** Neither contract has an owner, pause, rescue, migration or arbitrary call. Future route retirement, incompatible terminal/hook behavior or bridge failure can stop delivery and strand unsubmitted inventory. Unsupported assets and forced ETH are not recoverable. Source authorities can change future unlocked splits, not withdraw the collector balance.
- **Respect inherited capacity.** Upstream leaves use `uint128` token-count/native fields. A captured parent balance beyond the accepted source count cannot be sent partially through this collector. No practical attack reaching that bound for the qualified current sources was established; it remains a dependency capacity ceiling.
- **Retain upstream authority assumptions.** Source project and registry governance, core permissions, sucker trusted forwarding, token behavior and canonical transport remain trusted dependencies. A compromised dependency authority is outside the claim that an unrelated caller cannot redirect funds.
- **Track destination completion.** Source submission is not finality, claim, settlement or collection. Anyone can choose send/settlement timing and thereby affect the reward round. Permissionless execution does not install a keeper. Once submitted, the collector cannot recall a native withdrawal.
- **Keep pool choices explicit.** Sticky JBX's zero cashout tax remains provisional until launch; transfer mode and tax are permanent. Group 0 rewards historical balance without age or continued-ownership requirements. The collector does not change that policy or convert JBP6/REV into JBX.

Complete the linked [live setup and bounded-delivery procedure](DEPLOYMENT.md#source-collectors) after the final code verification. The audit does not create deployment authority or replace confirmed execution receipts.
