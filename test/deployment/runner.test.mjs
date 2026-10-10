import assert from 'node:assert/strict';
import test from 'node:test';
import { lstatSync, readFileSync } from 'node:fs';
import {
  destinationChainIds, familyDirectory, familySuite, networks, preflight, requireAllAddressFamilies, run, sharedSuite,
} from '../../script/deploy.mjs';

const address = byte => `0x${byte.toString(16).padStart(2, '0').repeat(20)}`;
const block = { number: '0x64', hash: '0x' + 'ab'.repeat(32) };

function fixture(group, { revision = 'abc123' } = {}) {
  const env = { SPHINX_ORG_ID: JSON.parse(readFileSync('sphinx.lock')).orgId, SPHINX_API_KEY: 'test-key',
    SPHINX_MANAGED_BASE_URL: 'https://sphinx.example.test' };
  const files = {};
  const sharedAddresses = Object.fromEntries(sharedSuite.map((field, i) => [field, address(i + 1)]));
  const familyAddresses = new Map(destinationChainIds(group).map((destination, i) => [destination,
    Object.fromEntries(familySuite.map((field, j) => [field, address(64 + i * familySuite.length + j)]))]));
  for (const [, chainId, key, folder] of networks[group]) {
    env[key] = 'http://127.0.0.1:8545';
    for (const name of ['JBController', 'JBDirectory', 'JBMultiTerminal']) {
      files[`node_modules/@bananapus/core-v6/deployments/${folder}/${name}.json`] = JSON.stringify({
        address: '0x' + '12'.repeat(20), chainId: `0x${chainId.toString(16)}`,
      });
    }
    files[`node_modules/@bananapus/suckers-v6/deployments/${folder}/JBSuckerRegistry.json`] = JSON.stringify({
      address: '0x' + '34'.repeat(20), chainId: `0x${chainId.toString(16)}`,
    });
    for (const destination of destinationChainIds(group)) {
      for (const kind of ['simulation', 'verified']) {
        files[`${familyDirectory(folder, destination)}/${kind}.json`] = JSON.stringify({
          ...sharedAddresses, ...familyAddresses.get(destination), kind, chainId, destinationChainId: destination,
          revision, rpcBlockNumber: 100, rpcBlockHash: block.hash,
        });
      }
    }
  }
  return { env, files, read: file => files[file] ?? readFileSync(file, 'utf8'), verifyInputs() {} };
}

function readOnlyTool(command, args) {
  if (command === 'cast') return { status: 0, stdout: JSON.stringify({ schema_version: 1, success: true, data: block }) };
  if (command === 'forge' && args[0] === 'build') return { status: 0 };
  if (command !== 'git') return;
  if (args[0] === 'show') return { status: 0, stdout: readFileSync('sphinx.lock', 'utf8') };
  return { status: 0, stdout: args[0] === 'rev-parse' ? 'abc123\n' : '' };
}

for (const group of Object.keys(networks)) {
  test(`${group}: all four source rehearsals validate every home before the Sphinx proposal`, () => {
    const setup = fixture(group);
    setup.env.FOUNDRY_OUT = 'unreviewed-output';
    const calls = [];
    const buildCalls = [];
    const castCalls = [];
    run('propose', group, { ...setup, spawn(command, args, options) {
      if (command !== 'git') assert.equal(options.env.FOUNDRY_OUT, 'out');
      if (command === 'forge' && args[0] === 'build') buildCalls.push(args);
      if (command === 'cast') castCalls.push(args);
      const tool = readOnlyTool(command, args);
      if (tool) return tool;
      calls.push({ command, args, chainId: options.env.STICKY_EXPECTED_CHAIN_ID });
      assert.equal(options.env.FOUNDRY_PROFILE, 'deploy');
      assert.equal(options.env.STICKY_REVISION, 'abc123');
      assert.equal(options.env.STICKY_DESTINATION_CHAIN_ID, undefined);
      if (command === 'forge') {
        assert.equal(options.env.STICKY_RPC_BLOCK_NUMBER, '100');
        assert.equal(options.env.STICKY_RPC_BLOCK_HASH, block.hash);
        assert.deepEqual(args.slice(4, 6), ['--fork-block-number', '100']);
      }
      return { status: 0 };
    } });
    assert.deepEqual(calls.slice(0, 4).map(call => call.args[3]), networks[group].map(([alias]) => alias));
    assert.deepEqual(calls.slice(0, 4).map(call => call.chainId), networks[group].map(([, id]) => String(id)));
    assert.equal(calls[4].chainId, '0');
    assert.equal(calls[4].command, 'node_modules/.bin/sphinx');
    assert.deepEqual(calls[4].args.slice(-2), ['--networks', group]);
    assert.equal(calls.length, 5);
    assert.deepEqual(buildCalls, [
      ['build', '--force', 'script/Deploy.s.sol'],
      ['build', '--force', 'script/Deploy.s.sol'],
    ]);
    assert.deepEqual(castCalls, networks[group].flatMap(([alias]) => [
      ['block', 'finalized', '--json', '--rpc-url', alias],
      ['block', '100', '--json', '--rpc-url', alias],
    ]));
  });
}

