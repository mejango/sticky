# Deploying Sticky

Sticky uses the same Sphinx proposal workflow and canonical CREATE2 factory as the other Juicebox V6 repositories. The production entrypoint is `script/Deploy.s.sol:Deploy`. For the current release, it verifies and reuses the six already deployed singleton contracts, then deploys only the selected `StickySourceCollector` family; each collector constructor creates its `StickySourceFeePayer`. Interface-source changes do not require replacement singleton deployments. `StickyToken` and `StickyPriceFeed` retain their bytecode and are created per pool by the launch path. `DeployLocal.s.sol` is a disposable demonstration with mintable tokens and different reward durations; it requires `STICKY_LOCAL_DEMO=true`, deploys the shared six-contract demo without collector families, and is not a production deployment.

## Reproducible checkout

Use Node 22.23.1, Foundry v1.8.1, and the committed npm lockfile. CI reproduces this workspace layout:

```text
nana-core-v6/                 # feff600654aee6fb1747dded692f18068b2230a6
nana-distributor-v6/          # 44d6d5d2e7cca77422ee0ac4909cf42ccf7839b5
extensions/Sticky/
```

The core and distributor are intentionally linked `file:` dependencies. Install all dependencies, including the pinned Sphinx CLI, before compiling scripts:

```sh
npm ci
forge fmt --check
forge test
forge build --sizes --skip '*/test/**' --skip '*/script/**' --skip SphinxUtils
forge build --skip '*/test/**'
```

Keep `remappings.txt` as the source of import mappings. In this workspace, explicit global package mappings also unify nested dependency copies: removing the OpenZeppelin and protocol mappings can compile duplicate `IERC20`/`IERC165`/Revnet interface types. They are not redundant merely because the top-level packages are real directories.

Changing source, compiler settings, dependency versions, or constructor arguments changes CREATE2 predictions. All chains must use the same reviewed checkout, compiler, lockfile, salts, and core dependency addresses to obtain matching singleton and reward receiver addresses. Distributor `STARTING_TIMESTAMP` is chain-specific; it does not enter its CREATE2 init code.

The source collector additionally binds one nonzero destination chain. Matching inputs produce the same collector address across sources for that home chain; a different destination constructor argument produces a different family. A pool has one home chain, and only qualified direct reward routes may feed it. The earlier Ethereum-only rehearsal and addresses are historical evidence and must not be reused for this changed constructor.

## Configuration and preflight

Copy `.env.example` to `.env`, provide RPC endpoints for the intended network group, configure `SPHINX_ORG_ID`, `SPHINX_API_KEY`, and `SPHINX_MANAGED_BASE_URL` for the existing Sphinx organization, and `ETHERSCAN_API_KEY` (one Etherscan v2 key serves every chain) for the post-execution artifacts. The npm deployment commands select the `deploy` Foundry profile (`isolate = false`), which is compatible with Sphinx and avoids Foundry 1.8.1's isolated Optimism factory-call failure. Local contract tests keep the default isolated execution model; the real-project `fork` profile uses non-isolated execution for the same production artifact inspection as rehearsals. For direct `sphinx` or deployment `forge script` commands, set `FOUNDRY_PROFILE=deploy`. The deployment commands load `.env` with portable POSIX shell syntax and also accept environment variables supplied by CI. Never commit credentials.

Set `STICKY_DESTINATION_CHAIN_ID` explicitly for every source-collector operation. There is no default destination or automatic deployment of every family. For a grouped command, the chosen home must belong to that command's mainnet or testnet group. This selects the family to deploy across sources; it does not establish a usable route from every source to that home.

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

Foundry's local script memory and gas budgets match `deploy-all-v6` so repeated artifact inspection can complete. Sphinx still estimates and checks the actual deployment transactions separately. Foundry file access permits reads from the checkout and the sibling core deployment tree, and writes only to `cache/` (required by Sphinx) and `deployments/`. A custom artifact path outside these locations needs an explicit additional read permission.

Run the deployment twice on a fork of each intended chain before making a proposal. This exercises fresh deployment, partial deployment recovery, or verified reuse, depending on the fork state, without sending transactions:

