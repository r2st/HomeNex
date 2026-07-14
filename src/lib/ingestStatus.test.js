import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ingestStatusLabel, ingestStatusTone } from './ingestStatus.js'

test('maps every known ingest status to a plain sentence', () => {
  assert.equal(ingestStatusLabel('created'), 'New lead')
  assert.equal(ingestStatusLabel('merged'), 'Added to existing contact')
  assert.equal(ingestStatusLabel('duplicate'), 'Already had this one')
  assert.equal(ingestStatusLabel('unmatched'), "Couldn't match — check it")
  assert.equal(ingestStatusLabel('failed'), "Didn't come through")
})

test('never leaks a raw status code', () => {
  for (const s of ['created', 'merged', 'duplicate', 'unmatched', 'failed']) {
    assert.notEqual(ingestStatusLabel(s), s)
  }
})

test('unknown status falls back to a safe word', () => {
  assert.equal(ingestStatusLabel('something_else'), 'Captured')
  assert.equal(ingestStatusLabel(undefined), 'Captured')
  assert.equal(ingestStatusTone('something_else'), 'muted')
})

test('tone is provided for colouring', () => {
  assert.equal(ingestStatusTone('created'), 'good')
  assert.equal(ingestStatusTone('failed'), 'bad')
  assert.equal(ingestStatusTone('unmatched'), 'warn')
})
