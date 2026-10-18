# Sticky production release, 2026-10-18

Contract source: `2f8ddf7bc97fdcb02611b57b388090e36aa1ceee`. This release publishes verified deployment records and updates their existing client importer. It does not change deployed Solidity or configure a particular pool.

Production proposal: https://sphinx.ba5ed.com/deployments/bc32dcfc-af0c-44c2-912b-2af845391700

Executed root: `0x0c5b538581b9f1ebe45c4318e4d248d7f54052501d4f19c5615484c171b19472`.

Relayr bundle: `83e61930-dab1-4e0c-9c4f-529902016eb9`.

All four production roots completed 20/20 leaves with 19 action successes and 20 canonical successful transaction receipts each, no failure/cancellation events, nonce 6 and no active root. Canonical `Verify.s.sol` checked all 14 contracts and four source/home families on each chain at finalized state, including every runtime immutable occurrence, CREATE2 identities, dependencies and permanent reciprocal bindings. Each pinned header hash was reread.

| Source | Finalized verification block |
| --- | ---: |
| Ethereum | 26222466 |
| Optimism | 158382006 |
| Base | 52786721 |
| Arbitrum | 516103499 |
| Sepolia | 11944051 |
| OP Sepolia | 50280058 |
| Base Sepolia | 48296621 |
| Arbitrum Sepolia | 320536665 |

The same reviewed source was freshly verified on all four testnets. Each environment has 16 verified source/home family records. Collector availability does not prove a usable bridge route; the SDK must still verify the selected route and pool.

The existing artifact emitter owns canonical `sphinx-sol-ct-artifact-1` files, creation bytecode/arguments, successful creation receipts and shared/family manifests. The existing frontend sync owner consumes those records. Its stale constructor-child assumptions are replaced by this release's explicit CREATE2 collector/fee-payer constructor arguments and independent creation receipts. Shared records are refreshed only after the full environment succeeds. This release targets the current generation only; previous artifacts remain available in Git history.

The client used to prepare the production proposal was upstream Sphinx `f34436a` plus only a disposable Anvil-account funding correction, submitted separately as https://github.com/xBA5ED/sphinx-client/pull/9. This did not change real balances, contracts, fees or signed gas checks.

## Integration and activation gates

- Finalized contract deployment verification: passed on all eight chains.
- Explorer source verification: passed for all 112 contract records using the standard emitter, with no source-verification bypass. Canonical artifact publication is recorded by this commit.
- SDK: publish the release that consumes this exact artifact commit and its generated collector records, then pin and test that official package in the frontend.
- Bendystraw: https://github.com/peripheralist/bendystraw/pull/40 targets only the current generation, starting from each Hook and Distributor creation receipt. Maintainer merge, indexer deployment and replay/cutover are separate requirements; a PR does not update the live API.
- Frontend: generated deployment registries, required checks, production build and browser smoke must pass against the final package/data identities before cutover. The pre-release live revision is `80ec842`; its Railway deployment is `45e0ff83-3d9c-4675-a142-0ab13b740cdc`.
- Generic lifecycle smoke passed on all four mainnets and Sepolia using actual deployed suites on disposable forks, with local mock backing and fork-only time travel for weekly vesting. It is not a live wallet transaction or evidence that four real weeks have elapsed.
- JBX pool creation, permanent launch settings and source reward allocations are intentionally deferred. There is no additional global contract activation transaction after the singleton wiring; pools use the existing permissionless launch path.
