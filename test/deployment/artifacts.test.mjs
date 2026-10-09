import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { constructorArgs, contracts, emit, trustedForwarder } from '../../script/artifacts.mjs';
import { destinationChainIds, familyDirectory, networks, suite } from '../../script/deploy.mjs';

const code = '0x6080604052';
const addresses = {
  controller: '0x' + '11'.repeat(20), directory: '0x' + '22'.repeat(20), terminal: '0x' + '33'.repeat(20),
  registry: '0x' + '44'.repeat(20), tokens: '0x' + '55'.repeat(20),
  sourceCollector: '0x' + 'a7'.repeat(20), sourceFeePayer: '0x' + 'a8'.repeat(20),
  deployer: '0x' + 'a1'.repeat(20), hook: '0x' + 'a2'.repeat(20), distributor: '0x' + 'a3'.repeat(20),
  rewardReceiver: '0x' + 'a6'.repeat(20), rewardReceiverFactory: '0x' + 'a4'.repeat(20), autoStick: '0x' + 'a5'.repeat(20),
};
const word = value => BigInt(value).toString(16).padStart(64, '0');
const expectedArgs = {
  StickyDeployer: [addresses.controller, addresses.terminal],
  StickyHook: [addresses.directory, addresses.deployer, trustedForwarder],
  StickyDistributor: [addresses.controller, addresses.directory, addresses.hook, '604800', '4', '63072000'],
  StickyRewardReceiver: [addresses.distributor],
  StickyRewardReceiverFactory: [addresses.rewardReceiver],
  StickyAutoStick: [addresses.deployer, addresses.distributor],
  StickySourceCollector: [addresses.registry, addresses.tokens, addresses.rewardReceiverFactory, '1'],
  StickySourceFeePayer: [],
};

const argsFor = (name, destination) => name === 'StickySourceCollector'
  ? [...expectedArgs[name].slice(0, 3), String(destination)] : expectedArgs[name];
const outputPath = (folder, contract, destination) => `${contract.family ? familyDirectory(folder, destination) : `deployments/${folder}`}/${contract.name}.json`;
const familyAddresses = (group, destination) => {
  const index = destinationChainIds(group).indexOf(destination);
  return {
    sourceCollector: `0x${(0xa7 + index * 2).toString(16).repeat(20)}`,
    sourceFeePayer: `0x${(0xa8 + index * 2).toString(16).repeat(20)}`,
  };
};

function artifact(name) {
  return JSON.stringify({
    abi: [{ type: 'constructor', inputs: expectedArgs[name].map(value => ({ type: value.startsWith('0x') ? 'address' : 'uint256' })) }],
    bytecode: { object: code }, deployedBytecode: { object: '0x60' }, rawMetadata: `{"${name}":true}`,
  });
}

function fixture(group, { revision = 'abc123' } = {}) {
  const files = {};
  for (const [, chainId, , folder] of networks[group]) {
    for (const destination of destinationChainIds(group)) {
      files[`${familyDirectory(folder, destination)}/verified.json`] = JSON.stringify({
        ...addresses, ...familyAddresses(group, destination), revision, chainId,
        destinationChainId: destination, kind: 'verified',
      });
    }
  }
  for (const { name } of contracts) files[`out/${name}.sol/${name}.json`] = artifact(name);
  const written = {};
  const verified = [];
  const fetched = [];
  return {
    written, verified, fetched, files,
    options: {
      env: { ETHERSCAN_API_KEY: 'key', STICKY_REVISION: revision },
      read: file => { if (!files[file]) throw new Error(`missing ${file}`); return files[file]; },
      write: (file, content) => { written[file] = JSON.parse(content); },
      spawn: (command, args) => { verified.push({ command, args }); return { status: 0, stdout: '' }; },
      async fetchJson(url) {
        fetched.push(url);
        const { searchParams } = new URL(url);
        if (searchParams.get('action') === 'getcontractcreation') {
          const target = searchParams.get('contractaddresses');
          const destination = destinationChainIds(group).find(destination =>
            Object.values(familyAddresses(group, destination)).includes(target));
          const bindings = destination === undefined ? addresses : { ...addresses, ...familyAddresses(group, destination) };
          const name = contracts.find(contract => bindings[contract.field] === target).name;
          const parent = name === 'StickyHook' ? 'StickyDeployer' : name === 'StickySourceFeePayer' ? 'StickySourceCollector' : undefined;
          const child = Boolean(parent);
          return { result: [{ txHash: `0xtx-${parent ?? name}`,
            creationBytecode: child ? undefined : `${code}${argsFor(name, destination ?? destinationChainIds(group)[0]).map(word).join('')}` }] };
        }
        return { result: { blockHash: '0x' + 'bb'.repeat(32), transactionHash: searchParams.get('txhash') } };
      },
    },
  };
}

