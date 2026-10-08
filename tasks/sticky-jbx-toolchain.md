# Sticky JBX confidence toolchain setup

- [x] Create detached, clean copies of the two reviewed local Solidity dependencies.
- [x] Install the root lockfile with Node22.23.1/npm10.9.8 and point only installed file-dependency links at those copies.
- [x] Initialize the exact forge-std gitlink and verify dependency/source integrity with Forge1.8.1 available.

## Plan refinement

- **Objective:** Prepare the confidence branch for later contract tests using the exact reviewed dependency revisions, without changing shared source checkouts or starting builds.
- **System fit:** Root owns the confidence plan and test/build scheduling; this setup owns only ignored dependencies, isolated Git worktrees and toolchain verification. Existing deployment pin checks remain authoritative. No wallet, proposal, broadcast or hosting action is authorized here.
- **Reuse and simplicity:** Use the committed root npm lockfile, standard detached Git worktrees and the existing forge-std submodule. Node22.23.1 already includes npm10.9.8; Forge1.8.1 is installed. Replace only npm-created file-dependency symlinks after clean install, preserving manifests, lockfiles and original dependency source trees.
- **Evidence and unknowns:** script/deploy.mjs pins core feff600654aee6fb1747dded692f18068b2230a6 and distributor44d6d5d2e7cca77422ee0ac4909cf42ccf7839b5. The forge-std gitlink is467ffd422ca01fed5797a4c766a1e4e3a5327902. The checker accepts worktree Git pointer files by invoking Git inside the installed package. Package installation and actual checker acceptance remain unverified until setup completes.
- **Verification:** Capture original source status/revisions and manifest/lock hashes, use physical npm ci with scripts disabled, assert installed links resolve to clean exact detached revisions, initialize the exact forge-std gitlink, invoke verifyDependencies directly without deployment actions, and compare source/lock integrity afterward. Report versions and paths. Root will request builds/tests separately.
- **Resource budget:** One installation owner, one read-only checker reviewer, isolated dependencies under /private/tmp/sticky-jbx-deps. No source edits, dependency version changes, repeated installations or heavy gates; replan on lock mutation, unexpected script needs or incorrect source pins.


## Review

- Physical root npm ci completed with Node22.23.1/npm10.9.8 and lifecycle scripts disabled. Logs: /private/tmp/sticky-jbx-root-npm-ci.log and /private/tmp/sticky-jbx-root-npm-ls.log. It installed986 packages. The optional npm ls diagnostic reports ELSPROBLEMS only for the two intentional file-link relocations: npm compares their resolved paths with the unchanged package.json sibling paths. No other top-level dependency is missing or invalid. This is not a passing npm dependency-tree gate; the existing deployment checker validates the actual source revisions and passes. The manifest/lock remain unchanged as requested.
- Installed `node_modules/@bananapus/core-v6` points to `/private/tmp/sticky-jbx-deps/nana-core-v6`, clean at feff600654aee6fb1747dded692f18068b2230a6 (source tree e7b500aa448c1e073fdab832163589e154fc5cda).
- Installed `node_modules/@bananapus/distributor-v6` points to `/private/tmp/sticky-jbx-deps/nana-distributor-v6`, clean at44d6d5d2e7cca77422ee0ac4909cf42ccf7839b5 (source tree0f1cfb3b3d201e1d22a263675cf12c7f58812e2c). Only these installed symlinks were replaced; their target worktrees are detached.
- `lib/forge-std` is initialized and clean at the committed467ffd422ca01fed5797a4c766a1e4e3a5327902. `/Users/jango/.foundry/versions/v1.8.1/forge` reports1.8.1. Its effective config preserves solc0.8.28, viaIR, optimizer200, Cancun and bytecode_hash=none; the matching solc executable is already installed.
- Direct invocation of the existing `verifyDependencies()` export passed locally without a deployment action or RPC. Before/after source HEAD/status/diff hashes match in both original shared repositories. Root and web package manifests/lockfile SHA-256 hashes are unchanged. Evidence: /private/tmp/sticky-jbx-toolchain-ready.json.
- Re-running npm ci recreates the package.json file links to the shared siblings. Repoint only the two installed symlinks to these isolated pinned worktrees and rerun verifyDependencies before later local contract qualification; do not edit the lockfile or shared sources. For Node-based contract tools use `/Users/jango/.nvm/versions/node/v22.23.1/bin` first in PATH, with `/Users/jango/.foundry/versions/v1.8.1` for Forge. The web toolchain remains unchanged.
- No builds, contract tests, fork tests, wallet actions, deployment actions, source commits or hosting mutations were run by this setup task. Root owns the subsequent confidence-suite schedule and records its results separately.
