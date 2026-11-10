'use strict';
const { formatMoney } = require('./money');

/** Render rows as a left-aligned text table. `columns` is [{ key, label, align? }]. */
function table(rows, columns) {
  if (!rows.length) return '(none)';
  const cells = rows.map(r => columns.map(c => String(typeof c.get === 'function' ? c.get(r) : r[c.key] ?? '')));
  const widths = columns.map((c, i) => Math.max(c.label.length, ...cells.map(row => row[i].length)));
  const fmt = row => row.map((v, i) => (columns[i].align === 'right' ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join('  ').trimEnd();
  return [fmt(columns.map(c => c.label)), ...cells.map(fmt)].join('\n');
}

function formatProducts(products) {
  return table(products, [
    { key: 'sku', label: 'SKU' },
    { key: 'name', label: 'NAME' },
    { label: 'PRICE', align: 'right', get: p => formatMoney(p.priceCents) },
    { key: 'stock', label: 'STOCK', align: 'right' },
    { key: 'category', label: 'CATEGORY' },
  ]);
}

function formatCustomers(customers) {
  return table(customers, [
    { key: 'id', label: 'ID' },
    { key: 'name', label: 'NAME' },
    { key: 'email', label: 'EMAIL' },
    { key: 'region', label: 'REGION' },
  ]);
}

function formatOrders(orders) {
  return table(orders, [
    { key: 'id', label: 'ID' },
    { key: 'customerId', label: 'CUSTOMER' },
    { key: 'status', label: 'STATUS' },
    { label: 'ITEMS', align: 'right', get: o => o.lines.reduce((n, l) => n + l.qty, 0) },
    { label: 'TOTAL', align: 'right', get: o => formatMoney(o.totals.total) },
    { label: 'DATE', get: o => o.createdAt.slice(0, 10) },
  ]);
}

/** The price breakdown block used by `quote` and `order show`. One "Label: $x" per line. */
function formatTotals(totals) {
  const rows = [['Subtotal', formatMoney(totals.subtotal)]];
  if (totals.discount) rows.push(['Discount', formatMoney(-totals.discount)]);
  rows.push(['Tax', formatMoney(totals.tax)], ['Shipping', formatMoney(totals.shipping)], ['Total', formatMoney(totals.total)]);
  const width = Math.max(...rows.map(r => r[0].length)) + 1;
  return rows.map(([label, value]) => `${(label + ':').padEnd(width)} ${value}`).join('\n');
}

function formatLines(lines) {
  return table(lines, [
    { key: 'sku', label: 'SKU' },
    { key: 'name', label: 'NAME' },
    { key: 'qty', label: 'QTY', align: 'right' },
    { label: 'UNIT', align: 'right', get: l => formatMoney(l.priceCents) },
    { label: 'AMOUNT', align: 'right', get: l => formatMoney(l.priceCents * l.qty) },
  ]);
}

function formatOrder(order) {
  const head = `Order ${order.id}  customer ${order.customerId}  ${order.status}  ${order.createdAt.slice(0, 10)}`;
  const code = order.code ? `\nCode: ${order.code}` : '';
  return `${head}\n\n${formatLines(order.lines)}\n\n${formatTotals(order.totals)}${code}`;
}

module.exports = { table, formatProducts, formatCustomers, formatOrders, formatTotals, formatLines, formatOrder };
