import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Explicit constructor injection intentionally replaces StickyDeployer and StickyHook.
// The remaining four singleton implementations retain their prior executable identities;
// their constructor dependencies and therefore their deployment addresses may change.
const baseline = JSON.parse(readFileSync(new URL('./existing-singletons.json', import.meta.url), 'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');
const publicAbi = value => Array.isArray(value) ? value.map(publicAbi)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'internalType').map(([key, item]) => [key, publicAbi(item)]))
    : value;

for (const [name, expected] of Object.entries(baseline.contracts)) {
  if (name === 'StickyDeployer' || name === 'StickyHook') continue;
  test(`${name} preserves its deployed creation code, runtime and public ABI`, () => {
    const artifact = JSON.parse(readFileSync(new URL(`../../out/${name}.sol/${name}.json`, import.meta.url), 'utf8'));
    assert.equal(digest(artifact.bytecode.object), expected.bytecode, `${name} creation bytecode changed`);
    assert.equal(digest(artifact.deployedBytecode.object), expected.deployedBytecode, `${name} runtime bytecode changed`);
    assert.equal(digest(JSON.stringify(publicAbi(artifact.abi))), expected.abi, `${name} public ABI changed`);
  });
}