```sh
set -a
. ./.env
set +a
export STICKY_REVISION="$(git rev-parse HEAD)"
export STICKY_DESTINATION_CHAIN_ID=11155111
npm run deploy:rehearse -- --rpc-url ethereum_sepolia -vv
```

Repeat with every intended RPC alias. CI's manually dispatched `test` workflow runs the same read-only rehearsal for its selected network. Regular CI compiles all deployment scripts and runs the local clean, partial, repeat, malformed-runtime, immutable-mismatch, and artifact-loading regression tests.

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

The current [source identity](tasks/adversarial-equivalence-20261009.json) and [verification record](tasks/adversarial-verification-20261009.json) bind contract commit `af4b08d0fa9a975002cafae79a36b7cb6d6221ed`, tree `3d663f5d6eef0ec15cd2bf845904673d122cce67`. Its exact-source [Ethereum-home rehearsal](tasks/home-chain-rehearsal.json) and [Arbitrum-home same-address control](tasks/arbitrum-home-control-rehearsal.json) cover Ethereum, OP, Base and Arbitrum. They are read-only simulations, not deployment receipts. The Ethereum-home family predicts collector `0x3b33E1aee2ADc340F2f9930863323F1686B02d68` and child `0x8833FBCD0A7Bc2afD4D5f837998F6cfffB23980E`; the Arbitrum-home control predicts `0xB2230C752086E2553677FCfBA1979B0c8CE0c777` and `0xC4642d4261fC2bF33124Ab17976A5ffA61D121df`. The [prepared Ethereum-home payload](tasks/home-chain-deployment.json) remains unexecuted and requires the separate proposal, execution and post-verification steps below.

The deployment code is locally ready for the collector-family release: preflight and clean four-chain rehearsals succeed against the exact contract candidate, verify reuse of the six live singletons and produce one prepared collector factory call per source chain. Exact-head hosted CI remains a release gate. No Sphinx proposal, execution or live verification has occurred.

## Source collectors

`StickySourceCollector` is shared by pools with the same home chain, alongside its constructor-created `StickySourceFeePayer`. Deploy only needed destination families through the existing deploy/rehearse/verify/artifact flow; no per-pool or per-route collector deployment is required. The six existing suite singletons retain creation bytecode, runtime bytecode, normalized public ABI and deployment identities, so the helper verifies and skips them. Declaration-only public-interface changes do not trigger redeployment; ABI internalType names may become interface types. The collector is intentionally different: it advertises `IStickySourceCollector`, `IJBSplitHook` and `IERC165`, returns false for unknown interface IDs, and therefore must use the regenerated family artifacts and predictions. Existing flat manifests and the prior Ethereum-only collector records do not identify this revised family; there is no automatic migration of that evidence. `StickyToken` and `StickyPriceFeed` are still created per pool during launch. This section owns setup and verification. The [accepted home-chain plan](tasks/home-chain-pools.md) and [current hook plan](tasks/omnichain-split-hook.md) own the implementation scope, while the [Sticky JBX qualification](tasks/sticky-jbx-qualification.md) retains historical pool-specific evidence.

