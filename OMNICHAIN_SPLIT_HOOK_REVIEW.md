# Omnichain reserved-token split hook review

Status: implementation review in progress on `codex/sticky-omnichain-split-hook-20261008`. This is an internal source/test review, not a claim of deployment, independent human certification or bridge finality. The contract PR must remain unmerged until deployment and verification are complete and Jango explicitly approves the final PR.

## Scope and outcome

`StickySourceCollector` and `StickySourceFeePayer` replace the undeployed fixed-project/fixed-route proposal with one shared reserved-token split hook. The reviewed split encoding is:

```text
hook        = shared collector address
beneficiary = Ethereum Sticky share-token address
projectId   = destination reward group (0 for the default group)
```

The controller context identifies the source project. The hook accepts attributed reserves without attempting settlement or bridging. Any caller can later deliver a positive part of one bucket to its fixed Ethereum receiver. Remote delivery can select any usable canonical registered Ethereum sucker and mapped backing asset; the caller cannot change the destination. Ethereum uses the same split configuration and local settlement. Source credits can wait for ERC-20 deployment and then be materialized for delivery.

The existing receiver factory owns destination prediction and validation. Existing receivers and the distributor own settlement, reward rounds, vesting and collection. The six existing Sticky singletons retain exact creation/runtime bytecode and ABI; no other production source changes. There is no new administrator, destination rewrite, principal withdrawal or recurring Safe custody step.

