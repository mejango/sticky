import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('the npm package excludes nested transient manifests and retains verified family records', () => {
  const root = mkdtempSync(join(tmpdir(), 'sticky-packlist-'));
  const cache = mkdtempSync(join(tmpdir(), 'sticky-packlist-cache-'));
  try {
    cpSync('package.json', join(root, 'package.json'));
    const deployments = join(root, 'deployments');
    mkdirSync(deployments);
    cpSync('deployments/.npmignore', join(deployments, '.npmignore'));
    const family = join(deployments, 'source', 'source-collectors', '123');
    mkdirSync(family, { recursive: true });
    for (const name of [
      'simulation.json', 'test.json', 'verified.json', 'StickySourceCollector.json', 'StickySourceFeePayer.json',
    ]) writeFileSync(join(family, name), '{}\n');

    const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: cache },
    });
    assert.equal(packed.status, 0, packed.stderr);
    const files = JSON.parse(packed.stdout)[0].files.map(({ path }) => path)
      .filter(path => path.startsWith('deployments/'));
    assert.deepEqual(files, [
      'deployments/source/source-collectors/123/StickySourceCollector.json',
      'deployments/source/source-collectors/123/StickySourceFeePayer.json',
      'deployments/source/source-collectors/123/verified.json',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});
