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
  { name: 'StickyDeployer', field: 'deployer', args: ['controller', 'terminal'] },
  // The deployer's constructor creates the hook, so the explorer attributes it to the deployer's creation transaction.
  { name: 'StickyHook', field: 'hook', args: ['directory', 'deployer', trustedForwarder], parent: 'deployer' },
  { name: 'StickyDistributor', field: 'distributor', args: ['controller', 'directory', 'hook', 7n * 86_400n, 4n, 2n * 365n * 86_400n] },
  { name: 'StickyRewardReceiver', field: 'rewardReceiver', args: ['distributor'] },
  { name: 'StickyRewardReceiverFactory', field: 'rewardReceiverFactory', args: ['rewardReceiver'] },
  { name: 'StickyAutoStick', field: 'autoStick', args: ['deployer', 'distributor'] },
  { name: 'StickySourceCollector', field: 'sourceCollector', args: ['registry', 'tokens', 'rewardReceiverFactory', 'destinationChainId'], family: true },
  { name: 'StickySourceFeePayer', field: 'sourceFeePayer', args: [], parent: 'sourceCollector', family: true },
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
  const checkedChildren = new Set();
  for (const { manifest, records } of prepared) {
    for (const { contract } of records) {
      if (!contract.parent) continue;
      const parent = manifest[contract.parent];
      const child = manifest[contract.field];
      const binding = `${parent.toLowerCase()}:${child.toLowerCase()}`;
      if (checkedChildren.has(binding)) continue;
      checkedChildren.add(binding);
      const result = spawn('cast', ['compute-address', '--nonce', '1', parent], { env: childEnv, encoding: 'utf8' });
      if (result.error || result.status !== 0 || result.stdout?.trim().toLowerCase() !== child.toLowerCase()) {
        throw new Error(`${contract.name}: recorded address is not the ${contract.parent} nonce-1 CREATE child.`);
      }
    }
  }
  for (const { alias, chainId, folder, destinationChainId, manifest, records } of prepared) {
    for (const { contract, artifact, args, argsHex } of records) {
      const address = manifest[contract.field];
      const creation = await fetchJson(`${explorer}?chainid=${chainId}&module=contract&action=getcontractcreation&contractaddresses=${address}&apikey=${key}`);
      const txHash = creation.result?.[0]?.txHash;
      if (!txHash) throw new Error(`${alias}: no creation transaction for ${contract.name} at ${address}`);
      // The explorer's creation bytecode is the factory's payload without the salt: creation code then arguments.
      // It must agree with the bindings the manifest recorded; a constructor-created child has no payload of its own.
      if (!contract.parent && String(creation.result[0].creationBytecode || '').replace(/^0x/, '').toLowerCase()
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
