'use strict';
const { check, requireString, parseInteger, isSku } = require('../util/validate');
const { assertCents } = require('../util/money');

/**
 * A product:
 *   { sku: string, name: string, priceCents: integer, stock: integer,
 *     category: string, createdAt: ISO string }
 * `priceCents` is the unit price in integer cents.
 */

const DEFAULT_CATEGORY = 'general';

function normalizeSku(raw) {
  const sku = String(raw == null ? '' : raw).trim().toUpperCase();
  check(isSku(sku), `invalid SKU ${JSON.stringify(raw)} (2-20 chars, A-Z, 0-9 and '-')`);
  return sku;
}

function createProduct({ sku, name, priceCents, stock = 0, category = DEFAULT_CATEGORY }, now = new Date().toISOString()) {
  const product = {
    sku: normalizeSku(sku),
    name: requireString(name, 'product name', { max: 80 }),
    priceCents: validatePrice(priceCents),
    stock: parseInteger(stock, 'stock', { min: 0 }),
    category: requireString(category, 'category', { max: 40 }).toLowerCase(),
    createdAt: now,
  };
  return product;
}

function validatePrice(priceCents) {
  assertCents(priceCents, 'price');
  check(priceCents > 0, 'price must be greater than zero');
  check(priceCents <= 100000000, 'price must be at most $1,000,000.00');
  return priceCents;
}

module.exports = { createProduct, normalizeSku, validatePrice, DEFAULT_CATEGORY };
