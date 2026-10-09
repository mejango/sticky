# Sticky JBX qualification — 2026-10-08

> **Historical fixed-route qualification.** The evidence below describes the 2026-10-08 qualification revision merged in `137e607`, before the shared destination-bound collector. Its collector counts, call signatures, fees and routing setup are not current instructions. Use [DEPLOYMENT.md](../DEPLOYMENT.md#source-collectors) for the operative setup and [the home-chain review](../OMNICHAIN_SPLIT_HOOK_REVIEW.md) for later evidence. No mainnet transaction, split edit, deployment, or user signature was sent during this qualification.

## Plan refinement

- **Objective:** Establish reproducible confidence in canonical Ethereum JBX custody and delivery of V6 project 1/JBP6 and project 3/REV reserved rewards from Ethereum, OP, Base and Arbitrum. The user requires permissionless delivery after setup; zero stickiness bonus is provisional, shares may be transferable, and rewards use group 0 without staking-age criteria.
- **System fit:** Source issuance and authorized split configuration feed existing bridge and reward contracts. The new fixed-route collector fills the source-custody initiation step; deployed suckers, canonical transports, receiver, distributor and holder redemption retain their existing responsibilities. The confirmed launch identity and source Safe authorizations precede live configuration.
- **Reuse and simplicity:** Extend the existing fork fixtures, deployed contracts and CI runner. Keep source collection separate from permanent Sticky pool accounting; reuse core cashout previews and protocol fee arithmetic. A minimal child fee payer prevents callback-delivered reserved principal from being mistaken for the caller's bridge-fee receipt.
- **Evidence and unknowns:** Tests pin canonical block hashes and live runtime identities. Native transport consensus/finality is modeled explicitly; no test proves real-world finalization or a running keeper. A simulated next project ID is not a launch identity. New collector code is not a deployed capability.
- **Verification:** Execute deployed JBX lifecycle and authority tests, direct Ethereum reserved splits, both reward projects on all three inbound native routes, and collector rollback/fee/callback regressions. Run local invariants, strict Solidity lint/build, deployment tooling and static analysis; record exact results below as completed.
- **Resource budget:** Reuse the pinned dependency checkout and one coordinated Forge queue. Independent custody and route reviewers inspect disjoint concerns; expand work only for concrete failures. Keep the four-chain fixture and test commands as the repeatable evidence.

## Existing deployment and selected behavior

The previously shipped omnichain design is present: a per-pool/group receiver can receive bridged project tokens, anyone can settle it, and the distributor handles reward eligibility, vesting and collection. The client already supports wallet-owned source tokens being prepared and bridged. Source tokens held by a reserved-split recipient need a callable source action; pointing that split at an Ethereum receiver's numeric address does not bridge them.

The original [JBStickyRewardPocket](https://github.com/mejango/sticky/blob/7600fa076d3c2defb9929a52acd8cf0a33dd6036/src/JBStickyRewardPocket.sol) is the historical destination basket that evolved into `StickyRewardReceiver`. The archived [JBXDistributor.bridgeToMainnet](https://github.com/Bananapus/nana-jbx-distributor-v6/blob/09dd1b564fd9ceb2cb6e25bc253c0fefd4f7ea19/src/JBXDistributor.sol) already allowed permissionless source reward preparation, but targeted its own mainnet reward ledger. The collector supplies that source role for the current Sticky receiver/distributor without introducing another reward ledger. The qualification's initial description of a source-delivery gap referred to this current integration, not an absence of prior permissionless designs.

The deployed Sticky source matches revision `f8928002c0685b29e327014e5ae4221a5bd53e08`; the confidence branch starts from client release `db8966c4efdc8ae0f69684a047c4ccb9e2173176`. All six existing suite creation bytecodes in the final compilation exactly match their Ethereum deployment artifacts, so adding the collector does not change those deployment predictions. All ten Ethereum manifest runtime identities are checked by [the deployed fixture](../test/fork/helpers/StickyJbxDeployedFork.sol), alongside immutable bindings and canonical JBX at `0x4554CC10898f92D45378b98D6D6c2dD54c687Fb2`.

Candidate pool settings are zero cashout tax and transferable shares; the tax choice remains provisional. Those launch settings are permanent. Group 0 is the planned reward policy, chosen per funding or receiver route; the pool can also receive other reward groups. Group 0 allocates by snapshot: acquiring shares temporarily before a snapshot and exiting afterward can retain rewards. It does not require continued staking. The first eligible snapshot matters because snapshots are shared across pools; zero-eligible funding can be recycled in a later round. JBP6 and REV remain separate reward tokens; AutoStick does not swap them into JBX.

## Historical source configuration

V6 project 1 is named **Juicebox Protocol V6**, symbol **JBP6**, token `0x6b50843C88290c180DF24c445E37B296d9760FA8`. The user's “JBP1” refers to this project. V6 project 3 is **Revnet Network**, symbol **REV**, token `0x3dD82a891C80Db068e95708E83583d626E2c1Fac`. These identities agree on all four chains.

At the pinned state, all project 1 reserves go to Safe `0x4dc161eF837fF1C4485b08DDFcDB182F2157bE18` (4-of-8), and all project 3 reserves go to Safe `0x6b92c73682f0e1fac35A18ab17efa5e77DDE9fE1` (3-of-7). None currently routes to Sticky. The current operators hold the required split-edit permission. Existing and future stage tables must be reviewed separately; distribution uses the table effective when pending reserves are distributed.

REV reserves 38% in all twelve configured stage tables. The requested approximately 10% of total issuance therefore uses `263157895 / 1000000000` of reserves, leaving `736842105 / 1000000000` for the existing recipient. Before integer mint/distribution rounding, this is `38% × 26.3157895% = 10.000000010%` of issuance subject to reserves. Automatic issuance and bridge remints bypass reserves; this configuration does not independently capture 10% of those mints. Project 1 reserves 62%; its desired Sticky allocation must be specified in the final routing configuration.

| Chain | REV configured stage IDs, oldest first |
| --- | --- |
| Ethereum | `1781612819`, `1781612820`, `1781612821` |
| OP | `1781587747`, `1781587748`, `1781587749` |
| Base | `1781587797`, `1781587798`, `1781587799` |
| Arbitrum | `1781633534`, `1781633535`, `1781633536` |

The next stage starts February 10, 2027; the final stage starts December 19, 2036 and has zero payment issuance weight. Both retain the same reserved percentage.

The fixed-route qualification used a direct Ethereum distributor hook and plain remote collector beneficiaries. That setup is superseded. For the current design on every source, including Ethereum, set `hook = verified Ethereum-home collector`, `beneficiary = confirmed Ethereum Sticky JBX share token`, and `projectId = 0` for group 0. Plain collector beneficiaries do not create pending entitlements. Follow the [current setup recipe](../DEPLOYMENT.md#source-collectors) before editing any source split; the fee child must never receive reserved allocations.

## Current delivery and recovery

The current collector family queues authenticated allocations by source project, home-chain Sticky token and group. Anyone may call `settle(sourceProjectId, stickyToken, groupId, amount)` on Ethereum, or `send(sourceProjectId, stickyToken, groupId, amount, sucker, backingToken)` on a qualified remote source, for a positive partial pending amount. The route is checked at delivery; a valid replacement must still point directly to Ethereum. A zero backing quote is allowed. Supply the current registry fee plus native transport budget, with gas separate. Historical `send()` signatures, positive-only quotes and fixed-fee amounts below are not operative APIs.

A failed delivery restores accepted custody atomically; incorrect acceptance configuration can instead make core burn unconsumed ERC-20 reserves or leave credits unattributed. Source submission, native finalization, destination claim, receiver settlement and holder collection each require their own canonical evidence. The receiver needs the destination reward ERC-20 before a remote claim. No collector deployment or keeper operation is established by these historical tests. The complete authority, retry and recovery boundaries live in [DEPLOYMENT.md](../DEPLOYMENT.md#source-collectors).

## Verification record

These results belong to the qualification revision merged in `137e607`. They establish that revision's evidence; subsequent changes and validation are recorded in the [collector audit](../SOURCE_COLLECTOR_AUDIT.md).

- **Passed:** Final combined local suite: 259 cases across 18 suites, including the 34 new collector cases, six invariant assertions at 1,024 runs / 102,400 handler calls and six fuzz functions at 4,096 runs each. The non-vacuous funding/collection tripwire passed. The unchanged baseline had also passed its 225 cases before the collector was added.
- **Passed:** 20 actual-deployment JBX lifecycle cases and five actual-deployment authority cases. Coverage includes 100 million actual JBX across two holders, exact zero-tax round trips, eight tax/transfer-mode combinations, donation/orphan/rounding cases, real JBP6 and REV payment-issued rewards, vesting/one-time collection, zero-eligible round recovery, signed forwarding/replay/tampering/expiry and unauthorized ruleset mutation.
- **Passed:** 34 focused collector cases, including callback-delivered principal isolation, transport/receipt/refund rollback, preexisting outbox restoration, reentrancy, dust, changing quotes/fees and excluded donations. Two independent source reviewers found no unresolved blocker in the collector and fee-child custody boundaries.
- **Passed:** Slither 0.11.3 with the CI `--fail-medium` policy, analyzing 130 contracts with 77 detectors. Its 87 remaining low-severity reports concern existing source. Three collector reports concern deliberate zero guards and intentionally unused preview fields; narrowly scoped comments document why those detectors do not indicate a defect. Executable behavior was unchanged.
- **Passed:** 46 deployment/runner Node checks across the initial run and a rerun of the loopback-server test, which the filesystem/network sandbox initially blocked from binding `127.0.0.1`.
- **Passed:** All ten existing-route cases: six manual-custodian native routes, two direct Ethereum reserved split hooks and two emergency-exit constraints. Arbitrum's fixture now distinguishes RPC height from EVM L1-style height and captures the actual ArbSys CALL opcode because Foundry omits mocked calls from its account-access recorder. The wrapper enables the required `-vvv` tracing and serial execution. Debug-trace copying gas is test overhead, not production transaction gas.
- **Passed:** Strict production lint and contract-size checks, deployment-entrypoint compilation and formatting. Collector runtime is 4,003 bytes; its fee payer is 1,701 bytes. Both are below the EVM runtime-size limit.
- **Passed:** Final complete `npm run test:fork`: 75 cases across six suites, zero failures/skips. This includes 34 historical regressions, 25 deployed JBX/authority cases and all 16 route cases. All six permissionless collector routes reach real destination minting, receiver settlement, vesting/collection and JBX redemption. REV uses the requested split fraction, preserves the existing Safe's remainder and checks controller rounding dust. Only setup impersonates the authorized Safe; an unrelated keeper distributes and sends. Exact source leaf, supply, escrow and caller fee-receipt checks accompany the shared transport proof.

The final contract total is **334 passing cases**: 259 local plus 75 fork cases. The archive-RPC CI workflow runs the complete fork suite with all four chain variables, verbosity required by opcode capture, and one worker. Local tooling uses Node 22.23.1, Forge 1.8.1 and the committed dependency pins; the [toolchain record](sticky-jbx-toolchain.md) describes the isolated installation.

The lifecycle fixture transfers existing JBX under a fork-only holder impersonation and proves inventory and supply conservation. Reward acquisition pays actual deployed terminals with bounded test ETH. It does not replace ERC-20 balances, contract code, project backing storage or bridge escrow.

The route tests execute source preparation and deployed bridge/messenger contracts using captured messages and actual escrow. They model only the consensus-established sender/finality boundary and Arbitrum's unsupported precompile response. They do not establish withdrawal inclusion/finality, outer Portal/outbox spent-message protection, or operational relayer availability. The route fixture pins four chains and six native inbound lanes; it does not execution-test every registered CCIP or other directional lane.

## Before live routing

Follow [the source-collector setup and verification recipe](../DEPLOYMENT.md#source-collectors). Sticky JBX still requires a confirmed live pool/receiver, the verified Ethereum-home collector family and fee child on each participating source (shared by JBP6 and REV), authorized split edits, and bounded acceptance, delivery, finalization, settlement and collection through each lane before scaling funding. Resolve project 1's percentage and the treatment of any automatic REV issuance separately. Neither the historical fork evidence nor a predicted next project ID supplies those live identities or receipts.

Source review and fork evidence increase confidence in the tested behavior; they are not a formal audit or proof that every contract, dependency and bridge failure is impossible.
