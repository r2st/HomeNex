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
