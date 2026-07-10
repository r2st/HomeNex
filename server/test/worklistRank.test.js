// Pure unit tests for the worklist ranker (no DB).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { worklistItem, rankWorklist, worklistCounts, WORKLIST_TYPES, PRIORITY_RANK } from '../worklist.js'

test('worklistItem stamps priority + action from the type table', () => {
  const item = worklistItem('service_window_closing', { lead_id: 3, title: 'Ravi', reason: 'closing' })
  assert.equal(item.priority, 'critical')
  assert.equal(item.action, 'reply_now')
  assert.equal(item.entity_id, 3) // defaults to lead_id
  assert.equal(worklistItem('nonsense', {}), null)
})

test('every worklist type has a valid priority', () => {
  for (const [type, def] of Object.entries(WORKLIST_TYPES)) {
    assert.ok(def.priority in PRIORITY_RANK, `${type} has an unknown priority`)
    assert.ok(def.action, `${type} needs an action`)
  }
})

test('rankWorklist sorts by priority then recency', () => {
  const now = Date.now()
  const items = [
    worklistItem('stale_lead', { lead_id: 1, title: 'a', reason: '', recencyAt: new Date(now - 5000).toISOString() }),
    worklistItem('service_window_closing', { lead_id: 2, title: 'b', reason: '', recencyAt: new Date(now - 10000).toISOString() }),
    worklistItem('hot_lead_waiting', { lead_id: 3, title: 'c', reason: '', recencyAt: new Date(now - 1000).toISOString() }),
    worklistItem('hot_lead_waiting', { lead_id: 4, title: 'd', reason: '', recencyAt: new Date(now - 60_000).toISOString() }),
  ]
  const ranked = rankWorklist(items)
  assert.equal(ranked[0].type, 'service_window_closing') // critical first
  assert.equal(ranked[1].lead_id, 3) // hot, more recent
  assert.equal(ranked[2].lead_id, 4) // hot, older
  assert.equal(ranked[3].type, 'stale_lead') // medium last
})

test('rankWorklist drops nulls and caps the list', () => {
  const many = Array.from({ length: 60 }, (_, i) =>
    worklistItem('stale_lead', { lead_id: i, title: 't', reason: '' }),
  )
  many.push(null)
  const ranked = rankWorklist(many, { limit: 50 })
  assert.equal(ranked.length, 50)
})

test('worklistCounts rolls up by type and priority', () => {
  const items = [
    worklistItem('service_window_closing', { lead_id: 1, title: 'a', reason: '' }),
    worklistItem('hot_lead_waiting', { lead_id: 2, title: 'b', reason: '' }),
    worklistItem('hot_lead_waiting', { lead_id: 3, title: 'c', reason: '' }),
  ]
  const counts = worklistCounts(items)
  assert.equal(counts.total, 3)
  assert.equal(counts.by_type.hot_lead_waiting, 2)
  assert.equal(counts.by_priority.critical, 1)
  assert.equal(counts.by_priority.high, 2)
})