test('the artifact contracts cover the whole suite the runner compares across chains', () => {
  assert.deepEqual(contracts.map(contract => contract.field), suite);
});

for (const group of Object.keys(networks)) {
  test(`${group}: shared contracts and every family are verified and written in their canonical layouts`, async () => {
    const { written, verified, options } = fixture(group);
    await emit(group, options);
    for (const [alias, chainId, , folder] of networks[group]) {
      for (const contract of contracts.filter(contract => !contract.family)) {
        const record = written[outputPath(folder, contract, destinationChainIds(group)[0])];
        assert.ok(record, `${alias} must write ${contract.name}.json`);
        assert.equal(record.format, 'sphinx-sol-ct-artifact-1');
        assert.equal(record.address, addresses[contract.field].toLowerCase());
        assert.equal(record.sourceName, `src/${contract.name}.sol`);
        assert.equal(record.contractName, contract.name);
        assert.equal(record.chainId, `0x${chainId.toString(16)}`);
        assert.deepEqual(record.args, argsFor(contract.name, destinationChainIds(group)[0]));
        assert.equal(record.destinationChainId, undefined);
        assert.equal(record.bytecode, code);
        assert.equal(record.gitCommit, 'abc123');
        assert.equal(record.gitDirty, false);
        assert.equal(record.receipt.blockHash, '0x' + 'bb'.repeat(32));
        assert.deepEqual(record.history, []);
      }
      for (const destination of destinationChainIds(group)) {
        const bindings = familyAddresses(group, destination);
        for (const contract of contracts.filter(contract => contract.family)) {
          const record = written[outputPath(folder, contract, destination)];
          assert.ok(record, `${alias} must write home ${destination} ${contract.name}.json`);
          assert.equal(record.address, bindings[contract.field].toLowerCase());
          assert.equal(record.chainId, `0x${chainId.toString(16)}`);
          assert.equal(record.destinationChainId, destination);
          assert.deepEqual(record.args, argsFor(contract.name, destination));
          assert.equal(record.gitCommit, 'abc123');
        }
        assert.equal(written[`${familyDirectory(folder, destination)}/StickySourceFeePayer.json`].receipt.transactionHash,
          '0xtx-StickySourceCollector');
      }
      // The hook is created by the deployer's constructor, so its receipt is the deployer's creation transaction.
      assert.equal(written[`deployments/${folder}/StickyHook.json`].receipt.transactionHash, '0xtx-StickyDeployer');
      assert.ok(!written[`deployments/${folder}/verified.json`], 'canonical singleton manifest is not rewritten');
      assert.ok(!written[`deployments/${folder}/StickySourceCollector.json`], 'no flat source-collector artifact');
    }
    assert.equal(verified.length, networks[group].length * (6 + 2 * destinationChainIds(group).length));
    for (const { command, args } of verified) {
      assert.equal(command, 'forge');
      assert.equal(args[0], 'verify-contract');
      const name = args[2].split(':')[1];
      if (expectedArgs[name].length) assert.equal(args.at(-2), '--constructor-args');
      else assert.ok(!args.includes('--constructor-args'), 'the child constructor takes no arguments');
      assert.ok(args.includes('--via-ir') && args.includes('--skip-is-verified-check'));
      assert.ok(!args.includes('--broadcast'));
    }
    const chainIds = new Set(verified.map(({ args }) => args[args.indexOf('--chain-id') + 1]));
    assert.deepEqual([...chainIds], networks[group].map(([, chainId]) => String(chainId)));
  });
}

test('a dirty revision is recorded as such, and a missing explorer key stops before any read', async () => {
  const dirty = fixture('testnets', { revision: 'abc123-dirty' });
  await emit('testnets', dirty.options);
  assert.equal(dirty.written['deployments/sepolia/StickyDeployer.json'].gitDirty, true);
  const { options, fetched } = fixture('testnets');
  await assert.rejects(emit('testnets', { ...options, env: {} }), /Missing ETHERSCAN_API_KEY/);
  assert.equal(fetched.length, 0);
  await assert.rejects(emit('unknown', options), /Network group/);
});

