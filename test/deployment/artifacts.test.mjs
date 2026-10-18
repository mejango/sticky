import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { constructorArgs, contracts, create2Address, emit, explorerFetch, trustedForwarder } from '../../script/artifacts.mjs';
import { destinationChainIds, familyDirectory, networks, suite } from '../../script/deploy.mjs';

const code = '0x6080604052';
const addresses = {
  deploymentAuthority: '0xd5136c794ee43BEf1eD4cF1eB6DEe45b7F803437',
  controller: '0x' + '11'.repeat(20), directory: '0x' + '22'.repeat(20), terminal: '0x' + '33'.repeat(20),
  registry: '0x' + '44'.repeat(20), tokens: '0x' + '55'.repeat(20),
  sourceCollector: '0x' + 'a7'.repeat(20), sourceFeePayer: '0x' + 'a8'.repeat(20),
  deployer: '0x' + 'a1'.repeat(20), hook: '0xa2663a34Fbf3188186eBf3807eAB2d0a4B94dd68', distributor: '0x' + 'a3'.repeat(20),
  rewardReceiver: '0x' + 'a6'.repeat(20), rewardReceiverFactory: '0x' + 'a4'.repeat(20), autoStick: '0x' + 'a5'.repeat(20),
};
const word = value => BigInt(value).toString(16).padStart(64, '0');
const expectedArgs = {
  StickyDeployer: [addresses.controller, addresses.terminal, addresses.hook],
  StickyHook: [addresses.directory, addresses.deploymentAuthority, trustedForwarder],
  StickyDistributor: [addresses.controller, addresses.directory, addresses.hook, '604800', '4', '63072000'],
  StickyRewardReceiver: [addresses.distributor],
  StickyRewardReceiverFactory: [addresses.rewardReceiver],
  StickyAutoStick: [addresses.deployer, addresses.distributor],
  StickySourceCollector: [addresses.registry, addresses.tokens, addresses.rewardReceiverFactory, '1', addresses.sourceFeePayer],
  StickySourceFeePayer: [addresses.deploymentAuthority],
};

// Cache only pure local cast computations, preserving real CREATE2 derivation in mocked explorer tests.
const castResults = new Map();
function castSpawn(command, args) {
  const key = JSON.stringify(args);
  if (!castResults.has(key)) castResults.set(key, spawnSync(command, args, { encoding: 'utf8' }));
  return castResults.get(key);
}
const explicitAddress = (field, destination) => {
  const contract = contracts.find(contract => contract.field === field);
  return create2Address(contract, { bytecode: { object: code } }, expectedArgs[contract.name].map(word).join(''), destination, castSpawn);
};
addresses.hook = explicitAddress('hook');
expectedArgs.StickyDeployer[2] = addresses.hook;
expectedArgs.StickyDistributor[2] = addresses.hook;
const outputPath = (folder, contract, destination) => `${contract.family ? familyDirectory(folder, destination) : `deployments/${folder}`}/${contract.name}.json`;
const familyAddresses = (group, destination) => {
  const index = destinationChainIds(group).indexOf(destination);
  return {
    sourceCollector: `0x${(0xa7 + index * 2).toString(16).repeat(20)}`,
    sourceFeePayer: explicitAddress('sourceFeePayer', destination),
  };
};
const argsFor = (name, destination, group = destinationChainIds('mainnets').includes(destination) ? 'mainnets' : 'testnets') => {
  const family = familyAddresses(group, destination);
  if (name === 'StickySourceCollector') return [...expectedArgs[name].slice(0, 3), String(destination), family.sourceFeePayer];
  if (name === 'StickySourceFeePayer') return expectedArgs[name];
  return expectedArgs[name];
};

function artifact(name) {
  return JSON.stringify({
    abi: [{ type: 'constructor', inputs: expectedArgs[name].map(value => ({ type: value.startsWith('0x') ? 'address' : 'uint256' })) }],
    bytecode: { object: code }, deployedBytecode: { object: '0x60' }, rawMetadata: `{"${name}":true}`,
  });
}