[Architecture](ARCHITECTURE.md), [invariants](INVARIANTS.md), [risks](RISKS.md), [deployment procedure](DEPLOYMENT.md#source-collectors), and the [checked plan](tasks/omnichain-split-hook.md) own the operative descriptions. The [fixed-route audit](SOURCE_COLLECTOR_AUDIT.md) remains historical evidence and does not qualify this implementation.

## Method and trust boundaries

Reviewed against pinned core `feff600654aee6fb1747dded692f18068b2230a6`, distributor `44d6d5d2e7cca77422ee0ac4909cf42ccf7839b5`, suckers1.1.2, OpenZeppelin5.6.1 and Foundry1.8.1 / Solidity0.8.28 / Cancun / viaIR / optimizer200. Independent agents separately reviewed custody, protocol interaction, deployment identity and documentation; root reviewed the full implementation and executed verification serially.

The review traced actual core controller catch-and-burn behavior, credit transfers before hooks, current-controller authentication, total token-plus-credit custody, holder-authorized credit claims, reserve callbacks during fee payment, sucker preparation/submission, terminal previews, both retained refund ledgers, receiver prediction/settlement and deterministic deployment verification. Tests use real balances, allowances and supply for adversarial local cases and actual pinned core/bridge code for fork cases.

Trust remains in canonical dependency identity, registry governance and approved sucker builders, source-project peer configuration, compatible project-token behavior, the backing asset/terminal and underlying bridge. Source acceptance cannot verify remote Ethereum token deployment. The destination reward ERC-20 must exist before a remote claim; the unchanged receiver cannot materialize credits minted directly to it. A positive registry fee requires its fee project's ERC-20; zero-fee submission does not. CCIP LINK payment is not provided.

## Design issues resolved before release

- **Receipt versus delivery:** Core catches reserved hook failures and burns unconsumed ERC-20 allocations. Acceptance therefore performs no transport, fee payment, cashout quote or receiver settlement. Temporary delivery failure restores the selected queue and source custody.
- **Nested valid allocations:** A blanket inbound reentrancy rejection could make another project's valid allocation burn during a token callback. Valid nested callbacks remain accepted. A transient depth blocks outbound mutation during receipt measurement. Combined custody growth less nested aggregate-liability growth attributes each receipt exactly once.
- **Cached credit contexts:** Core can cache a zero token before an earlier split deploys the ERC-20. Authenticated zero-token contexts remain valid and are booked only when combined custody covers aggregate liabilities. Delivery converts only the ERC-20 shortfall through the current controller.
- **Retired routes and capacity:** A bucket is bound to its destination rather than one sucker. A caller can choose a replacement registered sending-enabled route and a partial amount. State, canonical bindings and enabled nonemergency mapping are checked before spending.
- **Generic backing and fees:** The selected backing asset owns quote units. A zero quote remains valid because the sucker remints the leaf's project-token count. The fee child isolates the caller's token receipt from all parent reserves and atomically returns fresh registry and transport refunds. Neither ledger may contain prior credit or retain a remainder.
- **Source identity:** Shared initcode/arguments/salt are integrated into the existing deployment helper and immutable verification. Parent and constructor-created child are required in new complete manifests; old six-contract records are not silently treated as evidence of the new hook.

No demonstrated unresolved blocker was found in the reviewed production source under these dependency assumptions. Verification is still required for the exact final revision and actual deployment.

## Verification evidence

- Four-chain fork suite: **80/80 pass**, including six actual JBP6/REV reserved-hook lanes through modeled native transport, destination claims, settlement and holder collection; Ethereum local settlement; four-chain hook/fee-child address and runtime parity; generic project IDs beyond1/3; positive USDC.e and zero-backed source sends; real source credits followed by ERC-20 deployment and partial/full settlement.
- Deployment Solidity suite: **26/26 pass**, including repeat/partial deployment, prior singleton preservation, wrong core/registry/runtime/immutable rejection and complete manifest contents.
- Node tooling: **53/53 pass in the final complete run**, including declaration/NatSpec negative mutations, manifest gates and the loopback-server case that had needed a sandbox permission retry. The same final deployment command also passes all 26 Solidity deployment cases.
- Formatting, strict production build/sizes and deployment-entrypoint compilation: pass. Final machine comparison confirms that all six existing creation/runtime bytecodes and ABI exactly match the pre-audit baseline; both new contracts match their pre-final-style snapshots. Collector runtime/init-code sizes are **8,484/11,273 bytes**; the fee child's are **2,120/2,164 bytes**.
- Slither0.11.3: **131 contracts / 77 detectors / 87 existing Low findings**, no collector findings and no medium/high findings; `--fail-medium` passes.
- Complete local Solidity run: **279 tests across 18 suites pass**, with no failures or skips, including the deployment suite counted above. The collector's **50/50** include both custody fuzz tests at **4,096 runs each**, the corrected getter-order test and both custody-loss regressions.
- Nested-acceptance negative mutation: temporarily rejecting nested callbacks made both `testFuzz_nestedAcceptanceConserves` and `test_acceptanceNestedCrossProjectDoesNotBurnReserves` fail at their conservation/reserve-preservation assertions. The original source was restored before the complete passing local run. This demonstrates that the tests detect the rejected nested-allocation design.
- Existing client evidence is reusable because its source/configuration is unchanged and existing runtime bytecodes are identical: the preceding complete client check passed3,604 unit tests,53 browser cases and all builds/inventories. No new client behavior is claimed.
- Refund-interface reads: **24/24 pass** against the six deployed OP/Base/Arbitrum source routes at pinned and current state. These are read-only interface observations, not transport execution.

The fork harness models canonical native proving/finalization and message delivery; it does not establish consensus, elapsed withdrawal periods or a production relayer. The positive USDC.e case proves source-side actual terminal cashout, bridge burn/message and outbox accounting; it does not claim L1 ERC-20 finalization. Generic routes and caller-sensitive custom cashout hooks require their own setup/compatibility qualification.

## Release evidence

Deployment rehearsals, recorded final bytecode fingerprints, proposed addresses and GitHub checks are pending. No shared collector deployment, split edit, signature or onchain broadcast has occurred. Review approval of a deployment is separate from explicit approval to merge the final contract PR. Authorized deployment and post-execution verification must finish before explicit final merge approval. The recovery of the prematurely merged audit is available as unmerged draft [PR57](https://github.com/mejango/sticky/pull/57); this report does not authorize that merge either.
