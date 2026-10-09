import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dependencies, destinationChainId, familyDirectory, networks, preflight, requireOneAddressPerGroup, run, suite, verifyDependencies } from '../../script/deploy.mjs';

function fixture(group, destination = networks[group][0][1]) {
  const env = { SPHINX_ORG_ID: JSON.parse(readFileSync('sphinx.lock')).orgId, SPHINX_API_KEY: 'test-key',
    SPHINX_MANAGED_BASE_URL: 'https://sphinx.example.test', STICKY_DESTINATION_CHAIN_ID: String(destination) };
  const files = {};
  const addresses = Object.fromEntries(suite.map((field, i) => [field, `0x${String(i + 1).repeat(40)}`]));
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
    for (const kind of ['simulation', 'verified']) {
      files[`${familyDirectory(folder, destination)}/${kind}.json`] = JSON.stringify({
        ...addresses, kind, chainId, destinationChainId: destination,
      });
    }
  }
  return { env, files, read: file => files[file] ?? readFileSync(file, 'utf8') };
}

const block = { number: '0x64', hash: '0x' + 'ab'.repeat(32) };
function readOnlyTool(command, args) {
  if (command === 'cast') return { status: 0, stdout: JSON.stringify({ schema_version: 1, success: true, data: block }) };
  if (command !== 'git') return;
  if (args[0] === '-C') {
    return { status: 0, stdout: args[2] === 'rev-parse' ? dependencies[args[1].replace('node_modules/', '')] : '' };
  }
  return { status: 0, stdout: args[0] === 'rev-parse' ? 'abc123\n' : '' };
}

