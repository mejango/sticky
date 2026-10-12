import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const compilerArtifact = 'out/Deploy.s.sol/Deploy.json';
export const reviewedInputsPath = 'script/reviewed-inputs.json';
export const reviewedArtifacts = {
  Deploy: { path: compilerArtifact, target: { 'script/Deploy.s.sol': 'Deploy' } },
  StickyAutoStick: {
    path: 'out/StickyAutoStick.sol/StickyAutoStick.json', target: { 'src/StickyAutoStick.sol': 'StickyAutoStick' },
  },
  StickyDeployer: {
    path: 'out/StickyDeployer.sol/StickyDeployer.json', target: { 'src/StickyDeployer.sol': 'StickyDeployer' },
  },
  StickyDistributor: {
    path: 'out/StickyDistributor.sol/StickyDistributor.json',
    target: { 'src/StickyDistributor.sol': 'StickyDistributor' },
  },
  StickyHook: { path: 'out/StickyHook.sol/StickyHook.json', target: { 'src/StickyHook.sol': 'StickyHook' } },
  StickyRewardReceiver: {
    path: 'out/StickyRewardReceiver.sol/StickyRewardReceiver.json',
    target: { 'src/StickyRewardReceiver.sol': 'StickyRewardReceiver' },
  },
  StickyRewardReceiverFactory: {
    path: 'out/StickyRewardReceiverFactory.sol/StickyRewardReceiverFactory.json',
    target: { 'src/StickyRewardReceiverFactory.sol': 'StickyRewardReceiverFactory' },
  },
  StickySourceCollector: {
    path: 'out/StickySourceCollector.sol/StickySourceCollector.json',
    target: { 'src/StickySourceCollector.sol': 'StickySourceCollector' },
  },
  StickySourceFeePayer: {
    path: 'out/StickySourceFeePayer.sol/StickySourceFeePayer.json',
    target: { 'src/StickySourceFeePayer.sol': 'StickySourceFeePayer' },
  },
};

const format = 'sticky-reviewed-deployment-inputs-2';
const coreContracts = ['JBController', 'JBDirectory', 'JBMultiTerminal'];

const digest = value => createHash('sha256').update(value).digest('hex');
const sorted = values => [...values].sort();

function sortedJsonValue(value) {
  return Array.isArray(value) ? value.map(sortedJsonValue)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedJsonValue(value[key])])) : value;
}

export const canonicalJson = value => JSON.stringify(sortedJsonValue(value));