test('creation bytecode that disagrees with the recorded bindings stops the group', async () => {
  const { options, written } = fixture('mainnets');
  const fetchJson = options.fetchJson;
  options.fetchJson = async url => {
    const body = await fetchJson(url);
    if (body.result?.[0]?.creationBytecode && url.includes(addresses.distributor)) {
      body.result[0].creationBytecode = `${code}${word(addresses.controller)}`;
    }
    return body;
  };
  await assert.rejects(emit('mainnets', options), /creation bytecode of StickyDistributor/);
  assert.ok(!written['deployments/ethereum/StickyDistributor.json']);
});

test('explorer verification failure stops the group, but an already verified source does not', async () => {
  const failing = fixture('testnets');
  failing.options.spawn = () => ({ status: 1, stdout: 'Compiler error' });
  await assert.rejects(emit('testnets', failing.options), /explorer verification of StickyDeployer failed/);
  const verified = fixture('testnets');
  verified.options.spawn = () => ({ status: 1, stderr: 'Contract source code already verified' });
  await emit('testnets', verified.options);
  assert.equal(Object.keys(verified.written).length,
    networks.testnets.length * (6 + 2 * destinationChainIds('testnets').length));
});

test('constructor bindings are encoded from the manifest and rejected when the compiled constructor changes', () => {
  const manifest = { ...addresses };
  const distributor = contracts.find(contract => contract.name === 'StickyDistributor');
  const { args, argsHex } = constructorArgs(distributor, manifest, JSON.parse(artifact('StickyDistributor')));
  assert.deepEqual(args, expectedArgs.StickyDistributor);
  assert.equal(argsHex, expectedArgs.StickyDistributor.map(word).join(''));
  assert.throws(() => constructorArgs(distributor, manifest, { abi: [{ type: 'constructor', inputs: [{ type: 'address' }] }] }), /no longer matches/);
  assert.throws(() => constructorArgs(distributor, manifest, { abi: [{ type: 'constructor',
    inputs: [...Array(5).fill({ type: 'address' }), { type: 'bytes' }] }] }), /no longer matches/);
  assert.throws(() => constructorArgs(distributor, { ...manifest, hook: undefined }, JSON.parse(artifact('StickyDistributor'))), /no hook address/);
  // The compiled distributor takes exactly the policy the helper encodes.
  const compiled = JSON.parse(readFileSync('out/StickyDistributor.sol/StickyDistributor.json', 'utf8'));
  assert.deepEqual(compiled.abi.find(entry => entry.type === 'constructor').inputs.map(input => input.type),
    ['address', 'address', 'address', 'uint256', 'uint256', 'uint48']);
});


test('six deployed singleton creation bytes and constructor bindings stay unchanged', () => {
  const manifest = JSON.parse(readFileSync('deployments/ethereum/verified.json', 'utf8'));
  for (const contract of contracts.filter(contract => !contract.name.startsWith('StickySource'))) {
    const compiled = JSON.parse(readFileSync(`out/${contract.name}.sol/${contract.name}.json`, 'utf8'));
    const deployed = JSON.parse(readFileSync(`deployments/ethereum/${contract.name}.json`, 'utf8'));
    assert.equal(compiled.bytecode.object.toLowerCase(), deployed.bytecode.toLowerCase(), contract.name);
    assert.deepEqual(constructorArgs(contract, manifest, compiled).args.map(String).map(value => value.toLowerCase()),
      deployed.args.map(String).map(value => value.toLowerCase()), contract.name);
  }
});

test('an old live manifest cannot emit undeployed source singleton artifacts', async () => {
  const setup = fixture('mainnets');
  const read = setup.options.read;
  setup.options.read = file => {
    if (!file.endsWith('/verified.json')) return read(file);
    const manifest = JSON.parse(read(file));
    delete manifest.sourceCollector;
    delete manifest.sourceFeePayer;
    return JSON.stringify(manifest);
  };
  await assert.rejects(emit('mainnets', setup.options), /invalid sourceCollector deployment address/);
  assert.deepEqual(setup.written, {}, 'an incomplete live manifest must stop before any artifact write');
  assert.equal(setup.fetched.length, 0);
});

