const test = require('node:test');
const assert = require('node:assert');
const { newOrder, apply } = require('../src/orderMachine');

const menu = [
  { id: 1, name: 'Jollof Rice', aliases: ['jollof'], priceKobo: 250000, available: true },
  { id: 2, name: 'Chicken', priceKobo: 150000, available: true },
  { id: 3, name: 'Suya', priceKobo: 100000, available: false },
];
const run = (o, ...acts) => acts.reduce((acc, a) => {
  const r = apply(acc, a, menu);
  assert.ok(r.ok, r.error);
  return r.order;
}, o);

test('add and "make that two"', () => {
  const o = run(newOrder(), { type: 'add_item', item: 'jollof' }, { type: 'set_quantity', item: 'Jollof Rice', quantity: 2 });
  assert.equal(o.items[0].qty, 2);
  assert.equal(o.totalKobo, 500000);
});

test('rejects unknown, unavailable, bad qty', () => {
  assert.equal(apply(newOrder(), { type: 'add_item', item: 'pizza' }, menu).ok, false);
  assert.equal(apply(newOrder(), { type: 'add_item', item: 'Suya' }, menu).ok, false);
  assert.equal(apply(newOrder(), { type: 'add_item', item: 'Chicken', quantity: -1 }, menu).ok, false);
  assert.equal(apply(newOrder(), { type: 'add_item', item: 'Chicken', quantity: 1.5 }, menu).ok, false);
});

test('change after confirm requires re-confirm', () => {
  let o = run(newOrder(), { type: 'add_item', item: 'Chicken' }, { type: 'confirm_order' });
  assert.equal(o.status, 'confirmed');
  o = run(o, { type: 'add_item', item: 'Chicken' });
  assert.equal(o.status, 'building');
  assert.equal(apply(o, { type: 'start_payment', reference: 'x' }, menu).ok, false);
});

test('payment must match ref and amount', () => {
  const o = run(newOrder(), { type: 'add_item', item: 'Chicken' }, { type: 'confirm_order' }, { type: 'start_payment', reference: 'r1' });
  assert.equal(apply(o, { type: 'payment_success', reference: 'r1', amountKobo: 1 }, menu).ok, false);
  assert.equal(apply(o, { type: 'payment_success', reference: 'r2', amountKobo: 150000 }, menu).ok, false);
  assert.equal(apply(o, { type: 'add_item', item: 'Chicken' }, menu).ok, false);
  const paid = run(o, { type: 'payment_success', reference: 'r1', amountKobo: 150000 });
  assert.equal(paid.status, 'paid');
  assert.equal(apply(paid, { type: 'cancel_order' }, menu).ok, false);
});

test('empty order cannot confirm', () => {
  assert.equal(apply(newOrder(), { type: 'confirm_order' }, menu).ok, false);
});