test('the reviewed-input gate is repeated after rehearsal immediately before Sphinx', () => {
  const sequence = [];
  const setup = fixture('testnets');
  run('dry-run', 'testnets', { ...setup, verifyInputs() {
    sequence.push('reviewed inputs');
  }, spawn(command, args, options) {
    if (command === 'forge' && args[0] === 'build') sequence.push('forced build');
    if (command === 'cast' && args[1] === 'finalized' && sequence.length === 2) sequence.push('finalized RPC');
    if (command === 'node_modules/.bin/sphinx') sequence.push('sphinx');
    return readOnlyTool(command, args) ?? { status: 0 };
  } });
  assert.deepEqual(sequence, [
    'forced build', 'reviewed inputs', 'finalized RPC', 'forced build', 'reviewed inputs', 'sphinx',
  ]);
});

test('a checkout or lock mutation after the final build cannot reach Sphinx', () => {
  for (const fault of ['revision', 'status', 'lock']) {
    const setup = fixture('testnets');
    const originalRead = setup.read;
    let buildCount = 0;
    let revisionReads = 0;
    let statusReads = 0;
    let submitted = false;
    setup.read = file => {
      if (fault === 'lock' && buildCount === 2 && file === 'sphinx.lock') {
        return JSON.stringify({ ...JSON.parse(originalRead(file)), orgId: 'changed-after-build' });
      }
      return originalRead(file);
    };
    assert.throws(() => run('propose', 'testnets', { ...setup, spawn(command, args) {
      if (command === 'git' && args[0] === 'rev-parse') {
        revisionReads++;
        return { status: 0, stdout: fault === 'revision' && buildCount === 2 ? 'changed\n' : 'abc123\n' };
      }
      if (command === 'git' && args[0] === 'status') {
        statusReads++;
        return { status: 0, stdout: fault === 'status' && buildCount === 2 ? ' M src/StickyHook.sol\n' : '' };
      }
      if (command === 'forge' && args[0] === 'build') buildCount++;
      if (command === 'node_modules/.bin/sphinx') submitted = true;
      return readOnlyTool(command, args) ?? { status: 0 };
    } }), fault === 'revision' ? /source revision changed/ : /uncommitted changes/);
    assert.equal(buildCount, 2);
    assert.equal(revisionReads, 6);
    assert.equal(statusReads, 3);
    assert.equal(submitted, false);
  }
});

test('checkout inspection binds the lock to its captured revision and rejects an interleaved HEAD move', () => {
  const setup = fixture('testnets');
  let revisionReads = 0;
  assert.throws(() => run('verify', 'testnets', { ...setup, spawn(command, args) {
    if (command === 'git' && args[0] === 'rev-parse') {
      revisionReads++;
      return { status: 0, stdout: revisionReads === 1 ? 'abc123\n' : 'changed\n' };
    }
    if (command === 'git' && args[0] === 'status') return { status: 0, stdout: '' };
    if (command === 'git' && args[0] === 'show') {
      assert.equal(args[1], 'abc123:sphinx.lock');
      return { status: 0, stdout: readFileSync('sphinx.lock', 'utf8') };
    }
    assert.fail(`${command} must not run after HEAD moves`);
  } }), /source revision changed/);
  assert.equal(revisionReads, 2);
});

