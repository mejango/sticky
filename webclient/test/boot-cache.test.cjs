'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const Runtime = require('../runtime.js');

const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
function functionSource(name) {
  const match = new RegExp(`(?:^|\\n)(?:async )?function ${name}\\(`).exec(source);
  assert.ok(match, `missing function ${name}`);
  const start = match.index + (source[match.index] === '\n' ? 1 : 0);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}

const DEPLOYER = '0x' + '1'.repeat(40);
const saved = { chainId: 8453, hook: '0x' + '2'.repeat(40), tokens: '0x' + '3'.repeat(40), terminal: '0x' + '4'.repeat(40), controller: '0x' + '5'.repeat(40), store: '0x' + '6'.repeat(40) };

function boot(fresh) {
  const store = new Map([[`sticky.boot.v1:8453:${DEPLOYER}`, JSON.stringify(saved)]]);
  const calls = { applied: [], statuses: [], resolved: 0 };
  let finish;
  const resolving = new Promise((resolve) => { finish = resolve; });
  const c = vm.createContext({
    console, URL, StickyRuntime: Runtime, JSON,
    location: { href: 'https://sticky.center/?chain=8453#/project/7' },
    window: { STICKY_CONFIG: { defaultChainId: 1 } },
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    ctx: {},
    $: () => ({ value: DEPLOYER }),
    applyDeployment: (d) => { calls.applied.push(d); c.ctx.loaded = true; },
    resolveDeployment: () => { calls.resolved++; return resolving; },
    status: (message, cls) => calls.statuses.push([message, cls]),
  });
  vm.runInContext(`const BOOT_KEY = "sticky.boot.v1:";\n${functionSource('readBoot')}\n${functionSource('writeBoot')}\n${functionSource('loadDeployer')}`, c);
  return { c, calls, store, settle: async () => { finish(fresh); await new Promise(setImmediate); } };
}

test('a remembered deployment starts the page at once, and a matching check leaves it running', async () => {
  const { c, calls, settle } = boot({ ...saved });
  await c.loadDeployer();
  assert.equal(calls.applied.length, 1, 'applied before the chain answered');
  assert.equal(calls.resolved, 1, 'the full check still runs behind it');
  await settle();
  assert.equal(c.ctx.loaded, true);
  assert.equal(calls.statuses.length, 0);
});

test('a deployment the chain no longer confirms stops the page and forgets the saved copy', async () => {
  const { c, calls, store, settle } = boot({ ...saved, hook: '0x' + '9'.repeat(40) });
  await c.loadDeployer();
  await settle();
  assert.equal(c.ctx.loaded, false);
  assert.equal(calls.statuses.at(-1)[1], 'err');
  assert.equal(store.size, 0);
});
