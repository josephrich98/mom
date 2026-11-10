'use strict';
/** Library entry point: everything the CLI uses, for programmatic callers. */
module.exports = {
  Store: require('./store').Store,
  money: require('./util/money'),
  validate: require('./util/validate'),
  ids: require('./util/ids'),
  format: require('./util/format'),
  product: require('./models/product'),
  customer: require('./models/customer'),
  order: require('./models/order'),
  catalog: require('./services/catalog'),
  customers: require('./services/customers'),
  inventory: require('./services/inventory'),
  tax: require('./services/tax'),
  shipping: require('./services/shipping'),
  discount: require('./services/discount'),
  pricing: require('./services/pricing'),
  orders: require('./services/orders'),
};
