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
const FUNDER = addr('b');
const RECIPIENT = addr('c');
const TERMINAL = addr('7');
const E18 = 10n ** 18n;
const E6 = 10n ** 6n;
// SLOPSHOP has 6 decimals; its Sticky token always has 18.
const INFO = { symbol: 'SLOPSHOP', stSymbol: 'STICKYSLOPSHOP', decimals: 6, stakedToken: addr('2'), reward: 0n };

function context({ terminalLogs = [], failTerminal = false } = {}) {
  const scans = [];
  const c = vm.createContext({
    TextEncoder, TextDecoder, Uint8Array, BigInt, console: { warn() {} }, Date,
    account: () => '',
    autoStickAdapterOn: () => null,
    projectInfo: async () => INFO,
    addressLabel: (value) => value,
    projectHref: () => '#',
    chainIcons: () => '',
    stickyLabel: (info) => info.stSymbol,
    getLogsOn: async (reader, address, topics, from) => {
      scans.push({ address, topics, from });
      if (failTerminal) throw new Error('rpc down');
      return terminalLogs;
    },
  });
  vm.runInContext(`${block('const TOPIC =')}\n${codec}\n${constSource('esc')}\n${block('const feedCard =')}\n`
    + ['formatUnits', 'formatAmount', 'formatDuration', 'ago', 'moveKey', 'terminalMoves', 'underlyingAmount', 'shareAmount', 'logMove',
      'sameTxKey', 'activityItems', 'airdropItems'].map(functionSource).join('\n'), c);
  c.TOPIC = vm.runInContext('TOPIC', c);
  c.scans = scans;
  return c;
}
const reader = { chainId: 84532, terminal: TERMINAL };
function hookLog(c, topic, holder, data, tx, block = '0x10') {
  return { topics: [c.TOPIC[topic], '0x' + word(42), '0x' + word(BigInt(holder))], data: '0x' + data, transactionHash: tx, blockNumber: block, ts: 100 };
}
const staked = (c, holder, payer, count, balance, tx, block) =>
  hookLog(c, 'Staked', holder, word(BigInt(payer)) + word(count) + word(balance) + word(BigInt(payer)), tx, block);
const unstaked = (c, holder, count, balance, tx, block) => hookLog(c, 'Unstaked', holder, word(count) + word(balance) + word(BigInt(holder)), tx, block);
// JBMultiTerminal Pay(rulesetId, cycle, projectId indexed; payer, beneficiary, amount, newlyIssuedTokenCount, memo, metadata, caller).
function payLog(c, beneficiary, amount, count, tx, projectId = 42) {
  return {
    topics: [c.TOPIC.Pay, '0x' + word(1), '0x' + word(1), '0x' + word(projectId)], transactionHash: tx,
    data: '0x' + word(BigInt(FUNDER)) + word(BigInt(beneficiary)) + word(amount) + word(count) + word(224) + word(256) + word(BigInt(FUNDER)) + word(0) + word(0),
  };
}
// CashOutTokens(rulesetId, cycle, projectId indexed; holder, beneficiary, cashOutCount, cashOutTaxRate, reclaimAmount, metadata, caller).
function cashOutLog(c, holder, count, reclaim, tx) {
  return {
    topics: [c.TOPIC.CashOutTokens, '0x' + word(1), '0x' + word(1), '0x' + word(42)], transactionHash: tx,
    data: '0x' + word(BigInt(holder)) + word(BigInt(holder)) + word(count) + word(0) + word(reclaim) + word(224) + word(BigInt(holder)) + word(0),
  };
}
const amounts = (items) => Array.from(items, (item) => item.html.match(/<b>([^<]+)<\/b>/)[1]);
const lines = (items) => Array.from(items, (item) => item.html.match(/<div class="feed-line">([^<]+)</)[1]);

test('the terminal topics are JBMultiTerminal\'s Pay and CashOutTokens', () => {
  const c = context();
  assert.equal(c.TOPIC.Pay, '0x133161f1c9161488f777ab9a26aae91d47c0d9a3fafb398960f138db02c73797');
  assert.equal(c.TOPIC.CashOutTokens, '0xfaf1d4bf1b08470c7ed8c351c5065f51af70b36b237723173f898453b9724142');
});

test('sticks and unsticks show the underlying tokens that came in and went out, in its decimals and symbol', async () => {
  const c = context();
  c.scans.length = 0;
  const logs = [
    staked(c, HOLDER, HOLDER, 1000n * E18, 1000n * E18, '0xa1', '0x10'),
    staked(c, RECIPIENT, FUNDER, 5n * E18, 5n * E18, '0xa2', '0x12'),
    unstaked(c, HOLDER, 100n * E18, 900n * E18, '0xa3', '0x14'),
  ];
  const terminalLogs = [
    payLog(c, HOLDER, 1010n * E6, 1000n * E18, '0xA1'),
    payLog(c, RECIPIENT, 5n * E6, 5n * E18, '0xa2'),
    cashOutLog(c, HOLDER, 100n * E18, 99n * E6, '0xa3'),
  ];
  const withMoves = context({ terminalLogs });
  const items = await withMoves.activityItems(logs, false, reader);
  assert.deepEqual(amounts(items), ['99 SLOPSHOP', '5 SLOPSHOP', '1,010 SLOPSHOP']);
  assert.deepEqual(lines(items), [`unstuck by ${HOLDER}`, `to ${RECIPIENT} from ${FUNDER}`, `stuck by ${HOLDER}`]);
  // One terminal scan, from the oldest shown event's block, for the shown projects only.
  assert.equal(withMoves.scans.length, 1);
  assert.equal(withMoves.scans[0].address, TERMINAL);
  assert.equal(withMoves.scans[0].from, '0x10');
  assert.deepEqual(JSON.parse(JSON.stringify(withMoves.scans[0].topics)), [[c.TOPIC.Pay, c.TOPIC.CashOutTokens], null, null, ['0x' + word(42)]]);
  const airdrops = await withMoves.airdropItems(logs, reader);
  assert.deepEqual(amounts(airdrops), ['5 SLOPSHOP']);
});

