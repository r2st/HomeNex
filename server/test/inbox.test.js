// Unified inbox: unread state, internal notes, assignment, and labels
// (manual toggles + automatic lifecycle labels).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('inbox')

const { app } = await import('../index.js')
const { closePool } = await import('../db.js')

let server, base, token, agentId, leadId

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
const json = (r) => r.json()

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const out = await json(await req('POST', '/api/auth/signup', { name: 'Inbox Agent', phone: '+919800000071', password: 'secret123' }))
  token = out.token
  agentId = (await json(await req('GET', '/api/auth/me'))).id
  const sim = await json(await req('POST', '/api/simulate', { from: '919777700071', name: 'Nina Buyer', text: '2bhk chahiye wakad me' }))
  leadId = sim.lead.id
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

test('a new lead is auto-labelled "New"', async () => {
  const lead = await json(await req('GET', `/api/leads/${leadId}`))
  assert.ok(lead.labels.some((l) => l.name === 'New'), 'New label should be auto-applied')
})

test('unread count reflects buyer messages and clears on read', async () => {
  const list = await json(await req('GET', '/api/leads'))
  const row = list.find((l) => l.id === leadId)
  assert.ok(row.unread_count >= 1, `expected unread >=1, got ${row.unread_count}`)

  assert.equal((await req('POST', `/api/leads/${leadId}/read`)).status, 200)
  const after = (await json(await req('GET', '/api/leads'))).find((l) => l.id === leadId)
  assert.equal(after.unread_count, 0)

  // A new inbound message makes it unread again.
  await req('POST', '/api/simulate', { from: '919777700071', name: 'Nina Buyer', text: 'koi update?' })
  const again = (await json(await req('GET', '/api/leads'))).find((l) => l.id === leadId)
  assert.ok(again.unread_count >= 1)
})

test('internal notes: add, list, delete — never touches the message thread', async () => {
  const before = await json(await req('GET', `/api/leads/${leadId}`))
  const msgCount = before.messages.length

  const note = await json(await req('POST', `/api/leads/${leadId}/notes`, { body: 'Prefers weekend site visits' }))
  assert.ok(note.id)
  assert.equal((await req('POST', `/api/leads/${leadId}/notes`, { body: '   ' })).status, 400) // blank rejected

  const notes = await json(await req('GET', `/api/leads/${leadId}/notes`))
  assert.equal(notes.length, 1)
  assert.equal(notes[0].agent_name, 'Inbox Agent')

  // The note did not become a WhatsApp message.
  const afterLead = await json(await req('GET', `/api/leads/${leadId}`))
  assert.equal(afterLead.messages.length, msgCount)
  assert.equal(afterLead.notes.length, 1)

  assert.equal((await req('DELETE', `/api/leads/${leadId}/notes/${note.id}`)).status, 200)
  assert.equal((await json(await req('GET', `/api/leads/${leadId}/notes`))).length, 0)
})

test('manual labels can be toggled on and off', async () => {
  const labels = await json(await req('GET', '/api/labels'))
  assert.equal(labels.length, 6, 'six system labels seeded')
  const broker = labels.find((l) => l.name === 'Broker')

  const on = await json(await req('PUT', `/api/leads/${leadId}/labels/${broker.id}`, { on: true }))
  assert.ok(on.some((l) => l.id === broker.id))

  const off = await json(await req('PUT', `/api/leads/${leadId}/labels/${broker.id}`, { on: false }))
  assert.ok(!off.some((l) => l.id === broker.id))
})

test('system labels cannot be created-over or deleted, custom labels can', async () => {
  const custom = await json(await req('POST', '/api/labels', { name: 'NRI buyer', color: '#0ea5e9' }))
  assert.ok(custom.id)
  assert.equal((await req('DELETE', `/api/labels/${custom.id}`)).status, 200)

  // Deleting a system label is refused.
  const sys = (await json(await req('GET', '/api/labels'))).find((l) => l.is_system)
  assert.equal((await req('DELETE', `/api/labels/${sys.id}`)).status, 403)
})

test('booking a site visit auto-labels the thread "Site Visit Scheduled"', async () => {
  await req('POST', '/api/site-visits', { lead_id: leadId, scheduled_at: new Date(Date.now() + 86400000).toISOString() })
  const lead = await json(await req('GET', `/api/leads/${leadId}`))
  assert.ok(lead.labels.some((l) => l.name === 'Site Visit Scheduled'))
})

test('moving a lead to Lost auto-labels it "Lost"', async () => {
  const res = await req('PUT', `/api/leads/${leadId}/stage`, { stage: 'Lost', lost_reason: 'Bought elsewhere' })
  assert.equal(res.status, 200)
  const lead = await json(await req('GET', `/api/leads/${leadId}`))
  assert.ok(lead.labels.some((l) => l.name === 'Lost'))
})

test('assignment: owner can reassign the thread', async () => {
  const lead = await json(await req('POST', `/api/leads/${leadId}/assign-to`, { assignee_id: agentId }))
  assert.equal(lead.assigned_agent_id, agentId)
  // Handing back (null) falls back to the owner in the detail view.
  await req('POST', `/api/leads/${leadId}/assign-to`, { assignee_id: null })
  const detail = await json(await req('GET', `/api/leads/${leadId}`))
  assert.equal(detail.assigned_agent_id, agentId) // COALESCE(assigned, owner)
})
