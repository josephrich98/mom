'use strict';

/**
 * Flat-rate shipping.
 *   domestic (region starts with "US"): $5.99, free when merchandise >= $50.00
 *   international:                      $19.99, never free
 * "merchandise" is the subtotal after discounts, before tax.
 */
const DOMESTIC_FLAT = 599;
const INTERNATIONAL_FLAT = 1999;
const FREE_SHIPPING_THRESHOLD = 5000;

function isDomestic(region) {
  return typeof region === 'string' && (region === 'US' || region.startsWith('US-'));
}

function shippingFor({ region, merchandiseCents }) {
  if (!isDomestic(region)) return INTERNATIONAL_FLAT;
  return merchandiseCents >= FREE_SHIPPING_THRESHOLD ? 0 : DOMESTIC_FLAT;
}

module.exports = { DOMESTIC_FLAT, INTERNATIONAL_FLAT, FREE_SHIPPING_THRESHOLD, isDomestic, shippingFor };
