import { test } from 'node:test'
import assert from 'node:assert/strict'
import { glossary, explain } from './glossary.js'

test('every glossary entry is one plain, acronym-expanded sentence', () => {
  for (const [key, text] of Object.entries(glossary)) {
    assert.ok(text.length > 20, `${key} explanation is too short`)
    assert.ok(/[.!]$/.test(text.trim()), `${key} should end in a full stop`)
  }
})

test('RERA and the WhatsApp Business number are explained without leaving the acronym bare', () => {
  assert.match(glossary.RERA, /regulator/i)
  assert.match(glossary.WABA, /number buyers message/i)
})

test('explain() looks terms up case- and punctuation-insensitively', () => {
  assert.equal(explain('rera'), glossary.RERA)
  assert.equal(explain('service window'), glossary.SERVICE_WINDOW)
  assert.equal(explain('service-window'), glossary.SERVICE_WINDOW)
})

test('explain() returns undefined for an unknown term', () => {
  assert.equal(explain('quantum'), undefined)
  assert.equal(explain(''), undefined)
  assert.equal(explain(null), undefined)
})
