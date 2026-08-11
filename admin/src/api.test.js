// The admin portal's date formatters.
//
// These were written against SQLite, which stored zoneless "YYYY-MM-DD HH:MM:SS", and
// they appended a 'Z' to say "read that as UTC". Postgres sends something else, and the
// appended 'Z' turned every one of them into Invalid Date — the whole portal, silently:
// joined dates, WABA registration, last active, ticket timestamps, invoice periods.
// Nothing threw, so nothing pointed at it.
//
// The first two tests are that bug. The rest are the shapes the API actually sends.
import test from 'node:test'
import assert from 'node:assert/strict'
import { fmtDate, fmtDateTime, fmtAgo, fmtPaise } from './api.js'

// What pg + JSON.stringify produce for a TIMESTAMPTZ column: a JS Date, serialised.
const TIMESTAMPTZ = new Date(Date.UTC(2026, 6, 1, 10, 30, 0)).toISOString()
// What the DATE type parser in server/db.js deliberately leaves alone.
const DATE = '2026-07-01'

test('a TIMESTAMPTZ from the API renders as a date, not "Invalid Date"', () => {
  assert.match(TIMESTAMPTZ, /Z$/, 'precondition: the API already puts a zone on it')
  for (const [name, out] of [
    ['fmtDate', fmtDate(TIMESTAMPTZ)],
    ['fmtDateTime', fmtDateTime(TIMESTAMPTZ)],
    ['fmtAgo', fmtAgo(TIMESTAMPTZ)],
  ]) {
    assert.doesNotMatch(out, /Invalid Date|NaN/, `${name} produced "${out}"`)
  }
  assert.match(fmtDate(TIMESTAMPTZ), /2026/)
  assert.match(fmtDateTime(TIMESTAMPTZ), /2026/)
})

test('a DATE column renders as the day it says, in any timezone', () => {
  // period_start/period_end on a commission invoice are DATE. Putting them through a
  // timezone is what slides a payout date to the previous day west of Greenwich — the
  // reason the server refuses to parse them into Date objects in the first place.
  const out = fmtDate(DATE)
  assert.doesNotMatch(out, /Invalid Date/)
  assert.match(out, /1 Jul 2026/, `a date-only value must not shift a day (got "${out}")`)
})

test('a legacy zoneless timestamp is still read as UTC', () => {
  // Rows imported from the old SQLite file keep this shape. Dropping support for it
  // would break the one portal this code was originally written for.
  const out = fmtDateTime('2026-07-01 10:30:00')
  assert.doesNotMatch(out, /Invalid Date/)
  assert.equal(out, fmtDateTime(TIMESTAMPTZ), 'the two spellings mean the same instant')
})

test('a missing timestamp is an em dash, and so is an unparseable one', () => {
  for (const empty of [null, undefined, '']) {
    assert.equal(fmtDate(empty), '—')
    assert.equal(fmtDateTime(empty), '—')
    assert.equal(fmtAgo(empty), '—')
  }
  // The point of the fallback: whatever else goes wrong, the portal never prints the
  // words "Invalid Date" at an operator.
  for (const junk of ['not a date', '2026-13-45T99:99:99Z', {}, NaN, new Date('nope')]) {
    assert.equal(fmtDate(junk), '—', `fmtDate(${String(junk)})`)
    assert.equal(fmtDateTime(junk), '—', `fmtDateTime(${String(junk)})`)
    assert.equal(fmtAgo(junk), '—', `fmtAgo(${String(junk)})`)
  }
})

test('a Date object passes through, since not every caller stringifies', () => {
  assert.match(fmtDate(new Date(TIMESTAMPTZ)), /2026/)
})

test('fmtAgo counts down through the units', () => {
  const ago = (seconds) => fmtAgo(new Date(Date.now() - seconds * 1000).toISOString())
  assert.equal(ago(5), 'just now')
  assert.equal(ago(59), 'just now')
  assert.equal(ago(60), '1m ago')
  assert.equal(ago(3599), '59m ago')
  assert.equal(ago(3600), '1h ago')
  assert.equal(ago(86_399), '23h ago')
  assert.equal(ago(86_400), '1d ago')
  assert.equal(ago(9 * 86_400), '9d ago')
})

test('a timestamp slightly in the future reads as "just now", not a negative age', () => {
  // The admin's clock and the server's need not agree to the second, and a row created
  // moments ago can arrive stamped ahead of this browser.
  assert.equal(fmtAgo(new Date(Date.now() + 4000).toISOString()), 'just now')
})

test('fmtPaise renders whole rupees from the integer paise the API sends', () => {
  assert.equal(fmtPaise(123400), '₹1,234.00')
  assert.equal(fmtPaise(0), '₹0.00')
  assert.equal(fmtPaise(null), '—')
  assert.equal(fmtPaise(undefined), '—')
})
