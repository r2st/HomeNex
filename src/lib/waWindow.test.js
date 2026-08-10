import { test } from 'node:test'
import assert from 'node:assert/strict'
import { windowState, fmtCountdown, WINDOW_MS } from './waWindow.js'

const HOUR = 3600_000
// Postgres-style timestamp string, which is what the API actually returns.
const pgTs = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '')

test('a lead with no inbound anchor is treated as open but unknown', () => {
  assert.deepEqual(windowState({}, Date.now()), { known: false, open: true, msLeft: null })
  assert.deepEqual(windowState({ last_inbound_at: null }, Date.now()), { known: false, open: true, msLeft: null })
  assert.deepEqual(windowState(null, Date.now()), { known: false, open: true, msLeft: null })
  assert.deepEqual(windowState(undefined, Date.now()), { known: false, open: true, msLeft: null })
})

test('a garbled timestamp falls back to open/unknown rather than NaN', () => {
  const s = windowState({ last_inbound_at: 'not a date' }, Date.now())
  assert.deepEqual(s, { known: false, open: true, msLeft: null })
})

test('the window is open for 24 hours after the last inbound message', () => {
  const now = Date.UTC(2026, 7, 10, 12, 0, 0)
  const oneHourAgo = windowState({ last_inbound_at: pgTs(now - HOUR) }, now)
  assert.equal(oneHourAgo.known, true)
  assert.equal(oneHourAgo.open, true)
  assert.equal(oneHourAgo.msLeft, 23 * HOUR)
})

test('the window shuts exactly 24 hours after the anchor, not a moment before', () => {
  const now = Date.UTC(2026, 7, 10, 12, 0, 0)
  const anchor = now - WINDOW_MS

  // One second short of 24h: still open.
  assert.equal(windowState({ last_inbound_at: pgTs(anchor + 1000) }, now).open, true)
  // Exactly 24h: closed (expires > now is false when they are equal).
  assert.equal(windowState({ last_inbound_at: pgTs(anchor) }, now).open, false)
  // Past 24h: closed, with a negative msLeft the badge never renders.
  const stale = windowState({ last_inbound_at: pgTs(anchor - HOUR) }, now)
  assert.equal(stale.open, false)
  assert.ok(stale.msLeft < 0)
})

test('a Date object anchor works as well as a string', () => {
  const now = Date.UTC(2026, 7, 10, 12, 0, 0)
  const s = windowState({ last_inbound_at: new Date(now - 2 * HOUR) }, now)
  assert.equal(s.open, true)
  assert.equal(s.msLeft, 22 * HOUR)
})

test('an ISO timestamp with a Z is not double-shifted', () => {
  const now = Date.UTC(2026, 7, 10, 12, 0, 0)
  const iso = new Date(now - HOUR).toISOString()
  assert.equal(windowState({ last_inbound_at: iso }, now).msLeft, 23 * HOUR)
})

test('fmtCountdown shows hours and minutes above an hour', () => {
  assert.equal(fmtCountdown(23 * HOUR), '23h 0m')
  assert.equal(fmtCountdown(2 * HOUR + 30 * 60_000), '2h 30m')
  assert.equal(fmtCountdown(HOUR), '1h 0m')
})

test('fmtCountdown drops to minutes under an hour', () => {
  assert.equal(fmtCountdown(59 * 60_000), '59m')
  assert.equal(fmtCountdown(90_000), '1m')
})

test('fmtCountdown never shows 0m while the window is still open', () => {
  // The final seconds round up — an open window must never read as expired.
  assert.equal(fmtCountdown(59_000), '1m')
  assert.equal(fmtCountdown(1), '1m')
})

test('fmtCountdown degrades safely on expired or nonsense input', () => {
  assert.equal(fmtCountdown(0), '0m')
  assert.equal(fmtCountdown(-5000), '0m')
  assert.equal(fmtCountdown(NaN), '0m')
  assert.equal(fmtCountdown(null), '0m')
  assert.equal(fmtCountdown(Infinity), '0m')
})

test('an open window always produces a renderable countdown', () => {
  const now = Date.UTC(2026, 7, 10, 12, 0, 0)
  for (const minsAgo of [0, 1, 60, 600, 1200, 1439]) {
    const s = windowState({ last_inbound_at: pgTs(now - minsAgo * 60_000) }, now)
    assert.equal(s.open, true, `${minsAgo}m ago should be open`)
    assert.doesNotMatch(fmtCountdown(s.msLeft), /NaN|undefined/, `${minsAgo}m ago renders cleanly`)
  }
})
