// The once-a-minute tick, as a deploy actually runs it.
//
// index.js boots a single setInterval that calls deliverDueFestiveSchedules() and
// runDueJobs(). serverProcess.test.js proves that timer is wired and survives; the
// individual jobs each have their own suite. What neither covers is the seam between
// them: one call to runDueJobs() on a real agency's data, with WhatsApp configured and
// the Graph API the only thing stubbed.
//
// That seam is where the failures an agency actually reports live. A reminder job that
// works when called directly can still never fire because the cadence table says it ran
// (it didn't), or fire twice because the guard column is stamped before the send rather
// than after, or fire once and then never again because a Graph API blip was recorded
// as a success. None of those are visible from inside a single job's own test — every
// one of them needs a second tick to see.
//
// Everything here goes through runDueJobs(), never a *ForAgent helper, and reads its
// results back through the API the agent's screens use.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
process.env.WHATSAPP_ACCESS_TOKEN = 'tick-access-token'
process.env.WHATSAPP_PHONE_NUMBER_ID = 'tick-phone-id'
const dbName = await createTestDb('scheduledtick')

const { app } = await import('../index.js')
const { closePool, query, addMessage } = await import('../db.js')
const { runDueJobs } = await import('../scheduler.js')

const MIN = 60_000
const HOUR = 3600_000

let server, base, token, agentId
let waSends = []
let waFails = false
let sendSeq = 0
const realFetch = global.fetch

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
const json = async (...args) => (await req(...args)).json()

const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString()

// Far enough on that every job these tests watch is due again (the longest of them
// runs every 30 minutes), but not so far that an upcoming visit has been and gone —
// the reminder job only looks at visits still ahead of `now`.
const NEXT_DUE_TICK = () => Date.now() + 31 * MIN

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })

  global.fetch = async (url, opts) => {
    const target = String(url)
    if (target.includes('graph.facebook.com')) {
      if (waFails) return { ok: false, status: 500, headers: { get: () => null }, text: async () => 'upstream boom' }
      let body = null
      try {
        body = JSON.parse(opts?.body ?? '{}')
      } catch {
        body = null
      }
      waSends.push({ to: body?.to, text: body?.text?.body ?? '', body })
      sendSeq++
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ messages: [{ id: `wamid.tick.${sendSeq}` }] }),
      }
    }
    return realFetch(url, opts)
  }

  const me = await json(
    'POST',
    '/api/auth/signup',
    { name: 'Tick Agent', phone: '+919700000201', password: 'secret123' },
    null,
  )
  token = me.token
  agentId = me.agent.id
  await query('UPDATE agents SET wa_phone_number_id = $2, wa_phone_number = $3 WHERE id = $1', [
    agentId,
    'tick-phone-id',
    '+919700000201',
  ])
})

