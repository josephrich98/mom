'use strict';

/**
 * Sequential, prefixed ids: C1, C2, ... for customers, O1, O2, ... for orders.
 * The next id is one more than the largest existing numeric suffix, so ids are
 * never reused even after deletions in the middle.
 */
function nextId(items, prefix) {
  let max = 0;
  for (const item of items) {
    const suffix = typeof item.id === 'string' && item.id.startsWith(prefix) ? item.id.slice(prefix.length) : null;
    if (suffix && /^\d+$/.test(suffix)) max = Math.max(max, Number(suffix));
  }
  return `${prefix}${max + 1}`;
}

/** Normalise an id typed by a user: "c1" -> "C1", "1" -> "C1" for prefix "C". */
function normalizeId(raw, prefix) {
  const s = String(raw == null ? '' : raw).trim().toUpperCase();
  if (/^\d+$/.test(s)) return prefix + s;
  return s;
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = { nextId, normalizeId, nowIso };
