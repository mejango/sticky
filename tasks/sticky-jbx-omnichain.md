# Deployed V6 reserved rewards into Ethereum Sticky JBX

- [x] Reduce the live source inventory to a committed, pinned test fixture.
- [x] Implement two Ethereum split-hook cases, six inbound native-route cases, and two source emergency-exit cases.
- [x] Capture actual source bridge calldata and execute actual destination messenger/bridge contracts.
- [x] Pass the pinned Foundry build/lint and all ten initial fork cases.
- [x] Verify the behavior-preserving proof/destination-helper extraction before collector integration.
- [x] Reuse the qualified transport and destination lifecycle for the approved permissionless source collector.
- [x] Record final results and remaining boundaries.

## Plan refinement

- **Objective:** Qualify actual V6 project 1 (symbol JBP6) and project 3 (REV) reserved issuance reaching an Ethereum Sticky JBX holder under the provisional zero-tax, transferable-share, group-0 policy. The first ten cases establish existing deployed behavior; the approved collector extension must separately remove the source Safe transaction from recurring delivery.
- **System fit:** Controller reserved accounting and split dispatch own issuance. The source sucker owns burn, backing reclamation, leaf preparation and transport submission. Actual messengers/bridge contracts own authenticated destination delivery; the destination sucker owns claim and counterpart minting. Existing Sticky receiver/distributor contracts own settlement, vesting and holder-directed collection. No live configuration, signature, deployment or broadcast occurs.
- **Reuse and simplicity:** Inherit the shared deployed-JBX fixture and reuse the actual production contracts, Merkle library and emitted calldata. Keep OP/Base and Arbitrum consensus adapters in separate small helpers. Do not replace tokens, contracts, storage or backing. The committed census owns chain/block/hash/runtime identities.
- **Evidence and unknowns:** The current reserved tables pay known Safes without a hook; recurring source preparation therefore requires custody authorization. Native backing is enabled for all six selected inbound routes, while USDC and project-token backing are not qualified. OP's Portal uses the deployed ETHLockbox at the pinned state; Base retains Portal escrow. Real Arbitrum Bridge escrow funds the destination call. Exact runtime execution remains a gate, not an inferred pass.
- **Verification:** Check source issuance/pending reserve/custodian deltas, real burn and backing conservation, exact appended Merkle proof and emitted root/value, rejection before delivery and of unauthorized/wrong-peer delivery, actual destination mint/backing conservation, duplicate claim, exact receiver settlement, zero residual approval, locked then vested rewards, permissionless holder-only collection and full JBX redemption. Test that unsent emergency exit credits the leaf beneficiary on the source, while a sent leaf cannot exit locally. Run pinned Forge 1.8.1 with `--deny notes` under root's serial execution queue.
- **Resource budget:** One main test/fixture writer, one OP/Base helper writer and one Arbitrum helper writer. Shared deployed-JBX and collector implementation have separate owners. No overlapping source edits or concurrent Forge builds. Run bounded smoke cases before the full initial route suite; rerun only affected checks after failures. Replan any new custody or transport boundary before implementation.

## Pinned state

| Chain | Block | Canonical block hash |
| --- | ---: | --- |
| Ethereum | 26,149,188 | `0xaddf5db4175ca8a6c92885cee2619e4012b867f8ff15ff42889de2de1b98784e` |
| Optimism | 157,940,574 | `0x7653b5502773e096dc637685b97fc5c24970bbf61d9831f0739bdbe7180e4a70` |
| Base | 52,345,331 | `0x7d3b8898d9c8959201d6c5171b70f6a7bdb56c454e602f19d41d6a0e74cc4d45` |
| Arbitrum | 512,949,569 | `0x2b04b520d63191f0d7bb70e9055215e9c9852bc2707c7a3936062f433eb05386` |

The live inventory source is `/private/tmp/sticky-jbx-source-inventory.json`; the reduced committed fixture contains the same selected block hashes, actual runtime hashes and reciprocal native routes. Actual project tables are checked again in each fork before mutation. Ethereum reward snapshots advance time into a fresh unpinned distributor round instead of replacing existing snapshot storage.

