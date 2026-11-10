#!/usr/bin/env node
'use strict';
const path = require('path');
const { Store } = require('./store');
const { toCents, formatMoney } = require('./util/money');
const catalog = require('./services/catalog');
const customers = require('./services/customers');
const inventory = require('./services/inventory');
const discounts = require('./services/discount');
const pricing = require('./services/pricing');
const orders = require('./services/orders');
const fmt = require('./util/format');

const USAGE = `usage: shop <command> [args] [--data <file>]

Products
  product add <sku> <name> <price> [--stock <n>] [--category <c>]
  product list [--category <c>]
  product restock <sku> <qty>
  product price <sku> <price>
Customers
  customer add <name> <email> [--region <code>]
  customer list
Discount codes
  discount add <code> <percent|fixed> <value> [--min <amount>]
  discount list
Orders
  quote <customerId> <SKU:QTY>... [--code <code>]
  order place <customerId> <SKU:QTY>... [--code <code>]
  order list [--status <status>] [--customer <id>]
  order show <orderId>
  order pay|ship|cancel <orderId>

Options
  --data <file>   data file (default: ./shop.json or $SHOP_DATA)`;

/** Minimal argv parser: `--key value` pairs, bare `--flag` => true, everything else positional. */
function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      opts[key] = next !== undefined && !next.startsWith('--') ? argv[++i] : true;
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

function dataFile(opts) {
  return path.resolve(opts.data || process.env.SHOP_DATA || path.join(process.cwd(), 'shop.json'));
}

function need(value, what) {
  if (value === undefined || value === '') throw new Error(`missing ${what}\n\n${USAGE}`);
  return value;
}

function productCmd(store, sub, args, opts) {
  switch (sub) {
    case 'add': {
      const [sku, name, price] = args;
      const p = catalog.addProduct(store, {
        sku: need(sku, 'sku'),
        name: need(name, 'name'),
        priceCents: toCents(need(price, 'price')),
        stock: opts.stock === undefined ? 0 : opts.stock,
        category: typeof opts.category === 'string' ? opts.category : undefined,
      });
      return `added product ${p.sku} ${p.name} ${formatMoney(p.priceCents)} (stock ${p.stock})`;
    }
    case 'list':
      return fmt.formatProducts(catalog.listProducts(store, { category: opts.category }));
    case 'restock': {
      const p = inventory.restock(store, need(args[0], 'sku'), need(args[1], 'quantity'));
      return `restocked ${p.sku}: stock ${p.stock}`;
    }
    case 'price': {
      const p = catalog.setPrice(store, need(args[0], 'sku'), toCents(need(args[1], 'price')));
      return `price of ${p.sku} is now ${formatMoney(p.priceCents)}`;
    }
    default:
      throw new Error(`unknown product command: ${sub}\n\n${USAGE}`);
  }
}

function customerCmd(store, sub, args, opts) {
  switch (sub) {
    case 'add': {
      const c = customers.addCustomer(store, {
        name: need(args[0], 'name'),
        email: need(args[1], 'email'),
        region: typeof opts.region === 'string' ? opts.region : undefined,
      });
      return `added customer ${c.id} ${c.name} <${c.email}> ${c.region}`;
    }
    case 'list':
      return fmt.formatCustomers(customers.listCustomers(store));
    default:
      throw new Error(`unknown customer command: ${sub}\n\n${USAGE}`);
  }
}

function discountCmd(store, sub, args, opts) {
  switch (sub) {
    case 'add': {
      const d = discounts.addDiscount(store, {
        code: need(args[0], 'code'),
        type: need(args[1], 'type'),
        value: need(args[2], 'value'),
        minSubtotal: opts.min === undefined ? 0 : opts.min,
      });
      return `added discount ${d.code}: ${discounts.describeDiscount(d)}`;
    }
    case 'list':
      return fmt.table(store.discounts, [
        { key: 'code', label: 'CODE' },
        { label: 'DISCOUNT', get: d => discounts.describeDiscount(d) },
      ]);
    default:
      throw new Error(`unknown discount command: ${sub}\n\n${USAGE}`);
  }
}

function quoteCmd(store, args, opts) {
  const [customerId, ...items] = args;
  const q = pricing.quote(store, { customerId: need(customerId, 'customer id'), items, code: opts.code || null });
  return `Quote for ${q.customer.id} (${q.customer.region})\n\n${fmt.formatLines(q.lines)}\n\n${fmt.formatTotals(q.totals)}`;
}

function orderCmd(store, sub, args, opts) {
  switch (sub) {
    case 'place': {
      const [customerId, ...items] = args;
      const o = orders.placeOrder(store, { customerId: need(customerId, 'customer id'), items, code: opts.code || null });
      return `placed order ${o.id} for ${o.customerId}: total ${formatMoney(o.totals.total)}`;
    }
    case 'list':
      return fmt.formatOrders(orders.listOrders(store, { status: opts.status, customerId: opts.customer }));
    case 'show':
      return fmt.formatOrder(orders.getOrder(store, need(args[0], 'order id')));
    case 'pay':
      return `order ${orders.payOrder(store, need(args[0], 'order id')).id} is now paid`;
    case 'ship':
      return `order ${orders.shipOrder(store, need(args[0], 'order id')).id} is now shipped`;
    case 'cancel':
      return `order ${orders.cancelOrder(store, need(args[0], 'order id')).id} is now cancelled`;
    default:
      throw new Error(`unknown order command: ${sub}\n\n${USAGE}`);
  }
}

/** Run one CLI invocation and return its stdout text. Throws on any error. */
function main(argv) {
  const opts = parseArgs(argv);
  const [cmd, sub, ...rest] = opts._;
  if (!cmd || cmd === 'help' || opts.help) return USAGE;
  const store = new Store(dataFile(opts));
  switch (cmd) {
    case 'product': return productCmd(store, sub, rest, opts);
    case 'customer': return customerCmd(store, sub, rest, opts);
    case 'discount': return discountCmd(store, sub, rest, opts);
    case 'quote': return quoteCmd(store, [sub, ...rest].filter(x => x !== undefined), opts);
    case 'order': return orderCmd(store, sub, rest, opts);
    default: throw new Error(`unknown command: ${cmd}\n\n${USAGE}`);
  }
}

if (require.main === module) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { main, parseArgs, USAGE };
