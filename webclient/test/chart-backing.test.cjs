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
const block = (start) => {
  const at = source.indexOf(start);
  assert.ok(at >= 0, `missing ${start}`);
  return source.slice(at, source.indexOf('\n};', at) + 3);
};
const constSource = (name) => {
  const start = source.indexOf(`\nconst ${name} = `);
  assert.ok(start >= 0, `missing const ${name}`);
  return source.slice(start, source.indexOf(';\n', start) + 2);
};
const codec = source.slice(source.indexOf('const strip ='), source.indexOf('// ------------------------------------------------------------- rpc plumbing'));

const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const addr = (digit) => '0x' + digit.repeat(40);
const HOLDER = addr('a');
const TERMINAL = addr('7');
const E18 = 10n ** 18n;
const E6 = 10n ** 6n;
// SLOPSHOP has 6 decimals; its Sticky token always has 18.
const INFO = { symbol: 'SLOPSHOP', stSymbol: 'STICKYSLOPSHOP', decimals: 6 };

function context({ terminalLogs = [], fail = false } = {}) {
  const scans = [];
  const c = vm.createContext({
    TextEncoder, TextDecoder, Uint8Array, BigInt, console: { warn() {} }, Date, window: {},
    pageReader: () => ({ terminal: TERMINAL }),
    getLogsOn: async (reader, address, topics, from) => {
      scans.push({ address, topics, from });
      if (fail) throw new Error('rpc down');
      return terminalLogs.filter((log) => topics[0].includes(log.topics[0]));
    },
    attachTimestamps: async (logs) => { for (const log of logs) log.ts = Number(BigInt(log.blockNumber)); return logs; },
  });
  vm.runInContext(`${block('const TOPIC =')}\n${codec}\n${constSource('esc')}\n`
    + ['formatUnits', 'formatAmount', 'parseUnits', 'configuredChartPoints', 'backingSeries', 'chartSvg', 'backingFlows']
      .map(functionSource).join('\n'), c);
  c.TOPIC = vm.runInContext('TOPIC', c);
  c.scans = scans;
  return c;
}

// Share supply points, as chartSvg builds them before valuing: ts ascending, the last one now.
const points = (...rows) => rows.map(([ts, staked]) => ({ ts, streaks: staked > 0n ? 1 : 0, staked }));
const values = (series) => Array.from(series, (point) => point.value);

test('a stick adds its pay, and the latest point is today\'s backing', () => {
  const c = context();
  const series = c.backingSeries(points([0, 0n], [10, 100n * E18], [30, 100n * E18]), {
    flows: [{ ts: 10, delta: 101n * E6 }], rawBacking: 101n * E6, savedOrphaned: 0n,
  });
  assert.deepEqual(values(series), [0n, 101n * E6, 101n * E6]);
});

test('an unstick removes what the holder got and the fee that left with it', () => {
  const c = context();
  // 100 shares in for 100; 40 out for a 39 reclaim after a 1 fee. Today's backing is 60.
  const series = c.backingSeries(points([0, 0n], [10, 100n * E18], [20, 60n * E18], [30, 60n * E18]), {
    flows: [{ ts: 20, delta: -39n * E6 }, { ts: 10, delta: 100n * E6 }, { ts: 20, delta: -1n * E6 }],
    rawBacking: 60n * E6, savedOrphaned: 0n,
  });
  assert.deepEqual(values(series), [0n, 100n * E6, 60n * E6, 60n * E6]);
});

test('the latest point equals the anchor even when older flows are missing', () => {
  const c = context();
  // A donation the logs never saw: history shifts, today does not.
  const series = c.backingSeries(points([0, 0n], [10, 10n * E18], [30, 10n * E18]), {
    flows: [{ ts: 10, delta: 10n * E6 }], rawBacking: 15n * E6, savedOrphaned: 0n,
  });
  assert.equal(series.at(-1).value, 15n * E6);
  assert.equal(series[1].value, 15n * E6);
});

test('history is clamped at zero and is zero while no Sticky tokens exist', () => {
  const c = context();
  // Flows after ts 10 exceed today's balance, so the reconstruction would go negative there.
  const series = c.backingSeries(points([0, 0n], [10, 5n * E18], [20, 50n * E18], [30, 50n * E18]), {
    flows: [{ ts: 20, delta: 50n * E6 }], rawBacking: 40n * E6, savedOrphaned: 0n,
  });
  assert.deepEqual(values(series), [0n, 0n, 40n * E6, 40n * E6]);
  for (const point of series) assert.ok(point.value >= 0n);
  // Everyone left: the leftover backing is orphaned, not stuck.
  const empty = c.backingSeries(points([0, 0n], [10, 10n * E18], [20, 0n], [30, 0n]), {
    flows: [{ ts: 10, delta: 10n * E6 }], rawBacking: 10n * E6, savedOrphaned: 0n,
  });
  assert.deepEqual(values(empty), [0n, 10n * E6, 0n, 0n]);
});

test('orphaned funds are excluded from the point they were excluded on', () => {
  const c = context();
  // 10 stuck, everyone left 4 behind (fee-free rounding), a new holder stuck 10 and the 4 became orphaned.
  const series = c.backingSeries(points([0, 0n], [10, 10n * E18], [20, 0n], [25, 10n * E18], [30, 10n * E18]), {
    flows: [{ ts: 10, delta: 10n * E6 }, { ts: 20, delta: -6n * E6 }, { ts: 25, delta: 10n * E6 }],
    orphans: [{ ts: 25, amount: 4n * E6 }], rawBacking: 14n * E6, savedOrphaned: 4n * E6,
  });
  assert.deepEqual(values(series), [0n, 10n * E6, 0n, 10n * E6, 10n * E6]);
});

