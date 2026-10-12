import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { canonicalJson, verifyReviewedInputs } from './reviewed-inputs.mjs';

export const networks = {
  mainnets: [
    ['ethereum', 1, 'RPC_ETHEREUM_MAINNET', 'ethereum'],
    ['optimism', 10, 'RPC_OPTIMISM_MAINNET', 'optimism'],
    ['base', 8453, 'RPC_BASE_MAINNET', 'base'],
    ['arbitrum', 42161, 'RPC_ARBITRUM_MAINNET', 'arbitrum'],
  ],
  testnets: [
    ['ethereum_sepolia', 11155111, 'RPC_ETHEREUM_SEPOLIA', 'sepolia'],
    ['optimism_sepolia', 11155420, 'RPC_OPTIMISM_SEPOLIA', 'optimism_sepolia'],
    ['base_sepolia', 84532, 'RPC_BASE_SEPOLIA', 'base_sepolia'],
    ['arbitrum_sepolia', 421614, 'RPC_ARBITRUM_SEPOLIA', 'arbitrum_sepolia'],
  ],
};

// Every supported source environment deploys the same complete ordered set of home-chain families.
export function destinationChainIds(group) {
  if (!networks[group]) throw new Error('Network group must be testnets or mainnets.');
  return networks[group].map(([, chainId]) => chainId);
}

export function familyDirectory(folder, id) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid collector destination chain ID.');
  return `deployments/${folder}/source-collectors/${id}`;
}

