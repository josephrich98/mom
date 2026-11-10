#!/usr/bin/env node
'use strict';
// Acceptance checker for bench/fixture-shop + bench/tasks-shop.json.
// Usage: node bench/check-shop.js <workdir>  -> prints {score, max, checks, note} as JSON.
// Each task is checked black-box through the CLI (and module exports where the task is
// about the API), each in its own fresh data file so one task's failure can't cascade.
const cp = require('child_process'), fs = require('fs'), path = require('path'), os = require('os');
const work = path.resolve(process.argv[2] || '.');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-check-'));
const BASE_TESTS = 32;
const checks = {}, note = {};
let fileN = 0;
const newFile = () => path.join(tmp, `shop${++fileN}.json`);

function cli(file, ...args) {
  const r = cp.spawnSync('node', ['src/cli.js', ...args, '--data', file], { cwd: work, encoding: 'utf8', timeout: 20000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '' };
}
const ok = r => r.code === 0;
const readData = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const readSrc = p => { try { return fs.readFileSync(path.join(work, p), 'utf8'); } catch { return ''; } };
const json = s => { try { return JSON.parse(s); } catch { return undefined; } };
// Amount on the first line starting with `label` (e.g. "Tax:  $2.61"), as absolute cents, or null.
function amount(out, label) {
  const m = String(out).match(new RegExp(`^\\s*${label}\\b[^\\n\\d]*?(\\d[\\d,]*\\.\\d{2})`, 'im'));
  return m ? Math.round(Number(m[1].replace(/,/g, '')) * 100) : null;
}
// Run a group of checks; any exception marks the group's not-yet-set checks false.
function group(names, fn) {
  try { fn(); } catch (e) { note[`${names[0].split('_')[0]}_error`] = String(e && e.message || e).slice(0, 200); }
  for (const n of names) if (!(n in checks)) checks[n] = false;
}
function seed(file, { region = 'US-CA', products = [['WIDGET', 'Widget', '20.00', '100']] } = {}) {
  for (const [sku, name, price, stock, ...extra] of products) cli(file, 'product', 'add', sku, name, price, '--stock', stock, ...extra);
  cli(file, 'customer', 'add', 'Ada', `ada${fileN}@example.com`, '--region', region);
}

// ---- tests ---------------------------------------------------------------
const t = cp.spawnSync('npm', ['test', '--silent'], { cwd: work, encoding: 'utf8', timeout: 180000 });
const tout = (t.stdout || '') + (t.stderr || '');
const m = k => { const mm = tout.match(new RegExp(`^ℹ ${k} (\\d+)`, 'm')); return mm ? +mm[1] : null; };
note.tests = { total: m('tests'), pass: m('pass'), fail: m('fail'), exit: t.status };
checks.tests_pass = t.status === 0 && m('fail') === 0;
checks.tests_added = (m('tests') || 0) >= BASE_TESTS + 8;

// ---- rename-price ----------------------------------------------------------
group(['rename_product_field', 'rename_line_field', 'rename_migrates_legacy', 'rename_price_order_export', 'rename_no_old_names'], () => {
  const f = newFile();
  seed(f);
  cli(f, 'order', 'place', 'C1', 'WIDGET:1');
  const d = readData(f);
  const p = (d.products || [])[0] || {};
  checks.rename_product_field = p.unitPriceCents === 2000 && !('priceCents' in p);
  const l = (((d.orders || [])[0] || {}).lines || [])[0] || {};
  checks.rename_line_field = l.unitPriceCents === 2000 && !('priceCents' in l);
  const legacy = newFile();
  const at = '2024-01-01T00:00:00.000Z';
  fs.writeFileSync(legacy, JSON.stringify({
    version: 1,
    products: [{ sku: 'OLD', name: 'Old thing', priceCents: 1500, stock: 5, category: 'general', createdAt: at }],
    customers: [{ id: 'C1', name: 'Old', email: 'old@example.com', region: 'US-OR', createdAt: at }],
    discounts: [],
    orders: [{ id: 'O1', customerId: 'C1', status: 'paid', code: null, createdAt: at,
      lines: [{ sku: 'OLD', name: 'Old thing', qty: 1, priceCents: 1500 }],
      totals: { subtotal: 1500, discount: 0, tax: 0, shipping: 599, total: 2099 }, history: [{ status: 'pending', at }] }],
  }, null, 2));
  const q = cli(legacy, 'quote', 'C1', 'OLD:2');
  const r = cli(legacy, 'product', 'restock', 'OLD', '1');
  const ld = readData(legacy);
  const lp = (ld.products || [])[0] || {}, ll = (((ld.orders || [])[0] || {}).lines || [])[0] || {};
  checks.rename_migrates_legacy = ok(q) && amount(q.out, 'subtotal') === 3000 && ok(r) &&
    lp.unitPriceCents === 1500 && !('priceCents' in lp) && ll.unitPriceCents === 1500 && !('priceCents' in ll);
  const e = cp.spawnSync('node', ['-e', `const p=require(process.argv[1]); if (typeof p.priceOrder!=='function' || 'calcTotals' in p) process.exit(1);`,
    path.join(work, 'src/services/pricing.js')], { encoding: 'utf8', timeout: 20000 });
  checks.rename_price_order_export = e.status === 0; note.rename_export = (e.stderr || '').trim().slice(0, 200);
  const offenders = [];
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith('.js')) {
        const rel = path.relative(work, full), src = fs.readFileSync(full, 'utf8');
        if (/\bcalcTotals\b/.test(src) || (rel !== path.join('src', 'store.js') && /\bpriceCents\b/.test(src))) offenders.push(rel);
      }
    }
  })(path.join(work, 'src'));
  note.rename_offenders = offenders;
  checks.rename_no_old_names = offenders.length === 0;
});