function hookLog(c, topic, data, ts) {
  return { topics: [c.TOPIC[topic], '0x' + word(42), '0x' + word(BigInt(HOLDER))], data: '0x' + data, ts };
}
const stakedLog = (c, count, ts) => hookLog(c, 'Staked', word(BigInt(HOLDER)) + word(count) + word(count) + word(BigInt(HOLDER)), ts);
const unstakedLog = (c, count, ts) => hookLog(c, 'Unstaked', word(count) + word(0) + word(BigInt(HOLDER)), ts);

test('the chart labels Total stuck in the underlying token\'s decimals and symbol', () => {
  const c = context();
  const now = Math.floor(Date.now() / 1000);
  const logs = [stakedLog(c, 200n * E18, now - 100), unstakedLog(c, 60n * E18, now - 50)];
  const chart = c.chartSvg(logs, INFO, 42, {
    flows: [{ ts: now - 100, delta: 1010n * E6 }, { ts: now - 50, delta: -303n * E6 }], rawBacking: 707n * E6, savedOrphaned: 0n,
  });
  assert.match(chart.svg, /Peak: 1,010 SLOPSHOP stuck/);
  assert.doesNotMatch(chart.svg, /STICKYSLOPSHOP/);
});

test('without balance history the chart falls back to Sticky token supply in the Sticky symbol', () => {
  const c = context();
  const now = Math.floor(Date.now() / 1000);
  const logs = [stakedLog(c, 200n * E18, now - 100), unstakedLog(c, 60n * E18, now - 50)];
  const chart = c.chartSvg(logs, INFO, 42, null);
  assert.match(chart.svg, /Peak: 200 STICKYSLOPSHOP stuck/);
});

test('balance flows come from the terminal\'s Pay, CashOutTokens, AddToBalance and unheld ProcessFee', async () => {
  const c0 = context();
  const T = c0.TOPIC;
  const id = '0x' + word(42);
  const terminalLogs = [
    // Pay: payer, beneficiary, amount, count, ...
    { topics: [T.Pay, id, id, id], blockNumber: '0x1', data: '0x' + word(BigInt(HOLDER)) + word(BigInt(HOLDER)) + word(100n * E6) + word(100n * E18) },
    // CashOutTokens: holder, beneficiary, count, taxRate, reclaimAmount, ...
    { topics: [T.CashOutTokens, id, id, id], blockNumber: '0x3', data: '0x' + word(BigInt(HOLDER)) + word(BigInt(HOLDER)) + word(40n * E18) + word(1000) + word(39n * E6) },
    // ProcessFee(projectId, token, amount indexed; wasHeld, beneficiary, caller)
    { topics: [T.ProcessFee, id, '0x' + word(0), '0x' + word(1n * E6)], blockNumber: '0x3', data: '0x' + word(0) + word(0) + word(0) },
    { topics: [T.ProcessFee, id, '0x' + word(0), '0x' + word(7n * E6)], blockNumber: '0x4', data: '0x' + word(1) + word(0) + word(0) },
    // AddToBalance(projectId indexed; amount, returnedFees, memo, metadata, caller)
    { topics: [T.AddToBalance, id], blockNumber: '0x2', data: '0x' + word(5n * E6) + word(2n * E6) },
  ];
  const c = context({ terminalLogs });
  const flows = await c.backingFlows(42n, '0x9');
  assert.deepEqual(JSON.parse(JSON.stringify(flows, (k, v) => (typeof v === 'bigint' ? v.toString() : v))), [
    { ts: 1, delta: String(100n * E6) },
    { ts: 2, delta: String(7n * E6) },
    { ts: 3, delta: String(-39n * E6) },
    { ts: 3, delta: String(-1n * E6) },
  ]);
  assert.equal(c.scans.length, 2);
  for (const scan of c.scans) {
    assert.equal(scan.address, TERMINAL);
    assert.equal(scan.from, '0x9');
  }
  assert.deepEqual(JSON.parse(JSON.stringify(c.scans[0].topics)), [[T.Pay, T.CashOutTokens], null, null, id]);
  assert.deepEqual(JSON.parse(JSON.stringify(c.scans[1].topics)), [[T.ProcessFee, T.AddToBalance], id]);
});

test('a failed balance read rejects, so the page charts share supply instead', async () => {
  const c = context({ fail: true });
  await assert.rejects(c.backingFlows(42n, '0x9'), /rpc down/);
  assert.match(source, /const flowsRead = [^;]*backingFlows\(projectId, from\)\)\.catch\(/);
  assert.match(source, /chartSvg\(logs, info, projectId,\s*flows && \{ flows, orphans, rawBacking: pool\.rawBacking, savedOrphaned: pool\.savedOrphaned \}\)/);
});

test('the new topics are the terminal\'s and the hook\'s event hashes', () => {
  const c = context();
  assert.equal(c.TOPIC.ProcessFee, '0xb514e730b3f8ad3aa94b6857bcc5ff4a46954bdcf8c4b0346705b1d0ac7a4325');
  assert.equal(c.TOPIC.AddToBalance, '0x9ecaf7fc3dfffd6867c175d6e684b1f1e3aef019398ba8db2c1ffab4a09db253');
  assert.equal(c.TOPIC.ExcludeOrphanedBalance, '0xa0b9b2db99d31a6b0fbb43cedfc627f78ae7c1b1f39d286ed7c61b5c9bba83fa');
});
