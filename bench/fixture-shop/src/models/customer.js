'use strict';
const { check, requireString, isEmail, isRegion } = require('../util/validate');

/**
 * A customer:
 *   { id: "C<n>", name: string, email: string, region: string, createdAt: ISO string }
 * `region` is an ISO-3166-ish code such as "US-CA", "US-NY" or "DE"; it drives tax
 * and shipping.
 */

const DEFAULT_REGION = 'US-CA';

function normalizeRegion(raw) {
  const region = String(raw == null ? '' : raw).trim().toUpperCase();
  check(isRegion(region), `invalid region ${JSON.stringify(raw)} (expected e.g. US-CA or DE)`);
  return region;
}

function normalizeEmail(raw) {
  const email = String(raw == null ? '' : raw).trim().toLowerCase();
  check(isEmail(email), `invalid email ${JSON.stringify(raw)}`);
  return email;
}

function createCustomer({ id, name, email, region = DEFAULT_REGION }, now = new Date().toISOString()) {
  return {
    id,
    name: requireString(name, 'customer name', { max: 80 }),
    email: normalizeEmail(email),
    region: normalizeRegion(region),
    createdAt: now,
  };
}

module.exports = { createCustomer, normalizeRegion, normalizeEmail, DEFAULT_REGION };
