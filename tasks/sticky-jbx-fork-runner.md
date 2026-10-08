# Four-chain fork runner and CI wiring

## Plan refinement

- **Objective:** Make the default contract fork qualification require Ethereum, Optimism, Base and Arbitrum RPCs before Forge starts, while preserving focused lifecycle commands and unchanged Forge arguments. Wire the two additional CI secrets without modifying secrets, deployment settings or web code.
- **System fit:** The existing `script/test-fork.sh` owns environment loading and fork-profile execution; the existing contract workflow supplies credentials and invokes that runner. New pinned fork suites consume those RPCs. This change checks configuration readiness; actual contract and bridge evidence remains with the coordinated Forge qualification owners, and no live execution is authorized.
- **Reuse and simplicity:** Keep one shell runner and the existing Node deployment-test gate. A short scan for explicit contract/path/test filters preserves the old Ethereum/Base preflight for focused commands; Foundry reports any additional RPC required by selected tests. Default or ordinary unfiltered flags require all four. Do not add suite-name policy, a selector parser, a runner or dependencies.
- **Evidence and unknowns:** The current workflow fork step supplies only `RPC_ETHEREUM_MAINNET` and `RPC_BASE_MAINNET`; new omnichain fixtures need `RPC_OPTIMISM_MAINNET` and `RPC_ARBITRUM_MAINNET`. Root owns providing the latter GitHub secrets. Foundry v1.8.1 and the pinned contract Node22.23.1 toolchain remain unchanged. Stub tests prove the shell boundary, not RPC availability or fork execution.
- **Verification:** Run focused Node tests using a temporary copied runner and stub Forge: missing and empty RPCs, full and filtered invocations, preserved arguments/profile, explicit/default environment files, and child exit propagation. Check that the workflow's owning fork step maps all four secret names, run shell syntax and scoped whitespace checks, and obtain bounded independent review. Do not run real Forge while other qualification owners hold its queue.
- **Resource budget:** One small source edit, one workflow edit and one dependency-free regression file. Reuse existing installs and coordinate all real Forge runs through root. Run the failure-before regression once and final focused tests once unless a concrete failure requires correction; no build or RPC requests are needed.

- [x] Read required workspace resources and current qualification/source-delivery plans; resolve minimal filtered-run policy with root.
- [x] Pass the plan refinement gate before implementation.
- [x] Add stub-runner regressions and demonstrate the missing four-chain preflight/wiring.
- [x] Update the owning runner and workflow, then pass focused verification and independent review.

## Review

The new stub suite first reproduced six failures: missing/empty Optimism and Arbitrum RPCs reached Forge, ordinary unfiltered flags bypassed the missing additional RPCs, and the CI fork step lacked its Optimism mapping. After the minimal runner and workflow edits, all 21 new cases and 15 existing mocked deployment-runner cases pass under Node22.23.1 (36 total). Shell syntax and scoped whitespace checks pass. Logs are `/private/tmp/sticky-jbx-fork-runner-before.log` and `/private/tmp/sticky-jbx-fork-runner-final.log`.

The runner preserves every supplied Forge argument, the fork profile, environment-file precedence and subprocess exit status. Explicit contract/path/test filters, including the documented `--match-contract 'StickyJbx(Lifecycle|Authority)ForkTest'`, keep the prior Ethereum/Base preflight. Actual selected tests remain responsible for additional RPC requirements. Unfiltered runs require all four archive endpoints.

Independent source review found no blockers in the four scoped files and confirmed the unchanged fork-PR trust gate, isolated test environment and agreed focused-run policy. GitHub secret changes and real fork execution remain owned by root and the existing qualification queue. The two additional required secret/environment names are `RPC_OPTIMISM_MAINNET` and `RPC_ARBITRUM_MAINNET`; no credentials or live settings were changed.

## Plan refinement

- **Objective:** After the fork owner verifies Foundry1.8.1's debug-trace prerequisite, make the shared wrapper supply `-vvv` so its default and CI commands can capture the real Arbitrum precompile call. Run the fork suite with one worker to bound RPC and debug-capture resources.
- **System fit:** The Arbitrum helper owns call capture and bridge assertions; `script/test-fork.sh` owns the Forge invocation used by local and CI qualification. Add the demonstrated trace prerequisite there, preserving environment, selection and execution policy. No Solidity, wallet or production settings are changed by this follow-up.
- **Reuse and simplicity:** Add standard Forge `-vvv --threads 1` arguments to the existing invocation and update its existing stub expectation; add no runner, argument parser, suite-name policy or workflow branch. Callers use the wrapper's fixed serial setting; no unverified duplicate-flag override is promised.
- **Evidence and unknowns:** Root reports mocked ArbSys calls bypass state-diff capture. The fork owner proved opcode debug capture with `-vvv` under pinned Foundry1.8.1. Root also observed archive fetch resets with two workers and authorized serial execution within the existing 30-minute fork-step cap. Stub evidence alone cannot prove opcode trace availability or RPC reliability.
- **Verification:** Preserve the fork owner's bounded runtime result, then run the existing focused stub suite with the explicit `-vvv` expectation plus shell syntax and scoped whitespace checks. Root's full qualification remains the final end-to-end proof.
- **Resource budget:** Only runner, its existing regression expectation and this refinement record change. Coordinate with the current Forge owner; run no real Forge process or duplicate runtime probe.

- [x] Receive the pinned runtime proof before executable edits.
- [x] Add the wrapper verbosity prerequisite and pass its existing regression checks.

The fork owner verified `test_arbitrumProjectOne_manualCustodianToEthereumJbx` under pinned Forge1.8.1 with `-vvv` in 20.74 seconds, including real opcode capture, ArbSys native credit, deployed bridge authorization/delivery and the destination lifecycle. Evidence: `/private/tmp/sticky-jbx-omnichain-arbitrum-trace.log`. The wrapper now supplies `-vvv --threads 1` for both local and CI usage; callers need not repeat either setting. The existing argument regression failed before the trace prerequisite was added and all 21 stub cases pass on the final serial invocation; shell syntax, whitespace and plan gates pass. Follow-up logs: `/private/tmp/sticky-jbx-fork-runner-trace-before.log` and `/private/tmp/sticky-jbx-fork-runner-trace-final.log`. No duplicate real Forge probe was run by this tooling owner.
