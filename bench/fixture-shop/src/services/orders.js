'use strict';
const { createOrder, transition, STATUSES } = require('../models/order');
const { nextId, normalizeId } = require('../util/ids');
const { check, oneOf } = require('../util/validate');
const { quote } = require('./pricing');
const { reserve, release } = require('./inventory');

/** Price, reserve stock and persist a new pending order. */
function placeOrder(store, { customerId, items, code = null }) {
  const q = quote(store, { customerId, items, code });
  reserve(store, q.lines);
  const order = createOrder({
    id: nextId(store.orders, 'O'),
    customerId: q.customer.id,
    lines: q.lines,
    totals: q.totals,
    code: q.discount ? q.discount.code : null,
  });
  store.orders.push(order);
  store.save();
  return order;
}

function getOrder(store, id) {
  const key = normalizeId(id, 'O');
  const order = store.orders.find(o => o.id === key);
  check(order, `no such order: ${id}`);
  return order;
}

function listOrders(store, { status, customerId } = {}) {
  let items = store.orders.slice();
  if (status) items = items.filter(o => o.status === oneOf(status, STATUSES, 'status'));
  if (customerId) {
    const cid = normalizeId(customerId, 'C');
    items = items.filter(o => o.customerId === cid);
  }
  return items;
}

function payOrder(store, id) {
  const order = transition(getOrder(store, id), 'paid');
  store.save();
  return order;
}

function shipOrder(store, id) {
  const order = transition(getOrder(store, id), 'shipped');
  store.save();
  return order;
}

/** Cancel a pending or paid order and return its units to stock. */
function cancelOrder(store, id) {
  const order = transition(getOrder(store, id), 'cancelled');
  release(store, order.lines);
  store.save();
  return order;
}

module.exports = { placeOrder, getOrder, listOrders, payOrder, shipOrder, cancelOrder };