// ---- tiers ---------------------------------------------------------------
group(['tiers_add', 'tiers_reject_bad', 'tiers_below_threshold', 'tiers_applied', 'tiers_order_line_price'], () => {
  const f = newFile();
  seed(f, { region: 'US-OR', products: [['BOLT', 'Bolt', '2.00', '500']] });
  checks.tiers_add = ok(cli(f, 'product', 'tier', 'BOLT', '10', '1.50')) && ok(cli(f, 'product', 'tier', 'BOLT', '50', '1.00'));
  checks.tiers_reject_bad = checks.tiers_add && !ok(cli(f, 'product', 'tier', 'BOLT', '1', '1.00')) && !ok(cli(f, 'product', 'tier', 'BOLT', '20', 'cheap'));
  const q9 = cli(f, 'quote', 'C1', 'BOLT:9');
  checks.tiers_below_threshold = checks.tiers_add && ok(q9) && amount(q9.out, 'subtotal') === 1800;
  const q10 = cli(f, 'quote', 'C1', 'BOLT:10'), q60 = cli(f, 'quote', 'C1', 'BOLT:60');
  // replacing the minQty=10 tier must not duplicate it
  const rep = cli(f, 'product', 'tier', 'BOLT', '10', '1.40'), q12 = cli(f, 'quote', 'C1', 'BOLT:12');
  checks.tiers_applied = ok(q10) && amount(q10.out, 'subtotal') === 1500 && ok(q60) && amount(q60.out, 'subtotal') === 6000 &&
    ok(rep) && amount(q12.out, 'subtotal') === 1680;
  const placed = cli(f, 'order', 'place', 'C1', 'BOLT:20');
  const o = ((readData(f).orders) || [])[0] || {}, l = (o.lines || [])[0] || {};
  checks.tiers_order_line_price = ok(placed) && (l.unitPriceCents ?? l.priceCents) === 140 && (o.totals || {}).subtotal === 2800;
});

