import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { networks } from '../../script/deploy.mjs';
import {
  compiledExternalSources, compilerArtifact, deploymentInputs, reviewedInputsPath, verifyReviewedInputs,
} from '../../script/reviewed-inputs.mjs';

const suckerInterface = 'node_modules/@bananapus/suckers-v6/src/interfaces/IJBSuckerRegistry.sol';

function changedRead(target, change) {
  return (path, encoding) => {
    const value = readFileSync(path, encoding);
    return path === target ? change(value) : value;
  };
}

function changedJson(target, change) {
  return changedRead(target, value => `${JSON.stringify(change(JSON.parse(value)))}\n`);
}

test('the reviewed manifest binds the exact Deploy closure and all 32 deployment inputs', () => {
  verifyReviewedInputs(networks, 'testnets');
  verifyReviewedInputs(networks, 'mainnets');
  const sources = compiledExternalSources();
  assert.equal(sources.length, 222);
  assert.ok(sources.includes(suckerInterface));
  const deployments = deploymentInputs(networks);
  assert.equal(deployments.length, 32);
  assert.equal(new Set(deployments.map(({ logicalPath }) => logicalPath)).size, 32);
  const manifest = JSON.parse(readFileSync(reviewedInputsPath));
  assert.equal(Object.keys(manifest.artifacts).length, 9);
  for (const artifact of Object.values(manifest.artifacts)) {
    assert.match(artifact.immutableReferencesSHA256, /^[\da-f]{64}$/);
  }
  assert.equal(Object.keys(manifest.sources).length, 222);
  assert.equal(Object.keys(manifest.deployments).length, 32);
});

test('a changed or missing compiled Sucker registry interface is rejected', () => {
  assert.throws(() => verifyReviewedInputs(networks, 'testnets', {
    read: changedRead(suckerInterface, value => Buffer.concat([Buffer.from(value), Buffer.from('\n')])),
  }), /Compiled external source differs.*IJBSuckerRegistry/);
  assert.throws(() => verifyReviewedInputs(networks, 'testnets', {
    read(path, encoding) {
      if (path === suckerInterface) throw new Error('missing');
      return readFileSync(path, encoding);
    },
  }), /Missing or unreadable reviewed deployment input.*IJBSuckerRegistry/);
});

test('compiled external source additions and omissions are rejected', () => {
  assert.throws(() => verifyReviewedInputs(networks, 'testnets', {
    read: changedJson(compilerArtifact, artifact => {
      artifact.metadata.sources['node_modules/unreviewed/Extra.sol'] = {};
      return artifact;
    }),
  }), /Compiled external source set differs/);
  assert.throws(() => verifyReviewedInputs(networks, 'testnets', {
    read: changedJson(compilerArtifact, artifact => {
      delete artifact.metadata.sources[suckerInterface];
      return artifact;
    }),
  }), /Compiled external source set differs/);
});

test('compiler settings, artifact targets, immutable references and bytecode are bound to the reviewed build', () => {
  assert.throws(() => verifyReviewedInputs(networks, 'testnets', {
    read: changedJson(compilerArtifact, artifact => {
      artifact.metadata.settings.optimizer.runs++;
      return artifact;
    }),
  }), /Compiler settings or deployment artifact differs/);
  assert.throws(() => verifyReviewedInputs(networks, 'testnets', {
    read: changedJson(compilerArtifact, artifact => {
      artifact.metadata.settings.compilationTarget = { 'script/Other.s.sol': 'Deploy' };
      return artifact;
    }),
  }), /Unexpected compiler target/);
  assert.throws(() => verifyReviewedInputs(networks, 'testnets', {
    read: changedJson('out/StickyHook.sol/StickyHook.json', artifact => {
      artifact.metadata.settings.compilationTarget = { 'src/Other.sol': 'StickyHook' };
      return artifact;
    }),
  }), /Unexpected compiler target/);
  assert.throws(() => verifyReviewedInputs(networks, 'testnets', {
    read: changedJson('out/StickyHook.sol/StickyHook.json', artifact => {
      const [reference] = Object.values(artifact.deployedBytecode.immutableReferences);
      reference[0].start++;
      return artifact;
    }),
  }), /Compiler settings or deployment artifact differs/);
  assert.throws(() => verifyReviewedInputs(networks, 'testnets', {
    read: changedJson('out/StickyHook.sol/StickyHook.json', artifact => {
      artifact.deployedBytecode.object += '00';
      return artifact;
    }),
  }), /Compiler settings or deployment artifact differs/);
});

test('compiler identity excludes resolver-local remapping metadata', () => {
  verifyReviewedInputs(networks, 'testnets', {
    read: changedJson(compilerArtifact, artifact => {
      artifact.metadata.settings.remappings = [
        '/different/checkout/root/node_modules/@example/dependency/=vendor/arbitrary/',
        'entirely-different/=resolver-path/',
      ];
      artifact.metadata.settings = Object.fromEntries(Object.entries(artifact.metadata.settings).reverse());
      return artifact;
    }),
  });
});

test('immutable reference identity ignores compiler keys and ordering while preserving groups and ranges', () => {
  verifyReviewedInputs(networks, 'testnets', {
    read: changedJson('out/StickyDistributor.sol/StickyDistributor.json', artifact => {
      artifact.deployedBytecode.immutableReferences = Object.fromEntries(
        Object.values(artifact.deployedBytecode.immutableReferences).reverse()
          .map((references, index) => [`renamed-${index}`, [...references].reverse()]),
      );
      return artifact;
    }),
  });

  for (const change of [
    artifact => {
      const [[, first], [, second], ...remaining] = Object.entries(artifact.deployedBytecode.immutableReferences);
      artifact.deployedBytecode.immutableReferences = {
        merged: [...first, ...second], ...Object.fromEntries(remaining),
      };
    },
    artifact => {
      const entries = Object.entries(artifact.deployedBytecode.immutableReferences);
      const index = entries.findIndex(([, references]) => references.length > 1);
      const [[key, references]] = entries.splice(index, 1);
      artifact.deployedBytecode.immutableReferences = {
        ...Object.fromEntries(entries), [`${key}-first`]: [references[0]], [`${key}-rest`]: references.slice(1),
      };
    },
  ]) {
    assert.throws(() => verifyReviewedInputs(networks, 'testnets', {
      read: changedJson('out/StickyDistributor.sol/StickyDistributor.json', artifact => {
        change(artifact);
        return artifact;
      }),
    }), /Compiler settings or deployment artifact differs/);
  }
});

test('a changed Sucker deployment address artifact is rejected', () => {
  for (const folder of ['sepolia', 'ethereum']) {
    const path = `node_modules/@bananapus/suckers-v6/deployments/${folder}/JBSuckerRegistry.json`;
    assert.throws(() => verifyReviewedInputs(networks, 'testnets', {
      read: changedJson(path, artifact => ({ ...artifact, address: `0x${'ff'.repeat(20)}` })),
    }), new RegExp(`Core or sucker deployment file differs.*suckers-v6/${folder}/JBSuckerRegistry`));
  }
});
