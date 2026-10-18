// Verifies the deployed sources on the explorer and emits one `sphinx-sol-ct-artifact-1` JSON per contract and
// chain, the layout every V6 repository keeps under `deployments/<network>/`. Reads the addresses and constructor
// bindings from the `verified.json` the runner wrote, the compiled artifact from `out/` and the creation
// transaction from Etherscan.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { familyDirectory, networks, requireAllAddressFamilies } from './deploy.mjs';

// Core's ERC-2771 forwarder, the same on every chain. The runner's verify step checks each Sticky contract trusts it.
export const trustedForwarder = '0x3bA60b60933916a7C87D0860DcEE62a0CE34E3e2';

// Each contract's constructor arguments in declaration order: a manifest field, an address, or a policy constant.
// The distributor's words match `_distributorArgs` in script/helpers/StickyDeployment.sol.
export const contracts = [
  { name: 'StickyDeployer', field: 'deployer', args: ['controller', 'terminal', 'hook'] },
  { name: 'StickyHook', field: 'hook', args: ['directory', 'deploymentAuthority', trustedForwarder], create2: 'StickyDeployerV6' },
  { name: 'StickyDistributor', field: 'distributor', args: ['controller', 'directory', 'hook', 7n * 86_400n, 4n, 2n * 365n * 86_400n] },
  { name: 'StickyRewardReceiver', field: 'rewardReceiver', args: ['distributor'] },
  { name: 'StickyRewardReceiverFactory', field: 'rewardReceiverFactory', args: ['rewardReceiver'] },
  { name: 'StickyAutoStick', field: 'autoStick', args: ['deployer', 'distributor'] },
  { name: 'StickySourceCollector', field: 'sourceCollector', args: ['registry', 'tokens', 'rewardReceiverFactory', 'destinationChainId', 'sourceFeePayer'], family: true },
  { name: 'StickySourceFeePayer', field: 'sourceFeePayer', args: ['deploymentAuthority'], create2: 'StickySourceFeePayerV6Explicit1', family: true },
];

// One Etherscan v2 key serves every chain.
const explorer = 'https://api.etherscan.io/v2/api';

