// Random rather than sequential — a sequential order number lets anyone
// increment through other customers' orders (name, phone, address, items are
// all in the public order-lookup response). 900,000 possible values, picked
// uniformly; createOrderRecord retries on a collision the rare time one hits.
function generateOrderNumber() {
  return Math.floor(100000 + Math.random() * 900000);
}

module.exports = { generateOrderNumber };
