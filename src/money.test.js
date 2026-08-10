// The client twin of server/money.js. The UI edits budgets in lakhs while the API
// speaks integer paise, so a drift between the two copies would silently mis-price
// every lead card and property. These tests pin the client behaviour and then assert
// the shared helpers still agree with the server copy, which is the failure that
// would otherwise only show up as a wrong number on screen.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lakhsToPaise, paiseRangeToDisplay, paiseToDisplay, paiseToLakhs } from './money.js'
import * as server from '../server/money.js'

const LAKH = 1e7
const CRORE = 1e9

test('paiseToDisplay: quotes in the crore/lakh/rupee form brokers use', () => {
  assert.equal(paiseToDisplay(2 * CRORE), '₹ 2Cr')
  assert.equal(paiseToDisplay(1.2 * CRORE), '₹ 1.2Cr')
  assert.equal(paiseToDisplay(45 * LAKH), '₹ 45L')
  assert.equal(paiseToDisplay(80_000 * 100), '₹ 80,000')
  assert.equal(paiseToDisplay(0), '₹ 0')
})

test('paiseToDisplay: an unset price renders as nothing, not "₹ NaN"', () => {
  assert.equal(paiseToDisplay(null), null)
  assert.equal(paiseToDisplay(undefined), null)
  assert.equal(paiseToDisplay('abc'), null)
})

test('paiseRangeToDisplay: budget ranges, half-open ranges, and neither bound', () => {
  assert.equal(paiseRangeToDisplay(45 * LAKH, 60 * LAKH), '₹ 45L – ₹ 60L')
  assert.equal(paiseRangeToDisplay(null, 60 * LAKH), '₹ 60L')
  assert.equal(paiseRangeToDisplay(45 * LAKH, null), '₹ 45L')
  assert.equal(paiseRangeToDisplay(60 * LAKH, 60 * LAKH), '₹ 60L')
  assert.equal(paiseRangeToDisplay(null, null), null)
})

test('lakhsToPaise: a lakh field round-trips through the API as whole paise', () => {
  assert.equal(lakhsToPaise(45), 45 * LAKH)
  assert.equal(lakhsToPaise('45'), 45 * LAKH)
  assert.ok(Number.isInteger(lakhsToPaise(0.333)))
  assert.equal(paiseToLakhs(lakhsToPaise(1.25)), 1.25)
})

test('lakhsToPaise: an empty budget field stays empty rather than becoming ₹0', () => {
  assert.equal(lakhsToPaise(''), null)
  assert.equal(lakhsToPaise(null), null)
  assert.equal(lakhsToPaise('abc'), null)
})

// --- The two copies must not drift -------------------------------------------

test('the client copy matches server/money.js on every shared helper', () => {
  const samples = [null, undefined, 0, 1, 99_999, LAKH - 1, LAKH, 45 * LAKH, CRORE - 1, CRORE, 1.2 * CRORE, -45 * LAKH]
  for (const paise of samples) {
    assert.equal(paiseToDisplay(paise), server.paiseToDisplay(paise), `paiseToDisplay drifted at ${paise}`)
    assert.equal(paiseToLakhs(paise ?? null), server.paiseToLakhs(paise ?? null), `paiseToLakhs drifted at ${paise}`)
  }
  for (const lakhs of [null, '', 'abc', 0, 1.25, 45, '60']) {
    assert.equal(lakhsToPaise(lakhs), server.lakhsToPaise(lakhs), `lakhsToPaise drifted at ${lakhs}`)
  }
  for (const [lo, hi] of [[null, null], [45 * LAKH, 60 * LAKH], [null, 60 * LAKH], [45 * LAKH, null], [CRORE, CRORE]]) {
    assert.equal(paiseRangeToDisplay(lo, hi), server.paiseRangeToDisplay(lo, hi), `paiseRangeToDisplay drifted at ${lo}-${hi}`)
  }
})