export async function emit(group, {
  env = process.env, spawn = spawnSync, fetchJson = explorerFetch, read = readFileSync, write = writeFileSync,
  verifySources = true,
} = {}) {
  if (!networks[group]) throw new Error('Network group must be testnets or mainnets.');
  const key = env.ETHERSCAN_API_KEY?.trim();
  if (!key) throw new Error('Missing ETHERSCAN_API_KEY');
  const revision = env.STICKY_REVISION?.trim();
  if (!revision) throw new Error('Missing STICKY_REVISION');
  // Check every family and constructor before any explorer request or artifact write.
  const families = requireAllAddressFamilies(group, 'verified', read, { expectedRevision: revision });
  // The reviewed Solidity helper is the sole owner of setup authority, rather than the mutable manifests.
  const authorities = [...read('script/helpers/StickyDeployment.sol', 'utf8').matchAll(
    /^\s*address\s+public\s+constant\s+DEPLOYMENT_AUTHORITY\s*=\s*(0x[\da-fA-F]{40})\s*;\s*$/gm,
  )];
  if (authorities.length !== 1) throw new Error('Cannot read the reviewed deployment authority from StickyDeployment.sol.');
  const authority = authorities[0][1].toLowerCase();
  for (const { manifests } of families) {
    for (const { manifest } of manifests) {
      if (typeof manifest.deploymentAuthority !== 'string' || manifest.deploymentAuthority.toLowerCase() !== authority) {
        throw new Error('The manifest deploymentAuthority does not match the reviewed Solidity deployment authority.');
      }
    }
  }
  const childEnv = { ...env, FOUNDRY_PROFILE: 'deploy' };
  const artifacts = new Map(contracts.map(contract => [contract.name,
    JSON.parse(read(`out/${contract.name}.sol/${contract.name}.json`, 'utf8'))]));
  const sharedContracts = contracts.filter(contract => !contract.family);
  const familyContracts = contracts.filter(contract => contract.family);
  const prepared = families.flatMap(({ destinationChainId, manifests }, familyIndex) => manifests.map(context => ({
    ...context,
    destinationChainId,
    // The six shared singleton artifacts have one canonical path per source and need writing only once.
    records: [...(familyIndex === 0 ? sharedContracts : []), ...familyContracts].map(contract => ({
      contract, artifact: artifacts.get(contract.name),
      ...constructorArgs(contract, context.manifest, artifacts.get(contract.name)),
    })),
  })));
  const checkedAddresses = new Set();
  for (const { manifest, records } of prepared) {
    for (const { contract, artifact, argsHex } of records) {
      if (!contract.create2) continue;
      const destination = contract.family ? manifest.destinationChainId : undefined;
      const binding = `${contract.name}:${destination ?? ''}:${manifest[contract.field].toLowerCase()}`;
      if (checkedAddresses.has(binding)) continue;
      checkedAddresses.add(binding);
      const expected = create2Address(contract, artifact, argsHex, destination, spawn, childEnv);
      if (expected.toLowerCase() !== manifest[contract.field].toLowerCase()) {
        throw new Error(`${contract.name}: recorded address does not match the canonical CREATE2 deployment identity.`);
      }
    }
  }
  for (const { alias, chainId, folder, destinationChainId, manifest, records } of prepared) {
    for (const { contract, artifact, args, argsHex } of records) {
      const address = manifest[contract.field];
      const creation = await fetchJson(`${explorer}?chainid=${chainId}&module=contract&action=getcontractcreation&contractaddresses=${address}&apikey=${key}`);
      const txHash = creation.result?.[0]?.txHash;
      if (!txHash) throw new Error(`${alias}: no creation transaction for ${contract.name} at ${address}`);
      // Check the full creation code and constructor arguments for every explicit deployment, including the Hook and FeePayer.
      if (String(creation.result[0].creationBytecode || '').replace(/^0x/, '').toLowerCase()
        !== `${artifact.bytecode.object.replace(/^0x/, '')}${argsHex}`.toLowerCase()) {
        throw new Error(`${alias}: the creation bytecode of ${contract.name} does not match the compiled code and recorded bindings.`);
      }
      const receipt = (await fetchJson(`${explorer}?chainid=${chainId}&module=proxy&action=eth_getTransactionReceipt&txhash=${txHash}&apikey=${key}`)).result;
      if (!receipt?.blockHash) throw new Error(`${alias}: no receipt for ${txHash}`);
      if (verifySources) verify({ alias, chainId, address, contract, argsHex, spawn, env: childEnv, key });
      const record = {
        format: 'sphinx-sol-ct-artifact-1',
        address: address.toLowerCase(),
        sourceName: `src/${contract.name}.sol`,
        contractName: contract.name,
        chainId: `0x${Number(chainId).toString(16)}`,
        ...(contract.family ? { destinationChainId } : {}),
        abi: artifact.abi,
        args,
        solcInputHash: createHash('md5').update(artifact.rawMetadata).digest('hex'),
        receipt,
        bytecode: artifact.bytecode.object,
        deployedBytecode: artifact.deployedBytecode.object,
        metadata: artifact.rawMetadata,
        gitCommit: manifest.revision,
        gitDirty: String(manifest.revision).endsWith('-dirty'),
        history: [],
      };
      const directory = contract.family ? familyDirectory(folder, destinationChainId) : `deployments/${folder}`;
      write(`${directory}/${contract.name}.json`, `${JSON.stringify(record, null, '\t')}\n`);
      console.log(`${alias}: ${contract.name}.json`);
    }
  }
  // Publish the shared record only after all families and creation artifacts succeed.
  // Verify.s.sol writes family manifests; this projection keeps the canonical singleton
  // consumer path current without inventing a second source of deployment identity.
  for (const { folder, manifest } of families[0].manifests) {
    const shared = Object.fromEntries(Object.entries(manifest).filter(([field]) =>
      field !== 'destinationChainId' && !/^(sourceCollector|sourceFeePayer|registry|tokens)(Codehash|Salt)?$/.test(field)));
    write(`deployments/${folder}/verified.json`, `${JSON.stringify(shared, null, 2)}\n`);
  }
}

