'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const orders = require('../src/services/orders');
const inventory = require('../src/services/inventory');
const { parseItemSpecs } = require('../src/models/order');
const { Store } = require('../src/store');
const { seededStore } = require('./helpers');

test('parseItemSpecs merges duplicates and defaults qty to 1', () => {
  assert.deepEqual(parseItemSpecs(['mug:2', 'TEE', 'MUG:3']), [{ sku: 'MUG', qty: 5 }, { sku: 'TEE', qty: 1 }]);
  assert.throws(() => parseItemSpecs(['MUG:0']), /must be >= 1/);
  assert.throws(() => parseItemSpecs([]), /at least one item/);
});

test('placeOrder reserves stock and persists the order', () => {
  const store = seededStore();
  const order = orders.placeOrder(store, { customerId: 'C1', items: ['MUG:3'] });
  assert.equal(order.id, 'O1');
  assert.equal(order.status, 'pending');
  assert.equal(order.lines[0].priceCents, 1200);
  const reloaded = new Store(store.file);
  assert.equal(reloaded.products.find(p => p.sku === 'MUG').stock, 7);
  assert.equal(reloaded.orders.length, 1);
});

test('placeOrder fails atomically on insufficient stock', () => {
  const store = seededStore();
  assert.throws(() => orders.placeOrder(store, { customerId: 'C1', items: ['MUG:1', 'TEE:6'] }), /insufficient stock for TEE/);
  assert.equal(store.products.find(p => p.sku === 'MUG').stock, 10);
  assert.equal(store.orders.length, 0);
});

test('order lifecycle: pay, ship, and illegal transitions', () => {
  const store = seededStore();
  const { id } = orders.placeOrder(store, { customerId: 'C2', items: ['TEE:1'] });
  assert.throws(() => orders.shipOrder(store, id), /cannot change order O1 from pending to shipped/);
  orders.payOrder(store, id);
  orders.shipOrder(store, id);
  assert.equal(orders.getOrder(store, '1').status, 'shipped');
  assert.throws(() => orders.cancelOrder(store, id), /cannot change/);
  assert.deepEqual(orders.getOrder(store, id).history.map(h => h.status), ['pending', 'paid', 'shipped']);
});

test('cancelOrder returns units to stock', () => {
  const store = seededStore();
  const { id } = orders.placeOrder(store, { customerId: 'C1', items: ['TEE:2'] });
  assert.equal(store.products.find(p => p.sku === 'TEE').stock, 3);
  orders.cancelOrder(store, id);
  assert.equal(store.products.find(p => p.sku === 'TEE').stock, 5);
});

test('listOrders filters by status and customer', () => {
  const store = seededStore();
  orders.placeOrder(store, { customerId: 'C1', items: ['MUG:1'] });
  const second = orders.placeOrder(store, { customerId: 'C2', items: ['MUG:1'] });
  orders.payOrder(store, second.id);
  assert.deepEqual(orders.listOrders(store, { status: 'paid' }).map(o => o.id), ['O2']);
  assert.deepEqual(orders.listOrders(store, { customerId: 'c1' }).map(o => o.id), ['O1']);
  assert.throws(() => orders.listOrders(store, { status: 'lost' }), /status must be one of/);
});

test('lowStock and restock', () => {
  const store = seededStore();
  assert.deepEqual(inventory.lowStock(store, 5).map(p => p.sku), ['TEE']);
  inventory.restock(store, 'TEE', 10);
  assert.deepEqual(inventory.lowStock(store, 5), []);
  assert.throws(() => inventory.restock(store, 'TEE', 0), /must be >= 1/);
});
