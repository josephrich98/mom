# shop

A small, dependency-free order-processing library and CLI: a product catalog with
stock, customers, discount codes, quoting (subtotal, discount, tax, shipping) and an
order lifecycle. All data lives in one JSON file.

Requires Node.js 18+. No dependencies.

## CLI

```
node src/cli.js <command> [args] [--data <file>]
```

The data file defaults to `./shop.json` (or `$SHOP_DATA`); pass `--data <file>` to use
another one. Every command loads the file, runs, and saves it if anything changed.
Errors are printed to stderr as `error: <message>` with exit code 1.

Amounts are typed as dollars (`12`, `12.50`, `$1,299.00`) and stored as integer cents.

### Products

```
node src/cli.js product add <sku> <name> <price> [--stock <n>] [--category <c>]
node src/cli.js product list [--category <c>]
node src/cli.js product restock <sku> <qty>
node src/cli.js product price <sku> <price>
```

SKUs are upper-cased (`mug` becomes `MUG`); 2-20 characters of A-Z, 0-9 and `-`.
Stock defaults to 0 and category to `general`.

### Customers

```
node src/cli.js customer add <name> <email> [--region <code>]
node src/cli.js customer list
```

Customer ids are assigned sequentially: `C1`, `C2`, ... The region (default `US-CA`)
drives tax and shipping. Ids can be typed as `C1`, `c1` or just `1`.

### Discount codes

```
node src/cli.js discount add <code> percent <whole-percent> [--min <amount>]
node src/cli.js discount add <code> fixed <amount> [--min <amount>]
node src/cli.js discount list
```

`--min` is the minimum subtotal for the code to apply; using a code below its minimum
is an error. Fixed discounts never exceed the subtotal.

### Quotes and orders

```
node src/cli.js quote <customerId> <SKU:QTY>... [--code <code>]
node src/cli.js order place <customerId> <SKU:QTY>... [--code <code>]
node src/cli.js order list [--status <status>] [--customer <id>]
node src/cli.js order show <orderId>
node src/cli.js order pay <orderId>
node src/cli.js order ship <orderId>
node src/cli.js order cancel <orderId>
```

`QTY` defaults to 1 (`MUG` is `MUG:1`). Order ids are `O1`, `O2`, ...

`quote` and `order show` print one `Label: $amount` line per component:

```
Subtotal: $24.00
Discount: -$2.40
Tax:      $1.57
Shipping: $5.99
Total:    $29.16
```

(`Discount` is omitted when there is none.) `order place` reserves stock and fails if
any line is short; `order cancel` returns the units to stock.

Order lifecycle: `pending -> paid -> shipped`, and `pending | paid -> cancelled`.

## Pricing rules

All arithmetic is in integer cents; percentages round half up to the cent.

1. **subtotal** = sum of `unit price x qty` over all lines
2. **discount** = the discount code applied to the subtotal
3. **merchandise** = subtotal - discount
4. **tax** = merchandise x the region's rate (see below; unlisted regions are untaxed)
5. **shipping** = domestic (`US-*`): $5.99, free when merchandise >= $50.00;
   international: $19.99
6. **total** = merchandise + tax + shipping

| region | rate  |
|--------|-------|
| US-CA  | 7.25% |
| US-NY  | 4%    |
| US-TX  | 6.25% |
| US-WA  | 6.5%  |
| US-OR  | 0%    |
| DE     | 19%   |
| FR     | 20%   |
| GB     | 20%   |

## Data model

The data file is `{ version, products, customers, discounts, orders }`.

- product: `{ sku, name, priceCents, stock, category, createdAt }`
- customer: `{ id, name, email, region, createdAt }`
- discount: `{ code, type: "percent" | "fixed", value, minSubtotal, createdAt }`
- order: `{ id, customerId, status, code, createdAt, lines: [{ sku, name, qty, priceCents }],
  totals: { subtotal, discount, tax, shipping, total }, history: [{ status, at }] }`

## Library

`require('./src')` exposes every module: `Store`, `money`, `catalog`, `inventory`,
`pricing` (`calcTotals`, `quote`), `orders`, and so on.

## Layout

```
src/
  cli.js              argument parsing and command dispatch
  store.js            JSON-file persistence
  index.js            library entry point
  models/             product, customer, order (validation + shape)
  services/           catalog, customers, inventory, discount, tax, shipping, pricing, orders
  util/               money, validate, format, ids
test/                 node:test suites (npm test)
```

## Development

```
npm test
```
