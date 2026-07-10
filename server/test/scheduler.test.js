// Integration tests for the background scheduler jobs and the notification queue.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('scheduler')

const { app } = await import('../index.js')
const {
  closePool, query, upsertLead, addMessage, applyExtraction,
  createProperty, recordPropertyView, createSiteVisit, createCommission,
} = await import('../db.js')
const {
  serviceWindowWatchForAgent, detectHotLeadsForAgent, generateStaleFollowupsForAgent,
  siteVisitRemindersForAgent, commissionOverdueSweepForAgent, runDueJobs, recomputeScoresForAgent,
} = await import('../scheduler.js')

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
  const out = await (await req('POST', '/api/auth/signup', { name: 'Sched Agent', phone: '+919800000071', password: 'secret123' })).json()
  token = out.token
  agentId = out.agent.id
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

test('serviceWindowWatch notifies once per closing window (dedupe)', async () => {
  const lead = await upsertLead(agentId, '919888820001', 'Closing Chandra')
  await addMessage(lead.id, 'buyer', 'thinking about it')
  await backdateInbound(lead.id, 22) // window closes in ~2h

  assert.equal(await serviceWindowWatchForAgent(agentId), 1)
  assert.equal(await serviceWindowWatchForAgent(agentId), 0, 'same window does not re-notify')

  const { notifications, unread } = await (await req('GET', '/api/notifications')).json()
  const n = notifications.find((x) => x.entity_id === lead.id && x.type === 'service_window_closing')
  assert.ok(n)
  assert.ok(unread >= 1)
})

test('detectHotLeads fires on repeat micro-page views', async () => {
  const lead = await upsertLead(agentId, '919888820002', 'Clicker Chetan')
  await addMessage(lead.id, 'buyer', 'nice flat')
  const prop = await createProperty(agentId, { title: 'View Villa', locality: 'Kharadi', city: 'Pune' })
  for (let i = 0; i < 3; i++) await recordPropertyView(prop.id, null, lead.id)

  assert.equal(await detectHotLeadsForAgent(agentId), 1)
  assert.equal(await detectHotLeadsForAgent(agentId), 0, 'deduped for the day')

  const { notifications } = await (await req('GET', '/api/notifications?unread=1')).json()
  assert.ok(notifications.some((x) => x.entity_id === lead.id && x.type === 'hot_lead_waiting'))
})

test('generateStaleFollowups creates one AI-suggested follow-up and never nags twice', async () => {
  const lead = await upsertLead(agentId, '919888820003', 'Quiet Qadir')
  await addMessage(lead.id, 'buyer', 'will think')
  await backdateMessages(lead.id, 20)

  assert.equal(await generateStaleFollowupsForAgent(agentId), 1)
  assert.equal(await generateStaleFollowupsForAgent(agentId), 0, 'open follow-up already exists')

  const fu = await (await req('GET', `/api/followups?lead_id=${lead.id}`)).json()
  assert.equal(fu.length, 1)
  assert.equal(fu[0].type, 'ai_suggested')
})

test('siteVisitReminders notify the evening before', async () => {
  const lead = await upsertLead(agentId, '919888820004', 'Visit Vidya')
  await addMessage(lead.id, 'buyer', 'saturday works')
  await createSiteVisit(agentId, { lead_id: lead.id, scheduled_at: new Date(Date.now() + 20 * 3600_000).toISOString() })

  assert.equal(await siteVisitRemindersForAgent(agentId), 1)
  assert.equal(await siteVisitRemindersForAgent(agentId), 0, 'one reminder per visit')
})

test('commissionOverdueSweep flips expected->overdue and notifies', async () => {
  const lead = await upsertLead(agentId, '919888820005', 'Owed Om')
  await createCommission(agentId, { lead_id: lead.id, deal_value_paise: 10_000_000_00, commission_pct: 1, expected_payout_date: '2020-01-01', status: 'expected' })

  assert.equal(await commissionOverdueSweepForAgent(agentId), 1)
  const c = (await query('SELECT status FROM commissions WHERE lead_id = $1', [lead.id])).rows[0]
  assert.equal(c.status, 'overdue')
})

test('notification lifecycle: mark one read, then mark all read', async () => {
  const before = await (await req('GET', '/api/notifications')).json()
  assert.ok(before.unread > 0)
  const first = before.notifications.find((n) => !n.read_at)
  const marked = await (await req('PUT', `/api/notifications/${first.id}/read`)).json()
  assert.ok(marked.read_at)
  assert.equal((await req('PUT', `/api/notifications/${first.id}/read`)).status, 404) // already read

  await req('POST', '/api/notifications/read-all')
  const after = await (await req('GET', '/api/notifications')).json()
  assert.equal(after.unread, 0)
})

test('runDueJobs respects per-job cadence via the meta table', async () => {
  const now = Date.now()
  const first = await runDueJobs(now)
  assert.ok('service_window' in first, 'all jobs run on a cold start')
  // Immediately again: nothing is due (cadence not elapsed).
  const second = await runDueJobs(now + 1000)
  assert.deepEqual(second, {})
  // Far in the future: the tight-cadence jobs come due again.
  const later = await runDueJobs(now + 20 * 60_000)
  assert.ok('service_window' in later)
  assert.ok(!('commissions' in later), 'daily job is not yet due after 20 minutes')
})

test('recomputeScoresForAgent returns the number of live leads scored', async () => {
  const n = await recomputeScoresForAgent(agentId)
  assert.ok(n >= 1)
})
