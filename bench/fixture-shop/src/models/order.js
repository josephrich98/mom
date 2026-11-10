'use strict';
const { check, parseInteger } = require('../util/validate');
const { normalizeSku } = require('./product');

/**
 * An order:
 *   { id: "O<n>", customerId, status, code: string|null, createdAt,
 *     lines: [{ sku, name, qty, priceCents }],
 *     totals: { subtotal, discount, tax, shipping, total },   // integer cents
 *     history: [{ status, at }] }
 *
 * Status lifecycle: pending -> paid -> shipped, and pending|paid -> cancelled.
 */

const STATUSES = ['pending', 'paid', 'shipped', 'cancelled'];

const TRANSITIONS = {
  pending: ['paid', 'cancelled'],
  paid: ['shipped', 'cancelled'],
  shipped: [],
  cancelled: [],
};

/** Parse "SKU:QTY" item specs (qty defaults to 1) and merge duplicate SKUs. */
function parseItemSpecs(specs) {
  check(Array.isArray(specs) && specs.length > 0, 'at least one item (SKU:QTY) is required');
  const merged = new Map();
  for (const spec of specs) {
    const [rawSku, rawQty = '1', extra] = String(spec).split(':');
    check(extra === undefined, `invalid item ${JSON.stringify(spec)} (expected SKU:QTY)`);
    const sku = normalizeSku(rawSku);
    const qty = parseInteger(rawQty, `quantity for ${sku}`, { min: 1, max: 10000 });
    merged.set(sku, (merged.get(sku) || 0) + qty);
  }
  return [...merged].map(([sku, qty]) => ({ sku, qty }));
}

function createOrder({ id, customerId, lines, totals, code = null }, now = new Date().toISOString()) {
  check(lines.length > 0, 'order must have at least one line');
  return {
    id,
    customerId,
    status: 'pending',
    code,
    createdAt: now,
    lines: lines.map(l => ({ sku: l.sku, name: l.name, qty: l.qty, priceCents: l.priceCents })),
    totals: { ...totals },
    history: [{ status: 'pending', at: now }],
  };
}

function canTransition(order, to) {
  return (TRANSITIONS[order.status] || []).includes(to);
}

function transition(order, to, now = new Date().toISOString()) {
  check(STATUSES.includes(to), `unknown status ${JSON.stringify(to)}`);
  check(canTransition(order, to), `cannot change order ${order.id} from ${order.status} to ${to}`);
  order.status = to;
  order.history.push({ status: to, at: now });
  return order;
}

module.exports = { STATUSES, TRANSITIONS, parseItemSpecs, createOrder, canTransition, transition };
