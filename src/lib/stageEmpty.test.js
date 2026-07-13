import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stageEmptyText, stageEmptyIcon } from './stageEmpty.js'

test('New column gets the WhatsApp hint', () => {
  assert.equal(stageEmptyText('New'), 'New leads from WhatsApp will appear here')
  assert.equal(stageEmptyText('new'), 'New leads from WhatsApp will appear here')
  assert.equal(stageEmptyIcon('New'), '💬')
})

test('Lost column gets its own copy', () => {
  assert.match(stageEmptyText('Lost'), /lost/i)
})

test('other stages get a drag hint naming the stage', () => {
  assert.equal(stageEmptyText('Negotiation'), 'Drag leads here as they reach Negotiation')
})

test('blank stage does not crash', () => {
  assert.equal(typeof stageEmptyText(''), 'string')
  assert.equal(typeof stageEmptyText(undefined), 'string')
})