test('a failing final build or reviewed-input check cannot reach Sphinx', () => {
  for (const fault of ['build', 'inputs']) {
    const setup = fixture('testnets');
    let buildCount = 0;
    let inputChecks = 0;
    let submitted = false;
    assert.throws(() => run('propose', 'testnets', { ...setup, verifyInputs() {
      inputChecks++;
      if (fault === 'inputs' && inputChecks === 2) throw new Error('changed reviewed input');
    }, spawn(command, args) {
      if (command === 'forge' && args[0] === 'build') {
        buildCount++;
        if (fault === 'build' && buildCount === 2) return { status: 1 };
      }
      if (command === 'node_modules/.bin/sphinx') submitted = true;
      return readOnlyTool(command, args) ?? { status: 0 };
    } }), fault === 'build' ? /forge failed/ : /changed reviewed input/);
    assert.equal(buildCount, 2);
    assert.equal(inputChecks, fault === 'build' ? 1 : 2);
    assert.equal(submitted, false);
  }
});

test('the final checkout inspection runs after the second reviewed-input verification', () => {
  const setup = fixture('testnets');
  let inputChecks = 0;
  let mutated = false;
  let submitted = false;
  assert.throws(() => run('propose', 'testnets', { ...setup, verifyInputs() {
    inputChecks++;
    if (inputChecks === 2) mutated = true;
  }, spawn(command, args) {
    if (command === 'git' && args[0] === 'status' && mutated) {
      return { status: 0, stdout: ' M src/StickyHook.sol\n' };
    }
    if (command === 'node_modules/.bin/sphinx') submitted = true;
    return readOnlyTool(command, args) ?? { status: 0 };
  } }), /uncommitted changes/);
  assert.equal(inputChecks, 2);
  assert.equal(submitted, false);
});

test('verification closes with the same build, input and checkout gate', () => {
  const setup = fixture('testnets');
  let inputChecks = 0;
  let mutated = false;
  assert.throws(() => run('verify', 'testnets', { ...setup, verifyInputs() {
    inputChecks++;
    if (inputChecks === 2) mutated = true;
  }, spawn(command, args) {
    if (command === 'git' && args[0] === 'status' && mutated) {
      return { status: 0, stdout: ' M src/StickyHook.sol\n' };
    }
    return readOnlyTool(command, args) ?? { status: 0 };
  } }), /uncommitted changes/);
  assert.equal(inputChecks, 2);
});

test('Sphinx key reordering during rehearsal remains semantically clean', () => {
  const setup = fixture('testnets');
  const originalRead = setup.read;
  let rehearsalCount = 0;
  let submitted = false;
  setup.read = file => {
    if (file !== 'sphinx.lock' || rehearsalCount !== 4) return originalRead(file);
    const lock = JSON.parse(originalRead(file));
    return JSON.stringify(Object.fromEntries(Object.entries(lock).reverse()));
  };
  run('propose', 'testnets', { ...setup, spawn(command, args) {
    if (command === 'git' && args[0] === 'status' && rehearsalCount === 4) {
      return { status: 0, stdout: ' M sphinx.lock\n' };
    }
    if (command === 'forge' && args[0] === 'script') rehearsalCount++;
    if (command === 'node_modules/.bin/sphinx') submitted = true;
    return readOnlyTool(command, args) ?? { status: 0 };
  } });
  assert.equal(rehearsalCount, 4);
  assert.equal(submitted, true);
});

test('direct development rehearsals do not claim reviewed-input release evidence', () => {
  let checked = false;
  run('rehearse', 'testnets', { ...fixture('testnets'), verifyInputs() {
    checked = true;
  }, spawn(command, args) {
    return readOnlyTool(command, args) ?? { status: 0 };
  } });
  assert.equal(checked, false);
});

test('the review-only Sphinx dry run uses the same all-family rehearsals without submitting', () => {
  const calls = [];
  run('dry-run', 'testnets', { ...fixture('testnets'), spawn(command, args, options) {
    const tool = readOnlyTool(command, args);
    if (tool) return tool;
    calls.push({ command, args, chainId: options.env.STICKY_EXPECTED_CHAIN_ID });
    return { status: 0 };
  } });
  assert.equal(calls.filter(({ command }) => command === 'forge').length, 4);
  assert.deepEqual(calls.at(-1), {
    command: 'node_modules/.bin/sphinx',
    args: ['propose', 'script/Deploy.s.sol', '--target-contract', 'Deploy', '--networks', 'testnets', '--dry-run'],
    chainId: '0',
  });
});

