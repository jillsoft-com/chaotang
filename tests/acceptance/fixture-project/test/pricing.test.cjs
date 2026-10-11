const test = require('node:test')
const assert = require('node:assert/strict')
const { priceAfterDiscount } = require('../src/pricing.cjs')

test('discount reduces the price', () => {
  assert.equal(priceAfterDiscount(100, 0.1), 90)
})

test('zero discount leaves the price unchanged', () => {
  assert.equal(priceAfterDiscount(25.5, 0), 25.5)
})

test('full discount produces zero', () => {
  assert.equal(priceAfterDiscount(9.99, 1), 0)
})

test('invalid rate is rejected', () => {
  assert.throws(() => priceAfterDiscount(100, 1.2), RangeError)
})
