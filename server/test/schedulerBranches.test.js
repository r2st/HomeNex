// Branch coverage for scheduler.js: the arms the happy-path suites never take —
// a lead with no name, a visit already reminded, a send that fails mid-tick, an
// agent that no longer exists, and the explicit-limit form of the stale sweep.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('schedbranches')

const { app } = await import('../index.js')
const {
  closePool, query, upsertLead, addMessage, applyExtraction, recomputeLeadScore,
  createProperty, recordPropertyView, createSiteVisit, createCommission, createCommissionInvoice,
} = await import('../db.js')
const {
  serviceWindowWatchForAgent, detectHotLeadsForAgent, generateStaleFollowupsForAgent,
  siteVisitRemindersForAgent, noResponseNudgeForAgent, siteVisitWaRemindersForAgent,
  commissionOverdueSweepForAgent,
} = await import('../scheduler.js')

let server, base, token, agentId
const MISSING = 987654

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
const notification = async (dedupeKey) =>
  (await query('SELECT * FROM notifications WHERE agent_id = $1 AND dedupe_key = $2', [agentId, dedupeKey])).rows[0]

// Runs fn with console.error captured, so an expected failure doesn't spam the report.
const quietly = async (fn) => {
  const lines = []
  const real = console.error
  console.error = (...a) => lines.push(a.join(' '))
  try {
    return { result: await fn(), errors: lines }
  } finally {
    console.error = real
  }
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const out = await (
    await req('POST', '/api/auth/signup', { name: 'Branch Bina', phone: '+919750000001', password: 'secret123' })
  ).json()
  token = out.token
  agentId = out.agent.id
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- A lead with no name is addressed by its number ---------------------------

test('every notification falls back to the WhatsApp number when the lead is unnamed', async () => {
  const waId = '919750010001'
  const lead = await upsertLead(agentId, waId, null)
  assert.equal(lead.name, null, 'an inbound number with no profile name')
  await addMessage(lead.id, 'buyer', 'price?')
  await backdateInbound(lead.id, 22)

  // Service-window watch.
  assert.equal(await serviceWindowWatchForAgent(agentId), 1)
  const windowHour = Math.floor(new Date((await query('SELECT last_inbound_at FROM leads WHERE id = $1', [lead.id])).rows[0].last_inbound_at).getTime() / 3600_000)
  assert.match((await notification(`sw:${lead.id}:${windowHour}`)).title, new RegExp(waId))

  // No-response nudge (no agent/AI reply has ever gone out on this lead).
  assert.equal(await noResponseNudgeForAgent(agentId), 1)
  assert.match((await notification(`noresp:${lead.id}:${windowHour}`)).title, new RegExp(waId))

  // Hot-lead "waiting on you" alert.
  await applyExtraction(lead.id, { temp: 'Hot', score: 88 })
  await recomputeLeadScore(lead.id)
  await detectHotLeadsForAgent(agentId)
  const day = new Date().toISOString().slice(0, 10)
  assert.match((await notification(`hotwait:${lead.id}:${day}`)).title, new RegExp(waId))

  // Repeat-view alert.
  const prop = await createProperty(agentId, { title: 'Anon Heights', locality: 'Wakad', city: 'Pune' })
  for (let i = 0; i < 3; i++) await recordPropertyView(prop.id, null, lead.id)
  await detectHotLeadsForAgent(agentId)
  assert.match((await notification(`hotview:${lead.id}:${day}`)).title, new RegExp(waId))

  // Site-visit reminder.
  const visit = await createSiteVisit(agentId, {
    lead_id: lead.id,
    property_id: prop.id,
    scheduled_at: new Date(Date.now() + 20 * 3600_000).toISOString(),
  })
  assert.equal(await siteVisitRemindersForAgent(agentId), 1)
  const note = await notification(`visit:${visit.id}`)
  assert.match(note.title, new RegExp(waId))
  assert.match(note.body, /for Anon Heights/, 'the property title is named when there is one')
})

test('a site-visit reminder without a property reads cleanly', async () => {
  const lead = await upsertLead(agentId, '919750010002', 'Bare Bhavna')
  const visit = await createSiteVisit(agentId, {
    lead_id: lead.id,
    scheduled_at: new Date(Date.now() + 18 * 3600_000).toISOString(),
  })
  assert.equal(await siteVisitRemindersForAgent(agentId), 1)
  const note = await notification(`visit:${visit.id}`)
  assert.match(note.body, /^Site visit is coming up/, 'no dangling "for undefined"')
})

test('an overdue commission on an unnamed lead is still chaseable', async () => {
  const lead = await upsertLead(agentId, '919750010003', null)
  await createCommission(agentId, {
    lead_id: lead.id,
    deal_value_paise: 5_000_000_00,
    commission_pct: 2,
    expected_payout_date: '2020-01-01',
    status: 'expected',
  })
  assert.equal(await commissionOverdueSweepForAgent(agentId), 1)
  const { rows } = await query(
    `SELECT * FROM notifications WHERE agent_id = $1 AND type = 'commission_overdue'`,
    [agentId],
  )
  assert.match(rows[0].body, /919750010003/, 'the number stands in for the missing name')
})

// The sweep flips every overdue row in one statement and joins the lead in with it,
// so a second overdue deal must still get its own, correctly-named notification.
test('one sweep chases every overdue commission, each named after its own lead', async () => {
  const leads = await Promise.all([
    upsertLead(agentId, '919750010004', 'Overdue Ojas'),
    upsertLead(agentId, '919750010005', 'Overdue Ira'),
  ])
  for (const lead of leads) {
    await createCommission(agentId, {
      lead_id: lead.id,
      deal_value_paise: 3_000_000_00,
      commission_pct: 2,
      expected_payout_date: '2020-01-01',
      status: 'expected',
    })
  }
  assert.equal(await commissionOverdueSweepForAgent(agentId), 2)
  const { rows } = await query(
    `SELECT body FROM notifications
     WHERE agent_id = $1 AND type = 'commission_overdue' AND (body LIKE '%Ojas%' OR body LIKE '%Ira%')
     ORDER BY body`,
    [agentId],
  )
  assert.deepEqual(rows.map((r) => r.body.match(/Overdue \w+/)[0]), ['Overdue Ira', 'Overdue Ojas'])
  const stillExpected = (
    await query(`SELECT COUNT(*)::int AS n FROM commissions WHERE agent_id = $1 AND status = 'expected'`, [agentId])
  ).rows[0].n
  assert.equal(stillExpected, 0, 'nothing overdue is left behind')
})

// The regression the sweep was written around: an invoiced commission is money the
// agent has already billed for and still not been paid, so it is the one most worth
// chasing — but it used to be excluded from the sweep entirely.
test('an invoiced commission past its payout date goes overdue and names the invoice', async () => {
  const lead = await upsertLead(agentId, '919750010006', 'Invoiced Isha')
  const commission = await createCommission(agentId, {
    lead_id: lead.id,
    commission_flat_paise: 2_50_000,
    payer_type: 'builder',
    expected_payout_date: '2020-01-01',
    status: 'expected',
  })
  const invoice = await createCommissionInvoice(agentId, commission.id)
  assert.equal(
    (await query('SELECT status FROM commissions WHERE id = $1', [commission.id])).rows[0].status,
    'invoiced',
    'raising the invoice advances the commission',
  )

  assert.equal(await commissionOverdueSweepForAgent(agentId), 1)
  assert.equal(
    (await query('SELECT status FROM commissions WHERE id = $1', [commission.id])).rows[0].status,
    'overdue',
  )
  const note = await notification(`commov:${commission.id}`)
  assert.match(note.body, new RegExp(invoice.invoice_number), 'the agent is told which invoice to chase')
  assert.match(note.body, /Invoiced Isha/)
  assert.match(note.body, /Chase the payment/, 'invoiced money is chased, not re-invoiced')
})

// The commission carries the 'invoiced' status even when its only invoice was
// cancelled, so the body has no number to quote and must not print "undefined".
test('an invoiced commission whose invoice was cancelled still reads cleanly', async () => {
  const lead = await upsertLead(agentId, '919750010007', 'Cancelled Kabir')
  const commission = await createCommission(agentId, {
    lead_id: lead.id,
    commission_flat_paise: 1_00_000,
    payer_type: 'builder',
    expected_payout_date: '2020-01-01',
    status: 'expected',
  })
  const invoice = await createCommissionInvoice(agentId, commission.id)
  await query(`UPDATE commission_invoices SET status = 'cancelled' WHERE id = $1`, [invoice.id])

  assert.equal(await commissionOverdueSweepForAgent(agentId), 1)
  const note = await notification(`commov:${commission.id}`)
  assert.doesNotMatch(note.body, /undefined|null/, 'no dangling placeholder for the missing number')
  assert.match(note.body, /invoiced and past its payout date/)
  assert.match(note.body, /Cancelled Kabir/)
})

// 'received' is paid and 'overdue' is already flagged; sweeping either would
// re-open settled money or double-notify.
test('the sweep leaves received and already-overdue commissions alone', async () => {
  const lead = await upsertLead(agentId, '919750010008', 'Settled Sana')
  const made = {}
  for (const status of ['received', 'overdue']) {
    made[status] = await createCommission(agentId, {
      lead_id: lead.id,
      commission_flat_paise: 5_00_000,
      expected_payout_date: '2020-01-01',
      status,
    })
  }
  assert.equal(await commissionOverdueSweepForAgent(agentId), 0, 'nothing to sweep')
  assert.equal(
    (await query('SELECT status FROM commissions WHERE id = $1', [made.received.id])).rows[0].status,
    'received',
    'paid money stays paid',
  )
  assert.equal(
    (await query('SELECT COUNT(*)::int AS n FROM notifications WHERE agent_id = $1 AND dedupe_key = $2', [
      agentId,
      `commov:${made.overdue.id}`,
    ])).rows[0].n,
    0,
    'a row that was already overdue is not announced again',
  )
})

// A commission with no payout date has no date to be past, whichever status it holds.
test('a commission with no expected payout date is never swept', async () => {
  const lead = await upsertLead(agentId, '919750010009', 'Undated Uma')
  const commission = await createCommission(agentId, {
    lead_id: lead.id,
    commission_flat_paise: 3_00_000,
    status: 'expected',
  })
  await createCommissionInvoice(agentId, commission.id)
  assert.equal(await commissionOverdueSweepForAgent(agentId), 0)
  assert.equal(
    (await query('SELECT status FROM commissions WHERE id = $1', [commission.id])).rows[0].status,
    'invoiced',
  )
})

// The sweep runs daily, so the same overdue row is seen again tomorrow. The status
// flip takes it out of the WHERE clause, and the dedupe key is the backstop.
test('a second sweep does not re-announce a commission it already chased', async () => {
  const lead = await upsertLead(agentId, '919750010010', 'Repeat Rhea')
  const commission = await createCommission(agentId, {
    lead_id: lead.id,
    commission_flat_paise: 4_00_000,
    expected_payout_date: '2020-01-01',
    status: 'expected',
  })
  assert.equal(await commissionOverdueSweepForAgent(agentId), 1)
  assert.equal(await commissionOverdueSweepForAgent(agentId), 0, 'the flip makes the sweep idempotent')
  assert.equal(
    (await query('SELECT COUNT(*)::int AS n FROM notifications WHERE agent_id = $1 AND dedupe_key = $2', [
      agentId,
      `commov:${commission.id}`,
    ])).rows[0].n,
    1,
    'exactly one notification for one commission',
  )
})

// --- Stale follow-up sweep ----------------------------------------------------

test('the stale sweep honours an explicit limit', async () => {
  for (const n of [1, 2, 3]) {
    const lead = await upsertLead(agentId, `9197500200${n}0`, `Quiet ${n}`)
    await addMessage(lead.id, 'buyer', 'will think about it')
    await backdateMessages(lead.id, 30)
  }
  assert.equal(await generateStaleFollowupsForAgent(agentId, { limit: 2 }), 2, 'capped at the limit')
  assert.ok((await generateStaleFollowupsForAgent(agentId)) >= 1, 'the rest come through on the next pass')
})

// --- WhatsApp site-visit reminders --------------------------------------------

// Every delivered reminder is mirrored into the transcript keyed by its wamid, and
// that column is uniquely indexed — so the fake sender has to mint a fresh id per
// send, exactly as the Graph API does.
let wamidSeq = 0
const fakeSender = () => {
  const sent = []
  return [sent, async (to, text) => (sent.push({ to, text }), `wamid.BRANCH.${++wamidSeq}`)]
}

// The reminder job sweeps every upcoming visit an agent has, so each test below
// gets its own workspace — otherwise one test's leftovers are another's send count.
let phoneSeq = 0
const newAgent = async () => {
  const phone = `+91975003${String(++phoneSeq).padStart(4, '0')}`
  const out = await (
    await req('POST', '/api/auth/signup', { name: `Visit ${phoneSeq}`, phone, password: 'secret123' }, null)
  ).json()
  return out.agent.id
}

test('the WhatsApp reminder job is a no-op for an agent that no longer exists', async () => {
  const [, send] = fakeSender()
  assert.equal(await siteVisitWaRemindersForAgent(MISSING, Date.now(), send), 0)
})

test('a visit more than 25 hours out is too early to remind', async () => {
  const id = await newAgent()
  const lead = await upsertLead(id, '919751030001', 'Early Esha')
  const now = Date.now()
  await createSiteVisit(id, { lead_id: lead.id, scheduled_at: new Date(now + 25.5 * 3600_000).toISOString() })

  const [sent, send] = fakeSender()
  // Inside the 26h query window but outside the T-1 reminder band.
  assert.equal(await siteVisitWaRemindersForAgent(id, now, send), 0)
  assert.equal(sent.length, 0)
})

test('a visit that already got its reminder is skipped, in both bands', async () => {
  const id = await newAgent()
  const lead = await upsertLead(id, '919751030002', 'Done Deepa')
  const now = Date.now()
  const soon = await createSiteVisit(id, { lead_id: lead.id, scheduled_at: new Date(now + 90 * 60_000).toISOString() })
  const tomorrow = await createSiteVisit(id, { lead_id: lead.id, scheduled_at: new Date(now + 23 * 3600_000).toISOString() })
  await query('UPDATE site_visits SET reminder_t2_sent_at = now() WHERE id = $1', [soon.id])
  await query('UPDATE site_visits SET reminder_t1_sent_at = now() WHERE id = $1', [tomorrow.id])

  const [sent, send] = fakeSender()
  assert.equal(await siteVisitWaRemindersForAgent(id, now, send), 0)
  assert.equal(sent.length, 0, 'neither band re-sends')
})

test('a reminder renders in the agent’s own timezone', async () => {
  const id = await newAgent()
  await query('UPDATE agents SET timezone = $2 WHERE id = $1', [id, 'Asia/Dubai'])
  const lead = await upsertLead(id, '919751030003', 'Gulf Gita')
  const now = Date.now()
  const at = new Date(now + 90 * 60_000)
  await createSiteVisit(id, { lead_id: lead.id, scheduled_at: at.toISOString() })

  const [sent, send] = fakeSender()
  assert.equal(await siteVisitWaRemindersForAgent(id, now, send), 1)
  const dubai = at.toLocaleString('en-IN', {
    timeZone: 'Asia/Dubai', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  })
  assert.ok(sent[0].text.includes(dubai), `expected the Dubai time in:\n${sent[0].text}`)
})

test('a failed send is logged and left unstamped, so the next tick retries it', async () => {
  const id = await newAgent()
  const lead = await upsertLead(id, '919751030004', 'Flaky Farhan')
  const now = Date.now()
  const visit = await createSiteVisit(id, { lead_id: lead.id, scheduled_at: new Date(now + 90 * 60_000).toISOString() })

  const failing = async () => {
    throw new Error('Graph API is down')
  }
  const { result, errors } = await quietly(() => siteVisitWaRemindersForAgent(id, now, failing))
  assert.equal(result, 0, 'nothing counted as delivered')
  assert.ok(errors.some((e) => /site-visit reminder failed for visit/.test(e) && /Graph API is down/.test(e)))

  const { rows } = await query('SELECT reminder_t2_sent_at FROM site_visits WHERE id = $1', [visit.id])
  assert.equal(rows[0].reminder_t2_sent_at, null, 'not marked sent, so it will be retried')

  // And the retry does go through once the sender recovers.
  const [sent, send] = fakeSender()
  assert.equal(await siteVisitWaRemindersForAgent(id, now, send), 1)
  assert.equal(sent.length, 1)
})

test('one failing visit does not stop the others in the same tick', async () => {
  const id = await newAgent()
  const now = Date.now()
  const ids = []
  for (const n of [1, 2]) {
    const lead = await upsertLead(id, `91975104000${n}`, `Batch ${n}`)
    ids.push((await createSiteVisit(id, {
      lead_id: lead.id,
      scheduled_at: new Date(now + 90 * 60_000).toISOString(),
    })).id)
  }
  let calls = 0
  const flaky = async () => {
    if (++calls === 1) throw new Error('first one fails')
    return 'wamid.OK'
  }
  const { result } = await quietly(() => siteVisitWaRemindersForAgent(id, now, flaky))
  assert.equal(result, 1, 'the second visit still went out')
  const stamped = (
    await query('SELECT COUNT(*)::int AS n FROM site_visits WHERE id = ANY($1) AND reminder_t2_sent_at IS NOT NULL', [ids])
  ).rows[0].n
  assert.equal(stamped, 1)
})

// --- The WhatsApp reminder's two per-visit fallbacks ---------------------------

test('a WhatsApp reminder for an unnamed lead is addressed to its number', async () => {
  const id = await newAgent()
  const waId = '919751050001'
  const lead = await upsertLead(id, waId, null)
  assert.equal(lead.name, null, 'the fixture must be the unnamed case')
  const now = Date.now()
  await createSiteVisit(id, { lead_id: lead.id, scheduled_at: new Date(now + 90 * 60_000).toISOString() })

  const [sent, send] = fakeSender()
  assert.equal(await siteVisitWaRemindersForAgent(id, now, send), 1)
  assert.equal(sent.length, 1)
  // The activity log is the agent-facing record of the automated send, and an
  // unnamed lead must still be identifiable in it.
  const { rows } = await query(
    `SELECT text FROM activity WHERE agent_id = $1 AND lead_id = $2 AND kind = 'agent' ORDER BY id DESC LIMIT 1`,
    [id, lead.id],
  )
  assert.equal(rows[0].text, `Auto site-visit reminder sent to ${waId}`)
})

test('a reminder mid-Hinglish thread is written in the buyer’s own language', async () => {
  const id = await newAgent()
  const lead = await upsertLead(id, '919751050002', 'Hinglish Hetal')
  // The transcript is what detectConversationLanguage reads; without it the reminder
  // falls back to English, which is the arm the other reminder tests already take.
  await addMessage(lead.id, 'buyer', 'bhai 2bhk chahiye wakad me, budget 80 tak hai')
  await addMessage(lead.id, 'buyer', 'kal site visit ka time theek rahega kya')
  const now = Date.now()
  await createSiteVisit(id, { lead_id: lead.id, scheduled_at: new Date(now + 90 * 60_000).toISOString() })

  const [sent, send] = fakeSender()
  assert.equal(await siteVisitWaRemindersForAgent(id, now, send), 1)
  assert.equal(sent.length, 1)
  assert.match(
    sent[0].text,
    /Aapki site visit ~2 ghante mein hai/,
    'the T-2h reminder must be the Hinglish copy, not the English default',
  )
})
