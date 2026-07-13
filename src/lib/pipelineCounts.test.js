import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pipelineCounts } from './pipelineCounts.js'

test('counts by pipeline_type', () => {
  const counts = pipelineCounts([
    { pipeline_type: 'buy_primary' },
    { pipeline_type: 'buy_primary' },
    { pipeline_type: 'rental' },
  ])
  assert.equal(counts.buy_primary, 2)
  assert.equal(counts.rental, 1)
  assert.equal(counts.buy_resale, 0)
})

test('missing pipeline_type defaults to buy_primary', () => {
  const counts = pipelineCounts([{}, { pipeline_type: null }])
  assert.equal(counts.buy_primary, 2)
})

test('empty input -> all zero', () => {
  assert.deepEqual(pipelineCounts([]), { buy_primary: 0, buy_resale: 0, rental: 0 })
  assert.deepEqual(pipelineCounts(), { buy_primary: 0, buy_resale: 0, rental: 0 })
})