test('failed rehearsal prevents proposal submission and remaining execution', () => {
  let attempts = 0;
  assert.throws(() => run('propose', 'testnets', { ...fixture('testnets'), spawn(command, args) {
    const tool = readOnlyTool(command, args);
    if (tool) return tool;
    attempts++;
    assert.equal(command, 'forge');
    return { status: 1 };
  } }), /stopping/);
  assert.equal(attempts, 1);
});

test('verification runs one all-family read-only Verify on every source', () => {
  let attempts = 0;
  run('verify', 'mainnets', { ...fixture('mainnets'), spawn(command, args) {
    const tool = readOnlyTool(command, args);
    if (tool) return tool;
    attempts++;
    assert.equal(command, 'forge');
    assert.equal(args[1], 'script/Verify.s.sol:Verify');
    assert.ok(!args.includes('--broadcast'));
    return { status: 0 };
  } });
  assert.equal(attempts, 4);
});

test('preflight rejects missing RPCs and mismatched artifacts without leaking values', () => {
  const { env, read } = fixture('testnets');
  delete env.RPC_BASE_SEPOLIA;
  assert.throws(() => preflight('testnets', env, read), /missing RPC_BASE_SEPOLIA/);
  assert.throws(() => preflight('mainnets', env, () => JSON.stringify({ address: '0x' + '12'.repeat(20), chainId: 1 })), /invalid JBController/);
  assert.throws(() => preflight('unknown'), /Network group/);
});

test('missing proposal credentials fail before any child process starts', () => {
  const setup = fixture('testnets');
  delete setup.env.SPHINX_API_KEY;
  assert.throws(() => run('propose', 'testnets', { ...setup, spawn() { assert.fail('must not execute'); } }), /Missing SPHINX_API_KEY/);
});


test('runner networks match the Sphinx entrypoint and grouped homes need no workflow input', () => {
  const source = readFileSync('script/Deploy.s.sol', 'utf8');
  for (const group of Object.keys(networks)) {
    const line = source.split('\n').find(line => line.includes(`sphinxConfig.${group} =`));
    const configured = JSON.parse(line.slice(line.indexOf('['), line.lastIndexOf(']') + 1));
    assert.deepEqual(networks[group].map(([alias]) => alias), configured);
  }
  const workflow = readFileSync('.github/workflows/test.yml', 'utf8');
  assert.doesNotMatch(workflow, /destination_chain_id|STICKY_DESTINATION_CHAIN_ID/);
  assert.match(workflow, /FOUNDRY_PROFILE=deploy forge build --force script\/Deploy\.s\.sol/);
  assert.doesNotMatch(workflow, /forge build --force --contracts/);
  for (const [group, configured] of Object.entries(networks)) {
    assert.deepEqual(destinationChainIds(group), configured.map(([, chainId]) => chainId));
  }
});

test('Sphinx cannot overwrite rehearsal records and Verify validates every family before writing', () => {
  const deploy = readFileSync('script/Deploy.s.sol', 'utf8');
  const rehearse = readFileSync('script/Rehearse.s.sol', 'utf8');
  const verify = readFileSync('script/Verify.s.sol', 'utf8');
  const manifestKinds = source => [...source.matchAll(/_writeManifest\(\{[^}]+kind: "(\w+)"\}\)/g)]
    .map(([, kind]) => kind);
  assert.match(deploy, /_deployAll\(_core\);/);
  assert.deepEqual(manifestKinds(deploy), []);
  assert.deepEqual(manifestKinds(rehearse), ['simulation']);
  assert.deepEqual(manifestKinds(verify), ['verified']);
  assert.match(verify,
    /for \(uint256 i; i < deployed\.length; i\+\+\) \{\s*_verify\(\{core: core, deployed: deployed\[i\]\}\);\s*\}\s*for \(uint256 i; i < deployed\.length; i\+\+\) \{\s*_writeManifest/);
});