// ---- coupons -------------------------------------------------------------
group(['coupons_add_flags', 'coupons_reject_bad_date', 'coupons_expired_rejected', 'coupons_max_uses', 'coupons_cancel_returns_use', 'coupons_list_shows'], () => {
  const f = newFile();
  seed(f);
  checks.coupons_add_flags = ok(cli(f, 'discount', 'add', 'ONCE', 'percent', '10', '--expires', '2099-12-31', '--max-uses', '1')) &&
    ok(cli(f, 'discount', 'add', 'OLDIE', 'fixed', '5', '--expires', '2000-01-01')) &&
    (() => { const d = ((readData(f).discounts) || []).find(x => x.code === 'ONCE') || {}; const v = Object.values(d);
      return d.uses === 0 && v.some(x => String(x).startsWith('2099-12-31')) && v.some(x => x === 1 || x === '1'); })();
  checks.coupons_reject_bad_date = checks.coupons_add_flags && !ok(cli(f, 'discount', 'add', 'BADDATE', 'percent', '5', '--expires', '2099-02-30')) &&
    !ok(cli(f, 'discount', 'add', 'BADDATE2', 'percent', '5', '--expires', 'soon'));
  const qOld = cli(f, 'quote', 'C1', 'WIDGET:1', '--code', 'OLDIE'), pOld = cli(f, 'order', 'place', 'C1', 'WIDGET:1', '--code', 'OLDIE');
  checks.coupons_expired_rejected = checks.coupons_add_flags && !ok(qOld) && !ok(pOld) && ((readData(f).orders) || []).length === 0;
  const q1 = cli(f, 'quote', 'C1', 'WIDGET:1', '--code', 'ONCE'), q2 = cli(f, 'quote', 'C1', 'WIDGET:1', '--code', 'ONCE');
  const p1 = cli(f, 'order', 'place', 'C1', 'WIDGET:1', '--code', 'ONCE');
  const p2 = cli(f, 'order', 'place', 'C1', 'WIDGET:1', '--code', 'ONCE');
  const q3 = cli(f, 'quote', 'C1', 'WIDGET:1', '--code', 'ONCE');
  const once = () => ((readData(f).discounts) || []).find(d => d.code === 'ONCE') || {};
  checks.coupons_max_uses = ok(q1) && ok(q2) && amount(q1.out, 'discount') === 200 && ok(p1) && !ok(p2) && !ok(q3) &&
    once().uses === 1 && ((readData(f).orders) || []).length === 1;
  const c = cli(f, 'order', 'cancel', 'O1');
  const usesAfterCancel = once().uses;
  const p3 = cli(f, 'order', 'place', 'C1', 'WIDGET:1', '--code', 'ONCE');
  checks.coupons_cancel_returns_use = ok(c) && usesAfterCancel === 0 && ok(p3) && once().uses === 1;
  const list = cli(f, 'discount', 'list');
  const onceLine = list.out.split('\n').find(l => l.includes('ONCE')) || '';
  checks.coupons_list_shows = ok(list) && /2099-12-31/.test(onceLine) && /\b1\b/.test(onceLine.replace(/2099-12-31/, ''));
});

// ---- loyalty -------------------------------------------------------------
group(['loyalty_add_tier', 'loyalty_reject_bad', 'loyalty_gold_quote', 'loyalty_after_coupon', 'loyalty_stored_on_order'], () => {
  const f = newFile();
  cli(f, 'product', 'add', 'TEE', 'T-shirt', '20.00', '--stock', '100');
  const a = cli(f, 'customer', 'add', 'Gold', 'gold@example.com', '--region', 'US-CA', '--tier', 'gold');
  const b = cli(f, 'customer', 'add', 'Plain', 'plain@example.com', '--region', 'US-CA');
  const cs = (readData(f).customers) || [];
  const list = cli(f, 'customer', 'list');
  checks.loyalty_add_tier = ok(a) && ok(b) && (cs[0] || {}).tier === 'gold' && ((cs[1] || {}).tier || 'standard') === 'standard' &&
    /gold/i.test((list.out.split('\n').find(l => /C1\b/.test(l)) || ''));
  checks.loyalty_reject_bad = checks.loyalty_add_tier && !ok(cli(f, 'customer', 'add', 'Bad', 'bad@example.com', '--tier', 'platinum')) &&
    !ok(cli(f, 'customer', 'tier', 'C2', 'diamond'));
  // gold, $40 subtotal: loyalty 4.00, tax 7.25% of 36.00 = 2.61
  const q = cli(f, 'quote', 'C1', 'TEE:2');
  checks.loyalty_gold_quote = ok(q) && amount(q.out, 'loyalty') === 400 && amount(q.out, 'tax') === 261;
  // silver after a 10% code: 40 -> 36 -> loyalty 1.80, tax 7.25% of 34.20 = 2.48 (2.4795)
  const t = cli(f, 'customer', 'tier', 'C2', 'silver');
  cli(f, 'discount', 'add', 'TENOFF', 'percent', '10');
  const q2 = cli(f, 'quote', 'C2', 'TEE:2', '--code', 'TENOFF');
  checks.loyalty_after_coupon = ok(t) && ok(q2) && amount(q2.out, 'loyalty') === 180 && amount(q2.out, 'tax') === 248;
  const p = cli(f, 'order', 'place', 'C1', 'TEE:2');
  const o = ((readData(f).orders) || [])[0] || {};
  const tt = o.totals || {};
  checks.loyalty_stored_on_order = ok(p) && tt.loyalty === 400 &&
    tt.total === tt.subtotal - tt.discount - tt.loyalty + tt.tax + tt.shipping;
});

