import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('the npm package excludes transient manifests and retains reviewed deployment payloads', () => {
  const root = mkdtempSync(join(tmpdir(), 'sticky-packlist-'));
  const cache = mkdtempSync(join(tmpdir(), 'sticky-packlist-cache-'));
  try {
    cpSync('package.json', join(root, 'package.json'));
    const deployments = join(root, 'deployments');
    mkdirSync(deployments);
    cpSync('deployments/.npmignore', join(deployments, '.npmignore'));
    const source = join(deployments, 'source');
    const family = join(source, 'source-collectors', '123');
    mkdirSync(family, { recursive: true });
    for (const name of [
      'simulation.json', 'test.json', 'verified.json', 'StickySourceCollector.json', 'StickySourceFeePayer.json',
    ]) writeFileSync(join(family, name), '{}\n');
    for (const name of ['simulation.json', 'test.json', 'verified.json', 'StickyDeployer.json']) {
      writeFileSync(join(source, name), '{}\n');
    }
    mkdirSync(join(deployments, '_test'));
    writeFileSync(join(deployments, '_test', 'fixture.json'), '{}\n');
    mkdirSync(join(root, 'script'));
    cpSync('script/reviewed-inputs.json', join(root, 'script', 'reviewed-inputs.json'));

    const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: cache },
    });
    assert.equal(packed.status, 0, packed.stderr);
    const files = JSON.parse(packed.stdout)[0].files.map(({ path }) => path);
    for (const required of [
      'deployments/source/StickyDeployer.json',
      'deployments/source/source-collectors/123/StickySourceCollector.json',
      'deployments/source/source-collectors/123/StickySourceFeePayer.json',
      'deployments/source/source-collectors/123/verified.json',
      'deployments/source/verified.json',
      'script/reviewed-inputs.json',
    ]) assert.ok(files.includes(required), `missing package payload: ${required}`);
    for (const transient of [
      'deployments/_test/fixture.json',
      'deployments/source/simulation.json',
      'deployments/source/test.json',
      'deployments/source/source-collectors/123/simulation.json',
      'deployments/source/source-collectors/123/test.json',
    ]) assert.ok(!files.includes(transient), `transient package payload: ${transient}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});
