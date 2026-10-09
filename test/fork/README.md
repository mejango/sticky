# Real-project fork tests

The original suites run Sticky against the deployed V6 projects on Base `6` (Artizen,
`ART`) and Ethereum `3` (Revnet Network, `REV`). They create Sticky locally through
the production deployment helper, verify its bindings, and launch projects backed
by the existing project tokens. Underlying tokens are acquired by paying the live
project's native-token terminal. No ERC-20 balances, contract code, or project
configuration are replaced.

The `StickyJbx*` suites instead use the already deployed Ethereum Sticky suite,
canonical JBX, and current V6 project `1`/`3` reserved rewards. Their independent
pins and additional transport boundaries are described below.

## Run

Use the pinned workspace dependencies and Foundry version in the root
[README](../../README.md#develop-and-check). Provide Ethereum, OP, Base and Arbitrum archive RPCs
through `.env`, exported variables, or the existing deployment environment:

```sh
STICKY_ENV_FILE=../../deploy-all-v6/.env npm run test:fork
STICKY_ENV_FILE=../../deploy-all-v6/.env npm run test:fork -- --match-contract StickyBase6ForkTest
STICKY_ENV_FILE=../../deploy-all-v6/.env npm run test:fork -- --match-contract StickyEthereum3ForkTest
STICKY_ENV_FILE=../../deploy-all-v6/.env npm run test:fork -- --match-contract StickyCrossChainRewardsForkTest
STICKY_ENV_FILE=../../deploy-all-v6/.env npm run test:fork -- --match-contract 'StickyJbx(Lifecycle|Authority)ForkTest'
STICKY_ENV_FILE=../../deploy-all-v6/.env npm run test:fork -- --match-contract StickyJbxOmnichainForkTest
STICKY_ENV_FILE=../../deploy-all-v6/.env npm run test:fork -- --match-contract StickySourceCreditsForkTest
```

The wrapper selects the `fork` profile, using the same non-isolated production
artifact inspection as deployment rehearsals, and fails if a required RPC
variable is missing. A missing archive block, wrong chain, unavailable project, failed
payment, or missing bridge route fails the suite. Tests contain no RPC skip
guards. Default `forge test` runs the local suites without requiring public RPCs.
The wrapper supplies `-vvv` for the Arbitrum opcode capture and runs one worker to
bound archive-RPC pressure and trace memory. Direct Forge invocations of the
Arbitrum cases also need at least `-vvv`. Foundry's account-access recorder omits
mocked precompile calls; the opcode recorder preserves their actual CALL target,
value and full calldata without replacing the deployed bridge code.

The regular test workflow runs the fork suite on main-branch pushes, manual runs,
and pull requests originating in the same repository. External pull requests run
the local checks; their fork suite must be run from a reviewed revision with RPC
access. CI needs `RPC_ETHEREUM_MAINNET`, `RPC_OPTIMISM_MAINNET`,
`RPC_BASE_MAINNET` and `RPC_ARBITRUM_MAINNET` secrets. Sphinx and
wallet credentials are unnecessary for these tests.

## Pinned state

| Chain | Block | Block hash | Existing project token |
| --- | --- | --- | --- |
| Base | `51218441` | `0x8a01ed27f4d292f665be2eb0901e0224f7d1cd0129e103de0f04d792dfc41a97` | Project `6`: `0x44c4516768e47cd97cfF2561B81a74699F23f8Ec` |
| Ethereum | `25962175` | `0x79b726290770722b62d4bad4a0cdff6d412fc2230fc7dbec73ca55d0921982ba` | Project `3`: `0x3dD82a891C80Db068e95708E83583d626E2c1Fac` |

The block constants live in [the shared fixture](helpers/StickyRealProjectFork.sol).
Update the constants and this evidence together after reviewing project and
bridge configuration changes. Passing these historical forks does not establish
the state at a later deployment block.

## Lifecycle coverage

Validation on 2026-09-12 passed all 34 tests with `--deny notes`: 14 on each
underlying project and six cross-chain cases, with zero failures or skips.

[StickyRealProjects.t.sol](StickyRealProjects.t.sol) runs the same scenarios
against both projects:

- Real token acquisition, production Sticky launch, permanent project rules,
  reviewed stake previews, multiple deposits, and tranche ages through exits.
- Granter and holder consent, trust revocation, soulbound transfer rejection,
  transferable shares, voluntary burns, and historical checkpoints.
- Donations, stale minimum protection, orphaned backing, restart, and complete
  withdrawal while another holder retains one share atom in either transfer mode.
- Taxed partial and full cash-outs, comparing gross quotes with actual net wallet
  receipts and terminal backing.
- Weekly rewards with four vesting rounds, unequal holder allocations, transfers
  and burns after funding, and exclusion of deposits after the snapshot.
- Collection and auto-stick consent, approval-failure atomicity, retry, staking
  after exit, and donation-adjusted compounding that spends only collected rewards.

## Cross-chain coverage and boundary

[StickyCrossChainRewards.t.sol](StickyCrossChainRewards.t.sol) resolves
Ethereum `3`'s deployed native-token sucker route to Base `3` (Revnet Network,
`REV`), a separate project from Artizen. Both sides use sucker
`0xA2b081638dC179Dbb7e63f338357cEA2487bb933` and project token
`0x3dD82a891C80Db068e95708E83583d626E2c1Fac`. The L1 messenger is
`0x866E82a600A1414e583f7F13623F1aC5d58b0Afa`; the Base messenger is
`0x4200000000000000000000000000000000000007`.
It buys real source tokens, prepares a leaf addressed to the predicted destination
Sticky receiver, sends the actual outbox root, and captures the live L1 messenger's
message. The proof uses the outbox's existing Merkle frontier, including leaves
that predate the test.

