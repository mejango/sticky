# Explicit singleton deployments and failed-root recovery

## Plan refinement

- **Objective:** Move singleton Hook and SourceFeePayer creation into explicit CREATE2 deployment actions, pass them to their parents, and prepare a verified replacement proposal after Sepolia root failure. Preserve permissionless reward delivery and permanently fixed runtime authorization; do not merge or execute without applicable user authority.
- **System fit:** Singleton construction belongs to StickyDeployment; runtime project token/feed creation remains in StickyDeployer. Update predictions, verification, artifacts, client deployment bindings and release documentation together. Failed Sphinx roots require a new root; already deployed verified contracts are reusable.
- **Reuse and simplicity:** Use canonical V6 CREATE2 throughout, as requested. Reuse REVOwner's constructor-pinned setup authority and authenticated one-time binding to break reciprocal address dependencies. Parents retain immutable child references; children permanently lock parent references once and permit no replacement. Verify runtime, setup authority, reciprocal bindings and initialized status before trusting the suite.
- **Evidence and unknowns:** Sepolia root deee0d... failed at leaf1. Glamsterdam activated October6 and EIP8037 adds state gas invisible to gasleft; bare CREATE2 replay does not prove that signed execution gas is insufficient. Prove exact module action with high outer state-gas budget and inspect inner success events. Backend mainnet simulation conflict remains separate. Unbound instances may only be finalized by the reviewed setup authority; conflicting bindings halt release.
- **Verification:** Run STYLE_GUIDE/production lint, constructor and deployment regressions, full relevant Solidity and Node release tests, fresh dry-run of partial-state testnets/mainnets, exact signed module live execution checks and finalized deployment census. Reject unauthorized/repeated/wrong reciprocal binding, immutable mismatches, constructor cycles and incomplete reuse. Prepare proposal only, no on-chain execution or merge.
- **Resource budget:** Use an isolated branch with focused non-overlapping delegates; serialize Foundry release commands. Reuse V6 CREATE2 and one-shot binding patterns and existing fixtures. Live gas proof must understand both execution and state budgets before changing caps; unsupported RPC simulation is a real release blocker.

## Tasks

- [x] Externalize Hook and FeePayer with authenticated one-shot parent bindings.
- [x] Update CREATE2 predictions/deployments and manifests/artifacts.
- [x] Update fixtures, deployment regressions and documentation.
- [x] Reproduce exact signed execution with adequate outer state-gas budget; ship a read-only diagnostic with success-event checks.
- [ ] Confirm Relayr supplies adequate outer state-gas budgets for the new proposal; resolve separate mainnet simulation conflict.
- [ ] Verify partial-state reuse and prepare fresh proposals for review.

## Review

333/333 Solidity tests across 19 suites and 112/112 deployment/artifact/style Node checks pass. Production lint, formatter, diff checks, size checks and changed documentation links pass without warnings/notes. Finalized-fork rehearsals completed for all four testnets and all four mainnets. Independent source/script review found no security blocker; one import-order finding was corrected. External source and core/sucker deployment inputs are unchanged; compiler/artifact identities were refreshed for the intentional constructor changes. Four unchanged singleton implementations retain their prior bytecode/ABI identities.

Finalized live testnet roots: Sepolia previous root is FAILED with leavesExecuted=2/5; the other three are COMPLETED at 5/5. All four have zero active root and nonce14, so no old active root blocks a replacement. The mainnet backend issue remains separate and unresolved. No proposal, transaction, package publication or merge was performed during this revision.

Root resources: /Users/jango/Documents/jb/v6/evm/AGENTS.md, workflow/ponytail/SKILL.md, docs/PLAN_REFINEMENT.md, tasks/lessons.md.