1. **Bind the home-chain pool.** Confirm its single-chain launch receipt, underlying token, share token and permanent settings. Identify it by home chain and share token, not shared name or metadata. Predict or deploy the intended group's receiver through the verified destination factory, then confirm the factory/distributor/token/group bindings. An expected next project ID or a nonzero receiver address is insufficient. Sticky JBX is intended to launch on Ethereum; zero cashout tax remains provisional until launch, and group 0 is a funding policy rather than a permanent restriction on every reward. Verify the destination reward ERC-20 before any remote claim: the unchanged receiver cannot claim project credits or settle native currency.
2. **Authenticate the family and rehearse construction.** Independently verify the canonical registry, tokens, directory and receiver factory on every participating source, including parity with the home-chain receiver factory. Constructor arguments are `(registry, tokens, receiverFactory, destinationChainId)`, with a nonzero destination; the hook derives `DIRECTORY` from the registry and creates the no-argument fee child. Set `STICKY_DESTINATION_CHAIN_ID` and rehearse the selected family using the commands below. Matching compiler inputs, arguments, canonical CREATE2 factory and `StickySourceCollectorV6` salt are required for parity within that family. The home-chain constructor word separates different families; address parity must be checked, not inferred from a common salt.
3. **Review, execute and verify the selected family.** Complete independent contract review and required checks, then prepare the exact Sphinx proposal for separately authorized execution. The current proposal should contain one new collector factory call per participating source chain; the fee payer is created inside that call, while the six live singletons are verified and reused. Record runtimes and every immutable occurrence: parent `DIRECTORY`, `TOKENS`, `REGISTRY`, `RECEIVER_FACTORY`, `FEE_PAYER`, `DESTINATION_CHAIN_ID`; child `COLLECTOR`. Verify that the child is the parent's nonce-1 CREATE child and that the collector reports the three intended interface IDs while rejecting an unknown one. The deployment regression must also prove that a balance credited to the predicted child before deployment neither blocks its creation nor changes its binding. Before production, re-read project 1's primary native terminal and exercise `addFeeRefundToBalance()` with a bounded forced balance on a fork or testnet; confirm the exact terminal contribution, empty child and no caller payment. Any production value used for the same check needs a concrete amount and mechanism in the execution payload and its own applicable transaction authority. Family manifests include `destinationChainId`, `registry`, `tokens`, `sourceCollector`, `sourceCollectorCodehash`, `sourceFeePayer`, `sourceFeePayerCodehash` and `sourceCollectorSalt`, alongside the existing suite data. They and the two collector artifacts live under `deployments/<source-network>/source-collectors/<homeChainId>/`. Existing six contract artifacts remain at their canonical source-network paths. A source change remains in its PR through review, deployment and verification; merging the final PR requires explicit user approval afterward. Review authority does not authorize deployment or source-split transactions.
4. **Qualify each direct source/home lane.** For each source project, verify reward-token identity, a usable direct peer on the selected home chain, registered route implementation and builder provenance, enabled non-emergency backing mapping, current primary backing terminal, fee-project ERC-20 when the registry fee is positive, and both retained-refund APIs. The [source fixture](test/fork/fixtures/sticky-jbx-sources.json) pins historical JBP6/REV lanes; it is not a whitelist or proof of L2-to-L2 connectivity. The native topology is an Ethereum hub. An Ethereum-to-Arbitrum lane requires the same Arbitrum-home family on both chains. Every submission creates an unsafe root retryable whose refund targets the raw child address; its Arbitrum collector can permissionlessly contribute that complete balance to project 1. Prove address/runtime parity and the end-to-end terminal receipt before qualifying the lane. A positive mapped-ERC-20 transfer additionally creates a gateway retryable whose safe Inbox aliases the contract refund recipient; the raw-child operation cannot recover that balance, so keep positive ERC-20 backing unqualified pending an upstream explicit destination-refund recipient or separately reviewed alias recovery. A WETH gateway cancellation or expiry can also credit bridged call value to `alias(source sucker)`, outside Sticky control. A zero-backing ERC-20 send creates no gateway ticket. Ethereum-home JBX inbound lanes are unaffected. Other source/home pairs need a separately qualified direct route; there is no implicit Ethereum relay, and sending plain tokens to an intermediate collector creates no queue. Route state is checked on delivery; `DEPRECATION_PENDING` permits sending only until `deprecatedAfter - _maxMessagingDelay()`. A qualified registered replacement must preserve the same home-chain peer and canonical bindings. Source credits may queue before their ERC-20 exists, but delivery waits for that token.
5. **Authorize split setup.** Read source split authority and every current/future stage table. Preserve the chosen remainder and existing locks. On the home chain and each qualified source use `hook = verified collector for that home chain`, `beneficiary = confirmed home-chain Sticky share token`, `projectId = reward group`. The callback's source project ID remains separate from the group; no chain ID is packed into this encoding. A plain collector beneficiary creates no pending entitlement, and the fee child must never receive source allocations. Confirm executed split state, including the table handling already-pending reserves. For REV, preserve the requested approximately 10% total-issuance goal while identifying the issuance base: at 38% reserves, `263157895 / 1000000000` of reserves delivers approximately 10% of reserve-bearing issuance, with integer rounding and the existing remainder preserved. Automatic issuance and bridge remints bypass reserves, so that split alone does not capture 10% of those mints; resolve their treatment explicitly before claiming the total-issuance goal is met. The JBP6 allocation remains a separate decision. This setup creates no recurring Safe custody or signing requirement.
6. **Exercise bounded acceptance and delivery.** Establish an eligible home-chain reward snapshot. An unrelated caller distributes pending reserves; confirm `Queue`, `pendingOf` and `totalPendingOf` against combined ERC-20/credit custody in the selected family. Acceptance never requires a bridge fee or immediate settlement. On the home chain, call `settle(sourceProjectId, stickyToken, groupId, amount)` with a positive partial amount. On a qualified remote source, call `send(sourceProjectId, stickyToken, groupId, amount, sucker, backingToken)` with at least the registry fee plus native transport budget, paying gas separately. Confirm the selected bucket debit, leaf, zero allowance, source burn/backing deltas, sent-root inclusion and caller receipt/refund amounts. For a qualified native Arbitrum-home lane, also confirm the raw destination refund and permissionless project-1 contribution. Additional accepted allocations remain queued. Track native proving/finalization, destination claim, receiver settlement and holder collection; record every receipt and monitoring owner before increasing funding.