The test delivers that exact message through the deployed Base messenger,
impersonating the canonical aliased L1 messenger and crediting the matching ETH.
This models the portal deposit boundary. Both messengers, both suckers, the
destination mint and backing accounting, receiver settlement, vesting, auto-stick,
and the final Sticky cash-out execute actual contract code. Negative cases check
unauthorized delivery, a false remote sender, altered beneficiary/metadata/proof,
message replay, duplicate claims, retry after an early claim, and source slippage
rejection without burning tokens or changing the outbox.

This suite does not run a portal consensus proof, sequencer, finality delay,
off-chain relayer, or browser wallet. It covers the Ethereum-to-Base native route;
reverse withdrawals and alternate-token routes require separate bridge checks.
The existing [deployment rehearsals](../../DEPLOYMENT.md) cover singleton deployment
and restart across all eight configured networks. Neither suite broadcasts a
transaction or creates a Sphinx proposal.

The Base-home hook cases in this suite configure actual project `3` reserved splits
through a collector bound immutably to Base. One settles a Base-local allocation;
the other accepts Ethereum reserves, submits through the deployed Ethereum-to-Base
route, and reuses the same modeled portal boundary before claim, settlement and
holder rewards. The six existing pool singletons retain their identities. These
tests qualify that direct route; they do not establish OP-to-Base or
Arbitrum-to-Base delivery.

## Deployed Sticky JBX qualification

[StickyJbxLifecycle.t.sol](StickyJbxLifecycle.t.sol) reuses the existing lifecycle
scenarios through [StickyJbxDeployedFork.sol](helpers/StickyJbxDeployedFork.sol).
It selects the deployed suite rather than creating a replacement, verifies every
manifest runtime/binding, and obtains real JBX from an existing holder on the fork.
No ERC-20 balance, code or storage replacement supplies the position. Additional
cases exercise 100 million JBX across two holders, the provisional zero-tax
transferable policy, eight tax/transfer-mode combinations, actual JBP6/REV reward
issuance, and recovery of a startup round with no eligible shares.

[StickyJbxAuthority.t.sol](StickyJbxAuthority.t.sol) pins and calls the deployed
forwarder/operator/permissions contracts. Local test-key signatures cover valid
forwarding, wrong signer, tampering, replay and expiry; an unrelated caller cannot
queue rulesets through the operator. No user key or signature is used.

[StickyJbxOmnichain.t.sol](StickyJbxOmnichain.t.sol) exercises actual source
reserved-token distribution and native routes into Ethereum for projects `1`
(JBP6) and `3` (REV). The [source fixture](fixtures/sticky-jbx-sources.json)
records the deployed core/token/sucker runtime identities, implementation
bindings, current custodians and enabled native mappings.

| Chain | Block | Canonical block hash |
| --- | --- | --- |
| Ethereum | `26149188` | `0xaddf5db4175ca8a6c92885cee2619e4012b867f8ff15ff42889de2de1b98784e` |
| OP | `157940574` | `0x7653b5502773e096dc637685b97fc5c24970bbf61d9831f0739bdbe7180e4a70` |
| Base | `52345331` | `0x7d3b8898d9c8959201d6c5171b70f6a7bdb56c454e602f19d41d6a0e74cc4d45` |
| Arbitrum | `512949569` | `0x2b04b520d63191f0d7bb70e9055215e9c9852bc2707c7a3936062f433eb05386` |

