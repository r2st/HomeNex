// API tests for the pipeline-analytics, quick-match, follow-up overdue queue, and
// site-visit outcome->pipeline features (migration 008).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('pipelinevisits')

const { app } = await import('../index.js')
const { closePool, query, upsertLead, applyExtraction } = await import('../db.js')

let server, base, token, agentId

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
  const out = await (
    await req('POST', '/api/auth/signup', { name: 'PV Agent', phone: '+919800000051', password: 'secret123' })
  ).json()
  token = out.token
  agentId = out.agent.id
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

test('stage moves are recorded as transition events with dwell time', async () => {
  const lead = await upsertLead(agentId, '919888810001', 'Funnel Farid')
  // Backdate creation so the first dwell is non-zero.
  await query(`UPDATE leads SET created_at = now() - interval '2 hours' WHERE id = $1`, [lead.id])

  await req('PUT', `/api/leads/${lead.id}/stage`, { stage: 'Qualified' })
  await req('PUT', `/api/leads/${lead.id}/stage`, { stage: 'Shortlist Sent' })

  const events = (
    await query('SELECT * FROM lead_stage_events WHERE lead_id = $1 ORDER BY id', [lead.id])
  ).rows
  assert.equal(events.length, 2)
  assert.equal(events[0].from_stage, 'New') // implicit New (stage was null) -> Qualified
  assert.equal(events[0].to_stage, 'Qualified')
  assert.equal(events[1].from_stage, 'Qualified')
  assert.equal(events[1].to_stage, 'Shortlist Sent')
  assert.ok(Number(events[0].seconds_in_from_stage) >= 6000, 'dwell in New ~2h')
})

test('re-saving the same stage does not create a no-op event', async () => {
  const lead = await upsertLead(agentId, '919888810002', 'Noop Nadia')
  await req('PUT', `/api/leads/${lead.id}/stage`, { stage: 'Qualified' })
  await req('PUT', `/api/leads/${lead.id}/stage`, { stage: 'Qualified' })
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM lead_stage_events WHERE lead_id = $1', [lead.id])
  assert.equal(rows[0].n, 1)
})

test('GET /api/pipeline/analytics returns funnel, lost reasons and totals', async () => {
  // A lead that reaches Negotiation, and one that is Lost.
  const a = await upsertLead(agentId, '919888810010', 'Deal Deepa')
  await req('PUT', `/api/leads/${a.id}/stage`, { stage: 'Qualified' })
  await req('PUT', `/api/leads/${a.id}/stage`, { stage: 'Negotiation' })
  const b = await upsertLead(agentId, '919888810011', 'Gone Gopal')
  await req('PUT', `/api/leads/${b.id}/stage`, { stage: 'Lost', lost_reason: 'Budget mismatch' })

  const res = await req('GET', '/api/pipeline/analytics?type=buy_primary')
  assert.equal(res.status, 200)
  const a2 = await res.json()
  assert.equal(a2.pipeline_type, 'buy_primary')
  assert.ok(a2.funnel.length >= 10)
  const negotiation = a2.funnel.find((f) => f.stage === 'Negotiation')
  assert.ok(negotiation.open >= 1)
  assert.ok(a2.lost_reasons.some((r) => r.reason === 'Budget mismatch' && r.n >= 1))
  assert.ok(a2.totals.lost >= 1)
  assert.equal((await req('GET', '/api/pipeline/analytics?type=castle')).status, 400)
})

