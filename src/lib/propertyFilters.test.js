import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activeFilterCount, clearedFilters } from './propertyFilters.js'

test('counts only set filters, ignores search text', () => {
  assert.equal(activeFilterCount({ type: 'villa', band: '', bhk: '3', status: '', q: 'baner' }), 2)
  assert.equal(activeFilterCount({ type: '', band: '', bhk: '', status: '' }), 0)
  assert.equal(activeFilterCount({}), 0)
})

test('clearedFilters wipes filters but keeps other keys like q', () => {
  const cleared = clearedFilters({ type: 'villa', band: '0-50', bhk: '3', status: 'available', q: 'baner' })
  assert.deepEqual(cleared, { type: '', band: '', bhk: '', status: '', q: 'baner' })
})
