import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const rpc = Object.fromEntries(['ETHEREUM', 'OPTIMISM', 'BASE', 'ARBITRUM'].map(chain => [
  `RPC_${chain}_MAINNET`, `https://${chain.toLowerCase()}.example.test/private-key`,
]));
const focusedRpc = { RPC_ETHEREUM_MAINNET: rpc.RPC_ETHEREUM_MAINNET, RPC_BASE_MAINNET: rpc.RPC_BASE_MAINNET };
const baseArgs = ['test', '-vvv', '--threads', '1', '--deny', 'notes', '--summary', '--detailed', '--skip', '*/script/**'];

function run(t, { args = [], env = rpc, envFile, defaultEnv, exit = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sticky-fork-runner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'script'));
  mkdirSync(join(root, 'bin'));
  copyFileSync(new URL('../../script/test-fork.sh', import.meta.url), join(root, 'script/test-fork.sh'));
  const capture = join(root, 'capture.json');
  writeFileSync(join(root, 'bin/forge'), `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
writeFileSync(process.env.STICKY_FORK_CAPTURE, JSON.stringify({
  args: process.argv.slice(2), profile: process.env.FOUNDRY_PROFILE,
  rpcKeys: Object.keys(process.env).filter(key => key.startsWith('RPC_')).sort(),
}));
process.exit(Number(process.env.STICKY_FORGE_EXIT));
`, { mode: 0o755 });
  const contents = values => Object.entries(values).map(([key, value]) => `${key}='${value}'`).join('\n');
  if (defaultEnv) writeFileSync(join(root, '.env'), contents(defaultEnv));
  const file = join(root, 'environment with spaces.env');
  if (envFile) writeFileSync(file, contents(envFile));
  const result = spawnSync('/bin/sh', [join(root, 'script/test-fork.sh'), ...args], {
    cwd: root, encoding: 'utf8',
    // No real credentials or local .env are inherited by the fixture.
    env: {
      PATH: `${join(root, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`,
      STICKY_FORK_CAPTURE: capture, STICKY_FORGE_EXIT: String(exit), ...env,
      ...(envFile !== undefined ? { STICKY_ENV_FILE: file } : {}),
    },
  });
  return { ...result, captured: existsSync(capture) ? JSON.parse(readFileSync(capture, 'utf8')) : undefined };
}

for (const key of Object.keys(rpc)) {
  for (const empty of [false, true]) {
    test(`unfiltered run refuses ${empty ? 'empty' : 'missing'} ${key} before Forge`, t => {
      const env = { ...rpc };
      if (empty) env[key] = '';
      else delete env[key];
      const result = run(t, { env });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(`Set ${key}`));
      assert.equal(result.captured, undefined);
      assert.ok(!result.stderr.includes('private-key'));
    });
  }
}

test('full run serializes opcode tracing, forwards ordinary flags and uses the fork profile', t => {
  const args = ['--gas-report', '-vv'];
  const result = run(t, { args });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.captured, { args: [...baseArgs, ...args], profile: 'fork', rpcKeys: Object.keys(rpc).sort() });
  assert.equal(run(t, { args, env: focusedRpc }).captured, undefined);
});

for (const flag of ['--match-contract', '--mc', '--match-path', '--mp', '--match-test', '--mt']) {
  test(`${flag} preserves focused ETH/Base usage and exact filter arguments`, t => {
    const value = flag.includes('path') || flag === '--mp' ? 'test/fork/StickyJbxLifecycle.t.sol' : 'StickyJbx(Lifecycle|Authority) Fork';
    for (const args of [[flag, value], [`${flag}=${value}`]]) {
      const result = run(t, { args, env: focusedRpc });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.captured.args, [...baseArgs, ...args]);
    }
  });
}

test('focused runs retain the existing ETH/Base preflight', t => {
  for (const key of Object.keys(focusedRpc)) {
    const env = { ...focusedRpc };
    delete env[key];
    const result = run(t, { env, args: ['--match-contract', 'StickyJbx(Lifecycle|Authority)ForkTest'] });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`Set ${key}`));
    assert.equal(result.captured, undefined);
  }
});

test('explicit environment file with spaces exports RPCs and takes precedence over .env', t => {
  const result = run(t, { env: {}, envFile: rpc, defaultEnv: { RPC_ETHEREUM_MAINNET: '' } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.captured.rpcKeys, Object.keys(rpc).sort());
});

test('missing explicit environment file fails without fallback', t => {
  const result = run(t, { envFile: null, defaultEnv: rpc });
  assert.notEqual(result.status, 0);
  assert.equal(result.captured, undefined);
});

test('default .env supplies exported RPCs', t => {
  const result = run(t, { env: {}, defaultEnv: rpc });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.captured.rpcKeys, Object.keys(rpc).sort());
});

test('Forge failure is returned unchanged', t => {
  assert.equal(run(t, { exit: 42 }).status, 42);
});

test('the CI fork step supplies all four mainnet RPC secrets', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/test.yml', import.meta.url), 'utf8');
  const step = workflow.split(/\n(?=      - )/).find(value => value.includes('run: npm run test:fork\n'));
  assert.ok(step, 'owning fork step must use the shared runner');
  for (const key of Object.keys(rpc)) assert.ok(step.includes(`${key}: ` + '${{ secrets.' + key + ' }}'), key);
});
