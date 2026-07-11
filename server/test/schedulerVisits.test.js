// Tests for the new scheduler jobs: the no-response nudge (§4.6) and the automated
// WhatsApp site-visit reminders (§4.7). The reminder job takes an injectable sender
// so we can assert on the composed message without a live WhatsApp connection.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('schedvisits')

const { app } = await import('../index.js')
const { closePool, query, upsertLead, addMessage, createSiteVisit, createProperty } = await import('../db.js')
const { noResponseNudgeForAgent, siteVisitWaRemindersForAgent } = await import('../scheduler.js')

let server, base, token, agentId

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

const backdateInbound = (leadId, minutes) =>
  query(`UPDATE leads SET last_inbound_at = now() - ($2 || ' minutes')::interval WHERE id = $1`, [leadId, String(minutes)])

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const out = await (
    await req('POST', '/api/auth/signup', { name: 'SV Agent', phone: '+919800000061', password: 'secret123' })
  ).json()
  token = out.token
  agentId = out.agent.id
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

test('noResponseNudge alerts once for a new, unanswered lead', async () => {
  const lead = await upsertLead(agentId, '919888830001', 'Waiting Wasim')
  await addMessage(lead.id, 'buyer', 'is it still available?')
  await backdateInbound(lead.id, 45) // past the 30-min threshold

  assert.equal(await noResponseNudgeForAgent(agentId), 1)
  assert.equal(await noResponseNudgeForAgent(agentId), 0, 'deduped for the same waiting spell')

  const { notifications } = await (await req('GET', '/api/notifications?unread=1')).json()
  assert.ok(notifications.some((n) => n.entity_id === lead.id && n.type === 'no_response_nudge'))
})

test('noResponseNudge stays quiet once the agent (or AI) has replied', async () => {
  const lead = await upsertLead(agentId, '919888830002', 'Answered Anya')
  await addMessage(lead.id, 'buyer', 'hello')
  await addMessage(lead.id, 'ai', 'Hi! How can I help?')
  await backdateInbound(lead.id, 90)
  assert.equal(await noResponseNudgeForAgent(agentId), 0)
})

test('siteVisitWaReminders sends a T-2h reminder with a location pin, once', async () => {
  const prop = await createProperty(agentId, { title: 'Skyline Residency', locality: 'Hinjewadi', city: 'Pune' })
  const lead = await upsertLead(agentId, '919888830003', 'Soon Sneha')
  const visit = await createSiteVisit(agentId, {
    lead_id: lead.id,
    property_id: prop.id,
    scheduled_at: new Date(Date.now() + 90 * 60_000).toISOString(), // in 90 min -> T-2h window
  })

  const sent = []
  const fakeSend = async (to, text) => {
    sent.push({ to, text })
    return 'wamid.TEST'
  }
  assert.equal(await siteVisitWaRemindersForAgent(agentId, Date.now(), fakeSend), 1)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].to, '919888830003')
  assert.match(sent[0].text, /2 hours/)
  assert.match(sent[0].text, /maps\.google\.com/, 'carries the location pin')
  assert.match(sent[0].text, /Hinjewadi/)

  // Idempotent: the same visit is not reminded twice.
  assert.equal(await siteVisitWaRemindersForAgent(agentId, Date.now(), fakeSend), 0)
  const { rows } = await query('SELECT reminder_t2_sent_at FROM site_visits WHERE id = $1', [visit.id])
  assert.ok(rows[0].reminder_t2_sent_at, 'T-2h timestamp stamped')

  // The reminder is mirrored into the lead transcript.
  const l = await (await req('GET', `/api/leads/${lead.id}`)).json()
  assert.ok(l.messages.some((m) => m.role === 'agent' && /2 hours/.test(m.text)))
})

test('siteVisitWaReminders sends a T-1-day reminder for a next-day visit', async () => {
  const lead = await upsertLead(agentId, '919888830004', 'Tomorrow Tara')
  await createSiteVisit(agentId, {
    lead_id: lead.id,
    scheduled_at: new Date(Date.now() + 23 * 3600_000).toISOString(), // ~23h out -> T-1 window
  })
  const sent = []
  const fakeSend = async (to, text) => { sent.push(text); return 'wamid.T1' }
  assert.equal(await siteVisitWaRemindersForAgent(agentId, Date.now(), fakeSend), 1)
  assert.match(sent[0], /tomorrow/i)
})

test('siteVisitWaReminders is a no-op when WhatsApp is unconfigured (default sender)', async () => {
  const lead = await upsertLead(agentId, '919888830005', 'Quiet Qamar')
  await createSiteVisit(agentId, { lead_id: lead.id, scheduled_at: new Date(Date.now() + 90 * 60_000).toISOString() })
  assert.equal(await siteVisitWaRemindersForAgent(agentId), 0)
})
