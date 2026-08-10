// HTTP-level coverage for the AI auto-fill endpoints and the hybrid score surfaced
// on the lead-detail payload. Boots the real Express app against a throwaway DB;
// AI is off (no key), so we seed the extraction directly to exercise the accept flow.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('autofillapi')

const { app } = await import('../index.js')
const { closePool, applyExtraction } = await import('../db.js')

let server
let base
let token
let leadId

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  token = (await (await req('POST', '/api/auth/signup', { name: 'Fill Agent', phone: '+919800000081', password: 'secret123' })).json()).token
  const sim = await (await req('POST', '/api/simulate', { from: '919777700081', name: '919777700081', text: '2bhk chahiye wakad me, 80 tak, 2 mahine me' })).json()
  leadId = sim.lead.id
  // Simulate what the AI extractor stored for this Hinglish thread (this also fills
  // the card + ai_extracted). budget 80L, two localities.
  await applyExtraction(leadId, {
    name: 'Rohan',
    intent: 'buy',
    bhk: '2',
    preferred_localities: ['Wakad', 'Baner'],
    budget_max_l: 80,
    timeline: '2 months',
    financing: 'loan',
    temp: 'Warm',
    score: 60,
  })
  // The agent then narrows the card by hand: budget down to 60L, localities to Wakad
  // only. Now the stored AI extraction DIFFERS from the card — exactly what the
  // auto-fill accept/reject surface exists to reconcile.
  await req('PUT', `/api/leads/${leadId}`, { budget_max: 600000000, preferred_localities: ['Wakad'] })
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

test('GET /autofill proposes only the fields where AI differs from the card', async () => {
  const res = await req('GET', `/api/leads/${leadId}/autofill`)
  assert.equal(res.status, 200)
  const { suggestions } = await res.json()
  const fields = suggestions.map((s) => s.field)
  // name / bhk / timeline / financing all match the card — no noise.
  assert.ok(!fields.includes('name'))
  assert.ok(!fields.includes('bhk'))
  // budget and localities were narrowed by the agent — AI still suggests its values.
  assert.ok(fields.includes('budget_max'))
  assert.ok(fields.includes('preferred_localities'))
  const budget = suggestions.find((s) => s.field === 'budget_max')
  assert.equal(budget.suggested, 800000000) // 80L in paise
  assert.equal(Number(budget.current), 600000000) // shows what it was
})

test('POST /autofill/apply writes accepted fields and 404s an unknown lead', async () => {
  const res = await req('POST', `/api/leads/${leadId}/autofill/apply`, {
    accepted: { budget_max: 800000000, preferred_localities: ['Wakad', 'Baner'] },
  })
  assert.equal(res.status, 200)
  const lead = await res.json()
  assert.equal(Number(lead.budget_max), 800000000)
  assert.deepEqual(lead.preferred_localities, ['Wakad', 'Baner'])

  // Accepted fields no longer appear as suggestions (they now match the card).
  const after = await (await req('GET', `/api/leads/${leadId}/autofill`)).json()
  assert.ok(!after.suggestions.some((s) => s.field === 'budget_max'))

  assert.equal((await req('POST', '/api/leads/999999/autofill/apply', { accepted: { budget_max: 1 } })).status, 404)
})

// name and intent are written by their own statements, outside the generic CRM
// allowlist — so accepting only those leaves the CRM update with nothing to do.
test('accepting only the name and intent skips the CRM write entirely', async () => {
  const res = await req('POST', `/api/leads/${leadId}/autofill/apply`, {
    accepted: { name: '  Renamed Rhea  ', intent: 'rent' },
  })
  assert.equal(res.status, 200)
  const lead = await res.json()
  assert.equal(lead.name, 'Renamed Rhea', 'trimmed on the way in')
  assert.equal(lead.intent, 'rent')
})

test('a field outside the autofill allowlist is ignored, not written', async () => {
  const res = await req('POST', `/api/leads/${leadId}/autofill/apply`, {
    accepted: { stage: 'Registered/Closed', agent_id: 9999, timeline: '1-3 months' },
  })
  assert.equal(res.status, 200)
  const lead = await res.json()
  assert.equal(lead.timeline, '1-3 months', 'the allowlisted field still lands')
  assert.notEqual(lead.stage, 'Registered/Closed', 'pipeline columns are not autofillable')
  assert.notEqual(lead.agent_id, 9999)
})

test('POST /autofill/apply rejects a missing accepted map', async () => {
  assert.equal((await req('POST', `/api/leads/${leadId}/autofill/apply`, {})).status, 400)
})

test('lead detail carries the rules+LLM hybrid temperature and reason', async () => {
  const lead = await (await req('GET', `/api/leads/${leadId}`)).json()
  assert.ok(['Hot', 'Warm', 'Cold'].includes(lead.hybrid_temp))
  assert.equal(typeof lead.hybrid_reason, 'string')
  assert.ok(lead.hybrid_reason.length > 0)
})