## Explicit transport and authority boundaries

OP/Base capture the real L2 messenger's paired message/value events. Delivery models authenticated Portal caller and its finalized L2-sender context; the real L1 messenger verifies context and records success/failure. OP first executes the real lockbox's authorized withdrawal into the Portal. Native value comes from existing escrow. Arbitrum records the real sucker's `ArbSys.sendTxToL1` calldata/value and models the unsupported precompile return, then invokes the real Bridge from its actual allowed outbox while supplying finalized L2 sender context. No test establishes consensus inclusion, withdrawal finality, actual Outbox spent-proof protection or availability of an off-chain relayer.

Negative wrong-peer relay attempts run under a fork snapshot, restored before the independent valid delivery. This preserves real messenger failure retention without creating a second successful withdrawal. Current-Safe impersonation in the six baseline cases represents source custody authorization, not permissionless source delivery or Safe signer consent. Local Ethereum split-hook cases represent an authorized fork-only current-table configuration; a permanent production route also needs every applicable future REV stage table configured.

## Review

The initial ten cases are qualified: eight passed together in `/private/tmp/sticky-jbx-omnichain-initial.log`; the corrected Arbitrum cases passed individually in `/private/tmp/sticky-jbx-omnichain-arbitrum-trace.log` (20.74 seconds) and `/private/tmp/sticky-jbx-omnichain-arbitrum-rev.log` (22.40 seconds). All use pinned Forge 1.8.1 and `--deny notes`. The initial Ethereum/OP smoke also passed both cases.

Two harness corrections were required. Foundry already exposes Arbitrum's L1-style EVM `block.number` (26,149,158) while its RPC block height is 512,949,569. The shared helper now validates both domains against the same pinned header and validates its RPC parent header directly; it never rolls Arbitrum to a synthetic height. Also, Foundry returns mocked calls before state-diff recording, so actual ArbSys call capture uses its opcode trace. The helper verifies the actual CALL target/value/full input and the native balance credited to ArbSys. The wrapper now owns `-vvv` and one worker for the tracer prerequisite and steady archive traffic. Debug trace copying accounts for the large reported Arbitrum test gas; that figure is not production execution gas.

The behavior-preserving extraction passed the existing OP and Arbitrum project-1 cases before collector tests were added (`/private/tmp/sticky-jbx-omnichain-refactor.log`, 2/2). Six collector cases reuse the same proof and destination lifecycle. Each configures the source table through the actual authorized Safe only in the fork setup, then unrelated callers distribute reserves and submit the bridge. REV uses the approved 263,157,895/1,000,000,000 reserve share, preserves the Safe remainder and accounts for controller rounding dust. Full-reserve JBP6 routing remains an explicit qualification setting, not a final live allocation.

Independent review accepted the collector cases, including the exact current caller fee-token receipt, source native escrow conservation, actual source mint/burn events, and emitted leaf/proof. The final OP REV smoke passed with those assertions (`/private/tmp/sticky-jbx-collector-smoke-final.log`, 1/1).

The final exact `npm run test:fork` exited 0: **75/75 tests across six suites, zero failures and zero skips**, including all 16 route cases (56.21 seconds), 20 JBX lifecycle cases, five deployed-authority cases and 34 historical regressions. Final log: `/private/tmp/sticky-jbx-final-fork.log`. The invocation used `PATH=/Users/jango/.foundry/versions/v1.8.1:/Users/jango/.nvm/versions/node/v22.23.1/bin:$PATH` and `STICKY_ENV_FILE=/Users/jango/Documents/jb/v6/evm/deploy-all-v6/.env`; the wrapper owns `-vvv --threads 1 --deny notes`. RPC values are not recorded here. This final run qualifies the final wrapper, shared pin helper, both transport helpers, all existing fork suites and all six collector integrations together.

Independent source review found no blocking false transport/accounting evidence across the ten cases and both helpers. Test payer/keeper ETH inputs are supplied locally for real terminal payments and registry fees; reward token balances, project backing storage, bridge escrow and deployed code are never replaced. The final combined runtime qualification is recorded above.
