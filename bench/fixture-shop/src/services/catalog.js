'use strict';
const { createProduct, normalizeSku, validatePrice } = require('../models/product');
const { check } = require('../util/validate');

function addProduct(store, input) {
  const product = createProduct(input);
  check(!store.products.some(p => p.sku === product.sku), `product ${product.sku} already exists`);
  store.products.push(product);
  store.save();
  return product;
}

function findProduct(store, sku) {
  const key = String(sku == null ? '' : sku).trim().toUpperCase();
  return store.products.find(p => p.sku === key) || null;
}

function getProduct(store, sku) {
  const product = findProduct(store, normalizeSku(sku));
  check(product, `no such product: ${sku}`);
  return product;
}

function listProducts(store, { category } = {}) {
  let items = store.products.slice();
  if (category) items = items.filter(p => p.category === String(category).toLowerCase());
  return items.sort((a, b) => a.sku.localeCompare(b.sku));
}

function setPrice(store, sku, priceCents) {
  const product = getProduct(store, sku);
  product.priceCents = validatePrice(priceCents);
  store.save();
  return product;
}

module.exports = { addProduct, findProduct, getProduct, listProducts, setPrice };
