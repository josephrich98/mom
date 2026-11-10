'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { parseArgs } = require('../src/cli');
const { Store } = require('../src/store');
const { cliFor, tmpFile } = require('./helpers');

test('parseArgs separates flags from positionals', () => {
  assert.deepEqual(parseArgs(['quote', 'C1', 'MUG:2', '--code', 'X', '--verbose']), { _: ['quote', 'C1', 'MUG:2'], code: 'X', verbose: true });
});

test('store: missing file starts empty, corrupt file is an error', () => {
  const file = tmpFile();
  assert.deepEqual(new Store(file).products, []);
  fs.writeFileSync(file, '{nope');
  assert.throws(() => new Store(file), /not valid JSON/);
});

test('store: partial files are normalised', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ products: [{ sku: 'A1' }] }));
  const s = new Store(file);
  assert.equal(s.products.length, 1);
  assert.deepEqual(s.orders, []);
});

test('cli: add products and customers, then list them', () => {
  const shop = cliFor();
  assert.match(shop('product', 'add', 'mug', 'Coffee mug', '12.00', '--stock', '10', '--category', 'Kitchen'), /added product MUG/);
  assert.match(shop('customer', 'add', 'Ada', 'ADA@example.com', '--region', 'us-ny'), /added customer C1 .*US-NY/);
  assert.match(shop('product', 'list'), /MUG\s+Coffee mug\s+\$12\.00\s+10\s+kitchen/);
  assert.match(shop('product', 'list', '--category', 'garden'), /\(none\)/);
  assert.match(shop('customer', 'list'), /C1\s+Ada\s+ada@example\.com/);
  assert.throws(() => shop('product', 'add', 'MUG', 'Again', '1'), /already exists/);
});

test('cli: quote prints a labelled breakdown', () => {
  const shop = cliFor();
  shop('product', 'add', 'MUG', 'Coffee mug', '12', '--stock', '10');
  shop('customer', 'add', 'Ada', 'ada@example.com');
  shop('discount', 'add', 'save10', 'percent', '10');
  const out = shop('quote', 'C1', 'MUG:2', '--code', 'SAVE10');
  assert.match(out, /^Subtotal:\s+\$24\.00$/m);
  assert.match(out, /^Discount:\s+-\$2\.40$/m);
  assert.match(out, /^Tax:\s+\$1\.57$/m);
  assert.match(out, /^Shipping:\s+\$5\.99$/m);
  assert.match(out, /^Total:\s+\$29\.16$/m);
});

test('cli: order place / pay / ship / show', () => {
  const shop = cliFor();
  shop('product', 'add', 'TEE', 'T-shirt', '20', '--stock', '3');
  shop('customer', 'add', 'Bernd', 'b@example.de', '--region', 'DE');
  assert.match(shop('order', 'place', 'C1', 'TEE:2'), /placed order O1 for C1: total \$67\.59/);
  assert.match(shop('order', 'pay', 'O1'), /paid/);
  assert.match(shop('order', 'ship', '1'), /shipped/);
  assert.match(shop('order', 'list', '--status', 'shipped'), /O1\s+C1\s+shipped/);
  const show = shop('order', 'show', 'O1');
  assert.match(show, /TEE\s+T-shirt\s+2\s+\$20\.00\s+\$40\.00/);
  assert.match(show, /^Total:\s+\$67\.59$/m);
  assert.equal(shop.data().products[0].stock, 1);
});

test('cli: errors for bad input', () => {
  const shop = cliFor();
  assert.throws(() => shop('product', 'add', 'MUG', 'Mug', 'free'), /invalid amount/);
  assert.throws(() => shop('customer', 'add', 'X', 'not-an-email'), /invalid email/);
  assert.throws(() => shop('frobnicate'), /unknown command/);
  assert.match(shop(), /usage: shop/);
});
