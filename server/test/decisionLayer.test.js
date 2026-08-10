// Integration tests for the decision layer: score decay persistence, the pre-contact
// briefing endpoint, and the prioritised daily worklist.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('decision')

const { app } = await import('../index.js')
const {
  closePool, query, upsertLead, addMessage, applyExtraction,
  recomputeLeadScore, createFollowup, createSiteVisit, createCommission,
} = await import('../db.js')

let server, base, token, agentId

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

const backdateInbound = (leadId, hours) =>
  query(`UPDATE leads SET last_inbound_at = now() - ($2 || ' hours')::interval WHERE id = $1`, [leadId, String(hours)])
const backdateMessages = (leadId, days) =>
  query(`UPDATE messages SET created_at = now() - ($2 || ' days')::interval WHERE lead_id = $1`, [leadId, String(days)])

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const out = await (await req('POST', '/api/auth/signup', { name: 'Decision Agent', phone: '+919800000061', password: 'secret123' })).json()
  token = out.token
  agentId = out.agent.id
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

test('score decay: a Hot lead that goes silent cools down and is persisted', async () => {
  const lead = await upsertLead(agentId, '919888810001', 'Silent Sam')
  await addMessage(lead.id, 'buyer', 'Looking for 3BHK in Baner, budget 1.2Cr')
  await applyExtraction(lead.id, { temp: 'Hot', score: 88 })

  // Fresh: effective temperature is Hot.
  const fresh = await recomputeLeadScore(lead.id)
  assert.equal(fresh.temperature, 'Hot')

  // Three days of silence: recompute cools it down and writes it to the row.
  await backdateMessages(lead.id, 3)
  await backdateInbound(lead.id, 72)
  const cooled = await recomputeLeadScore(lead.id)
  assert.notEqual(cooled.temperature, 'Hot')
  assert.ok(cooled.effectiveScore < fresh.effectiveScore)

  const row = (await query('SELECT effective_temp, effective_score, last_decay_at FROM leads WHERE id = $1', [lead.id])).rows[0]
  assert.equal(row.effective_temp, cooled.temperature)
  assert.ok(row.last_decay_at)
})

test('score decay: the hard qualification rule keeps a lead Hot even after it goes silent', async () => {
  const lead = await upsertLead(agentId, '919888810011', 'Qualified Quiet Qasim')
  await addMessage(lead.id, 'buyer', 'Budget 90 lakh, need it in 2 months')
  await addMessage(lead.id, 'buyer', 'Yes I can visit this weekend')
  await applyExtraction(lead.id, { temp: 'Warm', score: 55, budget_min_l: 80, budget_max_l: 90, timeline: '2 months' })
  await createSiteVisit(agentId, { lead_id: lead.id, scheduled_at: new Date(Date.now() + 86_400_000).toISOString() })

  const fresh = await recomputeLeadScore(lead.id)
  assert.equal(fresh.temperature, 'Hot')

  // Three days of silence would normally cool a Warm-fit lead to Cold — but the
  // hard rule (budget + near-term timeline + 2 replies + visit agreed) is a
  // business-level qualification signal that decay must not erase.
  await backdateMessages(lead.id, 3)
  await backdateInbound(lead.id, 72)
  const cooled = await recomputeLeadScore(lead.id)
  assert.equal(cooled.temperature, 'Hot')

  const row = (await query('SELECT effective_temp FROM leads WHERE id = $1', [lead.id])).rows[0]
  assert.equal(row.effective_temp, 'Hot')
})

test('GET /api/leads/:id returns live decayed scoring fields', async () => {
  const lead = await upsertLead(agentId, '919888810002', 'Detail Dan')
  await addMessage(lead.id, 'buyer', 'hi')
  await applyExtraction(lead.id, { temp: 'Warm', score: 55 })

  const detail = await (await req('GET', `/api/leads/${lead.id}`)).json()
  assert.ok('effective_score' in detail)
  assert.ok('effective_temp' in detail)
  assert.ok('engagement_score' in detail)
  assert.ok(detail.score_factors)
})

