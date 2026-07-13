import { test } from 'node:test'
import assert from 'node:assert/strict'
import { replyModeBadge, REPLY_MODE_HELP } from './replyMode.js'

test('AI enabled -> Auto-reply badge', () => {
  const b = replyModeBadge({ ai_enabled: true })
  assert.equal(b.key, 'ai')
  assert.equal(b.label, 'Auto-reply')
  assert.equal(b.tone, 'brand')
})

test('AI disabled -> You reply badge', () => {
  const b = replyModeBadge({ ai_enabled: false })
  assert.equal(b.key, 'manual')
  assert.equal(b.label, 'You reply')
  assert.equal(b.tone, 'amber')
})

test('missing lead defaults to manual', () => {
  assert.equal(replyModeBadge().key, 'manual')
  assert.equal(replyModeBadge({}).label, 'You reply')
})

test('never emits the raw MANUAL code', () => {
  assert.notEqual(replyModeBadge({ ai_enabled: false }).label, 'MANUAL')
  assert.ok(REPLY_MODE_HELP.includes('You reply'))
  assert.ok(REPLY_MODE_HELP.includes('Auto-reply'))
})
