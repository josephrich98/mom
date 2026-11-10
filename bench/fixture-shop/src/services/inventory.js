'use strict';
const { getProduct } = require('./catalog');
const { check, parseInteger } = require('../util/validate');

/** Throws if any line asks for more units than are in stock. Does not mutate. */
function checkAvailability(store, lines) {
  for (const { sku, qty } of lines) {
    const product = getProduct(store, sku);
    check(product.stock >= qty, `insufficient stock for ${sku}: requested ${qty}, available ${product.stock}`);
  }
}

/** Decrement stock for every line, all-or-nothing. Caller is responsible for saving. */
function reserve(store, lines) {
  checkAvailability(store, lines);
  for (const { sku, qty } of lines) getProduct(store, sku).stock -= qty;
}

/** Put units back (e.g. when an order is cancelled). Caller is responsible for saving. */
function release(store, lines) {
  for (const { sku, qty } of lines) {
    const product = getProduct(store, sku);
    product.stock += qty;
  }
}

function restock(store, sku, qty) {
  const product = getProduct(store, sku);
  product.stock += parseInteger(qty, 'quantity', { min: 1, max: 1000000 });
  store.save();
  return product;
}

/** Products whose stock is at or below `threshold`, lowest stock first. */
function lowStock(store, threshold = 5) {
  const limit = parseInteger(threshold, 'threshold', { min: 0 });
  return store.products
    .filter(p => p.stock <= limit)
    .sort((a, b) => a.stock - b.stock || a.sku.localeCompare(b.sku));
}

module.exports = { checkAvailability, reserve, release, restock, lowStock };
