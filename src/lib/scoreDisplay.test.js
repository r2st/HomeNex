import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldShowScoreBreakdown, SCORE_BREAKDOWN_MIN } from './scoreDisplay.js'

const breakdown = [{ label: 'Budget', value: 0 }, { label: 'Intent', value: 10 }]

test('hidden when score below threshold', () => {
  assert.equal(shouldShowScoreBreakdown(10, breakdown), false)
  assert.equal(shouldShowScoreBreakdown(0, breakdown), false)
})

test('shown at or above threshold', () => {
  assert.equal(shouldShowScoreBreakdown(SCORE_BREAKDOWN_MIN, breakdown), true)
  assert.equal(shouldShowScoreBreakdown(80, breakdown), true)
})

test('hidden when breakdown is empty regardless of score', () => {
  assert.equal(shouldShowScoreBreakdown(90, []), false)
  assert.equal(shouldShowScoreBreakdown(90, null), false)
})

test('tolerates nullish score', () => {
  assert.equal(shouldShowScoreBreakdown(null, breakdown), false)
  assert.equal(shouldShowScoreBreakdown(undefined, breakdown), false)
})
