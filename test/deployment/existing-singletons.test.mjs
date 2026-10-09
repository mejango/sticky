import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// These six contracts are already deployed. Public interface typing may change
// internalType labels, but the home-chain update must not change their code or ABI.
const baseline = JSON.parse(readFileSync(new URL('./existing-singletons.json', import.meta.url), 'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');
const publicAbi = value => Array.isArray(value) ? value.map(publicAbi)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'internalType').map(([key, item]) => [key, publicAbi(item)]))
    : value;

for (const [name, expected] of Object.entries(baseline.contracts)) {
  test(`${name} preserves its deployed creation code, runtime and public ABI`, () => {
    const artifact = JSON.parse(readFileSync(new URL(`../../out/${name}.sol/${name}.json`, import.meta.url), 'utf8'));
    assert.equal(digest(artifact.bytecode.object), expected.bytecode, `${name} creation bytecode changed`);
    assert.equal(digest(artifact.deployedBytecode.object), expected.deployedBytecode, `${name} runtime bytecode changed`);
    assert.equal(digest(JSON.stringify(publicAbi(artifact.abi))), expected.abi, `${name} public ABI changed`);
  });
}
