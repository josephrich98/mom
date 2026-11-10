'use strict';
const { createCustomer } = require('../models/customer');
const { nextId, normalizeId } = require('../util/ids');
const { check } = require('../util/validate');

function addCustomer(store, input) {
  const customer = createCustomer({ ...input, id: nextId(store.customers, 'C') });
  check(!store.customers.some(c => c.email === customer.email), `a customer with email ${customer.email} already exists`);
  store.customers.push(customer);
  store.save();
  return customer;
}

function getCustomer(store, id) {
  const key = normalizeId(id, 'C');
  const customer = store.customers.find(c => c.id === key);
  check(customer, `no such customer: ${id}`);
  return customer;
}

function listCustomers(store) {
  return store.customers.slice();
}

module.exports = { addCustomer, getCustomer, listCustomers };