A rejected acceptance is different from a failed delivery: core catches split-hook failures and can burn unconsumed ERC-20 reserves, while credits already moved to an invalid split remain unattributed. Once accepted, a reverted delivery restores the selected bucket and leaves no partial preparation/submission from that attempt. Retry after resolving its cause and checking the canonical receipt; an RPC timeout is not proof of a revert. A successful `Send` proves source submission, not destination finality. If no compatible route remains, remote rewards stay queued with no rescue or destination reassignment. A successful native withdrawal cannot be recalled. Permissionless operations do not install a keeper or guarantee execution.

## Network-group commands

The operator commands follow `deploy-all-v6` naming. Run from this package with Node
22.23.1 and Foundry v1.8.1 on `PATH`. To reuse the workspace RPC and Sphinx setup
without copying credentials, set:

```sh
export STICKY_ENV_FILE=../../deploy-all-v6/.env
export NANA_CORE_DEPLOYMENT_PATH=../../nana-core-v6/deployments
export STICKY_DESTINATION_CHAIN_ID=1
```

An explicit `STICKY_ENV_FILE` must exist; otherwise commands load the package's
`.env` when present, or use the current environment. The exact-source rehearsals
used the shown core deployment override; omit it to use the configured core
package instead. Core artifact selection is independent of the credentials file.

The example above selects the Ethereum-home family for mainnet commands. Set a supported testnet home explicitly, such as `11155111`, before invoking the testnet group; the runner rejects a destination from the other group. Each invocation handles one family.

```sh
export STICKY_DESTINATION_CHAIN_ID=11155111
npm run deploy:preflight:testnets
npm run deploy:rehearse:testnets
npm run deploy:propose:testnets
# Only after the corresponding Sphinx proposal has executed:
npm run deploy:post:testnets

export STICKY_DESTINATION_CHAIN_ID=1
npm run deploy:preflight:mainnets
npm run deploy:rehearse:mainnets
npm run deploy:propose:mainnets
# Only after the corresponding Sphinx proposal has executed:
npm run deploy:post:mainnets
```

