// Money helpers. Every rupee amount in HomeNex is an integer number of paise, and the
// invariant that matters commercially is that a GST split adds back up exactly — an
// invoice whose subtotal + GST ≠ total is a compliance problem, not a rounding nit.
// The display helpers are the Indian lakh/crore forms brokers actually quote in.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GST_RATE,
  gstBreakdown,
  lakhsToPaise,
  paiseRangeToDisplay,
  paiseToDisplay,
  paiseToLakhs,
  paiseToRupees,
} from '../money.js'

const LAKH = 1e7 // paise in ₹1,00,000
const CRORE = 1e9 // paise in ₹1,00,00,000

// --- paiseToDisplay -----------------------------------------------------------

test('paiseToDisplay: crores, lakhs and plain rupees each get their own form', () => {
  assert.equal(paiseToDisplay(2 * CRORE), '₹ 2Cr')
  assert.equal(paiseToDisplay(1.2 * CRORE), '₹ 1.2Cr')
  assert.equal(paiseToDisplay(45 * LAKH), '₹ 45L')
  assert.equal(paiseToDisplay(1.5 * LAKH), '₹ 1.5L')
  assert.equal(paiseToDisplay(80_000 * 100), '₹ 80,000')
})

test('paiseToDisplay: trailing zeros are trimmed, not printed', () => {
  assert.equal(paiseToDisplay(1.0 * CRORE), '₹ 1Cr') // not "1.00Cr"
  assert.equal(paiseToDisplay(45.0 * LAKH), '₹ 45L') // not "45.0L"
  assert.equal(paiseToDisplay(1.2 * LAKH), '₹ 1.2L')
})

test('paiseToDisplay: the crore/lakh boundaries fall on the right side', () => {
  assert.equal(paiseToDisplay(CRORE), '₹ 1Cr')
  assert.equal(paiseToDisplay(CRORE - 1), '₹ 100L') // just under a crore is still lakhs
  assert.equal(paiseToDisplay(LAKH), '₹ 1L')
  // Just under a lakh stays in the plain-rupee form. The rupee figure is rounded to
  // the whole rupee, so ₹99,999.99 reads as ₹ 1,00,000 rather than gaining a paise
  // column — still the plain form, never "₹ 1L".
  assert.equal(paiseToDisplay(LAKH - 1), '₹ 1,00,000')
  assert.equal(paiseToDisplay(LAKH - 100), '₹ 99,999')
})

test('paiseToDisplay: negatives keep their sign', () => {
  assert.equal(paiseToDisplay(-45 * LAKH), '-₹ 45L')
  assert.equal(paiseToDisplay(-2 * CRORE), '-₹ 2Cr')
  assert.equal(paiseToDisplay(-50_000 * 100), '-₹ 50,000')
})

test('paiseToDisplay: zero shows as an amount, missing values as null', () => {
  assert.equal(paiseToDisplay(0), '₹ 0')
  assert.equal(paiseToDisplay(null), null)
  assert.equal(paiseToDisplay(undefined), null)
  assert.equal(paiseToDisplay('not a number'), null)
})

test('paiseToDisplay: numeric strings are accepted (Postgres BIGINT arrives as one)', () => {
  assert.equal(paiseToDisplay(String(45 * LAKH)), '₹ 45L')
})

// --- paiseRangeToDisplay ------------------------------------------------------

test('paiseRangeToDisplay: a real range renders both bounds', () => {
  assert.equal(paiseRangeToDisplay(45 * LAKH, 60 * LAKH), '₹ 45L – ₹ 60L')
})

test('paiseRangeToDisplay: one known bound renders alone, either side', () => {
  assert.equal(paiseRangeToDisplay(null, 60 * LAKH), '₹ 60L')
  assert.equal(paiseRangeToDisplay(45 * LAKH, null), '₹ 45L')
})

