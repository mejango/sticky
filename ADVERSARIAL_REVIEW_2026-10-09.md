# Sticky adversarial review — 2026-10-09

## Status and scope

Review baseline: `74dc08798976f2a78a560ee5b2c2c98656affc4b`, draft [PR #58](https://github.com/mejango/sticky/pull/58). Six independent source-first review domains covered all Sticky runtime contracts, their pinned core/distributor/sucker dependencies, deployment tooling, the web client and SDK, and operating documentation. Reviewers sought executable counterexamples before consulting earlier conclusions. This is an independent agent review, not an external human audit or certification.

The primary use case is Ethereum-home Sticky JBX: canonical JBX backing, provisional zero cash-out tax, transferable shares, group 0 without age weighting, and V6 project 1 (JBP6) and project 3 (REV) reserved rewards from Ethereum, OP, Base and Arbitrum. Generic projects, tenure groups, tax/transfer settings, decimals, source credits, replacement routes and non-Ethereum homes were also examined.

**Review and remediation are in progress.** The ledger below distinguishes reproduced findings from verification still queued. No deployment, launch, split configuration, package publication or contract PR merge is implied by this review.

## Finding ledger

| ID | Severity | Finding | Status / JBX relevance |
| --- | --- | --- | --- |
| A-01 | Medium | Native Ethereum-to-Arbitrum collector submissions assign asynchronous gas refunds to the fee child | Open upstream transport requirement; does not affect the selected L2-to-Ethereum JBX lanes |
| A-02 | Medium | Manual bridge preparation does not require current destination mint authority | Shared SDK fix verified; four-client final qualification underway; relevant to manual JBX reward delivery |
| A-03 | Medium | An ambiguous ordinary wallet response can permit a duplicate value transfer | Reproduced; durable shared submission recovery underway; relevant to holder operations |
| A-04 | Medium | Safe timeout and unauthenticated expiry inference can release duplicate guards without execution evidence | Shared Safe watcher fixed and verified; consumer release pending |
| A-05 | Low | Canonical deployment sync accepts simulation manifests and incomplete/failed deployment receipts | Fixed locally with failing-before/passing-after regressions; trusted repository input boundary |
| A-06 | Low | Historical setup and accounting documentation overstates or misdescribes current behavior | Corrections prepared; includes unsafe obsolete plain-beneficiary collector instructions |

No supported-underlying principal-loss, share-inflation, cross-bucket theft or blocked-holder-exit exploit was identified in the source review. That statement is bounded by the dependencies and evidence below; it does not close the findings in this ledger.

### A-01 — destination transport refunds

`StickySourceFeePayer.send` calls the selected sucker as the fee child. The pinned `JBArbitrumSucker` passes `_msgSender()` as the native retryable's `excessFeeRefundAddress` and the ERC-20 gateway's custom refund recipient. Nitro preserves this address on Arbitrum. Excess budget or unused execution gas therefore arrives at the child address on the destination chain, after the source transaction has completed.

Both source retained-credit ledgers can correctly be zero while this refund exists. The child has no withdrawal operation and forwards only each new call's `msg.value`; its home-chain collector cannot initiate a remote send. This affects the caller's transport budget, not the leaf's reward principal. Exact fee estimates do not eliminate refunds from unused execution gas.

The shared SDK route verifier now rejects native Ethereum-to-Arbitrum collector preparation, and fails closed on unknown transport. This mitigates first-party client selection; it does not change permissionless contract entrypoints or repair the upstream transport.

The installed `toRemote(address)` API cannot accept the original caller as an asynchronous refund beneficiary. Correct use of this native transport needs that attribution through the upstream sucker/transport API and a deployed, qualified replacement route. Existing registered CCIP routes are a separate alternative: installed CCIP code pays the router its quoted fee and returns excess budget synchronously through the source refund ledger. They require their own route qualification and positive native transport budget; a zero transport payment selects unsupported LINK payment. A source-only receive/rescue method would neither recover destination funds nor distinguish their owners. **Do not qualify the native Ethereum-to-Arbitrum collector route for live use until this is resolved.** Other transports require separate qualification; the finding is not a claim that every route to Arbitrum has the same refund behavior. Configurable home-chain identity alone is not transport qualification.

Proofs: `test/audit/SourceFeeArbitrumRefund.t.sol` exercises actual inherited native/ERC-20 transport encoding and the child's handling of existing native balances. `test_adversarialEthereumToArbitrum_retryableRefundUsesFeeChild` in the fork suite captures the real deployed Inbox payload and source ledgers. The native fork proof does not execute ArbOS refunds or establish finality. The separate `test_adversarialEthereumToArbitrum_ccipReturnsSourceTransportRefund` passes against the existing REV CCIP lane: it recreates the committed singleton creation code/arguments to authenticate its complete patched runtime, verifies the registered clone, and uses actual reserves, native wrapping and the deployed router. It proves one exact-fee source submission, source retained-refund attribution and return of the excess budget to the original caller. It does not prove CCIP destination delivery, finality or an Arbitrum Sticky pool.

### A-02 — destination mint readiness

The manual bridge path checks registered reciprocal peers and accounting contexts but can prepare a burn/leaf even when the destination controller already rejects that peer's `mintTokensOf`. Actual destination claims require this mint. Registration alone does not establish current authority; recovery can depend on a source-project authority restoring configuration.

The collector SDK already contained a read-only mint probe. Review of the new native-route mitigation also caught an existing classifier limitation: canonical Arbitrum L2 suckers use a zero L1 Inbox binding. L2 identification must use its actual layer and nonzero gateway rather than incorrectly requiring an L1 Inbox; faithful fixtures and live probes are separate verification gates. Remediation extracts that rule into the SDK's sucker owner, then reuses it with the exact recipient and token amount at manual preparation and the existing reviewed-write revalidation boundary in Sticky, Homerun, Revnet Money and Juicebox Money. A read-only simulation proves present authority, not that authority will remain unchanged during bridge finality.

### A-03 and A-04 — uncertain submissions

The ordinary-write reproduction broadcasts the reviewed five-token transfer, loses the wallet response, then exercises Retry: a second nonce transfers another five tokens. Returning an error with no hash does not establish non-submission. Existing durable launch/bridge journals avoid that sequence; ordinary writes need the same fail-closed boundary across reset, remount and reload.

The separate Safe reproduction advances the Safe's nonce after execution while its service still reports `isExecuted = false`. The prior timeout path labels the proposal replaced without proving which transaction consumed that nonce. Allowing resubmission at that point can repeat a completed operation. Separately, selector-shaped deadline calldata did not establish an enforcing contract: a value transfer to an EOA could be labeled expired from router-shaped calldata while remaining executable. Expiry now needs a canonical, chain-specific enforcing target and numbered-block evidence.

Remediation must preserve uncertain writes durably, recover known hashes/receipts, release only on explicit rejection or canonical terminal evidence, and never infer non-execution from time, missing indexer data or a higher nonce alone. Existing domain journals remain authoritative rather than receiving a second competing lock. These guards operate within the browser origin and saved storage: clearing storage or submitting through another wallet/client is outside their duplicate-prevention boundary. Further adversarial review exercises cross-tab attempt identity, stale asynchronous receipt effects, known hashes that fail persistence, queued Safe call adoption, and historical receipts that must not release a different unknown attempt. New domain attempts carry unique identities, and recovery compares the saved attempt again after asynchronous proof checks.

### A-05 and A-06 — provenance and documentation

The canonical six-suite sync path accepted `kind = simulation` and a receipt with failed status, zero block and no transaction/block hashes. The collector sync path was stricter but relied on canonical source/home configuration. The fix reuses one receipt predicate and requires verified manifests and successful, nonzero, identified receipts. This hardens trusted build inputs; it does not turn local artifacts into independent RPC proof.

Documentation corrections identify historical fixed-route instructions, source-only refund coverage, same-week tranche merging, controller catch-and-burn semantics, receiver implementation parity and the actual forwarder requirement. The same-deployer check against nested Sticky shares is now described accurately: a different factory can wrap transferable shares, leaving their original reward weight in terminal custody. A new regression demonstrates both that reward-weight limitation and recoverable nested principal. JBX itself is not a Sticky share token.

## JBX economics and operational boundaries

- Group 0 is a balance snapshot allocation, not continuous staking remuneration. With unset current/next snapshots, an actor can hold transferable shares across one block, call `poke()`, return them and keep both rounds' proportional rewards. The new proof captures 90% of two pots while having zero tenure entitlement. No redemption tax applies to simply returning transferred shares. The user's no-age preference remains provisional; this consequence must be accepted before launch.
- Receiver arrival does not fix the reward round or recipients. Permissionless settlement can occur after a boundary and benefit a later owner. The new proof makes this explicit.
- A `263157895 / 1e9` reserved split at 38% reserves yields approximately 10% of issuance that participates in reserve accounting. Automatic issuance and bridge remints bypass those reserves. This does not by itself establish a literal 10% of every gross mint or total existing supply. Recheck all applicable current/future stage tables and define the allocation base before execution; the JBP6 allocation is still unchosen.
- JBP6/REV rewards remain JBP6/REV. AutoStick only compounds rewards denominated in the pool's underlying token; it does not exchange those rewards for JBX.
- Permissionless delivery removes recurring Safe custody. It does not install a keeper, supply its fee budget, finalize withdrawals, or guarantee timely settlement. Source authorities must still authorize the initial split configuration.

## Evidence and limits

Pinned review dependencies: core `feff600654aee6fb1747dded692f18068b2230a6`, distributor `44d6d5d2e7cca77422ee0ac4909cf42ccf7839b5`, suckers 1.1.2, OpenZeppelin 5.6.1; Foundry 1.8.1, Solidity 0.8.28, Cancun, viaIR, optimizer 200. The published SDK baseline is core 2.26.0.

At the exact published baseline, all six hosted PR checks passed: formatting, Solidity/forks/deployment checks, Slither, web unit/build, browser and OCI smoke. Those are baseline results, not evidence for later edits.

Fresh review evidence is indexed by [the verification manifest](tasks/adversarial-verification-20261009.json):

- Existing six distributor/hook accounting invariants pass 2,048 runs at depth 200: **409,600 generated actions**, seed `0x20261009`. Handler reverts are counted; independent ghost mismatches are recorded outside discarded actions. The deterministic non-vacuity test also passes.
- Independent integer arithmetic cross-check: 221,987 cases across decimals 0–36. This checks pricing inequalities, not EVM behavior.
- New collector mixed-sequence campaign covers attributed ERC-20/credit receipts, nested receipt and delivery callbacks, donations, multiple projects/pools/groups, partial sends/settlement and failed-delivery rollback. All 4,096 runs pass, with 24 actions per run.
- Complete local Solidity gate: **296 tests across 19 suites**, zero failures/skips. This includes the new economic, vesting, cross-factory and local Arbitrum transport proofs.
- Formatting, strict runtime build/sizes, deployment entrypoint compilation and Slither pass. Static analysis examines 134 contracts with 77 detectors and the same 87 Low results, with no Medium/High result; it did not discover the cross-chain refund issue.
- Complete archive-fork gate: **86 tests across seven suites**, zero failures/skips. The real Ethereum Inbox proof confirms the asynchronous refund recipient and positive excess budget; the CCIP proof confirms its distinct source refund behavior.
- Deployment/style/tooling: **69 Node checks pass**, including all six singleton creation/runtime/normalized-ABI checks. [Current equivalence evidence](tasks/adversarial-equivalence-20261009.json) binds all 34 source/script files, verifies ten comment-only changes, and proves unchanged collector creation code, constructor init code and prepared deployment calldata. Original rehearsal evidence remains historical.
- [Fresh four-chain state census](tasks/adversarial-live-state-20261009.json): core runtime identities, token identities and previously pinned native routes remain unchanged at recorded finalized blocks; reviewed routes remain enabled without an emergency mapping. Reserved tables still point to the existing custodians, with 62% JBP6 and 38% REV reserves. Additional registered routes exist but are not qualified by this census. It does not replace mint-authority, split-authorization or future-stage checks.
- Shared SDK remediation at `a4022589502dada1507c1b40be7e9c13308bc630`: 2,274 core, 153 React and 35 connect tests pass; core line/branch coverage is 98.38%/96.35%, with strict Sticky, Safe service and reviewed-write owner gates at 100%. Types, builds, protocol comparisons, packaging, dependency audit and examples pass. A fresh locked `npm ci`, forced full `npm run check` without Turbo cache hits and production dependency audit also pass; all 769 compiled package files match the immutable preview. All four client gates are tracked separately before final qualification. The requested changeset is core 2.27.0; existing peer-dependency release policy derives React 41.0.0 without React implementation changes. Nothing has been published.
- [Live SDK transport probes](tasks/adversarial-sdk-transport-probes-20261009.json) pass all 36 registered routes: 12 native and 24 CCIP, including all six JBP6/REV native L2-to-Ethereum lanes. Reads use the census finalized blocks and recheck their canonical hashes. The qualified preview's classifier bytes match the probe artifact exactly. Positive classification is not implementation authentication or end-to-end delivery qualification.
- Deployment sync: 42 existing cases pass after behavior-preserving receipt-helper extraction; nine added cases fail before the stricter guard and all 52 pass afterward (including an additional missing-receipt case). All 24 Solidity source files were inventoried against canonical V6 NatSpec/style rules; the [documentation review](tasks/deployment-doc-review-20261009.md) records all 403 declarations and the current/historical document owners. Existing eight-chain generated configuration is unchanged.

The JBX fork suites use real JBX inventory, source payments/reserves, burns/outboxes, deployed bridge escrow, destination controller minting, receiver settlement, vesting, collection and redemption. Only canonical finality/sender context and the unsupported ArbSys response are modeled. This does not establish portal/outbox proof inclusion, their outer replay protection, elapsed finality or a production executor. Historical runtime hashes do not alone establish installed-source equivalence; refreshed live configuration is separate evidence.

The current census also identifies 24 additional directed CCIP routes by matching their clone runtimes to committed singleton addresses, including direct L2 pairs. The separate REV Ethereum-to-Arbitrum source proof authenticates its singleton against committed creation code and exercises that router/token lane. The census alone does not establish singleton/library source equality, live router/token lanes or end-to-end delivery for the other pairs.

Generic source-credit forks establish delayed token conversion and local settlement; generic ERC-20 transport cases establish source submission. Neither should be advertised as every-token, every-direction end-to-end qualification. Native L2-to-L2 delivery is not implicit.

## Release gates

Before substantial JBX use, close client/SDK remediation and release checks; confirm final immutable JBX settings and allocation policy; deploy and verify the approved collector family; create and verify the actual pool; qualify each live source/destination lane and reward ERC-20; authorize applicable current/future splits; and obtain complete small-value source-to-holder receipts through actual finalization with an identified operator/monitoring arrangement. Update the generated client registry only from verified deployment receipts.

The native Arbitrum-home refund finding is a separate generic-lane blocker and remains open even if Ethereum-home JBX qualifies. Contract PR #58 remains unmerged. Deployment, source configuration, package publication and final contract merge require their applicable separate authority.
