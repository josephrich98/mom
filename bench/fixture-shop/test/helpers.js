'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { main } = require('../src/cli');

/** A fresh, empty data file in a temp dir. */
function tmpFile(name = 'shop.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-test-'));
  return path.join(dir, name);
}

function tmpStore() {
  return new Store(tmpFile());
}

/** Returns a function that runs CLI commands against one temp data file. */
function cliFor(file = tmpFile()) {
  const run = (...args) => main([...args, '--data', file]);
  run.file = file;
  run.data = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  return run;
}

/** A store pre-loaded with two products, two customers and a discount code. */
function seededStore() {
  const store = tmpStore();
  store.products.push(
    { sku: 'MUG', name: 'Coffee mug', priceCents: 1200, stock: 10, category: 'kitchen', createdAt: '2024-01-01T00:00:00.000Z' },
    { sku: 'TEE', name: 'T-shirt', priceCents: 2000, stock: 5, category: 'apparel', createdAt: '2024-01-01T00:00:00.000Z' },
  );
  store.customers.push(
    { id: 'C1', name: 'Ada', email: 'ada@example.com', region: 'US-CA', createdAt: '2024-01-01T00:00:00.000Z' },
    { id: 'C2', name: 'Bernd', email: 'bernd@example.de', region: 'DE', createdAt: '2024-01-01T00:00:00.000Z' },
  );
  store.discounts.push({ code: 'SAVE10', type: 'percent', value: 10, minSubtotal: 0, createdAt: '2024-01-01T00:00:00.000Z' });
  store.save();
  return store;
}

module.exports = { tmpFile, tmpStore, cliFor, seededStore };