// ---- json ----------------------------------------------------------------
group(['json_lists', 'json_order_show', 'json_quote', 'json_flag_position', 'json_errors_nonzero'], () => {
  const f = newFile();
  seed(f, { products: [['MUG', 'Mug', '12.00', '10'], ['TEE', 'Tee', '20.00', '10']] });
  cli(f, 'discount', 'add', 'SAVE5', 'fixed', '5');
  cli(f, 'order', 'place', 'C1', 'MUG:2');
  cli(f, 'order', 'place', 'C1', 'TEE:1');
  cli(f, 'order', 'pay', 'O2');
  const pl = json(cli(f, 'product', 'list', '--json').stdout), cl = json(cli(f, 'customer', 'list', '--json').stdout);
  const dl = json(cli(f, 'discount', 'list', '--json').stdout), ol = json(cli(f, 'order', 'list', '--status', 'paid', '--json').stdout);
  checks.json_lists = Array.isArray(pl) && pl.length === 2 && pl.some(p => p.sku === 'MUG') &&
    Array.isArray(cl) && cl.length === 1 && cl[0].id === 'C1' && Array.isArray(dl) && dl.length === 1 && dl[0].code === 'SAVE5' &&
    Array.isArray(ol) && ol.length === 1 && ol[0].id === 'O2';
  const os1 = json(cli(f, 'order', 'show', 'O1', '--json').stdout);
  checks.json_order_show = !!os1 && os1.id === 'O1' && Array.isArray(os1.lines) && os1.lines[0].qty === 2 && Number.isInteger((os1.totals || {}).total);
  const q = json(cli(f, 'quote', 'C1', 'MUG:2', 'TEE:1', '--code', 'SAVE5', '--json').stdout);
  const tt = (q && q.totals) || {};
  const ints = ['subtotal', 'discount', 'tax', 'shipping', 'total'].every(k => Number.isInteger(tt[k]));
  checks.json_quote = !!q && q.customerId === 'C1' && Array.isArray(q.lines) && q.lines.length === 2 && ints &&
    tt.subtotal === 4400 && tt.discount === 500 && tt.total === tt.subtotal - tt.discount - (tt.loyalty || 0) + tt.tax + tt.shipping;
  const early = json(cli(f, 'order', 'show', '--json', 'O1').stdout), early2 = json(cli(f, 'product', '--json', 'list').stdout);
  checks.json_flag_position = !!early && early.id === 'O1' && Array.isArray(early2) && early2.length === 2;
  const bad = cli(f, 'order', 'show', 'O99', '--json');
  checks.json_errors_nonzero = checks.json_order_show && !ok(bad) && json(bad.stdout) === undefined;
});