Preflight checks all four RPC variables, the three core address/chain-ID artifacts
and the sucker registry artifact per destination. It does not contact RPCs. Rehearsal binds each RPC to its expected chain ID, checks live core/registry bindings, and
simulates fresh deployment and restart on every destination. It reads a canonical
RPC block header and pins Forge to that height; the header number and hash are
recorded separately from the EVM block height. After the group's rehearsals the
runner requires every chain to have predicted the same deployer, hook, distributor,
reward receiver implementation, reward receiver factory and adapter, plus the source collector and fee payer for the selected destination. It also requires matching `destinationChainId`; different home-chain families deliberately have different collector addresses. A same-family address check is not evidence of direct-route availability.
Proposal commands require Sphinx credentials, the public project lock, and clean
core/distributor checkouts at the reviewed commits recorded in `script/deploy.mjs`,
and rerun the entire group's
rehearsals before invoking the pinned local Sphinx CLI. A failed or divergent chain
stops the command before proposal submission. `deploy:testnets` and
`deploy:mainnets` are aliases for these proposal commands. Sphinx execution remains
a separate step.

`deploy:post:*` runs `deploy:verify:*`, which verifies the group on live RPCs,
requires the same family agreement, and writes `deployments/<network>/source-collectors/<homeChainId>/verified.json`; it
then runs `deploy:artifacts:*` (`script/artifacts.mjs`), which verifies the eight
sources on Etherscan and writes `deployments/<network>/StickyDeployer.json`,
`StickyHook.json`, `StickyDistributor.json`, `StickyRewardReceiver.json`,
`StickyRewardReceiverFactory.json` and `StickyAutoStick.json` at the canonical network root, plus `StickySourceCollector.json` and `StickySourceFeePayer.json` under that family's `source-collectors/<homeChainId>/` directory, in the `sphinx-sol-ct-artifact-1` layout the other V6
repositories keep: address, ABI, constructor arguments, creation receipt, bytecode,
metadata and source revision. It finally runs `web/scripts/sync-deployments.mjs` to regenerate `web/src/lib/sticky-deployments.json` and `web/src/lib/sticky-source-collectors.json`, the verified suite and destination-family records the Next client builds from. The flat singleton manifest is preserved by this collector-family release. A future release that changes any of the six existing singleton identities must add a reviewed canonical-manifest migration before publication; the current sync rejects an updated deployer artifact paired with the old flat manifest. The constructor arguments come from the bindings the
verified manifest recorded, and for every factory-deployed contract the explorer's
creation bytecode must equal the compiled creation code followed by those
arguments. The accounting hook uses the deployer's creation receipt; the source fee payer uses the collector's creation receipt and has no constructor arguments. Commit both kinds of file. `deploy:post:*` does
not publish packages or configure the website; follow the publication steps below.
If a later chain fails, earlier manifests remain valid for their recorded block,
but the group is incomplete. No group command broadcasts directly through Forge.

Proposal, verification and artifact commands reject changed or mismatched local
core and distributor dependencies (their commits, and any change under their
`src/`; tests and scratch files do not compile into the contracts), and an
uncommitted Sticky checkout, where the runner's own outputs under `deployments/`
do not count. A clean Sticky tree alone cannot identify symlinked sources.
Rehearsals allow development changes. CI and runner tests keep the reviewed
dependency commits aligned, and `npm run test:deployment` checks that every source
root of the compiled suite is pinned: the linked checkouts by revision, the npm
packages by the lockfile's integrity hashes.

The grouped commands record the current Git commit automatically, appending
`-dirty` when a rehearsal's checkout has changes. Commit the reviewed release and
rerun its rehearsals before proposal collection; use the identical checkout for
verification.
Match each family's recorded revision to that reviewed checkout before publishing artifacts. Source-chain, destination, kind and address validation do not themselves compare `manifest.revision` with the current commit.
The single-chain `deploy:rehearse` and `deploy:verify` commands remain available
for diagnosis and accept normal Forge options; source your environment and set
`STICKY_REVISION` explicitly when using those commands.

## Proposal and execution

The script keeps the original `StickyDeployerV6` and `StickyAutoStickV6` salts, adds `StickySourceCollectorV6`, and explicitly uses the canonical factory at `0x4e59b44847b379578588920cA78FbF26c0B4956C`. It validates that factory's exact runtime. The production helper verifies the following shared suite, reusing items 1–5 when their compiled runtime and immutable bindings match, and deploying item 6 for the selected destination family:

