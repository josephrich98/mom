'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const money = require('../src/util/money');
const { parseInteger, isIsoDate, isSku, ValidationError } = require('../src/util/validate');
const { nextId, normalizeId } = require('../src/util/ids');
const { table } = require('../src/util/format');

test('toCents parses common amount formats', () => {
  assert.equal(money.toCents('12'), 1200);
  assert.equal(money.toCents('12.5'), 1250);
  assert.equal(money.toCents('$1,234.56'), 123456);
  assert.equal(money.toCents('0.07'), 7);
  assert.equal(money.toCents(19.99), 1999);
});

test('toCents rejects malformed amounts', () => {
  for (const bad of ['', 'abc', '1.234', '1,23', '12.']) assert.throws(() => money.toCents(bad), /invalid amount/);
});

test('formatMoney renders cents with separators and sign', () => {
  assert.equal(money.formatMoney(0), '$0.00');
  assert.equal(money.formatMoney(5), '$0.05');
  assert.equal(money.formatMoney(123456789), '$1,234,567.89');
  assert.equal(money.formatMoney(-150), '-$1.50');
  assert.throws(() => money.formatMoney(1.5), /integer cents/);
});

test('percentOf rounds half up using integer math', () => {
  assert.equal(money.percentOf(3600, 725), 261); // 261.0
  assert.equal(money.percentOf(1000, 725), 73); // 72.5 -> 73
  assert.equal(money.percentOf(999, 1000), 100); // 99.9 -> 100
  assert.equal(money.percentOf(0, 1900), 0);
});

test('percentToBps and formatBps round-trip', () => {
  assert.equal(money.percentToBps('7.25'), 725);
  assert.equal(money.percentToBps('19'), 1900);
  assert.equal(money.formatBps(725), '7.25%');
  assert.equal(money.formatBps(450), '4.5%');
  assert.equal(money.formatBps(1900), '19%');
});

test('parseInteger validates range and format', () => {
  assert.equal(parseInteger('42', 'n'), 42);
  assert.throws(() => parseInteger('4.2', 'n'), ValidationError);
  assert.throws(() => parseInteger('-1', 'n', { min: 0 }), /must be >= 0/);
});

test('isIsoDate accepts only real calendar dates', () => {
  assert.ok(isIsoDate('2099-12-31'));
  assert.ok(isIsoDate('2024-02-29'));
  assert.ok(!isIsoDate('2023-02-29'));
  assert.ok(!isIsoDate('2099-13-01'));
  assert.ok(!isIsoDate('20991231'));
});

test('isSku', () => {
  assert.ok(isSku('MUG-01'));
  assert.ok(!isSku('m'));
  assert.ok(!isSku('-MUG'));
});

test('nextId continues after the largest existing id', () => {
  assert.equal(nextId([], 'C'), 'C1');
  assert.equal(nextId([{ id: 'C1' }, { id: 'C7' }, { id: 'O9' }], 'C'), 'C8');
  assert.equal(normalizeId('3', 'O'), 'O3');
  assert.equal(normalizeId('c2', 'C'), 'C2');
});

test('table pads columns', () => {
  const out = table([{ a: 'x', b: 1 }, { a: 'long', b: 22 }], [{ key: 'a', label: 'A' }, { key: 'b', label: 'B', align: 'right' }]);
  assert.equal(out, 'A      B\nx      1\nlong  22');
  assert.equal(table([], [{ key: 'a', label: 'A' }]), '(none)');
});
