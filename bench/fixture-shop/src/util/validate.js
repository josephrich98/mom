'use strict';

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function check(condition, message) {
  if (!condition) throw new ValidationError(message);
}

function requireString(value, name, { max = 200 } = {}) {
  check(typeof value === 'string' && value.trim().length > 0, `${name} is required`);
  check(value.trim().length <= max, `${name} must be at most ${max} characters`);
  return value.trim();
}

/** Parse a CLI/user value as an integer within [min, max]. Accepts numbers or digit strings. */
function parseInteger(value, name, { min = -Infinity, max = Infinity } = {}) {
  let n = NaN;
  if (typeof value === 'number') n = value;
  else if (/^-?\d+$/.test(String(value).trim())) n = Number(value);
  check(Number.isInteger(n), `${name} must be an integer, got ${JSON.stringify(value)}`);
  check(n >= min, `${name} must be >= ${min}`);
  check(n <= max, `${name} must be <= ${max}`);
  return n;
}

const SKU_RE = /^[A-Z0-9][A-Z0-9-]{1,19}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REGION_RE = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;
const CODE_RE = /^[A-Z0-9_-]{3,20}$/;

const isSku = s => typeof s === 'string' && SKU_RE.test(s);
const isEmail = s => typeof s === 'string' && EMAIL_RE.test(s);
const isRegion = s => typeof s === 'string' && REGION_RE.test(s);
const isCode = s => typeof s === 'string' && CODE_RE.test(s);

/** True for a real calendar date written as YYYY-MM-DD. */
function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function oneOf(value, allowed, name) {
  check(allowed.includes(value), `${name} must be one of ${allowed.join(', ')}, got ${JSON.stringify(value)}`);
  return value;
}

module.exports = { ValidationError, check, requireString, parseInteger, isSku, isEmail, isRegion, isCode, isIsoDate, oneOf };
