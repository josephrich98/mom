'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { calcTotals, quote } = require('../src/services/pricing');
const { discountAmount, createDiscount } = require('../src/services/discount');
const { computeTax, rateFor } = require('../src/services/tax');
const { shippingFor, isDomestic } = require('../src/services/shipping');
const { seededStore } = require('./helpers');

const line = (priceCents, qty) => ({ sku: 'X', name: 'x', priceCents, qty });

test('calcTotals: domestic order under the free-shipping threshold', () => {
  const t = calcTotals({ lines: [line(1200, 2)], region: 'US-CA' });
  assert.deepEqual(t, { subtotal: 2400, discount: 0, tax: 174, shipping: 599, total: 3173 });
});

test('calcTotals: free domestic shipping at $50 of merchandise', () => {
  const t = calcTotals({ lines: [line(2500, 2)], region: 'US-NY' });
  assert.equal(t.shipping, 0);
  assert.equal(t.tax, 200);
  assert.equal(t.total, 5200);
});

test('calcTotals: discount is applied before tax and the shipping threshold', () => {
  const discount = createDiscount({ code: 'SAVE10', type: 'percent', value: '10' });
  const t = calcTotals({ lines: [line(5000, 1)], region: 'US-CA', discount });
  assert.equal(t.discount, 500);
  assert.equal(t.tax, 326); // 4500 * 7.25% = 326.25
  assert.equal(t.shipping, 599); // 4500 < 5000
  assert.equal(t.total, 4500 + 326 + 599);
});

test('calcTotals: international shipping and VAT', () => {
  const t = calcTotals({ lines: [line(10000, 1)], region: 'DE' });
  assert.equal(t.tax, 1900);
  assert.equal(t.shipping, 1999);
});

test('discountAmount: fixed discounts are capped and minimums enforced', () => {
  const fixed = createDiscount({ code: 'FIVE', type: 'fixed', value: '5.00', minSubtotal: '20' });
  assert.equal(discountAmount(fixed, 2500), 500);
  assert.throws(() => discountAmount(fixed, 1999), /at least \$20\.00/);
  const big = createDiscount({ code: 'BIG', type: 'fixed', value: '100' });
  assert.equal(discountAmount(big, 3000), 3000);
});

test('tax and shipping lookups', () => {
  assert.equal(rateFor('US-CA'), 725);
  assert.equal(rateFor('ZZ'), 0);
  assert.equal(computeTax(-5, 'US-CA'), 0);
  assert.ok(isDomestic('US-TX'));
  assert.ok(!isDomestic('USA'));
  assert.equal(shippingFor({ region: 'FR', merchandiseCents: 100000 }), 1999);
});

test('quote resolves products, customer region and discount code', () => {
  const store = seededStore();
  const q = quote(store, { customerId: 'C1', items: ['mug:2', 'TEE'], code: 'save10' });
  assert.equal(q.lines.length, 2);
  assert.equal(q.totals.subtotal, 4400);
  assert.equal(q.totals.discount, 440);
  assert.equal(q.discount.code, 'SAVE10');
});

test('quote rejects unknown products, customers and codes', () => {
  const store = seededStore();
  assert.throws(() => quote(store, { customerId: 'C1', items: ['NOPE:1'] }), /no such product/);
  assert.throws(() => quote(store, { customerId: 'C9', items: ['MUG:1'] }), /no such customer/);
  assert.throws(() => quote(store, { customerId: 'C1', items: ['MUG:1'], code: 'BOGUS' }), /unknown discount code/);
});