test('core and distributor are exact integrity-bound registry packages', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  for (const [name, expected] of Object.entries({
    '@bananapus/core-v6': {
      version: '1.2.1',
      resolved: 'https://registry.npmjs.org/@bananapus/core-v6/-/core-v6-1.2.1.tgz',
      integrity: 'sha512-nHEvg6RPGnrTgEAxBDJE1PgnN0uIBeCM+zKDdMjplfCedr4/swNFDMsRLFw9Wm5chKzGo3LR2stOr5F0og6InQ==',
    },
    '@bananapus/distributor-v6': {
      version: '2.0.0',
      resolved: 'https://registry.npmjs.org/@bananapus/distributor-v6/-/distributor-v6-2.0.0.tgz',
      integrity: 'sha512-Zc4O+xqt3yOox96F41+R3BNX5gcF5SWGBH5lDmnp6RRE5LPFTCntgSOXks2qImSJBF/bLB3FjMh8aB1GFHdrbA==',
    },
  })) {
    const { integrity, resolved, version } = expected;
    assert.equal(pkg.dependencies[name], version);
    const entry = lock.packages[`node_modules/${name}`];
    assert.equal(entry.version, version);
    assert.equal(entry.resolved, resolved);
    assert.equal(entry.integrity, integrity);
    assert.equal(entry.link, undefined);
    assert.equal(lstatSync(`node_modules/${name}`).isSymbolicLink(), false);
    assert.equal(JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version, version);
  }
  assert.equal(lock.packages['../../nana-core-v6'], undefined);
  assert.equal(lock.packages['../../nana-distributor-v6'], undefined);
});

test('missing block identity stops before any Forge or Sphinx execution', () => {
  assert.throws(() => run('rehearse', 'testnets', { ...fixture('testnets'), spawn(command, args) {
    if (command === 'cast') return { status: 1, stdout: '' };
    const tool = readOnlyTool(command, args);
    if (tool) return tool;
    assert.equal(command, 'git');
    return { status: 0 };
  } }), /finalized RPC block/);
});

test('a changed pinned finalized block hash stops before the next source or Sphinx', () => {
  let rehearsals = 0;
  let submitted = false;
  assert.throws(() => run('propose', 'testnets', { ...fixture('testnets'), spawn(command, args) {
    if (command === 'cast') {
      const changed = args[1] === 'finalized' ? block : { ...block, hash: '0x' + 'cd'.repeat(32) };
      return { status: 0, stdout: JSON.stringify({ schema_version: 1, success: true, data: changed }) };
    }
    const tool = readOnlyTool(command, args);
    if (tool) return tool;
    if (command === 'forge') rehearsals++;
    if (command === 'node_modules/.bin/sphinx') submitted = true;
    return { status: 0 };
  } }), /finalized RPC block identity changed/);
  assert.equal(rehearsals, 1);
  assert.equal(submitted, false);
});

test('proposal rejects a missing lock, wrong organization, or unregistered project', () => {
  for (const fault of ['missing', 'organization', 'project']) {
    const setup = fixture('testnets');
    const read = setup.read;
    setup.read = file => {
      if (file !== 'sphinx.lock') return read(file);
      if (fault === 'missing') throw new Error('not found');
      const lock = JSON.parse(read(file));
      if (fault === 'organization') lock.orgId = 'different-org';
      if (fault === 'project') lock.projects = {};
      return JSON.stringify(lock);
    };
    assert.throws(() => run('propose', 'testnets', { ...setup, spawn() { assert.fail('must not execute'); } }));
  }
});

test('dependency provenance is declared before the reviewed manifest authenticates installed source bytes', () => {
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  for (const name of ['StickyDeployer', 'StickyHook', 'StickyDistributor', 'StickyRewardReceiver', 'StickyRewardReceiverFactory', 'StickyAutoStick', 'StickySourceCollector', 'StickySourceFeePayer']) {
    const artifact = JSON.parse(readFileSync(`out/${name}.sol/${name}.json`, 'utf8'));
    for (const source of Object.keys(artifact.metadata.sources)) {
      if (/^(src|script)\//.test(source)) continue;
      const pkg = source.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)\//)?.[1];
      assert.ok(pkg, `${source} must be this repository's or an installed package's source`);
      const entry = lock.packages[`node_modules/${pkg}`];
      assert.ok(entry, `${pkg} must be in the lockfile`);
      assert.notEqual(entry.link, true, `${pkg} must be a physical installed package`);
      assert.match(entry.integrity, /^sha512-/, `${pkg} must carry a lockfile integrity hash`);
    }
  }
});