test('GET /api/leads/:id/property-matches ranks fitting inventory', async () => {
  const lead = await upsertLead(agentId, '919888810020', 'Match Meena')
  await req('PUT', `/api/leads/${lead.id}`, {
    budget_min: 60_0000000, // ₹60L
    budget_max: 90_0000000, // ₹90L
    bhk: '2',
    property_type: 'apartment',
    preferred_localities: ['Baner'],
  })
  // A perfect fit, an over-budget miss, and a locality-mismatch (still returned, lower rank).
  await req('POST', '/api/properties', { title: 'Baner 2BHK', property_type: 'apartment', bhk: '2', price_paise: 80_0000000, locality: 'Baner', city: 'Pune', status: 'available' })
  await req('POST', '/api/properties', { title: 'Lux Penthouse', property_type: 'apartment', bhk: '2', price_paise: 300_0000000, locality: 'Baner', city: 'Pune', status: 'available' })
  await req('POST', '/api/properties', { title: 'Wakad 2BHK', property_type: 'apartment', bhk: '2', price_paise: 75_0000000, locality: 'Wakad', city: 'Pune', status: 'available' })

  const res = await req('GET', `/api/leads/${lead.id}/property-matches`)
  assert.equal(res.status, 200)
  const matches = await res.json()
  const titles = matches.map((m) => m.title)
  assert.ok(titles.includes('Baner 2BHK'), 'in-budget match present')
  assert.ok(!titles.includes('Lux Penthouse'), 'over-budget (even +10%) filtered out')
  assert.equal(matches[0].title, 'Baner 2BHK', 'locality match ranks first')

  assert.equal((await req('GET', '/api/leads/999999/property-matches')).status, 404)
})

test('completing a site visit auto-advances the lead to Site Visit Done', async () => {
  const lead = await upsertLead(agentId, '919888810030', 'Visit Varun')
  await req('PUT', `/api/leads/${lead.id}/stage`, { stage: 'Site Visit Scheduled' })
  const visit = await (
    await req('POST', '/api/site-visits', { lead_id: lead.id, scheduled_at: new Date().toISOString() })
  ).json()

  await req('PUT', `/api/site-visits/${visit.id}`, { status: 'completed' })
  let l = await (await req('GET', `/api/leads/${lead.id}`)).json()
  assert.equal(l.stage, 'Site Visit Done')

  // A no-show bounces it back to Site Visit Scheduled.
  await req('PUT', `/api/site-visits/${visit.id}`, { status: 'no_show' })
  l = await (await req('GET', `/api/leads/${lead.id}`)).json()
  assert.equal(l.stage, 'Site Visit Scheduled')
})

test('a completed visit does not resurrect a Lost lead', async () => {
  const lead = await upsertLead(agentId, '919888810031', 'Lost Latha')
  const visit = await (
    await req('POST', '/api/site-visits', { lead_id: lead.id, scheduled_at: new Date().toISOString() })
  ).json()
  await req('PUT', `/api/leads/${lead.id}/stage`, { stage: 'Lost', lost_reason: 'Unresponsive' })
  await req('PUT', `/api/site-visits/${visit.id}`, { status: 'completed' })
  const l = await (await req('GET', `/api/leads/${lead.id}`)).json()
  assert.equal(l.stage, 'Lost')
})

test('GET /api/followups?overdue=1&by_heat=1 sorts the overdue queue hottest-first', async () => {
  const cold = await upsertLead(agentId, '919888810040', 'Cold Kiran')
  await applyExtraction(cold.id, { temp: 'Cold', score: 20 })
  const hot = await upsertLead(agentId, '919888810041', 'Hot Hema')
  await applyExtraction(hot.id, { temp: 'Hot', score: 92 })

  const past = new Date(Date.now() - 3600_000).toISOString()
  await req('POST', '/api/followups', { lead_id: cold.id, due_at: past })
  await req('POST', '/api/followups', { lead_id: hot.id, due_at: past })

  const queue = await (await req('GET', '/api/followups?overdue=1&by_heat=1')).json()
  const idx = (leadId) => queue.findIndex((f) => f.lead_id === leadId)
  assert.ok(idx(hot.id) >= 0 && idx(cold.id) >= 0)
  assert.ok(idx(hot.id) < idx(cold.id), 'hot lead follow-up is worked first')
  assert.ok(queue.every((f) => f.overdue === 1))
})

test('booking a visit reports confirmation_sent=false when WhatsApp is unconfigured', async () => {
  const lead = await upsertLead(agentId, '919888810050', 'Confirm Chaya')
  const res = await req('POST', '/api/site-visits', { lead_id: lead.id, scheduled_at: new Date(Date.now() + 3 * 86400_000).toISOString() })
  assert.equal(res.status, 200)
  const visit = await res.json()
  assert.equal(visit.confirmation_sent, false)
  // The scheduling itself still succeeded and no confirmation timestamp was stamped.
  const { rows } = await query('SELECT confirmation_sent_at FROM site_visits WHERE id = $1', [visit.id])
  assert.equal(rows[0].confirmation_sent_at, null)
})
