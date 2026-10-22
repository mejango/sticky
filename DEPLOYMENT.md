# Deploying Sticky

Sticky uses the same Sphinx proposal workflow and canonical CREATE2 factory as the other Juicebox V6 repositories. The production entrypoint is `script/Deploy.s.sol:Deploy`. The explicit-singleton revision deploys the shared suite and all four destination-bound `StickySourceCollector`/`StickySourceFeePayer` families for the connected environment. Hook and FeePayer deployment are explicit CREATE2 actions; their consumers receive the predicted child addresses as immutable constructor arguments. Each child pins the deployment Safe as setup authority and accepts one authenticated parent binding, following REVOwner. The script establishes and verifies both directions before declaring readiness. There is no ongoing parent-replacement authority. This is a fresh suite generation: the earlier six-singleton reuse claim and earlier proposal roots do not apply. Verified contracts at the revised predictions may be reused; prior suites and existing pools remain untouched. `StickyToken` and `StickyPriceFeed` are still created per pool by the runtime launch path. `DeployLocal.s.sol` is a disposable demonstration, requires `STICKY_LOCAL_DEMO=true`, and is not a production deployment.

## Reproducible checkout

Use Node 22.23.4, Foundry v1.8.1, and the committed npm lockfile. It installs exact physical copies of `@bananapus/core-v6@1.2.1` and `@bananapus/distributor-v6@2.0.0`, including the core deployment records consumed by the scripts. Install all dependencies, including the pinned Sphinx CLI, before compiling scripts:

```sh
npm ci
forge fmt --check
npm run lint:solidity
forge test
forge build --sizes --skip '*/test/**' --skip '*/script/**' --skip SphinxUtils
forge build --deny notes --skip '*/test/**'
```

Like the other V6 suites, Foundry builds disable automatic whole-tree lint while compiling deployment and test
fixtures. `npm run lint:solidity` separately rejects every production-contract warning or note and remains part of CI
and `npm run test:deployment`.

Like the other V6 contract suites, `remappings.txt` contains only the explicit `forge-std` mapping. Foundry resolves npm package imports through the configured `node_modules` library directory.

Changing source, compiler settings, dependency versions, or constructor arguments changes CREATE2 predictions. Address equality alone never authenticates runtime code, immutable dependencies or one-time parent bindings. All chains must use the same reviewed checkout, compiler, lockfile, salts, and core dependency addresses to obtain matching singleton and reward receiver addresses. Distributor `STARTING_TIMESTAMP` is chain-specific; it does not enter its CREATE2 init code.

The source collector additionally binds one nonzero destination chain. Matching inputs produce the same collector address across sources for that home chain; a different destination constructor argument produces a different family. A pool has one home chain, and only qualified direct reward routes may feed it. Earlier constructor-created Hook/FeePayer rehearsals and addresses are historical evidence and must not be reused for this revision.

## Configuration and preflight

Copy `.env.example` to `.env`, provide RPC endpoints for the intended network group, configure `SPHINX_ORG_ID`, `SPHINX_API_KEY`, and `SPHINX_MANAGED_BASE_URL` for the existing Sphinx organization, and `ETHERSCAN_API_KEY` (one Etherscan v2 key serves every chain) for the post-execution artifacts. The npm deployment commands select the `deploy` Foundry profile (`isolate = false`, compiler warnings and notes denied), which is compatible with Sphinx and avoids Foundry 1.8.1's isolated Optimism factory-call failure while keeping proposal builds fail-closed. Local contract tests keep the default isolated execution model; the real-project `fork` profile uses non-isolated execution for the same production artifact inspection as rehearsals. For direct `sphinx` or deployment `forge script` commands, set `FOUNDRY_PROFILE=deploy`. The deployment commands load `.env` with portable POSIX shell syntax and also accept environment variables supplied by CI. Never commit credentials.