1. `StickyDeployer`, which creates its accounting hook in its constructor.
2. `StickyDistributor`, bound to that deployer's hook, with 7-day rounds, 4-round vesting, a 2-year claim window, and loans disabled.
3. `StickyRewardReceiver`, the implementation every reward receiver is cloned from, bound to that distributor.
4. `StickyRewardReceiverFactory`, bound to that implementation, which clones and initializes one receiver per Sticky token and reward group.
5. `StickyAutoStick`, bound to that deployer and distributor.
6. The selected home-chain family's `StickySourceCollector`, bound to the canonical sucker registry, core token registry, reward receiver factory and nonzero destination chain, which creates its parent-only `StickySourceFeePayer` in its constructor.

`StickyToken` and `StickyPriceFeed` are absent from this shared-suite list because each new Sticky pool creates its own pair during `deployStickyFor`. Their interface changes are covered by the preserved deployer/token runtime gates and do not add transactions to the collector-family proposal.

```sh
export STICKY_DESTINATION_CHAIN_ID=11155111
npm run deploy:testnets
# After the testnet release and all intended mainnet rehearsals are reviewed:
export STICKY_DESTINATION_CHAIN_ID=1
npm run deploy:mainnets
```

These commands create Sphinx proposals. Review the exact predicted addresses, missing deployment transactions, bytecode, constructors, network group, and Sphinx Safe before approving execution through the existing Sphinx process. Do not use `forge script --broadcast` with the Sphinx entrypoint.

A repeated proposal collection skips existing deployments only after checking their compiled executable runtime and all immutable bindings. Every occurrence of a compiler-reported immutable must agree; checking only its getter is insufficient. The accounting hook must be the deployer's nonce-1 CREATE child, and the source fee payer the collector's nonce-1 CREATE child. The distributor must be bound to the accounting hook with a matching epoch duration and retain its original valid starting timestamp. Unexpected code or settings cause a failure rather than silent reuse. A changed source revision deploys new predictions; it does not upgrade or replace earlier immutable projects.

## Verification and publication

A rehearsal or Sphinx collection writes `deployments/<network>/source-collectors/<homeChainId>/simulation.json`. This ignored file describes simulated state and is **not deployment evidence**. The corresponding `verified.json` and two collector artifacts use the same family directory. Earlier flat manifests remain untouched and do not qualify the revised destination-bound constructor.

After Sphinx executes, verify the unchanged reviewed compilation against each live RPC:

```sh
export STICKY_DESTINATION_CHAIN_ID=11155111
npm run deploy:verify -- --rpc-url ethereum_sepolia -vv
```

`Verify` sends no transactions. It requires the predicted suite for the selected home to already exist and rechecks runtime code, every immutable dependency including destination chain, distributor settings, hook prediction, and core bindings. Only then does it write the family's `verified.json`, containing source and destination chain identity, source revision, addresses, salts and complete runtime hashes.
`evmBlockNumber` and `evmParentBlockHash` describe the EVM context. On Arbitrum,
these are not the L2 RPC block identity. Grouped commands additionally record
`rpcBlockNumber` and `rpcBlockHash` from the header used to pin their fork. Direct
single-chain Forge calls do not provide those RPC fields automatically; retain
their fork context separately. Deployment start blocks for client event discovery
must come from execution receipts, not verification manifests. `revision: unrecorded` means the operator did not set `STICKY_REVISION`; fill that gap by rerunning with the actual reviewed commit before publishing artifacts.

Retain the executed Sphinx proposal/transaction receipts alongside the verified manifest and the per-contract artifacts `deploy:post:*` writes. Publish only verified artifacts for chains that have executed, and propagate them through the existing V6 artifact distribution process before configuring the website. Collector records must retain both source-chain and destination-chain identity; do not flatten different families into one chain-only address or register predictions as deployed code. Confirm all eight suite addresses and their canonical dependency bindings against the selected family manifest; complete those checks and target-chain transaction smoke tests before production cutover. Follow [the Next client deployment guide](web/README.md#deployment) for website configuration. No live deployment or production artifact is implied by files generated during local tests. Contract PRs require explicit approval of the final reviewed, deployed and verified result before merge; neither passing CI nor a deployment approval substitutes for that final approval.
