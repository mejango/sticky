# Sticky JBX qualification — 2026-10-08

This record distinguishes the already deployed Sticky system, new source-delivery code, and the configuration still needed for an Ethereum Sticky JBX pool. No mainnet transaction, split edit, deployment, or user signature was sent during qualification.

## Plan refinement

- **Objective:** Establish reproducible confidence in canonical Ethereum JBX custody and delivery of V6 project 1/JBP6 and project 3/REV reserved rewards from Ethereum, OP, Base and Arbitrum. The user requires permissionless delivery after setup; zero stickiness bonus is provisional, shares may be transferable, and rewards use group 0 without staking-age criteria.
- **System fit:** Source issuance and authorized split configuration feed existing bridge and reward contracts. The new fixed-route collector fills the source-custody initiation step; deployed suckers, canonical transports, receiver, distributor and holder redemption retain their existing responsibilities. The confirmed launch identity and source Safe authorizations precede live configuration.
- **Reuse and simplicity:** Extend the existing fork fixtures, deployed contracts and CI runner. Keep source collection separate from permanent Sticky pool accounting; reuse core cashout previews and protocol fee arithmetic. A minimal child fee payer prevents callback-delivered reserved principal from being mistaken for the caller's bridge-fee receipt.
- **Evidence and unknowns:** Tests pin canonical block hashes and live runtime identities. Native transport consensus/finality is modeled explicitly; no test proves real-world finalization or a running keeper. A simulated next project ID is not a launch identity. New collector code is not a deployed capability.
- **Verification:** Execute deployed JBX lifecycle and authority tests, direct Ethereum reserved splits, both reward projects on all three inbound native routes, and collector rollback/fee/callback regressions. Run local invariants, strict Solidity lint/build, deployment tooling and static analysis; record exact results below as completed.
- **Resource budget:** Reuse the pinned dependency checkout and one coordinated Forge queue. Independent custody and route reviewers inspect disjoint concerns; expand work only for concrete failures. Keep the four-chain fixture and test commands as the repeatable evidence.

## Existing deployment and selected behavior

The previously shipped omnichain design is present: a per-pool/group receiver can receive bridged project tokens, anyone can settle it, and the distributor handles reward eligibility, vesting and collection. The client already supports wallet-owned source tokens being prepared and bridged. Source tokens held by a reserved-split recipient need a callable source action; pointing that split at an Ethereum receiver's numeric address does not bridge them.

The deployed Sticky source matches revision `f8928002c0685b29e327014e5ae4221a5bd53e08`; the confidence branch starts from client release `db8966c4efdc8ae0f69684a047c4ccb9e2173176`. All six existing suite creation bytecodes in the final compilation exactly match their Ethereum deployment artifacts, so adding the collector does not change those deployment predictions. All ten Ethereum manifest runtime identities are checked by [the deployed fixture](../test/fork/helpers/StickyJbxDeployedFork.sol), alongside immutable bindings and canonical JBX at `0x4554CC10898f92D45378b98D6D6c2dD54c687Fb2`.

Candidate pool settings are zero cashout tax and transferable shares; the tax choice remains provisional. Those launch settings are permanent. Group 0 is the planned reward policy, chosen per funding or receiver route; the pool can also receive other reward groups. Group 0 allocates by snapshot: acquiring shares temporarily before a snapshot and exiting afterward can retain rewards. It does not require continued staking. The first eligible snapshot matters because snapshots are shared across pools; zero-eligible funding can be recycled in a later round. JBP6 and REV remain separate reward tokens; AutoStick does not swap them into JBX.

## Source configuration

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

Ethereum uses the existing distributor split hook: `hook = StickyDistributor`, `beneficiary = confirmed Sticky JBX share token`, `projectId = 0` for reward group 0. OP, Base and Arbitrum use a plain split beneficiary equal to the corresponding source collector, with no split hook and `projectId = 0`. The collector fixes the canonical native sucker and the confirmed Ethereum receiver. Its fee-payer child must never be a reserved-split beneficiary.

## Delivery and recovery

After authorized setup, anyone can distribute pending reserved tokens and call the source collector's `send()` with the registry's exact fee. It prepares its entire source-token balance with a fresh positive cashout minimum, clears its allowance, submits the outbox and verifies that its leaf was included. The current registry fee is 0.001 ETH per source submission, plus transaction gas; re-read it before sending. The caller receives their fee-payment JBP6 receipt or failed-payment refund. New reserves received during that fee payment remain in the parent collector.

A failed preparation, transport call, fee refund or sent-leaf check reverts the complete source transaction. The collector introduces no owner, arbitrary withdrawal or alternative destination. If the fixed route becomes permanently unusable before submission, held tokens cannot be rescued through this contract; operators can redirect future reserves by changing unlocked splits. Once submitted, native bridge proving/finalization and the destination claim still need execution. Permissionless means any eligible caller may perform these steps; it does not mean an unattended keeper is deployed or that delivery is immediate.

After finalized transport, anyone can submit the sucker Merkle claim to the fixed receiver, then settle that receiver into the distributor. Holders collect their vested allocation. Unsent leaves created through the older manual bridge path have a separate limitation: emergency exit remints to the leaf beneficiary on the source chain, which is not necessarily a usable source custodian. Atomic collector submission avoids leaving its own unsent leaf when transport reverts. It cannot undo a successfully submitted native withdrawal.

## Verification record

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

1. Finalize permanent pool settings, create Sticky JBX through the verified Ethereum deployer, and read the confirmed project/share-token identity from the receipt.
2. Predict/deploy the group-0 receiver through the verified receiver factory and confirm its pool, group and distributor bindings. Do not use a simulated next project ID.
3. Deploy and verify the six collectors against the reviewed source revision and canonical native suckers. Verify parent/child bindings and exact receiver before assigning funds.
4. Prepare source-authorized split edits for every configured stage on all four chains, preserving the remainder and any locks. Resolve project 1's percentage and the treatment of any automatic REV issuance separately.
5. Establish an eligible JBX holder snapshot, then exercise a bounded live reward delivery through every lane, including native finalization, destination settlement and holder collection. Record receipts and monitoring ownership before scaling funding.

Source review and fork evidence increase confidence in the tested behavior; they are not a formal audit or proof that every contract, dependency and bridge failure is impossible.