test('an artifacts run executes the explorer script only after the checkout and reviewed-input gates', () => {
  const calls = [];
  run('artifacts', 'testnets', { ...fixture('testnets'), spawn(command, args, options) {
    const tool = readOnlyTool(command, args);
    if (tool) return tool;
    calls.push({ command, args });
    assert.equal(options.env.FOUNDRY_PROFILE, 'deploy');
    assert.equal(options.env.STICKY_REVISION, 'abc123');
    return { status: 0 };
  } });
  assert.deepEqual(calls, [{ command: 'node', args: ['script/artifacts.mjs', 'testnets'] }]);
  assert.throws(() => run('artifacts', 'mainnets', { ...fixture('mainnets'), verifyInputs() {
    throw new Error('unreviewed installed input');
  }, spawn(command, args) {
    const tool = readOnlyTool(command, args);
    if (tool) return tool;
    assert.fail('artifacts must not run against unreviewed inputs');
  } }), /unreviewed installed input/);
  let mutated = false;
  assert.throws(() => run('artifacts', 'testnets', { ...fixture('testnets'), verifyInputs() {
    mutated = true;
  }, spawn(command, args) {
    if (command === 'git' && args[0] === 'status' && mutated) {
      return { status: 0, stdout: ' M src/StickyHook.sol\n' };
    }
    const tool = readOnlyTool(command, args);
    if (tool) return tool;
    assert.fail('artifacts must not run after the authenticated build mutates the checkout');
  } }), /uncommitted changes/);
});

test('an uncommitted checkout can rehearse but cannot dry-run, propose, verify or emit artifacts', () => {
  const dirtyGit = (command, args) => command === 'git' && args[0] === 'status' ? { status: 0, stdout: ' M src/StickyHook.sol' } : readOnlyTool(command, args);
  for (const action of ['dry-run', 'propose', 'verify', 'artifacts']) {
    assert.throws(() => run(action, 'testnets', { ...fixture('testnets'), spawn(command, args) {
      const tool = dirtyGit(command, args);
      if (tool) return tool;
      assert.fail(`${action} must not execute anything from a dirty checkout`);
    } }), /uncommitted/);
  }
  // Manifests the runner itself wrote are not source changes.
  let verifyRuns = 0;
  run('verify', 'testnets', { ...fixture('testnets'), spawn(command, args, options) {
    if (command === 'git' && args[0] === 'status') return { status: 0, stdout: '?? deployments/sepolia/verified.json\n' };
    const tool = readOnlyTool(command, args);
    if (tool) return tool;
    verifyRuns++;
    assert.equal(options.env.STICKY_REVISION, 'abc123');
    return { status: 0 };
  } });
  assert.equal(verifyRuns, 4);
  let forgeRuns = 0;
  run('rehearse', 'testnets', { ...fixture('testnets', { revision: 'abc123-dirty' }), spawn(command, args, options) {
    const tool = dirtyGit(command, args);
    if (tool) return tool;
    forgeRuns++;
    assert.equal(options.env.STICKY_REVISION, 'abc123-dirty');
    return { status: 0 };
  } });
  assert.equal(forgeRuns, 4);
});

test('a sphinx.lock Sphinx only reordered is clean; semantic, staged, mixed or type changes are not', () => {
  const lock = JSON.parse(readFileSync('sphinx.lock', 'utf8'));
  const reorderObjects = value => Array.isArray(value) ? value.map(reorderObjects)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).reverse().map(([key, nested]) => [key, reorderObjects(nested)])) : value;
  const reordered = JSON.stringify(reorderObjects(lock));
  const lockGit = (command, args, status = ' M sphinx.lock\n') => {
    if (command === 'git' && args[0] === 'status') return { status: 0, stdout: status };
    if (command === 'git' && args[0] === 'show') return { status: 0, stdout: JSON.stringify(lock) };
    return readOnlyTool(command, args);
  };
  const withLock = text => ({ ...fixture('testnets'), read: file => (file === 'sphinx.lock' ? text : fixture('testnets').read(file)) });
  let verifyRuns = 0;
  run('verify', 'testnets', { ...withLock(reordered), spawn(command, args, options) {
    const tool = lockGit(command, args);
    if (tool) return tool;
    verifyRuns++;
    assert.equal(options.env.STICKY_REVISION, 'abc123');
    return { status: 0 };
  } });
  assert.equal(verifyRuns, 4);
  const changed = structuredClone(lock);
  changed.projects.sticky.defaultSafe.owners.reverse();
  assert.throws(() => run('verify', 'testnets', { ...withLock(JSON.stringify(changed)), spawn(command, args) {
    const tool = lockGit(command, args, ' M sphinx.lock\n');
    if (tool) return tool;
    assert.fail('a changed lock must not verify');
  } }), /uncommitted/);
  for (const status of ['M  sphinx.lock\n', 'MM sphinx.lock\n', 'T  sphinx.lock\n', ' T sphinx.lock\n']) {
    assert.throws(() => run('verify', 'testnets', { ...withLock(JSON.stringify(lock)), spawn(command, args) {
      const tool = lockGit(command, args, status);
      if (tool) return tool;
      assert.fail(`lock status ${JSON.stringify(status)} must not verify`);
    } }), /uncommitted/);
  }
});

