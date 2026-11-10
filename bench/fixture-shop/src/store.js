'use strict';
const fs = require('fs');
const path = require('path');

/**
 * JSON-file persistence. The whole shop lives in one file:
 *   { version, products: [], customers: [], discounts: [], orders: [] }
 *
 * The store is loaded once per process; mutating services change the arrays in
 * place and call `save()`. Writes go through a temp file + rename so a crash never
 * leaves a half-written data file behind.
 */

const SCHEMA_VERSION = 1;
const COLLECTIONS = ['products', 'customers', 'discounts', 'orders'];

function emptyData() {
  return { version: SCHEMA_VERSION, products: [], customers: [], discounts: [], orders: [] };
}

class Store {
  constructor(file) {
    this.file = file;
    this.data = emptyData();
    this.load();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') { this.data = emptyData(); return this; }
      throw e;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`data file ${this.file} is not valid JSON: ${e.message}`);
    }
    this.data = this.normalize(parsed);
    return this;
  }

  /** Fill in missing collections so older/partial files keep working. */
  normalize(parsed) {
    const data = { ...emptyData(), ...(parsed && typeof parsed === 'object' ? parsed : {}) };
    for (const key of COLLECTIONS) if (!Array.isArray(data[key])) data[key] = [];
    data.version = SCHEMA_VERSION;
    return data;
  }

  save() {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(this.file)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
    return this;
  }

  get products() { return this.data.products; }
  get customers() { return this.data.customers; }
  get discounts() { return this.data.discounts; }
  get orders() { return this.data.orders; }
}

module.exports = { Store, SCHEMA_VERSION, emptyData };