// ---- report --------------------------------------------------------------
group(['report_sales_totals', 'report_sales_units', 'report_date_range', 'report_bad_date', 'report_low_stock'], () => {
  const f = newFile();
  seed(f, { products: [['MUG', 'Mug', '12.00', '50'], ['TEE', 'Tee', '20.00', '50'], ['RARE', 'Rare thing', '99.00', '3']] });
  cli(f, 'order', 'place', 'C1', 'MUG:3', 'TEE:1'); cli(f, 'order', 'pay', 'O1');
  cli(f, 'order', 'place', 'C1', 'MUG:2'); cli(f, 'order', 'pay', 'O2'); cli(f, 'order', 'ship', 'O2');
  cli(f, 'order', 'place', 'C1', 'TEE:5'); // stays pending: excluded
  cli(f, 'order', 'place', 'C1', 'TEE:4'); cli(f, 'order', 'cancel', 'O4'); // cancelled: excluded
  const orders = (readData(f).orders) || [];
  const revenue = orders.filter(o => o.id === 'O1' || o.id === 'O2').reduce((s, o) => s + ((o.totals || {}).total || 0), 0);
  const r = cli(f, 'report', 'sales');
  const ordersN = (r.out.match(/^\s*orders\b\D*(\d+)/im) || [])[1];
  checks.report_sales_totals = ok(r) && ordersN === '2' && revenue > 0 && amount(r.out, 'revenue') === revenue;
  const lines = r.out.split('\n');
  const mugLine = lines.find(l => /\bMUG\b/.test(l)) || '', teeLine = lines.find(l => /\bTEE\b/.test(l)) || '';
  checks.report_sales_units = /\b5\b/.test(mugLine) && /\b1\b/.test(teeLine) && !/\b(6|10)\b/.test(teeLine) &&
    lines.indexOf(mugLine) < lines.indexOf(teeLine);
  const future = cli(f, 'report', 'sales', '--from', '2099-01-01'), past = cli(f, 'report', 'sales', '--to', '2000-01-01');
  const all = cli(f, 'report', 'sales', '--from', '2000-01-01', '--to', '2099-12-31');
  const n = x => (x.out.match(/^\s*orders\b\D*(\d+)/im) || [])[1];
  checks.report_date_range = ok(future) && n(future) === '0' && ok(past) && n(past) === '0' && ok(all) && n(all) === '2';
  checks.report_bad_date = checks.report_sales_totals && !ok(cli(f, 'report', 'sales', '--from', '2099-13-01')) && !ok(cli(f, 'report', 'sales', '--to', 'yesterday'));
  const ls = cli(f, 'report', 'low-stock'), ls2 = cli(f, 'report', 'low-stock', '--threshold', '44');
  checks.report_low_stock = ok(ls) && /\bRARE\b/.test(ls.out) && !/\bMUG\b/.test(ls.out) && !/\bTEE\b/.test(ls.out) &&
    ok(ls2) && /\bTEE\b/.test(ls2.out) && /\bRARE\b/.test(ls2.out) && !/\bMUG\b/.test(ls2.out) &&
    ls2.out.indexOf('RARE') < ls2.out.indexOf('TEE');
});

// ---- tax-config ----------------------------------------------------------
group(['tax_set_override', 'tax_new_region', 'tax_list', 'tax_reject_bad', 'tax_unset'], () => {
  const f = newFile();
  seed(f);
  // $40 subtotal for a US-CA customer: default tax 2.90
  const s = cli(f, 'tax', 'set', 'US-CA', '10');
  const q = cli(f, 'quote', 'C1', 'WIDGET:2');
  checks.tax_set_override = ok(s) && ok(q) && amount(q.out, 'tax') === 400 && ((readData(f).taxRates) || {})['US-CA'] === 1000;
  const s2 = cli(f, 'tax', 'set', 'CA-ON', '13');
  cli(f, 'customer', 'add', 'Ont', 'ont@example.com', '--region', 'CA-ON');
  const q2 = cli(f, 'quote', 'C2', 'WIDGET:2');
  const p2 = cli(f, 'order', 'place', 'C2', 'WIDGET:2');
  const o = ((readData(f).orders) || [])[0] || {};
  checks.tax_new_region = ok(s2) && ok(q2) && amount(q2.out, 'tax') === 520 && ok(p2) && (o.totals || {}).tax === 520;
  const l = cli(f, 'tax', 'list');
  const line = re => l.out.split('\n').find(x => re.test(x)) || '';
  checks.tax_list = ok(l) && /\b13(\.0+)?\s*%/.test(line(/\bCA-ON\b/)) && /\b10(\.0+)?\s*%/.test(line(/\bUS-CA\b/)) && /\b19(\.0+)?\s*%/.test(line(/^\s*DE\b/));
  checks.tax_reject_bad = checks.tax_set_override && !ok(cli(f, 'tax', 'set', 'US-CA', '150')) && !ok(cli(f, 'tax', 'set', 'US-CA', 'abc')) &&
    !ok(cli(f, 'tax', 'set', 'not a region', '5'));
  const u = cli(f, 'tax', 'unset', 'US-CA');
  const q3 = cli(f, 'quote', 'C1', 'WIDGET:2');
  checks.tax_unset = ok(u) && amount(q3.out, 'tax') === 290;
});