test('a chain predicting different addresses stops the group before the Sphinx proposal', () => {
  const setup = fixture('mainnets');
  const file = `${familyDirectory('base', 1)}/simulation.json`;
  setup.files[file] = JSON.stringify({ ...JSON.parse(setup.files[file]), autoStick: '0x' + 'ee'.repeat(20) });
  assert.throws(() => requireAllAddressFamilies('mainnets', 'simulation', setup.read), /base: shared deployment differs/);
  assert.throws(() => run('propose', 'mainnets', { ...setup, spawn(command, args) {
    const tool = readOnlyTool(command, args);
    if (tool) return tool;
    assert.notEqual(command, 'node_modules/.bin/sphinx', 'the proposal must not be collected');
    return { status: 0 };
  } }), /shared deployment differs/);
});


test('all chains must contain both source singleton addresses before any group is accepted', () => {
  for (const field of ['sourceCollector', 'sourceFeePayer']) {
    for (const value of [undefined, '0x00', '0x' + '00'.repeat(20)]) {
      const setup = fixture('mainnets');
      for (const [, , , folder] of networks.mainnets) {
        const file = `${familyDirectory(folder, 1)}/simulation.json`;
        setup.files[file] = JSON.stringify({ ...JSON.parse(setup.files[file]), [field]: value });
      }
      assert.throws(() => requireAllAddressFamilies('mainnets', 'simulation', setup.read), new RegExp(`invalid ${field}`));
    }
  }
});

test('registry artifact roots are explicit and wrong registry chain metadata fails preflight', () => {
  const setup = fixture('mainnets');
  setup.env.NANA_SUCKERS_DEPLOYMENT_PATH = '/reviewed/suckers';
  const requested = [];
  preflight('mainnets', setup.env, file => {
    requested.push(file);
    return setup.read(file.replace('/reviewed/suckers', 'node_modules/@bananapus/suckers-v6/deployments'));
  });
  assert.equal(requested.filter(file => file.startsWith('/reviewed/suckers/')).length, 4);
  assert.throws(() => preflight('mainnets', setup.env, file => file.includes('JBSuckerRegistry')
    ? JSON.stringify({ address: '0x' + '34'.repeat(20), chainId: 999 }) : setup.read(file)), /invalid JBSuckerRegistry/);
});

test('each group has one exact ordered home set and family paths reject invalid IDs', () => {
  assert.deepEqual(destinationChainIds('mainnets'), [1, 10, 8453, 42161]);
  assert.deepEqual(destinationChainIds('testnets'), [11155111, 11155420, 84532, 421614]);
  assert.throws(() => destinationChainIds('unknown'), /Network group/);
  assert.throws(() => familyDirectory('ethereum', '../1'), /Invalid collector destination/);
});

test('a wrong second-chain destination, source or kind prevents proposal submission', () => {
  for (const mismatch of [{ destinationChainId: 8453 }, { chainId: 1 }, { kind: 'verified' }, { destinationChainId: undefined }]) {
    const setup = fixture('mainnets');
    const file = `${familyDirectory('optimism', 1)}/simulation.json`;
    setup.files[file] = JSON.stringify({ ...JSON.parse(setup.files[file]), ...mismatch });
    assert.throws(() => run('propose', 'mainnets', { ...setup, spawn(command, args) {
      const tool = readOnlyTool(command, args);
      if (tool) return tool;
      assert.notEqual(command, 'node_modules/.bin/sphinx', 'mixed-family evidence must not reach proposal submission');
      return { status: 0 };
    } }), /optimism: manifest destination, source chain or kind/);
  }
});