The production, rehearsal and verification entrypoints derive the exact four home chains from the connected source environment: Ethereum, OP, Base and Arbitrum on mainnet, or their four testnets. There is no destination environment variable. A grouped command deploys all four families on all four sources in that environment. This complete deployment grid does not establish a usable route between every source and home.

| Sphinx / RPC alias | Environment variable | Core artifact folder |
| --- | --- | --- |
| ethereum | RPC_ETHEREUM_MAINNET | ethereum |
| optimism | RPC_OPTIMISM_MAINNET | optimism |
| base | RPC_BASE_MAINNET | base |
| arbitrum | RPC_ARBITRUM_MAINNET | arbitrum |
| ethereum_sepolia | RPC_ETHEREUM_SEPOLIA | sepolia |
| optimism_sepolia | RPC_OPTIMISM_SEPOLIA | optimism_sepolia |
| base_sepolia | RPC_BASE_SEPOLIA | base_sepolia |
| arbitrum_sepolia | RPC_ARBITRUM_SEPOLIA | arbitrum_sepolia |

Sticky uses the registered `sticky` Sphinx project and the public `sphinx.lock`, so
proposal review uses its 1-of-3 `V6 Jango` Safe
(`0xd5136c794ee43BEf1eD4cF1eB6DEe45b7F803437`, the same address on every chain).
The lock contains public organization/project/Safe configuration, not credentials.
The proposal runner checks that its organization matches `SPHINX_ORG_ID` and that
the configured project exists; `Deploy.run()` refuses any other Safe. The installed
Sphinx CLI synchronizes this lock during proposal collection; review any resulting
Safe configuration changes before execution.

The core reader defaults to `node_modules/@bananapus/core-v6/deployments/<network>/`. An optional `NANA_CORE_DEPLOYMENT_PATH` overrides the directory containing the network folders. It requires `JBController.json`, `JBDirectory.json`, and `JBMultiTerminal.json`. The sucker registry reader requires `JBSuckerRegistry.json` under `node_modules/@bananapus/suckers-v6/deployments/<network>/`, overridable through `NANA_SUCKERS_DEPLOYMENT_PATH`. Each artifact must record the connected chain ID. The reader checks live contract code, controller launch authorization, controller/directory/terminal/token/project/store/split/price/ruleset bindings, and the sucker registry's directory/project registry before deploying anything. It requires code at the controller’s trusted forwarder and checks that the terminal trusts the same address.

The pinned core and sucker artifacts are the trusted address sources. Their `deployedBytecode` fields are templates with unresolved immutable words, so comparing those fields directly to live runtime hashes would be incorrect. Sticky checks dependency code existence and immutable cross-bindings, and records the observed full runtime hashes in its manifest. Verify the upstream releases independently when changing those trusted artifacts.

Foundry's local script memory and gas budgets match `deploy-all-v6` so repeated artifact inspection can complete. Sphinx still estimates and checks the actual deployment transactions separately. Foundry file access permits reads from the checkout, including installed packages, and writes only to `cache/` (required by Sphinx) and `deployments/`. A custom artifact path outside the checkout needs an explicit additional read permission.

Run the deployment twice on a fork of each intended chain before making a proposal. This exercises fresh deployment, partial deployment recovery, or verified reuse, depending on the fork state, without sending transactions:

```sh
set -a
. ./.env
set +a
export STICKY_REVISION="$(git rev-parse HEAD)"
npm run deploy:rehearse -- --rpc-url ethereum_sepolia -vv
```

The direct command rehearses all four testnet home families on the selected source. Repeat it with every intended RPC alias, or use the grouped command below to cover all four sources. CI's manually dispatched `test` workflow runs the same read-only rehearsal for its selected network or group. Regular CI compiles all deployment scripts and runs the local clean, partial, repeat, malformed-runtime, immutable-mismatch, and artifact-loading regression tests.

