'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
function functionSource(name) {
  const match = new RegExp(`(?:^|\\n)function ${name}\\(`).exec(source);
  assert.ok(match, `missing function ${name}`);
  const start = match.index + (source[match.index] === '\n' ? 1 : 0);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const c = vm.createContext({});
vm.runInContext(`${functionSource('formatUnits')}\n${functionSource('formatAmount')}`, c);
const units = (whole, decimals = 18) => {
  const [w, f = ''] = whole.split('.');
  return BigInt(w + f.padEnd(decimals, '0'));
};

test('displayed amounts are grouped with at most four decimals, like juicebox.money', () => {
  assert.equal(c.formatAmount(units('32577559.305605237523530572'), 18), '32,577,559.3056');
  assert.equal(c.formatAmount(units('1234.5'), 18), '1,234.5');
  assert.equal(c.formatAmount(units('10'), 18), '10');
  assert.equal(c.formatAmount(units('1.234567', 6), 6), '1.2346');
  assert.equal(c.formatAmount(units('1.23456789'), 18, 2), '1.23');
});

test('a tiny amount shows its first significant figure instead of reading as zero', () => {
  assert.equal(c.formatAmount(units('0.000004586733'), 18), '0.000005');
  assert.equal(c.formatAmount(units('0.00004'), 18), '0.00004');
  assert.equal(c.formatAmount(1n, 18), '0.000000000000000001');
  assert.equal(c.formatAmount(units('0.0001'), 18), '0.0001');
});

test('zero is plain zero', () => {
  assert.equal(c.formatAmount(0n, 18), '0');
  assert.equal(c.formatAmount(0n, 6), '0');
});

test('exact values for inputs stay full precision and ungrouped', () => {
  const raw = units('32577559.305605237523530572');
  assert.equal(c.formatUnits(raw, 18, 18), '32577559.305605237523530572');
});