test('GET /api/leads/:id/briefing gives rule-based talking points', async () => {
  const lead = await upsertLead(agentId, '919888810003', 'Briefing Bina')
  await addMessage(lead.id, 'buyer', 'Budget is 90 lakh, when can I move in?')
  await applyExtraction(lead.id, { temp: 'Warm', score: 60, budget_min_l: 80, budget_max_l: 90, financing: 'undecided' })

  const b = await (await req('GET', `/api/leads/${lead.id}/briefing`)).json()
  assert.equal(b.lead_id, lead.id)
  assert.ok(Array.isArray(b.talking_points))
  assert.ok(b.talking_points.length > 0)
  assert.ok(b.missing_bltc.includes('Location')) // no locality extracted
  assert.equal((await req('GET', '/api/leads/999999/briefing')).status, 404)
})

test('GET /api/worklist ranks the day: critical first, explainable reasons', async () => {
  // 1. Service window closing (critical): last inbound 22h ago.
  const sw = await upsertLead(agentId, '919888810010', 'Window Winnie')
  await addMessage(sw.id, 'buyer', 'still deciding')
  await backdateInbound(sw.id, 22)

  // 2. Hot lead waiting (high): fresh buyer message + strong fit, unanswered.
  const hot = await upsertLead(agentId, '919888810011', 'Hot Hema')
  await addMessage(hot.id, 'buyer', 'Ready to book, budget 1.5Cr, need it this month')
  await applyExtraction(hot.id, { temp: 'Hot', score: 92 })

  // 3. Overdue follow-up (high).
  const fu = await upsertLead(agentId, '919888810012', 'Followup Farah')
  await createFollowup(agentId, { lead_id: fu.id, due_at: new Date(Date.now() - 3600_000).toISOString(), note: 'Call back' })

  // 4. Commission overdue (medium).
  const com = await upsertLead(agentId, '919888810013', 'Commission Karan')
  await createCommission(agentId, { lead_id: com.id, deal_value_paise: 10_000_000_00, commission_pct: 1, expected_payout_date: '2020-01-01', status: 'expected' })

  const { items, counts } = await (await req('GET', '/api/worklist')).json()
  assert.ok(items.length >= 4)
  assert.equal(items[0].type, 'service_window_closing', 'critical service-window is first')
  assert.equal(items[0].priority, 'critical')
  assert.ok(items[0].reason, 'every item explains itself')

  const types = items.map((i) => i.type)
  assert.ok(types.includes('hot_lead_waiting'))
  assert.ok(types.includes('overdue_followup'))
  assert.ok(types.includes('commission_overdue'))
  assert.ok(counts.total >= 4)

  // Priority ordering is monotonic (never a lower band before a higher one).
  const rank = { critical: 0, high: 1, medium: 2, low: 3 }
  for (let i = 1; i < items.length; i++) {
    assert.ok(rank[items[i].priority] >= rank[items[i - 1].priority], 'priority order holds')
  }
})

test('worklist surfaces a site visit within 48h and a stale lead', async () => {
  const visitLead = await upsertLead(agentId, '919888810020', 'Visit Vikram')
  await addMessage(visitLead.id, 'buyer', 'confirmed for saturday')
  await createSiteVisit(agentId, { lead_id: visitLead.id, scheduled_at: new Date(Date.now() + 24 * 3600_000).toISOString() })

  const stale = await upsertLead(agentId, '919888810021', 'Stale Stan')
  await addMessage(stale.id, 'buyer', 'maybe later')
  await backdateMessages(stale.id, 20) // 20 days of silence

  const { items } = await (await req('GET', '/api/worklist')).json()
  const types = items.map((i) => i.type)
  assert.ok(types.includes('site_visit_soon'))
  assert.ok(items.find((i) => i.lead_id === stale.id)?.type === 'stale_lead')
})

test('worklist is tenant-scoped — never leaks another agent’s leads', async () => {
  const other = await (await req('POST', '/api/auth/signup', { name: 'Other', phone: '+919800000062', password: 'secret123' })).json()
  const mine = await (await req('GET', '/api/worklist', undefined, other.token)).json()
  assert.equal(mine.items.length, 0, 'a fresh agent has an empty worklist')
})
