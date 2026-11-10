'use strict';
const { multiply, sum } = require('../util/money');
const { discountAmount, findDiscount } = require('./discount');
const { computeTax } = require('./tax');
const { shippingFor } = require('./shipping');
const { getProduct } = require('./catalog');
const { getCustomer } = require('./customers');
const { parseItemSpecs } = require('../models/order');

/**
 * Order of operations (all integer cents):
 *   subtotal     = sum(line.priceCents * line.qty)
 *   discount     = discount code applied to subtotal
 *   merchandise  = subtotal - discount
 *   tax          = merchandise * rate(region), rounded half up
 *   shipping     = shippingFor(region, merchandise)
 *   total        = merchandise + tax + shipping
 */

/** Resolve [{sku, qty}] against the catalog into priced lines. */
function buildLines(store, items) {
  return items.map(({ sku, qty }) => {
    const product = getProduct(store, sku);
    return { sku: product.sku, name: product.name, qty, priceCents: product.priceCents };
  });
}

/** Pure pricing function: no store access. */
function calcTotals({ lines, region, discount = null }) {
  const lineTotals = lines.map(l => multiply(l.priceCents, l.qty));
  const subtotal = sum(lineTotals);
  const discountCents = discountAmount(discount, subtotal);
  const merchandise = subtotal - discountCents;
  const tax = computeTax(merchandise, region);
  const shipping = shippingFor({ region, merchandiseCents: merchandise });
  return {
    subtotal,
    discount: discountCents,
    tax,
    shipping,
    total: merchandise + tax + shipping,
  };
}

/**
 * Price a prospective order for a customer.
 * `items` are raw "SKU:QTY" strings or already-parsed [{sku, qty}].
 */
function quote(store, { customerId, items, code = null }) {
  const customer = getCustomer(store, customerId);
  const parsed = typeof items[0] === 'string' ? parseItemSpecs(items) : items;
  const lines = buildLines(store, parsed);
  const discount = findDiscount(store, code);
  const totals = calcTotals({ lines, region: customer.region, discount });
  return { customer, lines, discount, totals };
}

module.exports = { buildLines, calcTotals, quote };