// ---- shipping-weight -----------------------------------------------------
group(['ship_weight_set', 'ship_domestic_weight', 'ship_international_weight', 'ship_express', 'ship_free_threshold'], () => {
  const f = newFile();
  seed(f, { region: 'US-OR', products: [['BOOK', 'Book', '10.00', '100', '--weight', '1200'], ['PEN', 'Pen', '2.00', '100'], ['LAMP', 'Lamp', '60.00', '10', '--weight', '3000']] });
  cli(f, 'customer', 'add', 'Hans', 'hans@example.de', '--region', 'DE');
  const w = cli(f, 'product', 'weight', 'PEN', '600');
  const ps = (readData(f).products) || [];
  const by = sku => ps.find(p => p.sku === sku) || {};
  checks.ship_weight_set = ok(w) && by('BOOK').weightGrams === 1200 && by('PEN').weightGrams === 600 &&
    !ok(cli(f, 'product', 'add', 'NEG', 'Neg', '1', '--weight', '-5')) && !ok(cli(f, 'product', 'weight', 'PEN', '1.5'));
  const q1 = cli(f, 'quote', 'C1', 'BOOK:1'), q0 = cli(f, 'quote', 'C1', 'PEN:1');
  checks.ship_domestic_weight = ok(q1) && amount(q1.out, 'shipping') === 799 && ok(q0) && amount(q0.out, 'shipping') === 699;
  const qi = cli(f, 'quote', 'C2', 'BOOK:2');
  checks.ship_international_weight = ok(qi) && amount(qi.out, 'shipping') === 3499;
  const qe = cli(f, 'quote', 'C1', 'BOOK:1', '--express');
  const pe = cli(f, 'order', 'place', 'C1', 'BOOK:1', '--express');
  const o = ((readData(f).orders) || [])[0] || {};
  checks.ship_express = ok(qe) && amount(qe.out, 'shipping') === 1799 && ok(pe) && o.express === true && (o.totals || {}).shipping === 1799;
  const qf = cli(f, 'quote', 'C1', 'LAMP:1'), qfe = cli(f, 'quote', 'C1', 'LAMP:1', '--express');
  checks.ship_free_threshold = ok(qf) && amount(qf.out, 'shipping') === 0 && ok(qfe) && amount(qfe.out, 'shipping') === 1000;
});

// ---- docs + hygiene --------------------------------------------------------
const readme = readSrc('README.md');
checks.readme_updated = [/unitPriceCents/, /product tier/, /--expires/, /--max-uses/, /--tier/, /--json/, /report sales/, /low-stock/, /tax set/, /--weight/, /--express/]
  .filter(re => re.test(readme)).length >= 10;
const st = cp.spawnSync('git', ['status', '--porcelain'], { cwd: work, encoding: 'utf8' }).stdout || '';
checks.no_deleted_files = !/^\s*D /m.test(st);
note.git_status = st.trim().split('\n').filter(Boolean);

const perTask = {};
const TASK_OF = { rename: 'rename-price', tax: 'tax-config', ship: 'shipping-weight', readme: 'hygiene', no: 'hygiene' };
for (const [k, v] of Object.entries(checks)) {
  const task = TASK_OF[k.split('_')[0]] || k.split('_')[0];
  perTask[task] = perTask[task] || [0, 0];
  perTask[task][1]++; if (v) perTask[task][0]++;
}
note.per_task = Object.fromEntries(Object.entries(perTask).map(([k, [a, b]]) => [k, `${a}/${b}`]));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
const keys = Object.keys(checks); const passed = keys.filter(k => checks[k]).length;
console.log(JSON.stringify({ score: passed, max: keys.length, checks, note }, null, 2));