export function preflight(group, env = process.env, read = readFileSync) {
  const destinations = destinationChainIds(group);
  const errors = [];
  const root = env.NANA_CORE_DEPLOYMENT_PATH || 'node_modules/@bananapus/core-v6/deployments';
  const suckerRoot = env.NANA_SUCKERS_DEPLOYMENT_PATH || 'node_modules/@bananapus/suckers-v6/deployments';
  for (const [alias, chainId, variable, folder] of networks[group]) {
    if (!env[variable]?.trim()) errors.push(`${alias}: missing ${variable}`);
    for (const [artifactRoot, name] of [
      ...['JBController', 'JBDirectory', 'JBMultiTerminal'].map(name => [root, name]), [suckerRoot, 'JBSuckerRegistry'],
    ]) {
      const file = `${artifactRoot}/${folder}/${name}.json`;
      try {
        const artifact = JSON.parse(read(file, 'utf8'));
        if (typeof artifact.address !== 'string' || artifact.address.length !== 42
          || !/^0x[\da-fA-F]{40}$/.test(artifact.address) || /^0x0{40}$/.test(artifact.address)) {
          throw new Error('invalid contract address');
        }
        if (BigInt(artifact.chainId) !== BigInt(chainId)) throw new Error('wrong chain ID');
      } catch {
        errors.push(`${alias}: missing or invalid ${name} artifact (address/chain ID)`);
      }
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return destinations;
}

// Shared fields agree across every source and home; family fields agree across sources and differ by home.
export const suite = ['deployer', 'hook', 'distributor', 'rewardReceiver', 'rewardReceiverFactory', 'autoStick', 'sourceCollector', 'sourceFeePayer'];
export const sharedSuite = suite.filter(field => !field.startsWith('source'));
export const familySuite = suite.filter(field => field.startsWith('source'));

// Every source must record every home, with one distinct collector family per home.
export function requireAllAddressFamilies(group, kind, read = readFileSync, {
  expectedRevision,
  expectedRpcBlocks = {},
} = {}) {
  const destinations = destinationChainIds(group);
  if (!['simulation', 'verified'].includes(kind)) throw new Error('Manifest kind must be simulation or verified.');
  let expectedShared;
  const seenFamilyAddresses = Object.fromEntries(familySuite.map(field => [field, new Set()]));
  const families = [];
  for (const destination of destinations) {
    let expectedFamily;
    const manifests = [];
    for (const [alias, chainId, , folder] of networks[group]) {
      const manifest = JSON.parse(read(`${familyDirectory(folder, destination)}/${kind}.json`, 'utf8'));
      if (manifest.destinationChainId !== destination || manifest.chainId !== chainId || manifest.kind !== kind) {
        throw new Error(`${alias}: manifest destination, source chain or kind does not match the ${destination} ${kind} family.`);
      }
      if (expectedRevision !== undefined && manifest.revision !== expectedRevision) {
        throw new Error(`${alias}: home ${destination} manifest revision does not match the current deployment revision.`);
      }
      const expectedBlock = expectedRpcBlocks[alias];
      if (expectedBlock !== undefined && (
        !Number.isSafeInteger(manifest.rpcBlockNumber) || manifest.rpcBlockNumber <= 0
        || BigInt(manifest.rpcBlockNumber).toString() !== expectedBlock.number
        || typeof manifest.rpcBlockHash !== 'string'
        || manifest.rpcBlockHash.toLowerCase() !== expectedBlock.hash.toLowerCase()
      )) {
        throw new Error(`${alias}: home ${destination} manifest does not match the freshly pinned RPC block.`);
      }
      for (const field of suite) {
        if (typeof manifest[field] !== 'string' || manifest[field].length !== 42
          || !/^0x[\da-fA-F]{40}$/.test(manifest[field]) || /^0x0{40}$/i.test(manifest[field])) {
          throw new Error(`${alias}: missing or invalid ${field} deployment address for home ${destination}.`);
        }
      }
      const sharedIdentity = sharedSuite.map(field => `${field}=${manifest[field].toLowerCase()}`).join(' ');
      expectedShared ??= sharedIdentity;
      if (sharedIdentity !== expectedShared) {
        throw new Error(`${alias}: shared deployment differs for home ${destination}: ${sharedIdentity}`);
      }
      const familyIdentity = familySuite.map(field => `${field}=${manifest[field].toLowerCase()}`).join(' ');
      expectedFamily ??= familyIdentity;
      if (familyIdentity !== expectedFamily) {
        throw new Error(`${alias}: home ${destination} predicts a different collector family: ${familyIdentity}`);
      }
      manifests.push({ alias, chainId, folder, manifest });
    }
    for (const field of familySuite) {
      const address = manifests[0].manifest[field].toLowerCase();
      if (seenFamilyAddresses[field].has(address)) {
        throw new Error(`Home ${destination} reuses another family's ${field} address ${address}.`);
      }
      seenFamilyAddresses[field].add(address);
    }
    families.push({ destinationChainId: destination, manifests });
  }
  return families;
}

// Whether the working sphinx.lock holds exactly the committed content, ignoring key order.
export function sameLock(spawn = spawnSync, read = readFileSync, revision = 'HEAD') {
  const committed = spawn('git', ['show', `${revision}:sphinx.lock`], { encoding: 'utf8' });
  try {
    return committed.status === 0
      && canonicalJson(JSON.parse(committed.stdout)) === canonicalJson(JSON.parse(read('sphinx.lock', 'utf8')));
  } catch {
    return false;
  }
}

export function run(action, group, {
  env = process.env, spawn = spawnSync, read = readFileSync, verifyInputs = verifyReviewedInputs,
} = {}) {
  if (!['preflight', 'rehearse', 'dry-run', 'propose', 'verify', 'artifacts'].includes(action)) {
    throw new Error('Usage: deploy.sh <preflight|rehearse|dry-run|propose|verify|artifacts> <testnets|mainnets>');
  }
  preflight(group, env, read);
  if (action === 'dry-run' || action === 'propose') {
    for (const key of ['SPHINX_MANAGED_BASE_URL', 'SPHINX_ORG_ID', 'SPHINX_API_KEY']) {
      if (!env[key]?.trim()) throw new Error(`Missing ${key}`);
    }
    // Sphinx resolves the organization and Safe from this public lock before collecting any transactions.
    let lock;
    let projectName;
    try {
      lock = JSON.parse(read('sphinx.lock', 'utf8'));
      projectName = read('script/Deploy.s.sol', 'utf8').match(/sphinxConfig\.projectName\s*=\s*"([^"]+)"/)?.[1];
      if (!projectName || lock.projects?.[projectName]?.projectName !== projectName) throw new Error();
    } catch {
      throw new Error('The committed sphinx.lock must contain the deployment script\'s registered Sphinx project.');
    }
    if (lock.orgId !== env.SPHINX_ORG_ID.trim()) {
      throw new Error('SPHINX_ORG_ID does not match the committed sphinx.lock organization.');
    }
  }
  if (action === 'preflight') return;
  const inspectCheckout = expectedRevision => {
    const before = spawn('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (before.status !== 0) throw new Error('Cannot record the source revision.');
    const currentRevision = before.stdout.trim();
    const status = spawn('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' });
    if (status.status !== 0) throw new Error('Cannot inspect the source checkout.');
    const lockIsCurrent = sameLock(spawn, read, currentRevision);
    const after = spawn('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (after.status !== 0) throw new Error('Cannot record the source revision.');
    if (after.stdout.trim() !== currentRevision || (expectedRevision !== undefined && currentRevision !== expectedRevision)) {
      throw new Error(`The source revision changed during ${action}; stopping.`);
    }
    // The runner's own outputs under deployments/ do not make the reviewed source dirty, and neither does Sphinx
    // re-serializing sphinx.lock in a different key order during a proposal.
    const dirty = status.stdout.split('\n').some(line => line.trim() && !/^.{3}deployments\//.test(line)
      && !(line === ' M sphinx.lock' && lockIsCurrent));
    // Only a committed checkout may reach the Safe or certify a live deployment; rehearsals may carry development changes.
    if ((!lockIsCurrent || dirty) && action !== 'rehearse') {
      throw new Error(`Commit the reviewed checkout before ${action}; it has uncommitted changes.`);
    }
    return { dirty, revision: currentRevision };
  };
  const checkout = inspectCheckout();
  const childEnv = {
    ...env, FOUNDRY_OUT: 'out', FOUNDRY_PROFILE: 'deploy',
    STICKY_REVISION: checkout.revision + (checkout.dirty ? '-dirty' : ''),
  };
  const execute = (command, args, chainId = 0, block = { number: '0', hash: '0x' + '00'.repeat(32) }) => {
    const result = spawn(command, args, { env: {
      ...childEnv, STICKY_EXPECTED_CHAIN_ID: String(chainId),
      STICKY_RPC_BLOCK_NUMBER: block.number, STICKY_RPC_BLOCK_HASH: block.hash,
    }, stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error(`${command} failed; stopping ${group} ${action}.`);
  };
  // Release paths rebuild the exact proposal entrypoint before authenticating its external inputs and bytecode.
  // Direct rehearsals deliberately remain available for dirty local development; dry-run and propose rehearse again.
  const verifyReleaseInputs = () => {
    execute('forge', ['build', '--force', 'script/Deploy.s.sol']);
    verifyInputs(networks, group, { env: childEnv, read });
  };
  if (['dry-run', 'propose', 'verify', 'artifacts'].includes(action)) verifyReleaseInputs();
  // Explorer verification and per-contract artifacts read the verified manifests, so they follow a verify.
  if (action === 'artifacts') {
    inspectCheckout(checkout.revision);
    execute('node', ['script/artifacts.mjs', group]);
    return;
  }
  // Rehearse every source and all four of its destination families before creating a Sphinx proposal.
  const script = action === 'verify' ? 'Verify' : 'Rehearse';
  const expectedRpcBlocks = {};
  const readRpcBlock = (alias, tag, description) => {
    const header = spawn('cast', ['block', tag, '--json', '--rpc-url', alias], { env: childEnv, encoding: 'utf8' });
    try {
      if (header.status !== 0) throw new Error();
      const payload = JSON.parse(header.stdout);
      if (payload.success === false) throw new Error();
      const rpcBlock = payload.data ?? payload;
      rpcBlock.number = BigInt(rpcBlock.number).toString();
      if (BigInt(rpcBlock.number) <= 0n || !/^0x[\da-fA-F]{64}$/.test(rpcBlock.hash)) throw new Error();
      return rpcBlock;
    } catch {
      throw new Error(`${alias}: cannot read ${description} RPC block; stopping ${action}.`);
    }
  };
  for (const [alias, chainId] of networks[group]) {
    console.log(`${action}: ${alias}`);
    // Finalized RPC block heights identify fork state even on chains where EVM block.number means an L1 height.
    const block = readRpcBlock(alias, 'finalized', 'a finalized');
    execute('forge', ['script', `script/${script}.s.sol:${script}`, '--rpc-url', alias,
      '--fork-block-number', block.number, '-vv'], chainId, block);
    const pinnedBlock = readRpcBlock(alias, block.number, 'the pinned finalized');
    if (pinnedBlock.number !== block.number || pinnedBlock.hash.toLowerCase() !== block.hash.toLowerCase()) {
      throw new Error(`${alias}: finalized RPC block identity changed during ${action}.`);
    }
    expectedRpcBlocks[alias] = block;
  }
  requireAllAddressFamilies(group, script === 'Verify' ? 'verified' : 'simulation', read, {
    expectedRevision: childEnv.STICKY_REVISION,
    expectedRpcBlocks,
  });
  if (action === 'verify' || action === 'dry-run' || action === 'propose') {
    inspectCheckout(checkout.revision);
    verifyReleaseInputs();
    inspectCheckout(checkout.revision);
  }
  if (action === 'dry-run' || action === 'propose') {
    execute('node_modules/.bin/sphinx', [
      'propose', 'script/Deploy.s.sol', '--target-contract', 'Deploy', '--networks', group,
      ...(action === 'dry-run' ? ['--dry-run'] : []),
    ]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: deploy.sh <preflight|rehearse|dry-run|propose|verify|artifacts> <testnets|mainnets>');
    run(process.argv[2], process.argv[3]);
    console.log(`Sticky ${process.argv[2]} completed for ${process.argv[3]}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
