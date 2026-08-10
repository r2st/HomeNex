import { test } from 'node:test'
import assert from 'node:assert/strict'
import { actionableFollowupCount, badgeText } from './followups.js'

const now = new Date('2026-07-13T15:00:00')

test('counts overdue and due-today, skips completed and future', () => {
  const followups = [
    { id: 1, overdue: true, due_at: '2026-07-10T10:00:00' },
    { id: 2, due_at: '2026-07-13T18:00:00' }, // later today
    { id: 3, due_at: '2026-07-20T10:00:00' }, // future
    { id: 4, overdue: true, completed_at: '2026-07-12T10:00:00' }, // done
  ]
  assert.equal(actionableFollowupCount(followups, now), 2)
})

test('past due_at without overdue flag still counts', () => {
  assert.equal(actionableFollowupCount([{ due_at: '2026-07-01T10:00:00' }], now), 1)
})

test('empty / bad input', () => {
  assert.equal(actionableFollowupCount([], now), 0)
  assert.equal(actionableFollowupCount(), 0)
  assert.equal(actionableFollowupCount([{ due_at: 'not-a-date' }], now), 0)
})

test('badgeText caps and hides zero', () => {
  assert.equal(badgeText(0), null)
  assert.equal(badgeText(3), '3')
  assert.equal(badgeText(12), '9+')
  assert.equal(badgeText(12, 20), '12')
})

test('a completed follow-up never counts, even when flagged overdue', () => {
  assert.equal(
    actionableFollowupCount([{ overdue: true, completed_at: '2026-08-01T00:00:00Z', due_at: '2026-07-01T00:00:00Z' }]),
    0,
  )
})

test('null entries and undated follow-ups are ignored, not counted or crashed on', () => {
  assert.equal(actionableFollowupCount([null, undefined, {}, { due_at: null }]), 0)
  assert.equal(actionableFollowupCount([{ due_at: 'tomorrow-ish' }]), 0, 'an unparseable date is not actionable')
  assert.equal(actionableFollowupCount(), 0)
  assert.equal(actionableFollowupCount([]), 0)
})

test('a follow-up due later today counts; one due tomorrow does not', () => {
  const now = new Date('2026-08-10T11:00:00')
  const laterToday = new Date('2026-08-10T19:00:00').toISOString()
  const tomorrow = new Date('2026-08-11T09:00:00').toISOString()
  assert.equal(actionableFollowupCount([{ due_at: laterToday }], now), 1)
  assert.equal(actionableFollowupCount([{ due_at: tomorrow }], now), 0)
})

test('badgeText caps, hides zero, and tolerates junk counts', () => {
  assert.equal(badgeText(0), null)
  assert.equal(badgeText(-3), null)
  assert.equal(badgeText(null), null)
  assert.equal(badgeText('nonsense'), null)
  assert.equal(badgeText(1), '1')
  assert.equal(badgeText(9), '9')
  assert.equal(badgeText(10), '9+')
  assert.equal(badgeText(120, 99), '99+')
})
