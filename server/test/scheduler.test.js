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
  assert.match(fu[0].note, /No contact in 2\+ weeks/)
})

test('the follow-up for a never-messaged lead says so, instead of claiming silence', async () => {
  // The same rule catches two very different leads (see buildWorklist), and this job
  // writes a note the agent reads days later with no context but the sentence itself.
  // "Check in" is the wrong instruction for a lead that was typed in and never
  // written to — there is nothing to check back into.
  const lead = await upsertLead(agentId, '919888820009', 'Never Nandini')

  assert.equal(await generateStaleFollowupsForAgent(agentId), 1)

  const fu = await (await req('GET', `/api/followups?lead_id=${lead.id}`)).json()
  assert.equal(fu.length, 1)
  assert.doesNotMatch(fu[0].note, /2\+ weeks/)
  assert.match(fu[0].note, /never messaged/i)
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

test('detectHotLeads also nudges a Hot lead whose last message is still unanswered', async () => {
  const { recomputeLeadScore } = await import('../db.js')
  const lead = await upsertLead(agentId, '919888820090', 'Waiting Wasim')
  await applyExtraction(lead.id, { temp: 'Hot', score: 95 })
  await addMessage(lead.id, 'buyer', 'Can we see it this weekend?')
  await recomputeLeadScore(lead.id)

  const fired = await detectHotLeadsForAgent(agentId)
  assert.ok(fired >= 1)
  const notes = (
    await query(`SELECT * FROM notifications WHERE agent_id = $1 AND dedupe_key = $2`, [agentId, `hotwait:${lead.id}:${new Date().toISOString().slice(0, 10)}`])
  ).rows
  assert.equal(notes.length, 1)
  assert.match(notes[0].title, /Hot lead waiting/)
  assert.match(notes[0].body, /Score 95/)

  // Same day, same lead — deduped, so the agent isn't nagged every half hour.
  await detectHotLeadsForAgent(agentId)
  const again = (await query('SELECT COUNT(*)::int AS n FROM notifications WHERE agent_id = $1 AND dedupe_key = $2', [agentId, `hotwait:${lead.id}:${new Date().toISOString().slice(0, 10)}`])).rows[0]
  assert.equal(again.n, 1)
})

test('detectHotLeads stays quiet once the agent has answered the hot lead', async () => {
  const { recomputeLeadScore } = await import('../db.js')
  const lead = await upsertLead(agentId, '919888820091', 'Answered Anita')
  await applyExtraction(lead.id, { temp: 'Hot', score: 91 })
  await addMessage(lead.id, 'buyer', 'Interested')
  await addMessage(lead.id, 'agent', 'On it — sending options now.')
  await recomputeLeadScore(lead.id)

  await detectHotLeadsForAgent(agentId)
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM notifications WHERE agent_id = $1 AND entity_id = $2 AND type = 'hot_lead_waiting'`,
    [agentId, lead.id],
  )
  assert.equal(rows[0].n, 0, 'the last message is the agent’s — nothing is waiting')
})

// A job is now handed the WHOLE active agent list and does its work for all of them in
// a fixed number of statements, so what the tick has to survive is a failing JOB, not a
// failing agent: one job blowing up must not stop the seven behind it in runDueJobs.
test('runJobForAllAgents swallows a failing job so the rest of the tick still runs', async () => {
  const { runJobForAllAgents } = await import('../scheduler.js')
  const errs = []
  const realError = console.error
  console.error = (...a) => errs.push(a.join(' '))
  try {
    assert.equal(await runJobForAllAgents(async () => { throw new Error('boom') }), 0)
    assert.ok(errs.some((e) => /scheduler job failed/.test(e) && /boom/.test(e)))
  } finally {
    console.error = realError
  }
})

test('runJobForAllAgents treats a job returning nothing as zero actions', async () => {
  const { runJobForAllAgents } = await import('../scheduler.js')
  assert.equal(await runJobForAllAgents(async () => undefined), 0)
  assert.equal(await runJobForAllAgents(async () => null), 0)
})

test('runJobForAllAgents hands the job every active agent at once, and no deactivated one', async () => {
  const { runJobForAllAgents } = await import('../scheduler.js')
  const { createAgent } = await import('../db.js')
  const { hashPassword } = await import('../auth.js')
  const gone = await createAgent('Gone Girish', '+919800000079', null, hashPassword('secret123'))
  await query('UPDATE agents SET is_active = 0, deactivated_at = now() WHERE id = $1', [gone.id])

  const calls = []
  await runJobForAllAgents(async (ids) => { calls.push(ids); return 0 })
  assert.equal(calls.length, 1, 'one call for the whole customer base, not one per agent')
  assert.ok(calls[0].includes(agentId))
  assert.ok(!calls[0].includes(gone.id), 'a deactivated workspace gets no background work')
})

test('runJobForAllAgents does not even read the agent list twice when the caller has it', async () => {
  const { runJobForAllAgents } = await import('../scheduler.js')
  const seen = []
  await runJobForAllAgents(async (ids, now) => { seen.push([ids, now]); return 3 }, [agentId], 12345)
  assert.deepEqual(seen, [[[agentId], 12345]])
})

test('a tick with no active agents at all does no work rather than querying for none', async () => {
  const { runJobForAllAgents } = await import('../scheduler.js')
  let ran = false
  assert.equal(await runJobForAllAgents(async () => { ran = true; return 9 }, []), 0)
  assert.equal(ran, false)
})