test('a transfer between holders moves no underlying tokens and keeps its Sticky token count', async () => {
  const c = context({ terminalLogs: [] });
  const logs = [
    unstaked(c, HOLDER, 10n * E18, 90n * E18, '0xb1'),
    staked(c, RECIPIENT, HOLDER, 10n * E18, 10n * E18, '0xb1'),
  ];
  const items = await c.activityItems(logs, false, reader);
  assert.deepEqual(amounts(items), ['10 STICKYSLOPSHOP', '10 STICKYSLOPSHOP']);
  assert.deepEqual(lines(items), [`to ${RECIPIENT} from ${HOLDER}`, `removed by ${HOLDER}`]);
});

test('a terminal event for another holder, count or transaction is never matched', async () => {
  const c0 = context();
  const logs = [staked(c0, HOLDER, HOLDER, 10n * E18, 10n * E18, '0xc1'), unstaked(c0, HOLDER, 4n * E18, 6n * E18, '0xc2')];
  const c = context({ terminalLogs: [
    payLog(c0, RECIPIENT, 10n * E6, 10n * E18, '0xc1'),
    payLog(c0, HOLDER, 10n * E6, 11n * E18, '0xc1'),
    payLog(c0, HOLDER, 10n * E6, 10n * E18, '0xc9'),
    cashOutLog(c0, HOLDER, 5n * E18, 4n * E6, '0xc2'),
    { topics: [c0.TOPIC.Pay], data: '0x', transactionHash: '0xc1' },
  ] });
  assert.deepEqual(amounts(await c.activityItems(logs, false, reader)), ['4 STICKYSLOPSHOP', '10 STICKYSLOPSHOP']);
});

test('a failed terminal read falls back to Sticky token counts instead of breaking the feed', async () => {
  const c = context({ failTerminal: true });
  const logs = [staked(c, HOLDER, HOLDER, 3n * E18, 3n * E18, '0xd1')];
  assert.deepEqual(amounts(await c.activityItems(logs, false, reader)), ['3 STICKYSLOPSHOP']);
  const noTerminal = context();
  assert.deepEqual(amounts(await noTerminal.activityItems(logs, false, { chainId: 1 })), ['3 STICKYSLOPSHOP']);
  assert.equal(noTerminal.scans.length, 0);
});

test('stuck amounts on the page are the underlying token; Sticky token counts keep the Sticky symbol', () => {
  const render = functionSource('renderProject');
  assert.match(render, /\$\("h-staked"\)\.textContent = `\$\{formatAmount\(pool\.sigma, info\.decimals\)\} \$\{info\.symbol\}`;/);
  assert.match(functionSource('refreshPosition'), /\$\("p-balance"\)\.textContent = `\$\{formatAmount\(backingOfShares\(staked, pool\), info\.decimals\)\} \$\{info\.symbol\}`;/);
  assert.match(functionSource('renderEmptyPosition'), /\$\("p-balance"\)\.textContent = `0 \$\{info\.symbol\}`;/);
  assert.match(functionSource('renderBoard'), /underlyingAmount\(backingOfShares\(row\.staked, pool\), info\)/);
  assert.match(functionSource('renderAccount'), /<span class="mut">Stuck:<\/span> \$\{underlyingAmount\(backingOfShares\(staked, pool\), info\)\}/);
  assert.match(functionSource('detailsHtml'), /row\("Supply", `\$\{formatAmount\(pool\.supply, 18\)\} \$\{info\.stSymbol\}`\)/);
  const c = vm.createContext({});
  vm.runInContext(functionSource('backingOfShares'), c);
  assert.equal(c.backingOfShares(10n, { supply: 100n, sigma: 101n }), 10n);
  assert.equal(c.backingOfShares(50n, { supply: 100n, sigma: 202n }), 101n);
  assert.equal(c.backingOfShares(50n, { supply: 0n, sigma: 0n }), 0n);
});

test('a streak that starts or ends in a stick or unstick transaction reads on that row', async () => {
  const c = context();
  const streak = (topic, holder, tx, data = '') => hookLog(c, topic, holder, data, tx);
  const logs = [
    staked(c, HOLDER, HOLDER, 10n * E18, 10n * E18, '0xe1'),
    streak('StreakStarted', HOLDER, '0xE1'),
    // Another holder's streak in the same transaction keeps its own row.
    streak('StreakStarted', RECIPIENT, '0xe1'),
    unstaked(c, HOLDER, 10n * E18, 0n, '0xe2'),
    streak('StreakEnded', HOLDER, '0xe2', word(86400)),
  ];
  const items = await c.activityItems(logs, false, reader);
  assert.equal(items.length, 3);
  assert.match(items[0].html, new RegExp(`removed by ${HOLDER} and came unstuck after <span class="nowrap">`));
  assert.match(items[1].html, new RegExp(`${RECIPIENT} got sticky`));
  assert.match(items[2].html, new RegExp(`stuck by ${HOLDER} and got sticky`));
});
