# Sticky: Daybreak review handoff

**Prepared, not submitted or run.** This packet supports an independent review through the user's Daybreak access. No Daybreak result or external certification is established here. The final review bundle must bind the source identities below before any result is treated as a release review.

## Scope and source identity

Review Sticky's contracts, their actual V6 dependencies, deployment verification, the web client and the shared SDK rules used by all four client consumers. The intended first pool is Ethereum-home Sticky JBX, with provisional zero cashout tax, transferable shares and group 0, funded by V6 project 1/JBP6 and project 3/REV. Generic pools still require one home chain and individually qualified direct reward routes. Deployment and source configuration are outside this handoff's authority.

| Input | Identity and current status |
| --- | --- |
| Sticky baseline | `74dc08798976f2a78a560ee5b2c2c98656affc4b`; PR #58 |
| Final Sticky review commit | The supplied review bundle manifest records the final commit, tree and archive SHA-256; PR #58 may lag the local SDK-dependent client snapshot pending publication. |
| Current Solidity/source-script digests | [adversarial-equivalence-20261009.json](tasks/adversarial-equivalence-20261009.json), `sourceSHA256`; 34 files. This does not identify the uncommitted web, tests, JavaScript tooling or documentation. |
| Core Solidity | `feff600654aee6fb1747dded692f18068b2230a6` |
| Distributor Solidity | `44d6d5d2e7cca77422ee0ac4909cf42ccf7839b5` |
| Other Solidity dependencies | Exact root lockfile and remappings; reproduce the layout in [DEPLOYMENT.md](DEPLOYMENT.md#reproducible-checkout) |
| Shared SDK | Published baseline `@bananapus/nana-sdk-core@2.26.0`; remediation is a local preview targeting **2.27.0**, with package release pending. Reviewed SDK commit `a4022589502dada1507c1b40be7e9c13308bc630`; preview `2.27.0-preview.adversarial.9ee3da134017`, source digest `9ee3da13401741294223a507feaad88fead30fb35371d32992b9231125d1e027`. Package publication remains pending. Existing release policy derives React 41.0.0 from its core peer dependency, without React implementation changes. |
| SDK consumers | Sticky, Juicebox Money, Revnet Money and Homerun are being qualified against the local preview. The supplied bundle manifest records final commits, lockfile digests and installed-package identities for all four. A local preview is not a published release. |

### Finalize an exact review bundle

1. Record the full final commit and Git tree for Sticky, the SDK, all four clients and both linked Solidity dependencies. Sticky's client is part of its own repository. Record dirty status for each; a baseline commit plus a dirty working tree is not an exact review revision. Use committed snapshots for the final bundle, or explicitly attach and hash every reviewed patch and added file if an interim review is intentional.
2. Verify the current limited Solidity digest manifest from the Sticky root:

   ```sh
   python3 - <<'PY'
   import hashlib, json
   from pathlib import Path
   record = json.loads(Path('tasks/adversarial-equivalence-20261009.json').read_text())
   for name, expected in record['sourceSHA256'].items():
       actual = hashlib.sha256(Path(name).read_bytes()).hexdigest()
       assert actual == expected, f'Source changed: {name}'
   print(f"Matched {len(record['sourceSHA256'])} recorded Solidity/source-script files.")
   PY
   ```

   A mismatch invalidates the old identity for that file; investigate it and regenerate evidence against the intended revision. This check does not establish deployment, finality, a passing test run or equivalence of unlisted files.
3. Export each final committed repository with `git archive --format=tar --output=<repository>.tar <full-commit>` and record its SHA-256. Record the SHA-256 of every supplied lockfile, the exact Node/Foundry/compiler versions, dependency revisions, and the SDK tarball's SHA-256 and npm integrity. Git archives omit submodule content: include the pinned `forge-std` checkout or its exact gitlink plus retrieval instructions. Do not package `.env` files, credentials, wallet material or ignored runtime caches.
4. Keep a review-bundle manifest beside the exports containing repository name, commit, tree, archive SHA-256, dependency/lockfile digests, SDK package identity, included patches and evidence files. Hash the manifest itself. Verify installed SDK runtime/support files against the supplied preview or published tarball in each client; a `package.json` version alone does not identify a local overlay. Record every exact-source identity above and report any remaining dirty/preview input explicitly.
5. Attach commands, outputs and exit codes from the exact bundle. [AUDIT_INSTRUCTIONS.md](AUDIT_INSTRUCTIONS.md#verification) owns the verification commands; [the fork guide](test/fork/README.md) owns RPC inputs and modeled transport boundaries. Supply RPC access separately if the reviewer needs it. Never include credential values in artifacts or logs.

## First pass: source-first adversarial prompt

Give the following prompt and source bundle to the reviewer before the prior-findings appendix. Preserve the reviewer's initial hypotheses before asking for comparison with existing reports.

> Independently review the supplied exact-source Sticky and SDK/client bundle. First establish its contracts, dependencies, authority and asset-flow boundaries from source. Do not use earlier pass counts, finding severities or readiness conclusions as premises.
>
> Trace a user's reviewed intent through authorization, custody changes, observable receipts and recovery. Look for concrete sequences that lose backing, inflate shares, corrupt tranche/reward accounting, redirect accepted source buckets, block another holder's exit, or duplicate an uncertain value-moving transaction. Challenge the assumptions needed to call an outcome permanent, permissionless, verified or recoverable.
>
> For every source/home/asset/transport combination considered, distinguish acceptance, preparation, source submission, canonical finalization, destination mint/claim, receiver settlement, holder collection and refunds. Inspect native and CCIP implementations separately: registry membership, equal addresses and a successful source call do not prove a qualified end-to-end lane. Identify which callbacks, dependencies and administrative changes can invalidate a previously prepared action.
>
> Review the shared SDK owner and each of Sticky, Juicebox Money, Revnet Money and Homerun. Check direct wallets, Safe and relayed execution where used; lost responses, reloads, wallet/account changes and incomplete indexing must not authorize duplicate transfers or turn uncertain execution into proven failure. Keep each client's durable recovery records in scope.
>
> Build minimal executable counterexamples against real pinned dependency code where feasible. Check initial state, custody/supply/pending deltas, exact recipients and allowances, failure atomicity and independently computed expectations. Audit the harness itself: list every impersonation, injected balance, mocked call and modeled finality boundary. Separate a source-only proof from destination execution and actual consensus finality.
>
> After recording independent findings, use the architecture/invariants and audit instructions as completeness checklists, then compare with the prior-findings appendix. Try to falsify both existing findings and claimed fixes. Report new findings, reproduced findings, disproved findings, unresolved assumptions and untested paths separately, with severity justified by attainable impact.
>
> For each finding give exact repository/commit/file/line, prerequisites and attacker authority, executable steps and command, expected versus observed result, affected invariant/value, and a regression or proof limitation. Assess Ethereum-home JBX and generic route readiness separately. Do not deploy, modify source splits, send wallet transactions, publish packages or merge a PR.

Current mechanism owners are [ARCHITECTURE.md](ARCHITECTURE.md), [INVARIANTS.md](INVARIANTS.md), [USER_JOURNEYS.md](USER_JOURNEYS.md), [RISKS.md](RISKS.md), [ADMINISTRATION.md](ADMINISTRATION.md) and [STYLE_GUIDE.md](STYLE_GUIDE.md). Link findings to those owners instead of reproducing their specifications in the handoff.

## Second pass: prior findings and reproductions

Open this section after the independent pass. The [owning adversarial report](ADVERSARIAL_REVIEW_2026-10-09.md) contains the current finding ledger, evidence, proposed/fixed status and release gates. Its conclusions are review inputs to challenge, not external review results.

| Comparison area | Owning evidence |
| --- | --- |
| Native Ethereum-to-Arbitrum asynchronous fee refunds | Report A-01; [local transport reproduction](test/audit/SourceFeeArbitrumRefund.t.sol), [fork proof](test/fork/StickyJbxOmnichain.t.sol), specifically `test_adversarialEthereumToArbitrum_retryableRefundUsesFeeChild` |
| Destination mint readiness and shared SDK callers | Report A-02; `web/test/lib/sticky-bridge-readiness.test.ts` in the final client bundle, shared SDK patch/tests and equivalent consumer tests in the final bundle |
| Uncertain ordinary-wallet/Safe outcomes and retries | Report A-03/A-04; [ordinary writes](web/test/transactions/use-safe-tx.test.ts), [Safe proposal recovery](web/test/transactions/use-safe-tx-proposals.test.ts), SDK patch/tests and other client consumers |
| Deployment provenance and misleading operational documentation | Report A-05/A-06; [sync regressions](web/test/sync-deployments.test.ts) and [documentation/source inventory](tasks/deployment-doc-review-20261009.md) |

The refund finding concerns the **native** Ethereum-to-Arbitrum transport; CCIP has distinct fee/refund mechanics and needs separate evidence. Additional registered CCIP routes are observed, not generally qualified. The CCIP source-only proof `test_adversarialEthereumToArbitrum_ccipReturnsSourceTransportRefund` passes for the existing REV Ethereum-to-Arbitrum lane: actual reserves, complete singleton runtime checked against replayed committed creation code/arguments, wrapping, deployed router submission and source refund attribution. This does not qualify destination delivery or an Arbitrum pool; the final bundle binds its tested revision. [The live-state census](tasks/adversarial-live-state-20261009.json) is a configuration observation, not a substitute for implementation or lane verification.

## Review return and authority

Return the review-bundle manifest hash, exact reviewed commits, commands/results, concrete findings/reproductions and explicit exclusions. Identify whether each proposed fix was tested against the final shared SDK package and all affected clients. Distinguish review completion from release readiness; the live deployment, source setup, finality/holder-receipt and approval gates remain owned by [DEPLOYMENT.md](DEPLOYMENT.md) and the adversarial report.

## Plan refinement

- **Objective:** Prepare a reviewable Daybreak handoff with independent first-pass instructions, exact-source identification and a separately presented prior-findings appendix; do not claim an external review ran.
- **System fit:** Existing source, reports, reproduction tests and deployment evidence remain their own authorities. This packet only connects them to an external review input/output boundary; no execution authority changes.
- **Reuse and simplicity:** Link to current owning instructions and use Git snapshots, the existing source digests and standard SHA-256 manifests. Add no uploader, integration, dependency or competing audit specification.
- **Evidence and unknowns:** Baseline `74dc087` plus the current 34-file manifest identify a limited portion of uncommitted review work. SDK 2.27.0 is a pending release with four local-preview consumers. Final client commits and complete live lane qualification remain separate from the passing CCIP source-only proof.
- **Verification:** Check the recorded source digests, all local document links and the workspace plan-refinement gate. These checks establish packet consistency only; actual Daybreak execution and final bundle verification require their own evidence.
- **Resource budget:** One handoff document and one native-route wording correction, with read-only local checks. No source changes, builds, RPC calls, uploads, commits or release actions.