test('all four family manifests and constructor bindings are validated before any explorer request or write', async () => {
  for (const mismatch of [
    { destinationChainId: 8453 }, { destinationChainId: undefined }, { chainId: 1 }, { kind: 'simulation' },
    { revision: 'stale' }, { revision: undefined },
    { sourceCollector: undefined }, { sourceFeePayer: '0x' + '00'.repeat(20) }, { tokens: undefined },
    { sourceFeePayer: [addresses.sourceFeePayer] }, { sourceFeePayer: `${addresses.sourceFeePayer}\n` },
  ]) {
    const setup = fixture('mainnets');
    const file = `${familyDirectory('arbitrum', 42161)}/verified.json`;
    setup.files[file] = JSON.stringify({ ...JSON.parse(setup.files[file]), ...mismatch });
    await assert.rejects(emit('mainnets', setup.options));
    assert.equal(setup.fetched.length, 0, 'a second-chain mismatch must fail before querying the first chain');
    assert.equal(setup.verified.length, 0);
    assert.deepEqual(setup.written, {});
  }
});

test('shared contracts are emitted once per source while every family keeps its own namespace', async () => {
  const setup = fixture('mainnets');
  await emit('mainnets', setup.options);
  for (const [, , , folder] of networks.mainnets) {
    for (const contract of contracts.filter(contract => !contract.family)) {
      assert.ok(setup.written[`deployments/${folder}/${contract.name}.json`]);
      for (const destination of destinationChainIds('mainnets')) {
        assert.ok(!setup.written[`${familyDirectory(folder, destination)}/${contract.name}.json`]);
      }
    }
    for (const destination of destinationChainIds('mainnets')) {
      assert.deepEqual(setup.written[`${familyDirectory(folder, destination)}/StickySourceCollector.json`].args,
        [addresses.registry, addresses.tokens, addresses.rewardReceiverFactory, String(destination)]);
      assert.ok(setup.written[`${familyDirectory(folder, destination)}/StickySourceFeePayer.json`]);
    }
  }
});

test('a missing family manifest never falls back to legacy flat evidence', async () => {
  const setup = fixture('mainnets');
  const selected = `${familyDirectory('ethereum', 8453)}/verified.json`;
  setup.files['deployments/ethereum/verified.json'] = setup.files[selected];
  delete setup.files[selected];
  await assert.rejects(emit('mainnets', setup.options), /missing .*source-collectors\/8453\/verified.json/);
  assert.equal(setup.fetched.length, 0);
  assert.deepEqual(setup.written, {});
});

test('constructor integer encoding follows the compiled ABI and rejects coerced or overflowing values', () => {
  const collector = contracts.find(contract => contract.name === 'StickySourceCollector');
  const compiled = JSON.parse(artifact(collector.name));
  const manifest = { ...addresses, destinationChainId: 8453 };
  const encoded = constructorArgs(collector, manifest, compiled);
  assert.deepEqual(encoded.args, argsFor(collector.name, 8453));
  assert.equal(encoded.argsHex.slice(-64), word(8453));
  for (const value of [undefined, null, true, '', '01', '-1', '+1', '0x1', '1.0', '1e0', '1\n', 1.5,
    Number.MAX_SAFE_INTEGER + 1, (1n << 256n).toString()]) {
    assert.throws(() => constructorArgs(collector, { ...manifest, destinationChainId: value }, compiled), /invalid destinationChainId uint256/);
  }
  const uint8 = structuredClone(compiled);
  uint8.abi[0].inputs[3].type = 'uint8';
  assert.throws(() => constructorArgs(collector, manifest, uint8), /invalid destinationChainId uint8/);
  assert.equal(constructorArgs(collector, { ...manifest, destinationChainId: '255' }, uint8).args[3], '255');
  const invalidWidth = structuredClone(compiled);
  invalidWidth.abi[0].inputs[3].type = 'uint7';
  assert.throws(() => constructorArgs(collector, manifest, invalidWidth), /no longer matches/);
  const address = structuredClone(compiled);
  address.abi[0].inputs[3].type = 'address';
  assert.throws(() => constructorArgs(collector, manifest, address), /no destinationChainId address/);
  const integerRegistry = structuredClone(compiled);
  integerRegistry.abi[0].inputs[0].type = 'uint256';
  assert.throws(() => constructorArgs(collector, manifest, integerRegistry), /invalid registry uint256/);
});