test('paiseRangeToDisplay: equal bounds collapse to a single figure', () => {
  assert.equal(paiseRangeToDisplay(60 * LAKH, 60 * LAKH), '₹ 60L')
})

test('paiseRangeToDisplay: no bounds at all is null, not a stray dash', () => {
  assert.equal(paiseRangeToDisplay(null, null), null)
})

// --- lakhsToPaise / paiseToLakhs ---------------------------------------------

test('lakhsToPaise: the UI edits in lakhs, storage is integer paise', () => {
  assert.equal(lakhsToPaise(45), 45 * LAKH)
  assert.equal(lakhsToPaise('45'), 45 * LAKH)
  assert.equal(lakhsToPaise(1.25), 1.25 * LAKH)
  assert.ok(Number.isInteger(lakhsToPaise(0.333)), 'must round to whole paise')
})

test('lakhsToPaise: an empty or unparseable field is null, never 0', () => {
  assert.equal(lakhsToPaise(null), null)
  assert.equal(lakhsToPaise(undefined), null)
  assert.equal(lakhsToPaise(''), null)
  assert.equal(lakhsToPaise('abc'), null)
})

test('paiseToLakhs: round-trips a lakh figure back for editing', () => {
  assert.equal(paiseToLakhs(45 * LAKH), 45)
  assert.equal(paiseToLakhs(lakhsToPaise(1.25)), 1.25)
  assert.equal(paiseToLakhs(null), null)
})

// --- GST ----------------------------------------------------------------------

test('gstBreakdown: defaults to the 18% Indian SaaS/brokerage rate', () => {
  assert.equal(GST_RATE, 18)
  const b = gstBreakdown(100_000) // ₹1,000.00
  assert.deepEqual(b, { subtotal_paise: 100_000, gst_rate: 18, gst_paise: 18_000, total_paise: 118_000 })
})

test('gstBreakdown: an explicit rate is honoured', () => {
  assert.deepEqual(gstBreakdown(100_000, 5), {
    subtotal_paise: 100_000, gst_rate: 5, gst_paise: 5_000, total_paise: 105_000,
  })
  assert.equal(gstBreakdown(100_000, 0).total_paise, 100_000)
})

test('gstBreakdown: subtotal + gst always equals total, in whole paise', () => {
  for (const subtotal of [0, 1, 7, 333, 99_999, 123_456_789, 5 * LAKH]) {
    const b = gstBreakdown(subtotal)
    assert.equal(b.subtotal_paise + b.gst_paise, b.total_paise, `mismatch at ${subtotal}`)
    assert.ok(Number.isInteger(b.gst_paise), `fractional paise at ${subtotal}`)
    assert.ok(Number.isInteger(b.total_paise), `fractional paise at ${subtotal}`)
  }
})

test('gstBreakdown: a fractional or missing subtotal is coerced, never NaN', () => {
  assert.equal(gstBreakdown(100.6).subtotal_paise, 101)
  assert.equal(gstBreakdown(null).total_paise, 0)
  assert.equal(gstBreakdown(undefined).total_paise, 0)
  assert.equal(gstBreakdown('abc').total_paise, 0)
})

// --- paiseToRupees ------------------------------------------------------------

test('paiseToRupees: invoice lines always carry two decimal places', () => {
  assert.equal(paiseToRupees(123_400), '₹1,234.00')
  assert.equal(paiseToRupees(123_456), '₹1,234.56')
  assert.equal(paiseToRupees(0), '₹0.00')
})

test('paiseToRupees: groups in the Indian lakh/crore digit pattern', () => {
  // en-IN groups as 12,34,567 — not 1,234,567.
  assert.equal(paiseToRupees(123_456_700), '₹12,34,567.00')
})

test('paiseToRupees: missing amounts are null, not "₹NaN"', () => {
  assert.equal(paiseToRupees(null), null)
  assert.equal(paiseToRupees(undefined), null)
  assert.equal(paiseToRupees('abc'), null)
})