Each case verifies the chain, pinned block hash and parent identity before test
mutations. The Arbitrum RPC block identity is distinct from the EVM's L1-style
`block.number`; the fixture must respect that distinction. Runtime checks reject
missing or changed route implementations. Tests fund a payer/keeper with bounded
native ETH, then pay actual terminals and fees; project-token issuance and bridge
escrow remain governed by deployed code.

The OP/Base helper captures the real L2 messenger call and relays it through the
deployed Ethereum messenger. OP's Portal uses its real ETH lockbox; Base uses the
Portal's escrow. The Arbitrum helper captures the actual ArbSys call and executes
the real Ethereum Bridge through the rollup's currently allowed outbox. Escrow,
destination native backing and token mint deltas must agree exactly.

Only consensus-established sender/finality context and the unsupported ArbSys
precompile response are modeled. Tests do not establish withdrawal proof
inclusion/finality, the outer Portal/outbox spent-message protection, or a running
relayer. Destination early/tampered/duplicate claims and unauthorized bridge
delivery are checked separately. Successful arrival continues through fixed
receiver settlement, four-round vesting, one-time holder collection and JBX
redemption. Direct Ethereum cases use the same shared reserved split hook and
then permissionlessly settle its attributed custody through the existing receiver.

Manual-custodian cases exercise the shipped bridge path. Separate shared-hook cases
deploy the parent and fee child on local forks through the production deployment
helper, configure `hook = collector`, `beneficiary = Ethereum Sticky share token`
and `projectId = reward group`, then use an unrelated caller to distribute and
submit rewards. Receipt must only credit the selected pending bucket; the outbox
cannot change until a separate delivery call. These cases check principal/fee
receipt separation, the requested REV fraction and remainder, atomic retry after
insufficient fees, and the actual source leaf before reusing the destination proof.
The four-chain deployment cases compare the full hook/child runtime and addresses
within both the Ethereum-home and Base-home families, check receiver prediction
parity, and prove the six existing singleton runtimes remain unchanged. Different
home chains must have different collector and fee-child addresses. A real OP
reserved-split allocation into a Base-home family stays queued when the caller
tries its Ethereum peer; the Ethereum-home family cannot spend that allocation.
Address parity establishes a family identity, not a direct transport path between
every source and home chain.

The Ethereum-to-Arbitrum refund case captures the real unsafe root-retryable
payload on the Ethereum fork and verifies that it names the raw fee-child address.
It then deploys the same Arbitrum-home family on the Arbitrum fork, checks equal
parent and nonce-1 child addresses and the child-to-parent binding, and uses
`vm.deal` to model only the finalized ArbOS balance credit. A permissionless call
must add that complete raw balance to project 1 through its live native terminal,
mint no project tokens and pay nothing to the caller. The same case separately
funds the computed safe-Inbox alias and proves that balance remains untouched.
The test does not execute or prove retryable finality. The separate local transport regression proves that
the gateway request names `feeChild` and that its Nitro alias is distinct.
Pinned `AbsInbox` source establishes that the safe Inbox rewrites a contract
refund recipient to that alias; this test does not execute the gateway or Inbox
rewrite. The raw-address contribution does not cover that account, so positive
mapped-ERC-20 backing remains unqualified. Pinned WETH gateway/Inbox source also
shows that cancellation or expiry can credit bridged call value to
`alias(source sucker)`, which Sticky does not control; this fork case does
not execute that cancellation path.

Generic source cases launch ordinary projects with IDs above `3` through deployed
core. The OP tests cover zero native backing, zero ERC-20 backing, and positive
six-decimal USDC.e backing through a real registered OP sucker. The positive case
supplies bounded test USDC.e inventory with `deal`; payment, project issuance,
treasury cashout, project-token burning, selected outbox, canonical L2 bridge token
burn and emitted root all execute real contracts. A foreign-address backing
mapping models registry-owner setup where necessary. These generic transport
cases qualify source submission only: they do not create a destination project
or prove ERC-20 withdrawal finalization or L1 escrow release.

[StickySourceCredits.t.sol](StickySourceCredits.t.sol) tests the real controller's
credits-before-callback path for another generic source. A missing ERC-20 blocks
delivery while preserving the pending bucket and actual credits. Deploying the
project's ERC-20 permits partial and full permissionless settlement, preserving
ordinary holders' credits and funding the existing Sticky reward ledger exactly.

These local deployments do not establish live collector configuration or a running
keeper. Unsent manual leaves are also tested for their
source-chain emergency-beneficiary limitation. See the
[qualification record](../../tasks/sticky-jbx-qualification.md) for completed
results and exact proposed allocation, and [the deployment recipe](../../DEPLOYMENT.md#source-collectors)
for remaining live actions.
