'use strict';
/**
 * Money helpers. All amounts in this codebase are integer cents (USD).
 * Never use floats for money outside of parsing user input in this module.
 */

const MONEY_RE = /^-?\$?(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/;

/** Parse a user-supplied amount ("12", "12.5", "$1,234.56") into integer cents. */
function toCents(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error(`invalid amount: ${input}`);
    return Math.round(input * 100);
  }
  const s = String(input == null ? '' : input).trim();
  if (!MONEY_RE.test(s)) throw new Error(`invalid amount: ${JSON.stringify(input)}`);
  const negative = s.startsWith('-');
  const clean = s.replace(/[-$,]/g, '');
  const [whole, frac = ''] = clean.split('.');
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return negative ? -cents : cents;
}

/** Format integer cents as "$1,234.56" (negative amounts as "-$1.00"). */
function formatMoney(cents) {
  assertCents(cents);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}$${whole}.${frac}`;
}

function assertCents(value, name = 'amount') {
  if (!Number.isInteger(value)) throw new Error(`${name} must be integer cents, got ${value}`);
  return value;
}

/** Divide two integers and round half away from zero, using integer math only. */
function divRound(numerator, denominator) {
  const sign = Math.sign(numerator) * Math.sign(denominator) || 1;
  const n = Math.abs(numerator), d = Math.abs(denominator);
  return sign * Math.floor((2 * n + d) / (2 * d));
}

/** `bps` basis points of `cents` (725 bps = 7.25%), rounded half up. */
function percentOf(cents, bps) {
  assertCents(cents);
  assertCents(bps, 'bps');
  return divRound(cents * bps, 10000);
}

function multiply(cents, qty) {
  assertCents(cents);
  if (!Number.isInteger(qty)) throw new Error(`quantity must be an integer, got ${qty}`);
  return cents * qty;
}

function sum(amounts) {
  return amounts.reduce((acc, c) => acc + assertCents(c), 0);
}

/** Parse a percentage string ("7.25") into basis points (725). */
function percentToBps(input) {
  const s = String(input).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error(`invalid percentage: ${JSON.stringify(input)}`);
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

/** 725 -> "7.25%", 1900 -> "19%", 450 -> "4.5%". */
function formatBps(bps) {
  const whole = Math.floor(bps / 100), frac = bps % 100;
  if (!frac) return `${whole}%`;
  return `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}%`;
}

module.exports = { toCents, formatMoney, assertCents, divRound, percentOf, multiply, sum, percentToBps, formatBps };
