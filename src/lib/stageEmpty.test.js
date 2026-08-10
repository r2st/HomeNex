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

test('every terminal stage name maps to the closed copy and icon', () => {
  for (const name of ['Closed', 'Registered/Closed', 'Won', 'won', '  CLOSED  ']) {
    assert.equal(stageEmptyText(name), 'Closed deals will appear here', name)
    assert.equal(stageEmptyIcon(name), '🎉', name)
  }
})

test('New and Lost get their own copy and icon', () => {
  assert.equal(stageEmptyText('New'), 'New leads from WhatsApp will appear here')
  assert.equal(stageEmptyIcon('New'), '💬')
  assert.equal(stageEmptyText('Lost'), 'Leads you mark as lost show up here')
  assert.equal(stageEmptyIcon('Lost'), '🚫')
})

test('any other stage falls back to the drag prompt with its own name', () => {
  assert.equal(stageEmptyText('Shortlist Sent'), 'Drag leads here as they reach Shortlist Sent')
  assert.equal(stageEmptyIcon('Shortlist Sent'), '↴')
})

test('a missing or blank stage name still reads as a sentence', () => {
  for (const name of [null, undefined, '', '   ']) {
    assert.equal(stageEmptyText(name), 'Drag leads here as they reach this stage', String(name))
    assert.equal(stageEmptyIcon(name), '↴', String(name))
  }
})
