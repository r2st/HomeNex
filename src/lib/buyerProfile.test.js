import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buyerProfileIsEmpty } from './buyerProfile.js'

test('empty lead -> profile empty', () => {
  assert.equal(buyerProfileIsEmpty({}), true)
  assert.equal(buyerProfileIsEmpty(), true)
})

test('empty-string / empty-array fields still count as empty', () => {
  assert.equal(
    buyerProfileIsEmpty({ bhk: '', property_type: '', preferred_localities: [], timeline: '' }),
    true,
  )
})

test('any populated field -> not empty', () => {
  assert.equal(buyerProfileIsEmpty({ bhk: '3' }), false)
  assert.equal(buyerProfileIsEmpty({ budget_max: 5000000 }), false)
  assert.equal(buyerProfileIsEmpty({ preferred_localities: ['Baner'] }), false)
})

test('zero is a real value, not empty', () => {
  assert.equal(buyerProfileIsEmpty({ budget_min: 0 }), false)
})
