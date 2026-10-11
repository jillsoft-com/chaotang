function priceAfterDiscount(price, discountRate) {
  if (!Number.isFinite(price) || price < 0) throw new RangeError('price must be non-negative')
  if (!Number.isFinite(discountRate) || discountRate < 0 || discountRate > 1) {
    throw new RangeError('discountRate must be between 0 and 1')
  }
  return Math.round(price * (1 + discountRate) * 100) / 100
}

module.exports = { priceAfterDiscount }