function fixture(group, { revision = 'abc123' } = {}) {
  const files = { 'script/helpers/StickyDeployment.sol': readFileSync('script/helpers/StickyDeployment.sol', 'utf8') };
  for (const [, chainId, , folder] of networks[group]) {
    for (const destination of destinationChainIds(group)) {
      files[`${familyDirectory(folder, destination)}/verified.json`] = JSON.stringify({
        ...addresses, ...familyAddresses(group, destination), revision, chainId,
        destinationChainId: destination, kind: 'verified', rpcBlockNumber: chainId + 10,
        rpcBlockHash: '0x' + '77'.repeat(32), sourceCollectorSalt: 'collector-salt',
        sourceFeePayerSalt: 'fee-salt', sourceCollectorCodehash: 'collector-hash',
        sourceFeePayerCodehash: 'fee-hash', registryCodehash: 'registry-hash', tokensCodehash: 'tokens-hash',
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
      spawn: (command, args) => {
        if (command === 'cast') return castSpawn(command, args);
        verified.push({ command, args });
        return { status: 0, stdout: '' };
      },
      async fetchJson(url) {
        fetched.push(url);
        const { searchParams } = new URL(url);
        if (searchParams.get('action') === 'getcontractcreation') {
          const target = searchParams.get('contractaddresses');
          const destination = destinationChainIds(group).find(destination =>
            Object.values(familyAddresses(group, destination)).includes(target));
          const bindings = destination === undefined ? addresses : { ...addresses, ...familyAddresses(group, destination) };
          const name = contracts.find(contract => bindings[contract.field] === target).name;
          return { result: [{ txHash: `0xtx-${name}`,
            creationBytecode: `${code}${argsFor(name, destination ?? destinationChainIds(group)[0]).map(word).join('')}` }] };
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
          '0xtx-StickySourceFeePayer');
      }
      // Explicit singleton deployments retain their own creation receipts.
      assert.equal(written[`deployments/${folder}/StickyHook.json`].receipt.transactionHash, '0xtx-StickyHook');
      const shared = written[`deployments/${folder}/verified.json`];
      assert.equal(shared.kind, 'verified');
      assert.equal(shared.chainId, chainId);
      assert.equal(shared.revision, 'abc123');
      assert.equal(shared.deploymentAuthority, addresses.deploymentAuthority);
      assert.equal(shared.hook, addresses.hook);
      assert.equal(shared.rpcBlockNumber, chainId + 10);
      assert.equal(shared.rpcBlockHash, '0x' + '77'.repeat(32));
      for (const field of ['destinationChainId', 'sourceCollector', 'sourceFeePayer', 'registry', 'tokens',
        'sourceCollectorSalt', 'sourceFeePayerSalt', 'sourceCollectorCodehash', 'sourceFeePayerCodehash', 'registryCodehash', 'tokensCodehash']) {
        assert.equal(shared[field], undefined, `shared manifest excludes ${field}`);
      }
      assert.ok(!written[`deployments/${folder}/StickySourceCollector.json`], 'no flat source-collector artifact');
    }
    assert.equal(verified.length, networks[group].length * (6 + 2 * destinationChainIds(group).length));
    for (const { command, args } of verified) {
      assert.equal(command, 'forge');
      assert.equal(args[0], 'verify-contract');
      assert.equal(args.at(-2), '--constructor-args');
      assert.ok(args.includes('--via-ir') && args.includes('--watch'));
      assert.ok(!args.includes('--skip-is-verified-check'), 'native verification check makes interrupted runs idempotent');
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
  assert.ok(!Object.keys(written).some(path => path.endsWith('/verified.json')), 'no shared manifest is published for a partial artifact group');
});

test('explorer verification failure stops the group, but an already verified source does not', async () => {
  const failing = fixture('testnets');
  const failingSpawn = failing.options.spawn;
  failing.options.spawn = (command, args, options) => command === 'cast'
    ? failingSpawn(command, args, options) : { status: 1, stdout: 'Compiler error' };
  await assert.rejects(emit('testnets', failing.options), /explorer verification of StickyDeployer failed/);
  const verified = fixture('testnets');
  const verifiedSpawn = verified.options.spawn;
  verified.options.spawn = (command, args, options) => command === 'cast'
    ? verifiedSpawn(command, args, options) : { status: 1, stderr: 'Contract source code already verified' };
  await emit('testnets', verified.options);
  assert.equal(Object.keys(verified.written).length,
    networks.testnets.length * (7 + 2 * destinationChainIds('testnets').length));
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


test('compiled explicit singleton constructors match the release artifact bindings', () => {
  const destination = 1;
  const manifest = { ...addresses, ...familyAddresses('mainnets', destination), destinationChainId: destination };
  for (const contract of contracts) {
    const compiled = JSON.parse(readFileSync(`out/${contract.name}.sol/${contract.name}.json`, 'utf8'));
    assert.deepEqual(constructorArgs(contract, manifest, compiled).args, argsFor(contract.name, destination), contract.name);
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

test('a fee payer assigned to the wrong collector family stops before any explorer request or write', async () => {
  const setup = fixture('mainnets');
  const [first, second] = destinationChainIds('mainnets');
  for (const [, , , folder] of networks.mainnets) {
    const firstFile = `${familyDirectory(folder, first)}/verified.json`;
    const secondFile = `${familyDirectory(folder, second)}/verified.json`;
    const firstManifest = JSON.parse(setup.files[firstFile]);
    const secondManifest = JSON.parse(setup.files[secondFile]);
    [firstManifest.sourceFeePayer, secondManifest.sourceFeePayer] =
      [secondManifest.sourceFeePayer, firstManifest.sourceFeePayer];
    setup.files[firstFile] = JSON.stringify(firstManifest);
    setup.files[secondFile] = JSON.stringify(secondManifest);
  }
  await assert.rejects(emit('mainnets', setup.options), /StickySourceFeePayer.*canonical CREATE2 deployment identity/);
  assert.equal(setup.fetched.length, 0);
  assert.equal(setup.verified.length, 0);
  assert.deepEqual(setup.written, {});
});

test('an explicit singleton assigned to the wrong release identity stops before any explorer request or write', async () => {
  const setup = fixture('mainnets');
  for (const file of Object.keys(setup.files).filter(file => file.endsWith('/verified.json'))) {
    const manifest = JSON.parse(setup.files[file]);
    manifest.hook = addresses.autoStick;
    setup.files[file] = JSON.stringify(manifest);
  }
  await assert.rejects(emit('mainnets', setup.options), /StickyHook.*canonical CREATE2 deployment identity/);
  assert.equal(setup.fetched.length, 0);
  assert.equal(setup.verified.length, 0);
  assert.deepEqual(setup.written, {});
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
        argsFor('StickySourceCollector', destination));
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
  const manifest = { ...addresses, ...familyAddresses('mainnets', 8453), destinationChainId: 8453 };
  const encoded = constructorArgs(collector, manifest, compiled);
  assert.deepEqual(encoded.args, argsFor(collector.name, 8453));
  assert.equal(encoded.argsHex.slice(3 * 64, 4 * 64), word(8453));
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


test('explicit CREATE2 identities are bound to creation bytes, setup authority and destination', () => {
  const hook = contracts.find(contract => contract.field === 'hook');
  const fee = contracts.find(contract => contract.field === 'sourceFeePayer');
  const argsHex = expectedArgs.StickyHook.map(word).join('');
  const artifact = { bytecode: { object: code } };
  // Independently calculated with the pinned cast CREATE2 command and the literal fixture constructor words.
  const expected = '0xfeB1d99994ce2907c82d4Ff9123cf2EBd5E48C61';
  assert.equal(create2Address(hook, artifact, argsHex, undefined, castSpawn), expected);
  assert.notEqual(create2Address(hook, { bytecode: { object: '0x6080604053' } }, argsHex, undefined, castSpawn), expected);
  assert.notEqual(create2Address(hook, artifact, expectedArgs.StickyHook.map((arg, index) => word(index === 1 ? addresses.controller : arg)).join(''), undefined, castSpawn), expected);
  const families = destinationChainIds('mainnets').map(destination => explicitAddress('sourceFeePayer', destination));
  assert.equal(new Set(families).size, 4);
  const helper = readFileSync('script/helpers/StickyDeployment.sol', 'utf8');
  assert.ok(helper.includes(`STICKY_SALT = "${hook.create2}"`));
  assert.ok(helper.includes(`SOURCE_FEE_PAYER_SALT = "${fee.create2}"`));
});

test('CREATE2 computation failures stop all explorer requests and writes', async () => {
  for (const badResult of [{ status: 1, stdout: '' }, { status: 0, stdout: 'not an address' }, { error: new Error('missing cast') }]) {
    const setup = fixture('mainnets');
    const spawn = setup.options.spawn;
    setup.options.spawn = (command, args) => command === 'cast' ? badResult : spawn(command, args);
    await assert.rejects(emit('mainnets', setup.options), /cannot derive.*CREATE2/);
    assert.equal(setup.fetched.length, 0);
    assert.equal(setup.verified.length, 0);
    assert.deepEqual(setup.written, {});
  }
});

for (const field of ['hook', 'sourceFeePayer']) {
  test(`the explicit ${field} creation payload is checked instead of exempted as a constructor child`, async () => {
    const setup = fixture('mainnets');
    const fetchJson = setup.options.fetchJson;
    const target = field === 'hook' ? addresses.hook : familyAddresses('mainnets', 1).sourceFeePayer;
    setup.options.fetchJson = async url => {
      const body = await fetchJson(url);
      if (url.includes(target) && body.result?.[0]) delete body.result[0].creationBytecode;
      return body;
    };
    await assert.rejects(emit('mainnets', setup.options), /creation bytecode.*does not match/);
    assert.ok(!Object.keys(setup.written).some(path => path.endsWith(`/${contracts.find(contract => contract.field === field).name}.json`)));
  });
}


test('a substituted setup authority cannot emit artifacts even after recomputing every CREATE2 child address', async () => {
  const setup = fixture('mainnets');
  const malicious = addresses.controller;
  for (const file of Object.keys(setup.files).filter(file => file.endsWith('/verified.json'))) {
    const manifest = JSON.parse(setup.files[file]);
    manifest.deploymentAuthority = malicious;
    for (const contract of contracts.filter(contract => contract.create2)) {
      const compiled = JSON.parse(setup.files[`out/${contract.name}.sol/${contract.name}.json`]);
      const { argsHex } = constructorArgs(contract, manifest, compiled);
      manifest[contract.field] = create2Address(contract, compiled, argsHex, manifest.destinationChainId, castSpawn);
    }
    setup.files[file] = JSON.stringify(manifest);
  }
  await assert.rejects(emit('mainnets', setup.options), /deploymentAuthority does not match the reviewed Solidity/);
  assert.equal(setup.fetched.length, 0);
  assert.equal(setup.verified.length, 0);
  assert.deepEqual(setup.written, {});
});

test('missing, duplicate or computed Solidity setup authority is rejected before explorer access', async () => {
  for (const source of ['',
    'address public constant DEPLOYMENT_AUTHORITY = address(1);',
    `address public constant DEPLOYMENT_AUTHORITY = ${addresses.deploymentAuthority};\naddress public constant DEPLOYMENT_AUTHORITY = ${addresses.controller};`,
  ]) {
    const setup = fixture('mainnets');
    setup.files['script/helpers/StickyDeployment.sol'] = source;
    // The read double must permit an empty source to exercise the parser rather than a missing-file error.
    const read = setup.options.read;
    setup.options.read = file => file === 'script/helpers/StickyDeployment.sol' ? source : read(file);
    await assert.rejects(emit('mainnets', setup.options), /Cannot read the reviewed deployment authority/);
    assert.equal(setup.fetched.length, 0);
    assert.equal(setup.verified.length, 0);
    assert.deepEqual(setup.written, {});
  }
});


// These responses reproduce the explorer's NOTOK envelope and temporary empty evidence,
// without public API traffic or real backoff delays.
const explorerUrl = action => `https://example.invalid/api?action=${action}&apikey=private-test-key`;
function explorerResponses(responses) {
  const delays = [];
  let calls = 0;
  return {
    delays, get calls() { return calls; },
    options: {
      fetchResponse: async () => ({ ok: true, status: 200, json: async () => responses[Math.min(calls++, responses.length - 1)] }),
      wait: async delay => { delays.push(delay); },
    },
  };
}

for (const rate of [
  { status: '0', message: 'NOTOK', result: 'Max rate limit reached, please use API Key for higher rate limit' },
  { message: 'NOTOK', error: { message: 'Max calls per sec rate limit reached' } },
]) {
  test('rate-limit result/error is retried even when message is NOTOK', async () => {
    const found = { result: { blockHash: '0x123' } };
    const run = explorerResponses([rate, found]);
    assert.deepEqual(await explorerFetch(explorerUrl('eth_getTransactionReceipt'), run.options), found);
    assert.equal(run.calls, 2);
    assert.deepEqual(run.delays, [250, 2000, 250]);
  });
}

for (const [action, missing, found] of [
  ['eth_getTransactionReceipt', { jsonrpc: '2.0', result: null }, { result: { blockHash: '0x123' } }],
  ['getcontractcreation', { status: '0', message: 'No data found', result: [] }, { status: '1', result: [{ txHash: '0x123' }] }],
]) {
  test(`${action}: transient missing evidence retries, persistent missing evidence fails closed`, async () => {
    const recovered = explorerResponses([missing, found]);
    assert.deepEqual(await explorerFetch(explorerUrl(action), recovered.options), found);
    assert.equal(recovered.calls, 2);
    const absent = explorerResponses([missing]);
    await assert.rejects(explorerFetch(explorerUrl(action), absent.options), /missing creation or receipt evidence persisted after 8 attempts/);
    assert.equal(absent.calls, 8);
    assert.ok(absent.delays.every(delay => delay <= 10_000));
    assert.equal(absent.delays.reduce((a, b) => a + b), 56_000);
  });
}

test('persistent rate limits and unretryable API errors identify the action without exposing secrets', async () => {
  const limited = explorerResponses([{ status: '0', message: 'NOTOK', result: 'Max rate limit reached' }]);
  await assert.rejects(explorerFetch(explorerUrl('getcontractcreation'), limited.options), /Explorer getcontractcreation: rate limit persisted after 8 attempts/);
  assert.equal(limited.calls, 8);
  for (const failure of [
    { status: '0', message: 'NOTOK', result: 'Invalid API key private-test-key' },
    { error: { message: 'Invalid method private-test-key' } },
  ]) {
    const rejected = explorerResponses([failure]);
    await assert.rejects(explorerFetch(explorerUrl('getcontractcreation'), rejected.options), error =>
      /Explorer getcontractcreation: API rejected/.test(error.message) && !/private-test-key|https:/.test(error.message));
    assert.equal(rejected.calls, 1);
  }
});


test('Forge native lookup throttling retries before publishing and retains native verification flags', async () => {
  const setup = fixture('mainnets');
  const spawn = setup.options.spawn;
  const delays = [];
  let calls = 0;
  setup.options.wait = async delay => { delays.push(delay); };
  setup.options.spawn = (command, args) => command === 'forge' && ++calls === 1
    ? { status: 1, stderr: 'Max calls per sec rate limit reached (5/sec)' }
    : spawn(command, args);
  await emit('mainnets', setup.options);
  assert.equal(calls, 57);
  assert.deepEqual(delays, [2000]);
  assert.ok(setup.verified.every(({ args }) => args.includes('--watch') && !args.includes('--skip-is-verified-check')));
});

for (const [output, expectedCalls] of [
  ['Max calls per sec rate limit reached (5/sec)', 8],
  ['Invalid API key key at https://example.invalid/?apikey=key', 1],
]) {
  test(`Forge failures remain bounded and do not publish artifacts (${expectedCalls} attempts)`, async () => {
    const setup = fixture('mainnets');
    const spawn = setup.options.spawn;
    const delays = [];
    let calls = 0;
    setup.options.wait = async delay => { delays.push(delay); };
    setup.options.spawn = (command, args) => command === 'forge'
      ? (++calls, { status: 1, stderr: output }) : spawn(command, args);
    await assert.rejects(emit('mainnets', setup.options), error =>
      error.message.includes(`after ${expectedCalls} attempt(s)`) && !/https:|apikey=key|API key key/.test(error.message));
    assert.equal(calls, expectedCalls);
    assert.deepEqual(setup.written, {});
    assert.equal(delays.reduce((a, b) => a + b, 0), expectedCalls === 8 ? 54000 : 0);
  });
}
