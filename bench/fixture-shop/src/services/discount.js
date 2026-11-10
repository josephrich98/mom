'use strict';
const { check, isCode, oneOf, parseInteger } = require('../util/validate');
const { percentOf, toCents, formatMoney } = require('../util/money');

/**
 * A discount code:
 *   { code: "SAVE10", type: "percent" | "fixed", value: integer, minSubtotal: integer cents, createdAt }
 * For "percent", value is a whole percentage 1..100. For "fixed", value is cents.
 */

const TYPES = ['percent', 'fixed'];

function normalizeCode(raw) {
  const code = String(raw == null ? '' : raw).trim().toUpperCase();
  check(isCode(code), `invalid discount code ${JSON.stringify(raw)}`);
  return code;
}

/** Build a discount from user input; `value` is "10" for 10% or "5.00" for $5 off. */
function createDiscount({ code, type, value, minSubtotal = 0 }, now = new Date().toISOString()) {
  oneOf(type, TYPES, 'discount type');
  const parsedValue = type === 'percent'
    ? parseInteger(value, 'percent', { min: 1, max: 100 })
    : toCents(value);
  check(parsedValue > 0, 'discount value must be positive');
  const min = typeof minSubtotal === 'number' ? minSubtotal : toCents(minSubtotal);
  check(Number.isInteger(min) && min >= 0, 'minimum subtotal must be >= 0');
  return { code: normalizeCode(code), type, value: parsedValue, minSubtotal: min, createdAt: now };
}

function addDiscount(store, input) {
  const discount = createDiscount(input);
  check(!store.discounts.some(d => d.code === discount.code), `discount ${discount.code} already exists`);
  store.discounts.push(discount);
  store.save();
  return discount;
}

function findDiscount(store, code) {
  if (!code) return null;
  const key = normalizeCode(code);
  const discount = store.discounts.find(d => d.code === key);
  check(discount, `unknown discount code: ${key}`);
  return discount;
}

/** Amount (cents) that `discount` takes off `subtotalCents`. Throws if the minimum isn't met. */
function discountAmount(discount, subtotalCents) {
  if (!discount) return 0;
  check(subtotalCents >= discount.minSubtotal,
    `code ${discount.code} requires a subtotal of at least ${formatMoney(discount.minSubtotal)}`);
  const amount = discount.type === 'percent' ? percentOf(subtotalCents, discount.value * 100) : discount.value;
  return Math.min(amount, subtotalCents);
}

function describeDiscount(discount) {
  const what = discount.type === 'percent' ? `${discount.value}% off` : `${formatMoney(discount.value)} off`;
  return discount.minSubtotal ? `${what} orders over ${formatMoney(discount.minSubtotal)}` : what;
}

module.exports = { TYPES, normalizeCode, createDiscount, addDiscount, findDiscount, discountAmount, describeDiscount };