for (const group of Object.keys(networks)) {
  test(`${group}: all four rehearsals precede the Sphinx proposal`, () => {
    const calls = [];
    run('propose', group, { ...fixture(group), spawn(command, args, options) {
      const tool = readOnlyTool(command, args);
      if (tool) return tool;
      calls.push({ command, args, chainId: options.env.STICKY_EXPECTED_CHAIN_ID });
      assert.equal(options.env.FOUNDRY_PROFILE, 'deploy');
      assert.equal(options.env.STICKY_REVISION, 'abc123');
      assert.equal(options.env.STICKY_DESTINATION_CHAIN_ID, String(networks[group][0][1]));
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
  });
}

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

test('verification only runs read-only Verify on every destination', () => {
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
  assert.throws(() => preflight('mainnets', { ...env, STICKY_DESTINATION_CHAIN_ID: '1' }, () => JSON.stringify({ address: '0x' + '12'.repeat(20), chainId: 1 })), /invalid JBController/);
  assert.throws(() => preflight('unknown'), /Network group/);
});

test('missing proposal credentials fail before any child process starts', () => {
  const setup = fixture('testnets');
  delete setup.env.SPHINX_API_KEY;
  assert.throws(() => run('propose', 'testnets', { ...setup, spawn() { assert.fail('must not execute'); } }), /Missing SPHINX_API_KEY/);
});


test('runner destinations match the Sphinx entrypoint exactly', () => {
  const source = readFileSync('script/Deploy.s.sol', 'utf8');
  for (const group of Object.keys(networks)) {
    const line = source.split('\n').find(line => line.includes(`sphinxConfig.${group} =`));
    const configured = JSON.parse(line.slice(line.indexOf('['), line.lastIndexOf(']') + 1));
    assert.deepEqual(networks[group].map(([alias]) => alias), configured);
  }
  const workflow = readFileSync('.github/workflows/test.yml', 'utf8');
  const destinationInput = workflow.match(/^      destination_chain_id:\n((?:        [^\n]*\n)*)/m)?.[1];
  assert.ok(destinationInput, 'manual rehearsal exposes the destination selector');
  assert.match(destinationInput, /^        type: string$/m);
  assert.match(destinationInput, /^        required: true$/m);
  assert.doesNotMatch(destinationInput, /^        default:/m, 'a home chain must never be selected implicitly');
  assert.match(workflow, /^          STICKY_DESTINATION_CHAIN_ID: \$\{\{ inputs\.destination_chain_id \}\}$/m);
});


test('release dependencies must match pinned clean sources', () => {
  verifyDependencies(readOnlyTool);
  assert.throws(() => verifyDependencies((command, args) => ({ status: 0, stdout: args[2] === 'rev-parse' ? 'wrong' : '' })), /reviewed revision/);
  for (const change of [' M src/JBController.sol', '?? src/JBNew.sol', 'R  test/Old.t.sol -> src/Moved.sol']) {
    assert.throws(() => verifyDependencies((command, args) => args[2] === 'status'
      ? { status: 0, stdout: change } : readOnlyTool(command, args)), /must be clean/);
  }
  // Test edits, scratch directories and Finder droppings do not compile into the contracts.
  verifyDependencies((command, args) => args[2] === 'status'
    ? { status: 0, stdout: ' M test/JBController.t.sol\n?? .DS_Store\n?? src/.DS_Store\n?? .scratch/\n' } : readOnlyTool(command, args));
  const workflow = readFileSync('.github/workflows/test.yml', 'utf8');
  for (const revision of Object.values(dependencies)) assert.ok(workflow.includes(revision));
});

test('missing block identity stops before any Forge or Sphinx execution', () => {
  assert.throws(() => run('rehearse', 'testnets', { ...fixture('testnets'), spawn(command, args) {
    if (command === 'cast') return { status: 1, stdout: '' };
    assert.equal(command, 'git');
    return readOnlyTool(command, args);
  } }), /canonical RPC block/);
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

test('every compiled source root is pinned: linked checkouts by revision, packages by the lockfile', () => {
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  for (const name of ['StickyDeployer', 'StickyHook', 'StickyDistributor', 'StickyRewardReceiver', 'StickyRewardReceiverFactory', 'StickyAutoStick', 'StickySourceCollector', 'StickySourceFeePayer']) {
    const artifact = JSON.parse(readFileSync(`out/${name}.sol/${name}.json`, 'utf8'));
    for (const source of Object.keys(artifact.metadata.sources)) {
      if (/^(src|script)\//.test(source)) continue;
      const pkg = source.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)\//)?.[1];
      assert.ok(pkg, `${source} must be this repository's or an installed package's source`);
      const entry = lock.packages[`node_modules/${pkg}`];
      assert.ok(entry, `${pkg} must be in the lockfile`);
      if (entry.link) assert.ok(dependencies[pkg], `${pkg} is linked, so its revision must be pinned for release`);
      else assert.ok(entry.integrity, `${pkg} must carry a lockfile integrity hash`);
    }
  }
});

test('an artifacts run executes the explorer script only after the pin and checkout gates', () => {
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
  assert.throws(() => run('artifacts', 'mainnets', { ...fixture('mainnets'), spawn(command, args) {
    if (command === 'git' && args[0] === '-C' && args[2] === 'rev-parse') return { status: 0, stdout: 'wrong' };
    const tool = readOnlyTool(command, args);
    if (tool) return tool;
    assert.fail('artifacts must not run against unreviewed dependencies');
  } }), /reviewed revision/);
});

test('an uncommitted checkout can rehearse but neither propose, verify nor emit artifacts', () => {
  const dirtyGit = (command, args) => command === 'git' && args[0] === 'status' ? { status: 0, stdout: ' M src/StickyHook.sol' } : readOnlyTool(command, args);
  for (const action of ['propose', 'verify', 'artifacts']) {
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
  run('rehearse', 'testnets', { ...fixture('testnets'), spawn(command, args, options) {
    const tool = dirtyGit(command, args);
    if (tool) return tool;
    forgeRuns++;
    assert.equal(options.env.STICKY_REVISION, 'abc123-dirty');
    return { status: 0 };
  } });
  assert.equal(forgeRuns, 4);
});

test('a sphinx.lock Sphinx only reordered is clean; a changed one is not', () => {
  const lock = JSON.parse(readFileSync('sphinx.lock', 'utf8'));
  const reordered = JSON.stringify(Object.fromEntries(Object.entries(lock).reverse()));
  const lockGit = (command, args) => {
    if (command === 'git' && args[0] === 'status') return { status: 0, stdout: ' M sphinx.lock\n' };
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
  const changed = JSON.stringify({ ...lock, orgId: 'someone-else' });
  assert.throws(() => run('verify', 'testnets', { ...withLock(changed), spawn(command, args) {
    const tool = lockGit(command, args);
    if (tool) return tool;
    assert.fail('a changed lock must not verify');
  } }), /uncommitted/);
});

test('a chain predicting different addresses stops the group before the Sphinx proposal', () => {
  const setup = fixture('mainnets');
  const file = `${familyDirectory('base', 1)}/simulation.json`;
  setup.files[file] = JSON.stringify({ ...JSON.parse(setup.files[file]), autoStick: '0x' + 'ee'.repeat(20) });
  assert.throws(() => requireOneAddressPerGroup('mainnets', 'simulation', 1, setup.read), /base predicts a different deployment/);
  assert.throws(() => run('propose', 'mainnets', { ...setup, spawn(command, args) {
    const tool = readOnlyTool(command, args);
    if (tool) return tool;
    assert.notEqual(command, 'node_modules/.bin/sphinx', 'the proposal must not be collected');
    return { status: 0 };
  } }), /different deployment/);
});


test('all chains must contain both source singleton addresses before any group is accepted', () => {
  for (const field of ['sourceCollector', 'sourceFeePayer']) {
    for (const value of [undefined, '0x00', '0x' + '00'.repeat(20)]) {
      const setup = fixture('mainnets');
      for (const [, , , folder] of networks.mainnets) {
        const file = `${familyDirectory(folder, 1)}/simulation.json`;
        setup.files[file] = JSON.stringify({ ...JSON.parse(setup.files[file]), [field]: value });
      }
      assert.throws(() => requireOneAddressPerGroup('mainnets', 'simulation', 1, setup.read), new RegExp(`invalid ${field}`));
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

test('a destination is explicit, canonical, safe and in the selected source network group', () => {
  for (const value of [undefined, '', '0', '01', '-1', '+1', '1.0', '1e0', '0x1', ' 1', '1 ', '1\n', '9007199254740993', 1]) {
    const setup = fixture('mainnets');
    setup.env.STICKY_DESTINATION_CHAIN_ID = value;
    assert.throws(() => run('propose', 'mainnets', { ...setup,
      read() { assert.fail('invalid destination must fail before reading deployment inputs'); },
      spawn() { assert.fail('invalid destination must fail before any subprocess'); },
    }), /STICKY_DESTINATION_CHAIN_ID/);
  }
  assert.throws(() => destinationChainId('mainnets', { STICKY_DESTINATION_CHAIN_ID: '11155111' }), /belong to mainnets/);
  assert.throws(() => destinationChainId('testnets', { STICKY_DESTINATION_CHAIN_ID: '1' }), /belong to testnets/);
  for (const [group, chains] of Object.entries(networks)) {
    for (const [, id] of chains) assert.equal(destinationChainId(group, { STICKY_DESTINATION_CHAIN_ID: String(id) }), id);
  }
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

test('one invocation reads only the selected family and never falls back to a flat manifest', () => {
  const setup = fixture('mainnets', 8453);
  const other = fixture('mainnets', 1);
  Object.assign(setup.files, other.files);
  const requested = [];
  run('verify', 'mainnets', { ...setup, read(file) {
    requested.push(file);
    return setup.read(file);
  }, spawn(command, args, options) {
    const tool = readOnlyTool(command, args);
    if (tool) return tool;
    assert.equal(options.env.STICKY_DESTINATION_CHAIN_ID, '8453');
    return { status: 0 };
  } });
  assert.deepEqual(requested.filter(file => file.endsWith('/verified.json')),
    networks.mainnets.map(([, , , folder]) => `${familyDirectory(folder, 8453)}/verified.json`));

  const selected = `${familyDirectory('ethereum', 8453)}/verified.json`;
  setup.files['deployments/ethereum/verified.json'] = setup.files[selected];
  delete setup.files[selected];
  assert.throws(() => requireOneAddressPerGroup('mainnets', 'verified', 8453, file => {
    assert.ok(file.includes('/source-collectors/8453/'), 'no flat-manifest fallback');
    if (!setup.files[file]) throw new Error('missing selected family');
    return setup.files[file];
  }), /missing selected family/);
});
