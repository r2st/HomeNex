// Pure unit tests for the WhatsApp quality-rating send limiter (no DB).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  warmupDailyCap,
  withinSendWindow,
  inQuietRange,
  hourInTimezone,
  evaluateSend,
  PER_CONTACT_MIN_GAP_H,
  PER_CONTACT_MONTHLY_CAP,
} from '../sendLimiter.js'

const DAY = 86_400_000

test('warmupDailyCap ramps over three weeks', () => {
  const now = Date.now()
  assert.equal(warmupDailyCap(null, now), 50) // never started -> week 1
  assert.equal(warmupDailyCap(new Date(now - 2 * DAY).toISOString(), now), 50)
  assert.equal(warmupDailyCap(new Date(now - 10 * DAY).toISOString(), now), 150)
  assert.equal(warmupDailyCap(new Date(now - 17 * DAY).toISOString(), now), 500)
  assert.equal(warmupDailyCap(new Date(now - 30 * DAY).toISOString(), now), 1000)
})

test('inQuietRange handles ranges that wrap past midnight', () => {
  assert.equal(inQuietRange(23, 21, 8), true)
  assert.equal(inQuietRange(3, 21, 8), true)
  assert.equal(inQuietRange(12, 21, 8), false)
  assert.equal(inQuietRange(10, 9, 17), true) // same-day range
  assert.equal(inQuietRange(5, null, null), false) // no quiet hours configured
})

test('hourInTimezone returns null on a bad timezone (fail-open signal)', () => {
  assert.equal(hourInTimezone(Date.now(), 'Not/AZone'), null)
  assert.ok(hourInTimezone(Date.now(), 'Asia/Kolkata') !== null)
})

test('withinSendWindow blocks the hard night guard 00:00-06:00', () => {
  // 03:00 IST == 21:30 UTC previous day.
  const threeAmIST = Date.UTC(2026, 0, 10, 21, 30)
  assert.equal(withinSendWindow(threeAmIST, 'Asia/Kolkata'), false)
  // 14:00 IST == 08:30 UTC.
  const twoPmIST = Date.UTC(2026, 0, 10, 8, 30)
  assert.equal(withinSendWindow(twoPmIST, 'Asia/Kolkata'), true)
})

test('withinSendWindow fails open on an unparseable timezone', () => {
  assert.equal(withinSendWindow(Date.now(), 'Nonsense/Zone'), true)
})

test('withinSendWindow respects configured quiet hours', () => {
  const ninePmIST = Date.UTC(2026, 0, 10, 15, 30) // 21:00 IST
  assert.equal(withinSendWindow(ninePmIST, 'Asia/Kolkata', { quietStart: 21, quietEnd: 8 }), false)
  assert.equal(withinSendWindow(ninePmIST, 'Asia/Kolkata', { quietStart: 22, quietEnd: 8 }), true)
})

test('evaluateSend blocks opted-out contacts first', () => {
  assert.deepEqual(evaluateSend({ optInStatus: 'opted_out' }), { canSend: false, reason: 'opted_out' })
})

test('evaluateSend enforces the daily cap', () => {
  const r = evaluateSend({ sendsToday: 50, dailyCap: 50, enforceWindow: false })
  assert.deepEqual(r, { canSend: false, reason: 'daily_cap_reached' })
})

test('evaluateSend enforces the per-contact minimum gap', () => {
  const now = Date.now()
  const recent = new Date(now - (PER_CONTACT_MIN_GAP_H - 1) * 3600_000).toISOString()
  assert.equal(evaluateSend({ lastSentToContactAt: recent, now, enforceWindow: false }).reason, 'too_soon_since_last')
  const old = new Date(now - (PER_CONTACT_MIN_GAP_H + 1) * 3600_000).toISOString()
  assert.equal(evaluateSend({ lastSentToContactAt: old, now, enforceWindow: false }).canSend, true)
})

test('evaluateSend enforces the per-contact monthly cap', () => {
  assert.equal(
    evaluateSend({ contactSendsThisMonth: PER_CONTACT_MONTHLY_CAP, enforceWindow: false }).reason,
    'contact_monthly_cap',
  )
})

test('evaluateSend passes a clean send', () => {
  assert.deepEqual(evaluateSend({ enforceWindow: false }), { canSend: true, reason: 'ok' })
})

test('evaluateSend can skip the window check for agent-initiated sends', () => {
  const threeAmIST = Date.UTC(2026, 0, 10, 21, 30)
  assert.equal(evaluateSend({ now: threeAmIST, tz: 'Asia/Kolkata', enforceWindow: true }).reason, 'outside_send_window')
  assert.equal(evaluateSend({ now: threeAmIST, tz: 'Asia/Kolkata', enforceWindow: false }).canSend, true)
})