Before proposing a release, also run
`STICKY_ENV_FILE=../../deploy-all-v6/.env npm run test:fork`. The
[real-project suites](test/fork/README.md) exercise Sticky's lifecycle against Base
`6` and Ethereum `3`, including Ethereum `3`'s deployed Base reward route, and
canonical JBX against the deployed Ethereum Sticky suite with V6 project `1`/`3`
rewards arriving from OP, Base and Arbitrum. These complement the eight-network
singleton deployment rehearsals. Trusted CI runs require Ethereum, OP, Base and Arbitrum
archive RPC secrets; the tests fail when required state or
configuration is unavailable.

The pool-specific [Sticky JBX qualification](tasks/sticky-jbx-qualification.md)
records source configuration, historical proof and remaining live boundaries.
The shared source-hook procedure is below. Historical fixed-route collector evidence in that qualification record does not qualify the current [generalized design](tasks/omnichain-split-hook.md).

## Failed proposals and recovery

The [2026-10-09 source identity](tasks/adversarial-equivalence-20261009.json), [verification record](tasks/adversarial-verification-20261009.json) and selected-family rehearsals are historical evidence for the preceding constructor-created design. Their addresses, payloads and passing checks do not qualify the explicit-singleton revision.

The testnet root `0xdeee0db609ed7efac41d4cf40855a4f6043dc859963280794fdb50563ec3ca50` reached execution but failed on Sepolia at leaf 1 on October 12. Its earlier approval failed with a 228,834-gas outer limit and succeeded on retry with 1,228,834. Replay of the later exact signed action, retaining its 3,026,638 inner gas cap, failed with 4.2-million and 20-million outer limits but succeeded with 35-million and 40-million outer limits, consuming 18,476,969 total gas. This corrects the earlier conclusion that the signed inner cap was insufficient: the unchanged action succeeds with enough outer gas.