function immutableReferenceGroups(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Missing compiled immutable references: ${path}`);
  }
  const groups = Object.values(value).map(group => {
    if (!Array.isArray(group) || !group.length) throw new Error(`Invalid compiled immutable references: ${path}`);
    return group.map(reference => {
      const { length, start } = reference ?? {};
      if (!Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(start) || start < 0) {
        throw new Error(`Invalid compiled immutable references: ${path}`);
      }
      return { length, start };
    }).sort((a, b) => a.start - b.start || a.length - b.length);
  });
  return groups.sort((a, b) => {
    const left = canonicalJson(a);
    const right = canonicalJson(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function readJson(path, read) {
  try {
    return JSON.parse(read(path, 'utf8'));
  } catch {
    throw new Error(`Missing or invalid reviewed deployment input: ${path}`);
  }
}

function hash(path, read) {
  try {
    return digest(read(path));
  } catch {
    throw new Error(`Missing or unreadable reviewed deployment input: ${path}`);
  }
}

function compilerIdentity(read) {
  const artifact = readJson(compilerArtifact, read);
  const version = artifact.metadata?.compiler?.version;
  const settings = artifact.metadata?.settings;
  if (typeof version !== 'string' || !settings) throw new Error(`Missing compiler metadata: ${compilerArtifact}`);
  if (JSON.stringify(settings.compilationTarget) !== JSON.stringify({ 'script/Deploy.s.sol': 'Deploy' })) {
    throw new Error(`Unexpected compiler target: ${compilerArtifact}`);
  }
  const { remappings: _remappings, ...reviewedSettings } = settings;
  return { version, settingsSHA256: digest(canonicalJson(reviewedSettings)) };
}

function compiledArtifactDigests(read) {
  return Object.fromEntries(Object.entries(reviewedArtifacts).map(([name, { path, target }]) => {
    const artifact = readJson(path, read);
    const creation = artifact.bytecode?.object;
    const runtime = artifact.deployedBytecode?.object;
    const immutableReferences = artifact.deployedBytecode?.immutableReferences ?? {};
    if (JSON.stringify(artifact.metadata?.settings?.compilationTarget) !== JSON.stringify(target)) {
      throw new Error(`Unexpected compiler target: ${path}`);
    }
    if (typeof creation !== 'string' || typeof runtime !== 'string') {
      throw new Error(`Missing compiled bytecode: ${path}`);
    }
    return [name, {
      path,
      creationCodeSHA256: digest(creation),
      immutableReferencesSHA256: digest(canonicalJson(immutableReferenceGroups(immutableReferences, path))),
      runtimeCodeSHA256: digest(runtime),
    }];
  }));
}

export function compiledExternalSources(read = readFileSync) {
  const artifact = readJson(compilerArtifact, read);
  const paths = Object.keys(artifact.metadata?.sources ?? {});
  if (!paths.length) throw new Error(`Missing compiler source metadata: ${compilerArtifact}`);
  const unexpected = paths.filter(path => !/^(src|script)\//.test(path) && !/^(lib|node_modules)\//.test(path));
  if (unexpected.length) throw new Error(`Unexpected compiler source root: ${unexpected[0]}`);
  return sorted(paths.filter(path => /^(lib|node_modules)\//.test(path)));
}

export function deploymentInputs(networkGroups, env = process.env) {
  const coreRoot = env.NANA_CORE_DEPLOYMENT_PATH || 'node_modules/@bananapus/core-v6/deployments';
  const suckerRoot = env.NANA_SUCKERS_DEPLOYMENT_PATH || 'node_modules/@bananapus/suckers-v6/deployments';
  return Object.values(networkGroups).flat().flatMap(([, , , folder]) => [
    ...coreContracts.map(name => ({
      logicalPath: `core-v6/${folder}/${name}.json`,
      physicalPath: `${coreRoot}/${folder}/${name}.json`,
    })),
    {
      logicalPath: `suckers-v6/${folder}/JBSuckerRegistry.json`,
      physicalPath: `${suckerRoot}/${folder}/JBSuckerRegistry.json`,
    },
  ]);
}

export function collectReviewedInputs(networkGroups, { env = process.env, read = readFileSync } = {}) {
  return {
    format,
    compilerArtifact,
    compiler: compilerIdentity(read),
    artifacts: compiledArtifactDigests(read),
    sources: Object.fromEntries(compiledExternalSources(read).map(path => [path, hash(path, read)])),
    deployments: Object.fromEntries(deploymentInputs(networkGroups, env)
      .map(({ logicalPath, physicalPath }) => [logicalPath, hash(physicalPath, read)]).sort(([a], [b]) => a.localeCompare(b))),
  };
}

export function verifyReviewedInputs(networkGroups, group, { env = process.env, read = readFileSync } = {}) {
  if (!networkGroups[group]) throw new Error('Network group must be testnets or mainnets.');
  const manifest = readJson(reviewedInputsPath, read);
  if (manifest.format !== format || manifest.compilerArtifact !== compilerArtifact) {
    throw new Error('The reviewed deployment-input manifest has an unsupported format or compiler artifact.');
  }
  if (JSON.stringify(compilerIdentity(read)) !== JSON.stringify(manifest.compiler)
    || JSON.stringify(compiledArtifactDigests(read)) !== JSON.stringify(manifest.artifacts)) {
    throw new Error('Compiler settings or deployment artifact differs from the reviewed deployment inputs.');
  }

  const sources = compiledExternalSources(read);
  if (sources.join('\n') !== sorted(Object.keys(manifest.sources ?? {})).join('\n')) {
    throw new Error('Compiled external source set differs from the reviewed deployment inputs.');
  }
  for (const path of sources) {
    if (hash(path, read) !== manifest.sources[path]) {
      throw new Error(`Compiled external source differs from the reviewed deployment input: ${path}`);
    }
  }

  const allDeployments = deploymentInputs(networkGroups, env);
  if (sorted(allDeployments.map(({ logicalPath }) => logicalPath)).join('\n')
    !== sorted(Object.keys(manifest.deployments ?? {})).join('\n')) {
    throw new Error('Core or sucker deployment input set differs from the reviewed deployment inputs.');
  }
  for (const { logicalPath, physicalPath } of allDeployments) {
    if (hash(physicalPath, read) !== manifest.deployments[logicalPath]) {
      throw new Error(`Core or sucker deployment file differs from the reviewed input: ${logicalPath}`);
    }
  }
}
