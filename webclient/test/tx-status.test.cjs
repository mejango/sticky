'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
function functionSource(name) {
  const match = new RegExp(`(?:^|\\n)(?:async )?function ${name}\\(`).exec(source);
  assert.ok(match, `missing function ${name}`);
  const start = match.index + (source[match.index] === '\n' ? 1 : 0);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}

function harness() {
  const nodes = { 'tx-status-message': { textContent: '', children: [], append(...items) { for (const item of items) { if (typeof item === 'string') this.textContent += item; else { this.children.push(item); this.textContent += item.textContent; } } } }, 'tx-status': { className: '' } };
  const timers = [];
  const c = vm.createContext({
    Date,
    $: (id) => nodes[id],
    document: { createElement: () => ({ textContent: '' }) },
    chainById: (id) => (id === 8453 ? { explorer: 'https://basescan.org' } : null),
    setTimeout: (fn, ms) => { timers.push(ms); return timers.length; },
    clearTimeout: () => {},
  });
  vm.runInContext(`let txStatusTimer = null;\nlet lastConfirmedTx = null;\n${functionSource('txStatus')}`, c);
  return { c, nodes, timers };
}

test('a confirmation names the transaction that just landed and stays until dismissed', () => {
  const { c, nodes, timers } = harness();
  vm.runInContext(`lastConfirmedTx = { chainId: 8453, hash: '0x${'a'.repeat(64)}', at: Date.now() }`, c);
  c.txStatus('Stick confirmed', 'ok');
  const link = nodes['tx-status-message'].children[0];
  assert.equal(link.href, `https://basescan.org/tx/0x${'a'.repeat(64)}`);
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(timers.length, 0, 'no auto-dismiss for a linked confirmation');
  // The link is used once: a later notice without a fresh confirmation carries none and fades.
  c.txStatus('Sender trusted', 'ok');
  assert.equal(nodes['tx-status-message'].children.length, 1);
  assert.deepEqual(timers, [8000]);
  c.txStatus('The wallet did not send the transaction.', 'err');
  assert.deepEqual(timers, [8000, 8000]);
});
