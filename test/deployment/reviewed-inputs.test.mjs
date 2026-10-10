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

test('compiler settings, artifact targets and bytecode are bound to the reviewed build', () => {
  assert.throws(() => verifyReviewedInputs(networks, 'testnets', {
    read: changedJson(compilerArtifact, artifact => {
      artifact.metadata.settings.optimizer.runs++;
      return artifact;
    }),
  }), /Compiler settings or deployment bytecode differs/);
  assert.throws(() => verifyReviewedInputs(networks, 'testnets', {
    read: changedJson(compilerArtifact, artifact => {
      artifact.metadata.settings.compilationTarget = { 'script/Other.s.sol': 'Deploy' };
      return artifact;
    }),
  }), /Unexpected compiler target/);
  assert.throws(() => verifyReviewedInputs(networks, 'testnets', {
    read: changedJson(compilerArtifact, artifact => {
      artifact.metadata.settings.remappings[0] += 'changed';
      return artifact;
    }),
  }), /Compiler settings or deployment bytecode differs/);
  assert.throws(() => verifyReviewedInputs(networks, 'testnets', {
    read: changedJson('out/StickyHook.sol/StickyHook.json', artifact => {
      artifact.metadata.settings.compilationTarget = { 'src/Other.sol': 'StickyHook' };
      return artifact;
    }),
  }), /Unexpected compiler target/);
  assert.throws(() => verifyReviewedInputs(networks, 'testnets', {
    read: changedJson('out/StickyHook.sol/StickyHook.json', artifact => {
      artifact.deployedBytecode.object += '00';
      return artifact;
    }),
  }), /Compiler settings or deployment bytecode differs/);
});

test('compiler identity is portable across checkout-root remapping contexts', () => {
  verifyReviewedInputs(networks, 'testnets', {
    read: changedJson(compilerArtifact, artifact => {
      artifact.metadata.settings.remappings = artifact.metadata.settings.remappings.map(remapping =>
        remapping.replace(/^\/.*?\/(?=node_modules\/)/, '/different/checkout/root/')).reverse();
      return artifact;
    }),
  });
});

test('a changed Sucker deployment address artifact is rejected', () => {
  for (const folder of ['sepolia', 'ethereum']) {
    const path = `node_modules/@bananapus/suckers-v6/deployments/${folder}/JBSuckerRegistry.json`;
    assert.throws(() => verifyReviewedInputs(networks, 'testnets', {
      read: changedJson(path, artifact => ({ ...artifact, address: `0x${'ff'.repeat(20)}` })),
    }), new RegExp(`Core or sucker deployment file differs.*suckers-v6/${folder}/JBSuckerRegistry`));
  }
});
