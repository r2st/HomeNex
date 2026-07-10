// API tests for lead pipeline management: CRM field updates, stage moves,
// lost-reason enforcement, and pipeline stage listing.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('pipeline')

const { app } = await import('../index.js')
const { closePool, upsertLead, attachLeadContact, addContact } = await import('../db.js')

let server
let base
let token
let agentId
let leadId

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const out = await (
    await req('POST', '/api/auth/signup', { name: 'Pipeline Agent', phone: '+919800000001', password: 'secret123' })
  ).json()
  token = out.token
  agentId = out.agent.id

  // Seed one contact + linked lead the way the webhook would.
  const contact = await addContact(agentId, '+919876500001', 'Ramesh Kumar')
  const lead = await upsertLead(agentId, '919876500001', 'Ramesh Kumar')
  await attachLeadContact(lead.id, contact.id)
  leadId = lead.id
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

test('GET /api/pipeline-stages returns the seeded stages, filterable by type', async () => {
  const all = await (await req('GET', '/api/pipeline-stages')).json()
  assert.equal(all.length, 28) // 10 buy_primary + 10 buy_resale + 8 rental
  const rental = await (await req('GET', '/api/pipeline-stages?type=rental')).json()
  assert.equal(rental.length, 8)
  assert.equal(rental[0].stage_name, 'New')
  assert.deepEqual([...new Set(rental.map((s) => s.pipeline_type))], ['rental'])
})

test('PUT /api/leads/:id updates CRM fields (paise budgets, BHK, localities, financing)', async () => {
  const res = await req('PUT', `/api/leads/${leadId}`, {
    budget_min: 80_0000000, // ₹80L in paise
    budget_max: 95_0000000,
    bhk: '2',
    property_type: 'apartment',
    preferred_localities: ['Baner', 'Balewadi'],
    timeline: '3 months',
    financing: 'loan',
    notes: 'Pre-approved HDFC loan',
  })
  assert.equal(res.status, 200)
  const lead = await res.json()
  assert.equal(lead.budget_min, 80_0000000)
  assert.equal(lead.budget_max, 95_0000000)
  assert.equal(lead.bhk, '2')
  assert.deepEqual(lead.preferred_localities, ['Baner', 'Balewadi'])
  assert.equal(lead.financing, 'loan')
})

test('PUT /api/leads/:id rejects invalid enum values with 400', async () => {
  assert.equal((await req('PUT', `/api/leads/${leadId}`, { financing: 'crypto' })).status, 400)
  assert.equal((await req('PUT', `/api/leads/${leadId}`, { property_type: 'castle' })).status, 400)
})

test('PUT /api/leads/:id/stage moves the lead through the pipeline', async () => {
  const res = await req('PUT', `/api/leads/${leadId}/stage`, { stage: 'Qualified' })
  assert.equal(res.status, 200)
  const lead = await res.json()
  assert.equal(lead.stage, 'Qualified')
  assert.equal(lead.closed_at, null)
})

test('stage filter on GET /api/leads returns only matching leads', async () => {
  const qualified = await (await req('GET', '/api/leads?pipeline_type=buy_primary&stage=Qualified')).json()
  assert.ok(qualified.some((l) => l.id === leadId))
  const newOnes = await (await req('GET', '/api/leads?stage=Site Visit Done')).json()
  assert.ok(!newOnes.some((l) => l.id === leadId))
})

test('moving to a stage that is not in the pipeline 400s', async () => {
  const res = await req('PUT', `/api/leads/${leadId}/stage`, { stage: 'Options Sent' }) // rental-only stage
  assert.equal(res.status, 400)
})

test('moving to Lost requires a lost reason', async () => {
  const missing = await req('PUT', `/api/leads/${leadId}/stage`, { stage: 'Lost' })
  assert.equal(missing.status, 400)
  const out = await missing.json()
  assert.match(out.error, /lost reason/i)

  const ok = await req('PUT', `/api/leads/${leadId}/stage`, { stage: 'Lost', lost_reason: 'Bought elsewhere' })
  assert.equal(ok.status, 200)
  const lead = await ok.json()
  assert.equal(lead.stage, 'Lost')
  assert.equal(lead.lost_reason, 'Bought elsewhere')
  assert.ok(lead.closed_at, 'terminal stage stamps closed_at')
})

test('moving back out of Lost clears lost_reason and closed_at', async () => {
  const res = await req('PUT', `/api/leads/${leadId}/stage`, { stage: 'Negotiation' })
  assert.equal(res.status, 200)
  const lead = await res.json()
  assert.equal(lead.lost_reason, null)
  assert.equal(lead.closed_at, null)
})

test('GET /api/leads/:id includes contact, followups, and site visits', async () => {
  const res = await req('GET', `/api/leads/${leadId}`)
  assert.equal(res.status, 200)
  const lead = await res.json()
  assert.ok(lead.contact, 'linked contact is embedded')
  assert.equal(lead.contact.phone, '+919876500001')
  assert.ok(Array.isArray(lead.followups))
  assert.ok(Array.isArray(lead.site_visits))
  assert.ok(Array.isArray(lead.messages))
})

test('stage moves on a lead the agent does not own 404', async () => {
  const other = await (
    await req('POST', '/api/auth/signup', { name: 'Other Agent', phone: '+919800000002', password: 'secret123' })
  ).json()
  const res = await req('PUT', `/api/leads/${leadId}/stage`, { stage: 'Qualified' }, other.token)
  assert.equal(res.status, 404)
})
