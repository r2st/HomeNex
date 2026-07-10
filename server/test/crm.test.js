// API tests for follow-ups, site visits, and the home dashboard aggregation.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('crm')

const { app } = await import('../index.js')
const { closePool, query, upsertLead, addMessage, applyExtraction } = await import('../db.js')

let server
let base
let token
let agentId
let leadId
let propertyId

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

const hoursFromNow = (h) => new Date(Date.now() + h * 3600_000).toISOString()

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const out = await (
    await req('POST', '/api/auth/signup', { name: 'CRM Agent', phone: '+919800000005', password: 'secret123' })
  ).json()
  token = out.token
  agentId = out.agent.id

  const lead = await upsertLead(agentId, '919888800002', 'Followup Fiona')
  leadId = lead.id
  const prop = await (
    await req('POST', '/api/properties', { title: 'Dashboard Towers', locality: 'Baner', city: 'Pune' })
  ).json()
  propertyId = prop.id
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

test('POST /api/followups creates a follow-up on an owned lead', async () => {
  const res = await req('POST', '/api/followups', {
    lead_id: leadId,
    due_at: hoursFromNow(2),
    note: 'Confirm Saturday site visit',
  })
  assert.equal(res.status, 200)
  const f = await res.json()
  assert.equal(f.lead_id, leadId)
  assert.equal(f.note, 'Confirm Saturday site visit')
  assert.equal(f.completed_at, null)

  assert.equal((await req('POST', '/api/followups', { lead_id: leadId })).status, 400)
  assert.equal((await req('POST', '/api/followups', { lead_id: 999999, due_at: hoursFromNow(1) })).status, 404)
})

test('GET /api/followups joins the lead name and flags overdue', async () => {
  // One overdue follow-up (due an hour ago).
  await req('POST', '/api/followups', { lead_id: leadId, due_at: hoursFromNow(-1), note: 'Overdue ping' })

  const all = await (await req('GET', '/api/followups?pending=1')).json()
  assert.equal(all.length, 2)
  assert.equal(all[0].lead_name, 'Followup Fiona')
  const overdue = all.find((f) => f.note === 'Overdue ping')
  assert.equal(overdue.overdue, 1)
  const upcoming = all.find((f) => f.note === 'Confirm Saturday site visit')
  assert.equal(upcoming.overdue, 0)

  // today=1 covers due-today and overdue items.
  const today = await (await req('GET', '/api/followups?pending=1&today=1')).json()
  assert.ok(today.some((f) => f.note === 'Overdue ping'))
})

test('PUT /api/followups/:id completes and reopens', async () => {
  const [f] = await (await req('GET', '/api/followups?pending=1')).json()
  const done = await (await req('PUT', `/api/followups/${f.id}`, { completed: true })).json()
  assert.ok(done.completed_at)

  const pending = await (await req('GET', '/api/followups?pending=1')).json()
  assert.ok(!pending.some((x) => x.id === f.id))

  const reopened = await (await req('PUT', `/api/followups/${f.id}`, { completed: false, note: 'Try again' })).json()
  assert.equal(reopened.completed_at, null)
  assert.equal(reopened.note, 'Try again')

  assert.equal((await req('PUT', '/api/followups/999999', { completed: true })).status, 404)
})

test('POST /api/site-visits schedules a visit with pickup', async () => {
  const res = await req('POST', '/api/site-visits', {
    lead_id: leadId,
    property_id: propertyId,
    scheduled_at: new Date().toISOString(), // "now" is today in any timezone
    pickup_required: true,
    pickup_location: 'Baner Road Starbucks',
  })
  assert.equal(res.status, 200)
  const v = await res.json()
  assert.equal(v.status, 'scheduled')
  assert.equal(v.pickup_required, true)

  assert.equal((await req('POST', '/api/site-visits', { lead_id: leadId })).status, 400)
  assert.equal(
    (await req('POST', '/api/site-visits', { lead_id: leadId, property_id: 999999, scheduled_at: hoursFromNow(1) })).status,
    404,
  )
})

test('PUT /api/site-visits/:id walks the status lifecycle and rejects bad statuses', async () => {
  const [v] = await (await req('GET', '/api/site-visits')).json()
  for (const status of ['confirmed', 'completed']) {
    const res = await req('PUT', `/api/site-visits/${v.id}`, { status })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).status, status)
  }
  assert.equal((await req('PUT', `/api/site-visits/${v.id}`, { status: 'teleported' })).status, 400)
})

test('GET /api/site-visits joins lead and property, filters today', async () => {
  const all = await (await req('GET', '/api/site-visits')).json()
  assert.equal(all[0].lead_name, 'Followup Fiona')
  assert.equal(all[0].property_title, 'Dashboard Towers')

  const today = await (await req('GET', '/api/site-visits?today=1')).json()
  assert.ok(today.some((x) => x.id === all[0].id), 'a visit scheduled now is today (IST)')
})

test('GET /api/dashboard aggregates unanswered, followups, visits, hot leads, activity', async () => {
  // An unanswered buyer message on a second lead.
  const waiting = await upsertLead(agentId, '919888800003', 'Waiting Walt')
  await addMessage(waiting.id, 'buyer', 'Any 3BHK options in Wakad?')
  // A hot lead via extraction.
  const hot = await upsertLead(agentId, '919888800004', 'Hot Harry')
  await applyExtraction(hot.id, { temp: 'Hot', score: 88 })

  const res = await req('GET', '/api/dashboard')
  assert.equal(res.status, 200)
  const d = await res.json()

  const unansweredIds = d.unanswered.map((u) => u.id)
  assert.ok(unansweredIds.includes(waiting.id), 'lead with buyer-last message is unanswered')
  const w = d.unanswered.find((u) => u.id === waiting.id)
  assert.ok(w.last_at, 'age timer source is present')
  assert.equal(w.last_msg, 'Any 3BHK options in Wakad?')

  assert.ok(Array.isArray(d.followupsToday))
  assert.ok(d.siteVisitsToday.every((v) => v.lead_name), 'visits are joined')
  assert.ok(d.hotLeads.some((h) => h.id === hot.id))
  assert.ok(Array.isArray(d.activity))
})

test('an agent reply removes the lead from the unanswered queue', async () => {
  const { rows } = await query(`SELECT id FROM leads WHERE wa_id = '919888800003'`)
  await addMessage(rows[0].id, 'agent', 'Yes! Sending options now.')
  const d = await (await req('GET', '/api/dashboard')).json()
  assert.ok(!d.unanswered.some((u) => u.id === rows[0].id))
})