Sepolia activated Glamsterdam on October 6; its [EIP-8037 state-gas reservoir](https://eips.ethereum.org/EIPS/eip-8037) is metered separately from execution gas and is not exposed by `gasleft()`. The [Ethereum Foundation announcement](https://blog.ethereum.org/2026/09/17/glamsterdam-testnet-announcement) leaves mainnet activation unscheduled. Estimation must therefore cover the complete signed action under the target chain's active rules. Raise the authoritative outer action budget where proved necessary and inspect module success/failure logs, rather than blindly inflating the inner leaf limit. The historical measurements are not a fixed budget for this changed release. An outer Sphinx receipt may succeed while an inner action fails and the root is marked failed; verify module events and deployed code. Preserve successful deployments and receipts on the other chains. A failed root needs a replacement proposal after partial-state verification, not blind replay.

The mainnet root `0x9bd0b966afccf8af2f8f2c1dc666f054a3e7aa20afbf92a1b4167fd01e8cc6ff` encountered a backend `active merkle root` simulation conflict. That issue remains unresolved and is distinct from Sepolia's state-gas budget. The explicit-singleton revision still requires fresh qualification, new roots and separately authorized execution; no deployment-ready claim is made here.

The historical gas result can be reproduced without sending a transaction:

```sh
npm run deploy:diagnose:sepolia -- 0xb2bf5f48e94931a4e307e9ddc67683f8ed9ecb8fac0f18685471dc9db8393b1d
```

This requires a Sepolia archive RPC supporting `eth_simulateV1`. It preserves the signed calldata and inner caps, tries bounded outer budgets, and accepts only the expected module's success events for every leaf. An outer success receipt alone cannot pass. The command diagnoses historical execution; it does not change Relayr's budget or qualify a new proposal automatically.

## Source collectors

`StickySourceCollector` is shared by pools with the same home chain, alongside its explicitly deployed, permanently bound `StickySourceFeePayer`. The production flow deploys every supported destination family; no per-pool or per-route collector deployment is required. Changed Hook/Deployer and FeePayer/Collector constructor dependencies produce a new suite generation. Earlier flat manifests, constructor-created children and prior family records do not identify this revision. The collector advertises `IStickySourceCollector`, `IJBSplitHook` and `IERC165` and rejects unknown interface IDs. `StickyToken` and `StickyPriceFeed` remain runtime per-pool creations. This section owns setup and verification; the [explicit-singleton plan](tasks/explicit-singleton-deployments.md) owns the deployment refinement, and the [Sticky JBX qualification](tasks/sticky-jbx-qualification.md) retains historical pool-specific evidence.

1. **Bind the home-chain pool.** Confirm its single-chain launch receipt, underlying token, share token and permanent settings. Identify it by home chain and share token, not shared name or metadata. Predict or deploy the intended group's receiver through the verified destination factory, then confirm the factory/distributor/token/group bindings. An expected next project ID or a nonzero receiver address is insufficient. Sticky JBX is intended to launch on Ethereum; zero cashout tax remains provisional until launch, and group 0 is a funding policy rather than a permanent restriction on every reward. Verify the destination reward ERC-20 before any remote claim: the unchanged receiver cannot claim project credits or settle native currency.
2. **Authenticate every family and rehearse construction.** Independently verify canonical registry, tokens, directory and receiver factory on every participating source, including home-chain receiver-factory parity. Collector arguments are `(registry, tokens, receiverFactory, destinationChainId, feePayer)`, with a nonzero destination. Deployer arguments are `(controller, terminal, hook)`. Hook arguments are `(directory, deploymentAuthority, trustedForwarder)`; FeePayer arguments are `(deploymentAuthority)`. All singleton predictions use the canonical CREATE2 factory, reviewed creation code and constructor arguments. Authenticate the constructor-pinned deployment Safe, child runtime and parent dependencies before setup. The Safe binds Hook `DEPLOYER` and FeePayer `COLLECTOR` exactly once with `setDeployer` and `setCollector`; the parents' child references remain immutable. Matching reviewed inputs are required for parity; address equality alone is insufficient.
3. **Review, execute and verify the all-family proposal.** Complete independent review and required checks, then prepare the exact Sphinx proposal for separately authorized execution. Review explicit shared-suite and four-family CREATE2 deployments plus missing one-time binding actions on each source; inventory depends on verified partial state. Record runtimes and every immutable occurrence: collector `DIRECTORY`, `TOKENS`, `REGISTRY`, `RECEIVER_FACTORY`, `FEE_PAYER`, `DESTINATION_CHAIN_ID`; deployer `HOOK`; each child's `DEPLOYMENT_AUTHORITY` and other constructor dependencies. Separately verify permanently locked storage bindings Hook `DEPLOYER` and FeePayer `COLLECTOR`. The script must verify both directions before reuse or readiness. Unauthorized, repeated, zero, incompatible or conflicting bindings must fail; no setter permits replacing a configured parent. Foreign runtime or a conflicting binding stops the release. Rehearse unbound partial deployment, correct completed reuse and rejected mismatches. Prove a predeployment native balance does not change authorized bindings. Before production, exercise `addFeeRefundToBalance()` with a bounded forced balance on a fork or testnet and confirm the exact canonical project-1 native terminal contribution, empty payer and no caller payment. Production test value needs its own concrete execution authority. Family manifests and collector/payer artifacts live under `deployments/<source-network>/source-collectors/<homeChainId>/`; shared artifacts remain at canonical source-network paths. Regenerate predictions and artifacts against the reviewed revision. A source change stays in its PR through review, deployment and verification; final merge requires explicit user approval afterward. Review authority does not authorize deployment or source-split transactions.
4. **Qualify each direct source/home lane.** For each source project, verify reward-token identity, a usable direct peer on the selected home chain, registered route implementation and builder provenance, enabled non-emergency backing mapping, current primary backing terminal, fee-project ERC-20 when the registry fee is positive, and both retained-refund APIs. The [source fixture](test/fork/fixtures/sticky-jbx-sources.json) pins historical JBP6/REV lanes; it is not a whitelist or proof of L2-to-L2 connectivity. The native topology is an Ethereum hub. An Ethereum-to-Arbitrum lane requires the same Arbitrum-home family on both chains. Every submission creates an unsafe root retryable whose refund targets the raw child address; its Arbitrum collector can permissionlessly contribute that complete balance to project 1. Prove address/runtime parity and the end-to-end terminal receipt before qualifying the lane. A positive mapped-ERC-20 transfer additionally creates a gateway retryable whose safe Inbox aliases the contract refund recipient; the raw-child operation cannot recover that balance, so keep positive ERC-20 backing unqualified pending an upstream explicit destination-refund recipient or separately reviewed alias recovery. A WETH gateway cancellation or expiry can also credit bridged call value to `alias(source sucker)`, outside Sticky control. A zero-backing ERC-20 send creates no gateway ticket. Ethereum-home JBX inbound lanes are unaffected. Other source/home pairs need a separately qualified direct route; there is no implicit Ethereum relay, and sending plain tokens to an intermediate collector creates no queue. Route state is checked on delivery; `DEPRECATION_PENDING` permits sending only until `deprecatedAfter - _maxMessagingDelay()`. A qualified registered replacement must preserve the same home-chain peer and canonical bindings. Source credits may queue before their ERC-20 exists, but delivery waits for that token.
5. **Authorize split setup.** Read source split authority and every current/future stage table. Preserve the chosen remainder and existing locks. On the home chain and each qualified source use `hook = verified collector for that home chain`, `beneficiary = confirmed home-chain Sticky share token`, `projectId = reward group`. The callback's source project ID remains separate from the group; no chain ID is packed into this encoding. A plain collector beneficiary creates no pending entitlement, and the fee child must never receive source allocations. Confirm executed split state, including the table handling already-pending reserves. For REV, preserve the requested approximately 10% total-issuance goal while identifying the issuance base: at 38% reserves, `263157895 / 1000000000` of reserves delivers approximately 10% of reserve-bearing issuance, with integer rounding and the existing remainder preserved. Automatic issuance and bridge remints bypass reserves, so that split alone does not capture 10% of those mints; resolve their treatment explicitly before claiming the total-issuance goal is met. The JBP6 allocation remains a separate decision. This setup creates no recurring Safe custody or signing requirement.
6. **Exercise bounded acceptance and delivery.** Establish an eligible home-chain reward snapshot. An unrelated caller distributes pending reserves; confirm `Queue`, `pendingOf` and `totalPendingOf` against combined ERC-20/credit custody in the selected family. Acceptance never requires a bridge fee or immediate settlement. On the home chain, call `settle(sourceProjectId, stickyToken, groupId, amount)` with a positive partial amount. On a qualified remote source, call `send(sourceProjectId, stickyToken, groupId, amount, sucker, backingToken)` with at least the registry fee plus native transport budget, paying gas separately. Confirm the selected bucket debit, leaf, zero allowance, source burn/backing deltas, sent-root inclusion and caller receipt/refund amounts. For a qualified native Arbitrum-home lane, also confirm the raw destination refund and permissionless project-1 contribution. Additional accepted allocations remain queued. Track native proving/finalization, destination claim, receiver settlement and holder collection; record every receipt and monitoring owner before increasing funding.

A rejected acceptance is different from a failed delivery: core catches split-hook failures and can burn unconsumed ERC-20 reserves, while credits already moved to an invalid split remain unattributed. Once accepted, a reverted delivery restores the selected bucket and leaves no partial preparation/submission from that attempt. Retry after resolving its cause and checking the canonical receipt; an RPC timeout is not proof of a revert. A successful `Send` proves source submission, not destination finality. If no compatible route remains, remote rewards stay queued with no rescue or destination reassignment. A successful native withdrawal cannot be recalled. Permissionless operations do not install a keeper or guarantee execution.

## Network-group commands

The operator commands follow `deploy-all-v6` naming. Run from this package with Node
22.23.4 and Foundry v1.8.1 on `PATH`. To reuse the workspace RPC and Sphinx setup
without copying credentials, set:

```sh
export STICKY_ENV_FILE=../../deploy-all-v6/.env
```

An explicit `STICKY_ENV_FILE` must exist; otherwise commands load the package's
`.env` when present, or use the current environment. Core artifact selection is
independent of the credentials file. `NANA_CORE_DEPLOYMENT_PATH` remains available
for a reviewed override whose bytes match the committed input manifest; a path
outside the checkout also needs explicit Foundry read permission.

No destination selection is required. The testnet commands cover Sepolia, OP Sepolia, Base Sepolia and Arbitrum Sepolia as both source networks and destination families. The mainnet commands cover Ethereum, OP, Base and Arbitrum in the same 4-by-4 grid. Testnet and mainnet remain separate proposals.

```sh
npm run deploy:preflight:testnets
npm run deploy:rehearse:testnets
npm run deploy:dry-run:testnets
npm run deploy:propose:testnets
# Only after the corresponding Sphinx proposal has executed:
npm run deploy:post:testnets

npm run deploy:preflight:mainnets
npm run deploy:rehearse:mainnets
npm run deploy:dry-run:mainnets
npm run deploy:propose:mainnets
# Only after the corresponding Sphinx proposal has executed:
npm run deploy:post:mainnets
```

Preflight checks all four RPC variables, the three core address/chain-ID artifacts
and the sucker registry artifact per source. It does not contact RPCs. Rehearsal binds each RPC to its expected chain ID, checks live core/registry bindings, and
simulates fresh deployment and restart for all four home families on every source. It reads the
RPC's `finalized` block header and pins Forge to that height. After Forge returns,
the runner reads that exact height again and requires the same number and hash
before accepting its manifests. The finalized header identity is recorded
separately from the EVM block height. After the group's rehearsals the
runner requires every chain to have predicted the same deployer, hook, distributor,
reward receiver implementation, reward receiver factory and adapter. For every home, it requires one matching source collector and fee payer across all sources, an exact `destinationChainId`, and distinct collector and child addresses from the other three families. Complete deployment is not evidence of direct-route availability.
Proposal commands require Sphinx credentials, the public project lock and a clean
Sticky checkout. They force the deployment profile and canonical `out` directory,
build `Deploy.s.sol`, then compare the exact external compiler source set, compiler
identity and non-remapping settings, known artifact targets, creation/runtime
bytecodes and semantic immutable-reference groups and ranges, and all 32 core/sucker deployment inputs with
[`script/reviewed-inputs.json`](script/reviewed-inputs.json). The package lock records
download provenance; this manifest authenticates the physical installed bytes used
by the proposal. Sphinx JS, Foundry and Node remain trusted operator tools. Proposal
commands then rerun the entire group's rehearsals, repeat the clean checkout, semantic
Sphinx lock, forced build and reviewed-input gates, and perform one final clean check
immediately before invoking the pinned local Sphinx CLI. A failed or divergent chain
stops the command before proposal submission. `deploy:testnets` and
`deploy:mainnets` are aliases for these proposal commands. Sphinx execution remains
a separate step.

Run release commands from an exclusively controlled checkout. Any external filesystem
mutation after the final inspection syscall invalidates that run and its outputs.

`deploy:post:*` runs `deploy:verify:*` after the execution blocks are finalized. It
verifies the complete 4-by-4 group on finalized live RPC state, requires the same
shared and per-family agreement, validates all four families on a source before
writing any of that source's records, and writes
`deployments/<network>/source-collectors/<homeChainId>/verified.json` for every home; it
then runs `deploy:artifacts:*` (`script/artifacts.mjs`), which verifies the four
sources on Etherscan and writes `deployments/<network>/StickyDeployer.json`,
`StickyHook.json`, `StickyDistributor.json`, `StickyRewardReceiver.json`,
`StickyRewardReceiverFactory.json` and `StickyAutoStick.json` once at the canonical network root, plus `StickySourceCollector.json` and `StickySourceFeePayer.json` under every family's `source-collectors/<homeChainId>/` directory, in the `sphinx-sol-ct-artifact-1` layout the other V6
repositories keep: address, ABI, constructor arguments, creation receipt, bytecode,
metadata and source revision. It finally runs `web/scripts/sync-deployments.mjs` to regenerate `web/src/lib/sticky-deployments.json` and `web/src/lib/sticky-source-collectors.json`, the verified suite and destination-family records the Next client builds from. The explicit-singleton release must regenerate the canonical singleton manifest as well as the family records; pairing new deployer artifacts with the old flat manifest must fail. Constructor arguments come from the verified bindings. Before explorer requests or artifact writes, rederive canonical CREATE2 predictions and authenticate every immutable dependency and one-time reciprocal binding. Creation bytecode must match the compiled creation code followed by the recorded arguments. Explicit Hook and FeePayer deployments have their own creation receipts; the FeePayer arguments include its collector address. Commit both kinds of file. `deploy:post:*` does
not publish packages or configure the website; follow the publication steps below.
If a later chain fails, earlier manifests remain valid for their recorded block,
but the group is incomplete. No group command broadcasts directly through Forge.

Proposal, verification and artifact commands reject an uncommitted Sticky checkout,
where the runner's own outputs under `deployments/` do not count. Exact registry
versions and lockfile integrities identify the installed packages; the reviewed-input
gate authenticates the physical compiler source closure and deployment records.
Direct rehearsals allow development changes and deliberately do not claim release
input authentication. Dry runs and proposals repeat all release-input gates after
rehearsal. CI and runner tests prove that any missing, added or changed compiled
external source, deployment JSON, non-remapping compiler setting, artifact target,
immutable-reference group or range, or bytecode stops a release path. When an
intentional reviewed input changes, run
`node script/generate-reviewed-inputs.mjs --write`, inspect the complete manifest
diff, rebuild and rerun the deployment checks before committing it.

The grouped commands record the current Git commit automatically, appending
`-dirty` when a rehearsal's checkout has changes. Commit the reviewed release and
rerun its rehearsals before proposal collection; use the identical checkout for
verification.
Match each family's recorded revision to that reviewed checkout before publishing artifacts. Source-chain, destination, kind and address validation do not themselves compare `manifest.revision` with the current commit.
The grouped CLI requires every simulation or verified manifest to carry the exact
current revision. The direct single-chain `deploy:rehearse` and `deploy:verify`
Forge commands remain available for diagnosis, cover all four homes for the
connected source, and accept normal Forge options; source your environment and set
`STICKY_REVISION` explicitly when using those commands. Without it, those direct
commands write `revision: unrecorded`, which cannot satisfy grouped release gates.

## Proposal and execution

The script keeps the original `StickyDeployerV6` and `StickyAutoStickV6` salts, adds `StickySourceCollectorV6`, and explicitly uses the canonical factory at `0x4e59b44847b379578588920cA78FbF26c0B4956C`. It validates that factory's exact runtime. The production helper verifies the following suite, reusing items 1–5 when their compiled runtime and immutable bindings match, and deploying item 6 once for each of the environment's four home chains:

1. `StickyDeployer`, which creates its accounting hook in its constructor.
2. `StickyDistributor`, bound to that deployer's hook, with 7-day rounds, 4-round vesting, a 2-year claim window, and loans disabled.
3. `StickyRewardReceiver`, the implementation every reward receiver is cloned from, bound to that distributor.
4. `StickyRewardReceiverFactory`, bound to that implementation, which clones and initializes one receiver per Sticky token and reward group.
5. `StickyAutoStick`, bound to that deployer and distributor.
6. Each home-chain family's `StickySourceCollector`, bound to the canonical sucker registry, core token registry, reward receiver factory and nonzero destination chain, which creates its parent-only `StickySourceFeePayer` in its constructor.

`StickyToken` and `StickyPriceFeed` are absent from this shared-suite list because each new Sticky pool creates its own pair during `deployStickyFor`. Their interface changes are covered by the preserved deployer/token runtime gates and do not add transactions to the collector-family proposal.

```sh
npm run deploy:testnets
# After the testnet release and all intended mainnet rehearsals are reviewed:
npm run deploy:mainnets
```

Each proposal command creates one Sphinx proposal for its environment. A dry run collects and simulates the same entrypoint without backend submission. The action inventory includes missing explicit shared-suite and four-family deployments, and required one-time parent binding actions; verified partial deployments are skipped. Review every predicted address, creation bytecode, constructor, signed inner gas limit, network group and Safe before separately authorized execution. A successful local simulation does not establish the backend's bundle state or live signed-gas sufficiency. Do not use `forge script --broadcast` with the Sphinx entrypoint.

A repeated proposal collection skips existing deployments only after checking their compiled executable runtime and all immutable bindings. Every occurrence of a compiler-reported immutable must agree; checking only its getter is insufficient. The accounting hook and each source fee payer must match their canonical CREATE2 predictions, constructor-pinned setup authority and permanently locked reciprocal bindings; neither is created by its consumer constructor. The distributor must be bound to the accounting hook with a matching epoch duration and retain its original valid starting timestamp. Unexpected code or settings cause a failure rather than silent reuse. A changed source revision deploys new predictions; it does not upgrade or replace earlier immutable projects.

## Verification and publication

`Rehearse` alone writes one `deployments/<network>/source-collectors/<homeChainId>/simulation.json` per home family. The Sphinx `Deploy` entrypoint writes no manifests, so proposal collection cannot overwrite freshly pinned rehearsal evidence with an unbound RPC context. These ignored files describe simulated state and are **not deployment evidence**. Each corresponding `verified.json` and pair of collector artifacts uses the same family directory. Earlier flat manifests remain untouched and do not qualify the revised destination-bound constructor.

After Sphinx executes and every receipt block is finalized, run the grouped post-execution path against the unchanged reviewed compilation:

```sh
npm run deploy:post:testnets
```

`Verify` sends no transactions. It requires the predicted suite for all four homes in the connected environment to already exist and rechecks runtime code, every immutable dependency including destination chain, distributor settings, hook prediction, and core bindings. It validates the complete four-family set before writing the first `verified.json`, then writes source and destination chain identity, source revision, addresses, salts and complete runtime hashes for each family.
`evmBlockNumber` and `evmParentBlockHash` describe the EVM context. On Arbitrum,
these are not the L2 RPC block identity. Grouped commands additionally record
`rpcBlockNumber` and `rpcBlockHash` from the finalized header used to pin their fork,
after rereading that exact height and hash. Direct
single-chain Forge calls do not provide those RPC fields automatically; retain
their fork context separately. Deployment start blocks for client event discovery
must come from execution receipts, not verification manifests. `revision: unrecorded` means the operator did not set `STICKY_REVISION`; fill that gap by rerunning with the actual reviewed commit before publishing artifacts.

Retain the executed Sphinx proposal/transaction receipts alongside the verified manifests and the per-contract artifacts `deploy:post:*` writes. Publish only verified artifacts for chains that have executed, and propagate them through the existing V6 artifact distribution process before configuring the website. Collector records must retain both source-chain and destination-chain identity; do not flatten different families into one chain-only address or register predictions as deployed code. Confirm all six shared addresses and all eight family addresses on each source, with their canonical dependency bindings, against the four family manifests; complete those checks and target-chain transaction smoke tests before production cutover. Follow [the Next client deployment guide](web/README.md#deployment) for website configuration. No live deployment or production artifact is implied by files generated during local tests. Contract PRs require explicit approval of the final reviewed, deployed and verified result before merge; neither passing CI nor a deployment approval substitutes for that final approval.