after(async () => {
  global.fetch = realFetch
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

beforeEach(() => {
  waSends = []
  waFails = false
})

// The cadence table is process-wide state that every test here shares, so each one
// starts by clearing it — otherwise the first test to run leaves every job "recently
// run" and the rest silently do nothing at all.
const forgetCadences = () => query(`DELETE FROM meta WHERE key LIKE 'job:%:last_run'`)

test('FLOW one tick sends the T-2h reminder for a booked visit, and puts it in the thread', async () => {
  await forgetCadences()
  const lead = (await json('POST', '/api/leads/quick-add', { phone: '+919611300001', name: 'Rohit Kale' })).lead
  const property = await json('POST', '/api/properties', { title: 'Hilltop Residency', locality: 'Wakad', city: 'Pune' })
  const booked = await json('POST', '/api/site-visits', {
    lead_id: lead.id,
    property_id: property.id,
    scheduled_at: iso(90 * MIN),
  })
  // Booking sends its own confirmation. That is a different message from a different
  // code path, so it is acknowledged and cleared rather than left to be miscounted as
  // the tick's work.
  assert.equal(booked.confirmation_sent, true, 'the booking confirmation never went out')
  assert.equal(waSends.length, 1)
  waSends = []

  const results = await runDueJobs()

  // Every job is due on a tick that has never run, so this also pins that the table is
  // walked in full — a job dropped out of JOBS would stop appearing here.
  assert.deepEqual(
    Object.keys(results).sort(),
    ['commissions', 'hot_leads', 'no_response', 'scores', 'service_window', 'site_visit_wa', 'site_visits', 'stale_followups'],
    'the tick did not run every job it owes',
  )
  assert.equal(results.site_visit_wa, 1, 'the tick did not send the visit reminder')

  // 1. It reached Meta, addressed to this buyer, and carries the pin that makes the
  //    T-2h reminder worth sending at all.
  assert.equal(waSends.length, 1, `the tick sent ${waSends.length} messages, expected 1`)
  assert.equal(waSends[0].to, '919611300001')
  assert.match(waSends[0].text, /Hilltop Residency/)

  // 2. And it is in the transcript the agent reads, so they are not left replying to a
  //    buyer about a message they cannot see.
  const thread = await json('GET', `/api/leads/${lead.id}`)
  assert.ok(
    thread.messages.some((m) => m.role === 'agent' && /Hilltop Residency/.test(m.text)),
    'the reminder went out but never appeared in the conversation',
  )

  // 3. With the activity line that says it was the system, not the agent, who sent it.
  const { rows } = await query(
    `SELECT text FROM activity WHERE lead_id = $1 AND text LIKE 'Auto site-visit reminder%'`,
    [lead.id],
  )
  assert.equal(rows.length, 1, 'the automated send was not logged as automated')
})

test('FLOW the next tick does not remind the same buyer again', async () => {
  await forgetCadences()
  const lead = (await json('POST', '/api/leads/quick-add', { phone: '+919611300002', name: 'Sneha Patil' })).lead
  await json('POST', '/api/site-visits', { lead_id: lead.id, scheduled_at: iso(90 * MIN) })
  waSends = [] // the booking confirmation; the tick's reminder is what is being counted

  assert.equal((await runDueJobs()).site_visit_wa, 1)
  assert.equal(waSends.length, 1)

  // A day later every cadence has elapsed, so the job genuinely runs a second time —
  // this is the guard column being asserted, not the cadence table hiding the job.
  waSends = []
  const second = await runDueJobs(NEXT_DUE_TICK())
  assert.ok('site_visit_wa' in second, 'the second tick skipped the job instead of running it')
  assert.equal(second.site_visit_wa, 0, 'the buyer was reminded twice about one visit')
  assert.equal(waSends.length, 0)
})

test('FLOW a tick a minute later does no work at all', async () => {
  await forgetCadences()
  const first = await runDueJobs()
  assert.ok(Object.keys(first).length > 0, 'the first tick was supposed to run everything')

  // The tightest cadence in the table is 10 minutes. A minute after a full tick, the
  // right amount of work is none — this is what stops sixty ticks an hour turning into
  // sixty score recomputes and sixty passes over every open lead.
  const results = await runDueJobs(Date.now() + MIN)
  assert.deepEqual(results, {}, `a tick one minute on ran ${Object.keys(results).join(', ')}`)
})

test('FLOW a buyer left waiting is nudged by the tick, on the screen the agent checks', async () => {
  await forgetCadences()
  const lead = (await json('POST', '/api/leads/quick-add', { phone: '+919611300003', name: 'Waiting Wasim' })).lead
  await addMessage(lead.id, 'buyer', 'Is the Wakad flat still available?')
  await query(`UPDATE leads SET last_inbound_at = now() - interval '45 minutes' WHERE id = $1`, [lead.id])

  await runDueJobs()

  const { notifications } = await json('GET', '/api/notifications?unread=1')
  const nudge = notifications.find((n) => n.type === 'no_response_nudge' && n.entity_id === lead.id)
  assert.ok(nudge, 'a buyer waiting 45 minutes for a first reply was never flagged')
  assert.match(nudge.title, /Waiting Wasim/)

  // A second tick a day on must not nudge again for the same waiting spell: the agent
  // has one unanswered lead, and two notifications would say they have two.
  await runDueJobs(NEXT_DUE_TICK())
  const after = await json('GET', '/api/notifications?unread=1')
  assert.equal(
    after.notifications.filter((n) => n.type === 'no_response_nudge' && n.entity_id === lead.id).length,
    1,
    'the same unanswered lead was nudged twice',
  )
})

test('FLOW a Graph API failure mid-tick leaves the reminder to be retried, not lost', async () => {
  await forgetCadences()
  const lead = (await json('POST', '/api/leads/quick-add', { phone: '+919611300004', name: 'Unlucky Umesh' })).lead
  const visit = await json('POST', '/api/site-visits', { lead_id: lead.id, scheduled_at: iso(2 * HOUR) })
  const before = (await json('GET', `/api/leads/${lead.id}`)).messages.filter((m) => m.role === 'agent').length

  // Meta is down for this tick. The job has to survive it — a throw here would take the
  // rest of the tick's work with it — and, crucially, must not stamp the guard column.
  waFails = true
  waSends = []
  assert.equal((await runDueJobs()).site_visit_wa, 0, 'a failed send was counted as delivered')

  const stamped = await query('SELECT reminder_t2_sent_at FROM site_visits WHERE id = $1', [visit.id])
  assert.equal(
    stamped.rows[0].reminder_t2_sent_at,
    null,
    'a send that never happened was recorded as sent, so the buyer never gets reminded',
  )
  const thread = await json('GET', `/api/leads/${lead.id}`)
  assert.equal(
    thread.messages.filter((m) => m.role === 'agent').length,
    before,
    'a message that failed to send was still mirrored into the transcript',
  )

  // Meta is back. The next tick delivers the reminder the buyer never got.
  waFails = false
  waSends = []
  assert.equal((await runDueJobs(NEXT_DUE_TICK())).site_visit_wa, 1, 'the retry never happened')
  assert.equal(waSends.length, 1)
  assert.equal(waSends[0].to, '919611300004')
})
