import { test } from 'node:test'
import assert from 'node:assert/strict'
import { presetDate, FOLLOWUP_PRESETS } from './followupPresets.js'

// A fixed local-time reference so the assertions don't depend on when they run.
const from = new Date(2026, 7, 10, 15, 42, 37, 500) // Mon 10 Aug 2026, 15:42:37.5

test('tomorrow lands at 10am the next day', () => {
  const d = presetDate('tomorrow', from)
  assert.equal(d.getDate(), 11)
  assert.equal(d.getMonth(), 7)
  assert.equal(d.getFullYear(), 2026)
  assert.equal(d.getHours(), 10)
  assert.equal(d.getMinutes(), 0)
})

test('3 days and next week land at 10am on the right day', () => {
  const three = presetDate('3days', from)
  assert.equal(three.getDate(), 13)
  assert.equal(three.getHours(), 10)

  const week = presetDate('nextweek', from)
  assert.equal(week.getDate(), 17)
  assert.equal(week.getHours(), 10)
})

test('presets zero out seconds and milliseconds', () => {
  for (const { kind } of FOLLOWUP_PRESETS) {
    const d = presetDate(kind, from)
    assert.equal(d.getSeconds(), 0, `${kind} seconds`)
    assert.equal(d.getMilliseconds(), 0, `${kind} ms`)
  }
})

test('every declared preset produces a future date', () => {
  for (const { kind, label } of FOLLOWUP_PRESETS) {
    assert.ok(presetDate(kind, from).getTime() > from.getTime(), `${label} is in the future`)
  }
})

test('presets roll over month and year boundaries', () => {
  const endOfMonth = new Date(2026, 7, 31, 9, 0, 0)
  const next = presetDate('tomorrow', endOfMonth)
  assert.equal(next.getMonth(), 8, 'September')
  assert.equal(next.getDate(), 1)

  const endOfYear = new Date(2026, 11, 29, 9, 0, 0)
  const week = presetDate('nextweek', endOfYear)
  assert.equal(week.getFullYear(), 2027)
  assert.equal(week.getMonth(), 0)
  assert.equal(week.getDate(), 5)
})

test('a preset chosen late at night still lands at 10am, not the next dawn', () => {
  const nearMidnight = new Date(2026, 7, 10, 23, 55, 0)
  const d = presetDate('tomorrow', nearMidnight)
  assert.equal(d.getDate(), 11)
  assert.equal(d.getHours(), 10)
})

test('custom and unknown kinds start from now without inventing 10am', () => {
  for (const kind of ['custom', 'nonsense', '', null, undefined]) {
    const d = presetDate(kind, from)
    assert.equal(d.getDate(), 10, `${kind} keeps today`)
    assert.equal(d.getHours(), 15, `${kind} keeps the current hour`)
    assert.equal(d.getSeconds(), 0)
  }
})

test('presetDate does not mutate the date it was given', () => {
  const original = new Date(2026, 7, 10, 15, 42, 37, 500)
  const snapshot = original.getTime()
  presetDate('nextweek', original)
  assert.equal(original.getTime(), snapshot)
})

test('every preset has a kind and a human label', () => {
  for (const p of FOLLOWUP_PRESETS) {
    assert.ok(p.kind, 'kind present')
    assert.ok(p.label && p.label.trim().length > 0, 'label present')
  }
  const kinds = FOLLOWUP_PRESETS.map((p) => p.kind)
  assert.equal(new Set(kinds).size, kinds.length, 'kinds are unique')
})