test('stale revision or finalized RPC-block evidence cannot satisfy a fresh proposal rehearsal', () => {
  for (const mismatch of [
    { revision: 'stale' }, { revision: undefined }, { rpcBlockNumber: 99 }, { rpcBlockNumber: undefined },
    { rpcBlockHash: '0x' + 'cd'.repeat(32) }, { rpcBlockHash: undefined },
  ]) {
    const setup = fixture('testnets');
    const file = `${familyDirectory('arbitrum_sepolia', 421614)}/simulation.json`;
    setup.files[file] = JSON.stringify({ ...JSON.parse(setup.files[file]), ...mismatch });
    assert.throws(() => run('propose', 'testnets', { ...setup, spawn(command, args) {
      const tool = readOnlyTool(command, args);
      if (tool) return tool;
      assert.notEqual(command, 'node_modules/.bin/sphinx', 'stale evidence must not reach proposal submission');
      return { status: 0 };
    } }), /manifest (revision does not match|does not match the freshly pinned RPC block)/);
  }
});

test('one omitted fresh family manifest blocks Sphinx even when stale files remain', () => {
  const setup = fixture('testnets', { revision: 'stale' });
  let submitted = false;
  assert.throws(() => run('propose', 'testnets', { ...setup, spawn(command, args) {
    const tool = readOnlyTool(command, args);
    if (tool) return tool;
    if (command === 'node_modules/.bin/sphinx') submitted = true;
    if (command === 'forge') {
      const alias = args[3];
      const [, chainId, , folder] = networks.testnets.find(([candidate]) => candidate === alias);
      for (const destination of destinationChainIds('testnets')) {
        if (alias === 'arbitrum_sepolia' && destination === 421614) continue;
        const file = `${familyDirectory(folder, destination)}/simulation.json`;
        setup.files[file] = JSON.stringify({
          ...JSON.parse(setup.files[file]), revision: 'abc123', chainId,
          rpcBlockNumber: 100, rpcBlockHash: block.hash,
        });
      }
    }
    return { status: 0 };
  } }), /manifest revision does not match/);
  assert.equal(submitted, false);
});

test('different homes cannot reuse either family address', () => {
  for (const field of familySuite) {
    const setup = fixture('mainnets');
    const first = JSON.parse(setup.files[`${familyDirectory('ethereum', 1)}/verified.json`])[field];
    for (const [, , , folder] of networks.mainnets) {
      const file = `${familyDirectory(folder, 10)}/verified.json`;
      setup.files[file] = JSON.stringify({ ...JSON.parse(setup.files[file]), [field]: first });
    }
    assert.throws(() => requireAllAddressFamilies('mainnets', 'verified', setup.read), new RegExp(`reuses another family's ${field}`));
  }
});

test('one invocation requires every family and never falls back to a flat manifest', () => {
  const setup = fixture('mainnets');
  const requested = [];
  run('verify', 'mainnets', { ...setup, read(file) {
    requested.push(file);
    return setup.read(file);
  }, spawn(command, args, options) {
    const tool = readOnlyTool(command, args);
    if (tool) return tool;
    assert.equal(options.env.STICKY_DESTINATION_CHAIN_ID, undefined);
    return { status: 0 };
  } });
  assert.deepEqual(requested.filter(file => file.endsWith('/verified.json')),
    destinationChainIds('mainnets').flatMap(destination =>
      networks.mainnets.map(([, , , folder]) => `${familyDirectory(folder, destination)}/verified.json`)));

  const selected = `${familyDirectory('ethereum', 8453)}/verified.json`;
  setup.files['deployments/ethereum/verified.json'] = setup.files[selected];
  delete setup.files[selected];
  assert.throws(() => requireAllAddressFamilies('mainnets', 'verified', file => {
    assert.match(file, /\/source-collectors\/\d+\/verified\.json$/, 'no flat-manifest fallback');
    if (!setup.files[file]) throw new Error('missing required family');
    return setup.files[file];
  }), /missing required family/);
});