// Derive explicit child identities from their complete compiled code and recorded constructor bindings.
// The Solidity deployment helper owns these release salts, checked by the deployment regression tests.
export function create2Address(contract, artifact, argsHex, destinationChainId, spawn = spawnSync, env = process.env) {
  const cast = (args, pattern) => {
    const result = spawn('cast', args, { env, encoding: 'utf8' });
    const value = result.stdout?.trim();
    if (result.error || result.status !== 0 || !pattern.test(value ?? '')) {
      throw new Error(`${contract.name}: cannot derive the canonical CREATE2 deployment identity.`);
    }
    return value;
  };
  let salt = `0x${Buffer.from(contract.create2).toString('hex').padEnd(64, '0')}`;
  if (contract.family) {
    salt = cast(['keccak', `${salt}${BigInt(destinationChainId).toString(16).padStart(64, '0')}`], /^0x[\da-fA-F]{64}$/);
  }
  return cast(['compute-address', '--salt', salt, '--init-code', `${artifact.bytecode.object}${argsHex}`,
    '0x4e59b44847b379578588920ca78fbf26c0b4956c'], /^0x[\da-fA-F]{40}$/);
}

// Every constructor takes addresses and unsigned integers, which encode as one 32-byte word each.
export function constructorArgs(contract, manifest, artifact) {
  const inputs = artifact.abi.find(entry => entry.type === 'constructor')?.inputs ?? [];
  if (inputs.length !== contract.args.length || !inputs.every(input => /^(address|uint\d*)$/.test(input.type))) {
    throw new Error(`The compiled ${contract.name} constructor no longer matches the recorded bindings.`);
  }
  const args = contract.args.map((arg, index) => {
    const type = inputs[index].type;
    const value = typeof arg === 'bigint' || /^0x[\da-fA-F]{40}$/.test(arg) ? arg : manifest[arg];
    if (type === 'address') {
      if (typeof value !== 'string' || value.length !== 42 || !/^0x[\da-fA-F]{40}$/.test(value)) {
        throw new Error(`The manifest records no ${arg} address.`);
      }
      return value;
    }
    const bits = Number(type.slice(4) || 256);
    if (!Number.isInteger(bits) || bits < 8 || bits > 256 || bits % 8 !== 0
      || (type !== 'uint' && type !== `uint${bits}`)) {
      throw new Error(`The compiled ${contract.name} constructor no longer matches the recorded bindings.`);
    }
    // ABI integers must be exact decimal values; reject lossy numbers, hex addresses and coercible JS values.
    if (!['string', 'number', 'bigint'].includes(typeof value)
      || (typeof value === 'number' && !Number.isSafeInteger(value)) || !/^(0|[1-9]\d*)$/.test(String(value))
      || BigInt(value).toString() !== String(value) || BigInt(value) >= (1n << BigInt(bits))) {
      throw new Error(`The manifest records an invalid ${arg} ${type} value.`);
    }
    return String(value);
  });
  const argsHex = args.map(value => BigInt(value).toString(16).padStart(64, '0')).join('');
  return { args, argsHex };
}

function verify({ alias, chainId, address, contract, argsHex, spawn, env, key }) {
  const args = ['verify-contract', address, `src/${contract.name}.sol:${contract.name}`, '--chain-id', String(chainId),
    '--verifier', 'etherscan', '--verifier-url', `${explorer}?chainid=${chainId}`, '--etherscan-api-key', key,
    '--compiler-version', '0.8.28', '--num-of-optimizations', '200', '--evm-version', 'cancun', '--via-ir',
    '--skip-is-verified-check', '--watch', '--retries', '12', '--delay', '10'];
  if (argsHex) args.push('--constructor-args', `0x${argsHex}`);
  const result = spawn('forge', args, { env, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0 && !/already verified/i.test(output)) {
    throw new Error(`${alias}: explorer verification of ${contract.name} failed:\n${output.slice(-800)}`);
  }
  console.log(`${alias}: ${contract.name} source verified`);
}

async function explorerFetch(url) {
  for (let attempt = 1; ; attempt++) {
    await sleep(250);
    const body = await (await fetch(url)).json();
    if (!/rate limit|max calls/i.test(String(body.message ?? body.result ?? '')) || attempt === 8) return body;
    await sleep(1000 * 2 ** attempt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: artifacts.mjs <testnets|mainnets>');
    await emit(process.argv[2]);
    console.log(`Sticky artifacts completed for ${process.argv[2]}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
