'use strict';
const { percentOf } = require('../util/money');

/**
 * Sales tax rates in basis points (725 = 7.25%), keyed by customer region.
 * Regions not listed here are untaxed.
 */
const DEFAULT_RATES = Object.freeze({
  'US-CA': 725,
  'US-NY': 400,
  'US-TX': 625,
  'US-WA': 650,
  'US-OR': 0,
  DE: 1900,
  FR: 2000,
  GB: 2000,
});

function rateFor(region) {
  return Object.prototype.hasOwnProperty.call(DEFAULT_RATES, region) ? DEFAULT_RATES[region] : 0;
}

/** Tax owed on `taxableCents` for a customer in `region`, rounded half up to the cent. */
function computeTax(taxableCents, region) {
  if (taxableCents <= 0) return 0;
  return percentOf(taxableCents, rateFor(region));
}

module.exports = { DEFAULT_RATES, rateFor, computeTax };
