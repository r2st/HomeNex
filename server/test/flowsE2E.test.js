// End-to-end journeys through the real HTTP stack.
//
// Every other server test file exercises one route or one helper. This one follows
// a lead the way an agent actually experiences it — a buyer messages the business
// number, the webhook turns that into a lead, the lead is scored, a site visit is
// booked, a template goes out, and each of those has to show up in the screens the
// agent looks at next (inbox, dashboard, worklist, activity).
//
// The value is in the seams: a route can pass its own unit test and still fail to
// stamp the thing the NEXT screen reads. Assertions here deliberately cross those
// boundaries rather than re-checking a single response body.
//
// Outbound Graph API calls are stubbed at global.fetch so sends are observable
// without touching Meta; requests to the local test server pass straight through.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
process.env.WHATSAPP_APP_SECRET = 'e2e-app-secret'
process.env.WHATSAPP_VERIFY_TOKEN = 'e2e-verify-token'
process.env.WHATSAPP_ACCESS_TOKEN = 'e2e-access-token'
process.env.WHATSAPP_PHONE_NUMBER_ID = 'e2e-phone-id'
const dbName = await createTestDb('flowse2e')

const { app } = await import('../index.js')
const { closePool, query, serviceWindow } = await import('../db.js')

let server
let base
let token
let agentId
const APP_SECRET = 'e2e-app-secret'

// Every outbound Graph API call made during a test, in order. Reset per test.
let waSends = []
// The stubbed wa_message_id must be globally unique, NOT per-test: messages carry a
// unique index on wa_message_id (migration 015, the webhook dedupe gate), so reusing
// an id across tests would collide the way a genuine Meta redelivery does.
let sendSeq = 0
const realFetch = global.fetch

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

const json = async (...args) => (await req(...args)).json()

// A signed inbound WhatsApp text message, exactly as Meta delivers it.
const inboundPayload = ({ from, name, text, messageId, phoneNumberId = 'e2e-phone-id', type = 'text', extra = {} }) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: phoneNumberId },
            contacts: [{ profile: { name }, wa_id: from }],
            messages: [{ from, id: messageId, timestamp: '1', type, ...(type === 'text' ? { text: { body: text } } : {}), ...extra }],
          },
        },
      ],
    },
  ],
})

const postWebhook = (payload) => {
  const raw = JSON.stringify(payload)
  return fetch(base + '/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex'),
    },
    body: raw,
  })
}

// Poll until a condition holds — the webhook acks Meta immediately and finishes
// the pipeline afterwards, so nothing downstream is readable synchronously.
async function until(fn, what = 'condition', timeoutMs = 5000) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

const leadByWaId = async (waId) =>
  (await query('SELECT * FROM leads WHERE agent_id = $1 AND wa_id = $2', [agentId, waId])).rows[0] || null

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })

  // Intercept Graph API traffic only; the suite's own HTTP calls must still work.
  global.fetch = async (url, opts) => {
    const target = String(url)
    if (target.includes('graph.facebook.com')) {
      let body = null
      try {
        body = JSON.parse(opts?.body ?? '{}')
      } catch {
        body = null
      }
      waSends.push({ url: target, body })
      sendSeq++
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ messages: [{ id: `wamid.stub.${sendSeq}` }] }),
      }
    }
    return realFetch(url, opts)
  }

  const me = await json('POST', '/api/auth/signup', {
    name: 'Priya Nair',
    phone: '+919600000001',
    password: 'secret123',
  }, null)
  token = me.token
  agentId = me.agent.id

  // Bind this agent to the business number the webhook will carry, so inbound
  // messages route to them rather than to the unassigned pool.
  await query('UPDATE agents SET wa_phone_number_id = $2, wa_phone_number = $3 WHERE id = $1', [
    agentId,
    'e2e-phone-id',
    '+919600000001',
  ])
})

beforeEach(() => {
  waSends = []
})

after(async () => {
  global.fetch = realFetch
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// === Flow 1: a buyer message becomes a lead an agent can work ===============

test('FLOW inbound WhatsApp message → lead, contact, activity, inbox and dashboard', async () => {
  const res = await postWebhook(
    inboundPayload({
      from: '919611100001',
      name: 'Rohit Sharma',
      text: 'Looking for a 2 BHK in Baner, budget around 90 lakhs, need it in 3 months',
      messageId: 'wamid.e2e.lead.1',
    }),
  )
  // Meta must be acked immediately, whatever happens downstream.
  assert.equal(res.status, 200)

  const lead = await until(() => leadByWaId('919611100001'), 'the lead to be created')

  // 1. The message itself is persisted against the lead.
  const messages = (await query('SELECT * FROM messages WHERE lead_id = $1 ORDER BY id', [lead.id])).rows
  assert.ok(messages.some((m) => m.role === 'buyer' && /2 BHK in Baner/.test(m.text)), 'buyer message stored')

  // 2. The 24h service window is open, anchored on that message.
  assert.ok(lead.last_inbound_at, 'last_inbound_at stamped')
  assert.equal(serviceWindow(lead).open, true)

  // 3. It is visible through the API the inbox actually calls.
  const list = await json('GET', '/api/leads')
  assert.ok(list.some((l) => l.id === lead.id), 'lead appears in GET /api/leads')

  const detail = await json('GET', `/api/leads/${lead.id}`)
  assert.equal(detail.id, lead.id)
  assert.equal(detail.service_window.open, true)
  assert.ok(Array.isArray(detail.messages), 'detail carries the thread')

  // 4. A CRM contact was auto-captured for the number.
  const contact = await until(
    async () => (await query('SELECT * FROM contacts WHERE agent_id = $1 AND phone LIKE $2', [agentId, '%9611100001'])).rows[0],
    'the contact to be captured',
  )
  assert.ok(contact, 'contact auto-created from the inbound message')

  // 5. The new-lead activity entry exists, which is what the activity feed renders.
  const activity = await json('GET', '/api/activity')
  assert.ok(
    activity.some((a) => a.kind === 'lead' && /Rohit Sharma|9611100001/.test(a.text || '')),
    `no new-lead activity: ${JSON.stringify(activity.slice(0, 3))}`,
  )

  // 6. The dashboard shows it as unanswered — the buyer spoke last.
  const dash = await json('GET', '/api/dashboard')
  assert.ok(dash.unanswered.some((l) => l.id === lead.id), 'lead is in the unanswered queue')
})

test('FLOW a redelivered webhook does not double-create the message or the lead', async () => {
  const payload = inboundPayload({
    from: '919611100002',
    name: 'Duplicate Dev',
    text: 'is the flat still available?',
    messageId: 'wamid.e2e.dupe.1',
  })

  assert.equal((await postWebhook(payload)).status, 200)
  const lead = await until(() => leadByWaId('919611100002'), 'the lead')
  await until(
    async () => (await query('SELECT COUNT(*)::int AS n FROM messages WHERE lead_id = $1', [lead.id])).rows[0].n > 0,
    'the first message',
  )

  // Meta redelivers on any ack hiccup. Same message id → must be a no-op.
  assert.equal((await postWebhook(payload)).status, 200)
  await new Promise((r) => setTimeout(r, 250))

  const leadCount = (await query('SELECT COUNT(*)::int AS n FROM leads WHERE agent_id = $1 AND wa_id = $2', [agentId, '919611100002'])).rows[0].n
  const msgCount = (await query(`SELECT COUNT(*)::int AS n FROM messages WHERE lead_id = $1 AND role = 'buyer'`, [lead.id])).rows[0].n
  assert.equal(leadCount, 1, 'no second lead')
  assert.equal(msgCount, 1, 'no second copy of the buyer message')
})

test('FLOW a non-text message still lands as a readable placeholder, not a dropped event', async () => {
  const res = await postWebhook(
    inboundPayload({
      from: '919611100003',
      name: 'Media Meena',
      messageId: 'wamid.e2e.media.1',
      type: 'image',
      extra: { image: { id: 'media-1', mime_type: 'image/jpeg' } },
    }),
  )
  assert.equal(res.status, 200)

  const lead = await until(() => leadByWaId('919611100003'), 'the image lead')
  const messages = await until(
    async () => {
      const rows = (await query('SELECT * FROM messages WHERE lead_id = $1', [lead.id])).rows
      return rows.length ? rows : null
    },
    'the placeholder message',
  )
  assert.ok(messages[0].text && messages[0].text.trim().length > 0, 'a photo must not become an empty message')
})

// === Flow 2: scoring recalculation ==========================================

test('FLOW qualifying a lead recomputes and persists an explainable score', async () => {
  const lead = await until(() => leadByWaId('919611100001'), 'the flow-1 lead')

  // Fill in BLTC through the CRM route the lead card uses.
  const updated = await json('PUT', `/api/leads/${lead.id}`, {
    budget_min: 85_0000000,
    budget_max: 95_0000000,
    bhk: '2',
    property_type: 'apartment',
    preferred_localities: ['Baner'],
    timeline: '1-3 months',
    financing: 'loan',
  })
  assert.equal(updated.budget_max, 95_0000000)

  // Make the engagement signals unambiguous: a recent buyer reply on a fresh lead.
  await query(
    `UPDATE leads SET locality = 'Baner', config = '2BHK', budget_max_l = 95, budget_min_l = 85,
       timeline = '1-3 months', last_inbound_at = now() - interval '1 hour' WHERE id = $1`,
    [lead.id],
  )

  // GET /api/worklist runs the recompute synchronously — this is the real trigger.
  const work = await json('GET', '/api/worklist')
  assert.ok(Array.isArray(work.items), 'worklist returns items')

  const scored = (await query('SELECT * FROM leads WHERE id = $1', [lead.id])).rows[0]
  assert.equal(typeof scored.engagement_score, 'number', 'engagement score written')
  assert.equal(typeof scored.effective_score, 'number', 'effective score written')
  assert.ok(['Hot', 'Warm', 'Cold'].includes(scored.effective_temp), `unexpected temp ${scored.effective_temp}`)
  assert.ok(scored.score_factors, 'the score is explainable — factors are stored')

  // The same numbers must be what the lead card reads back.
  const detail = await json('GET', `/api/leads/${lead.id}`)
  assert.equal(detail.effective_score, scored.effective_score)
})

test('FLOW booking a site visit does not cool a hot lead', async () => {
  // Regression guard for the scoring bug fixed in 8347f9f, at the HTTP level:
  // agreeing to a visit is the strongest buying signal there is, and must never
  // reduce the score.
  const sim = await json('POST', '/api/simulate', {
    from: '919611100004',
    name: 'Hot Harish',
    text: 'ready to buy, budget 1.2 cr, want possession in 2 months in Baner',
  })
  const leadId = sim.lead.id
  await query(
    `UPDATE leads SET locality = 'Baner', config = '3BHK', budget_max_l = 120, budget_min_l = 100,
       timeline = '1-3 months', last_inbound_at = now() - interval '30 minutes' WHERE id = $1`,
    [leadId],
  )

  await json('GET', '/api/worklist')
  const before = (await query('SELECT effective_score, effective_temp FROM leads WHERE id = $1', [leadId])).rows[0]

  const visit = await json('POST', '/api/site-visits', {
    lead_id: leadId,
    scheduled_at: new Date(Date.now() + 36 * 3600_000).toISOString(),
  })
  assert.ok(visit.id, `site visit not created: ${JSON.stringify(visit)}`)

  await json('GET', '/api/worklist')
  const after = (await query('SELECT effective_score, effective_temp FROM leads WHERE id = $1', [leadId])).rows[0]

  assert.ok(
    after.effective_score >= before.effective_score,
    `score fell after booking a visit: ${before.effective_score} -> ${after.effective_score}`,
  )
  if (before.effective_temp === 'Hot') assert.equal(after.effective_temp, 'Hot', 'a Hot lead must stay Hot')
})

// === Flow 3: site visit booking =============================================

test('FLOW booking a site visit surfaces it in the visit list, dashboard and worklist', async () => {
  const sim = await json('POST', '/api/simulate', {
    from: '919611100005',
    name: 'Visit Vikram',
    text: 'can I see the flat this weekend?',
  })
  const leadId = sim.lead.id

  const property = await json('POST', '/api/properties', {
    title: 'Balewadi High Street 3BHK',
    locality: 'Balewadi',
    price_l: 140,
  })
  assert.ok(property.id, `property not created: ${JSON.stringify(property)}`)

  const scheduledAt = new Date(Date.now() + 20 * 3600_000).toISOString()
  const visit = await json('POST', '/api/site-visits', {
    lead_id: leadId,
    property_id: property.id,
    scheduled_at: scheduledAt,
    pickup_required: true,
    pickup_location: 'Baner Road metro',
  })
  assert.ok(visit.id, `visit not created: ${JSON.stringify(visit)}`)
  assert.equal(visit.status, 'scheduled')

  // 1. It is listed, and filterable by lead.
  const all = await json('GET', '/api/site-visits')
  assert.ok(all.some((v) => v.id === visit.id), 'visit in the full list')
  const forLead = await json('GET', `/api/site-visits?lead_id=${leadId}`)
  assert.ok(forLead.every((v) => v.lead_id === leadId), 'lead filter is scoped')
  assert.ok(forLead.some((v) => v.id === visit.id))

  // 2. It reaches the worklist as an upcoming, unconfirmed visit.
  const work = await json('GET', '/api/worklist')
  assert.ok(
    work.items.some((i) => i.type === 'site_visit_soon' && i.entity_id === visit.id),
    `visit missing from worklist: ${JSON.stringify(work.items.map((i) => i.type))}`,
  )

  // 2b. The dashboard's "today" widget filters on the calendar date in the AGENT's
  //     timezone, not a rolling 24h window — so the visit above (20h out) may well
  //     be tomorrow. Book a second one pinned to noon today in that timezone, which
  //     is deterministic whenever the suite happens to run.
  const todayVisit = await json('POST', '/api/site-visits', {
    lead_id: leadId,
    scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
  })
  const { timezone } = (await query('SELECT COALESCE(timezone, $2) AS timezone FROM agents WHERE id = $1', [agentId, 'Asia/Kolkata'])).rows[0]
  await query(
    `UPDATE site_visits SET scheduled_at = (date_trunc('day', now() AT TIME ZONE $2) + interval '12 hours') AT TIME ZONE $2
     WHERE id = $1`,
    [todayVisit.id, timezone],
  )

  const dash = await json('GET', '/api/dashboard')
  assert.ok(
    dash.siteVisitsToday.some((v) => v.id === todayVisit.id),
    `today's visit missing from the dashboard widget: ${JSON.stringify(dash.siteVisitsToday.map((v) => v.id))}`,
  )

  // 3. The activity feed records the booking.
  const activity = await json('GET', '/api/activity')
  assert.ok(activity.some((a) => /Site visit scheduled/i.test(a.text || '')), 'booking logged to activity')

  // 4. Confirming it moves the status and drops it off the "needs confirming" list.
  const confirmed = await json('PUT', `/api/site-visits/${visit.id}`, { status: 'confirmed' })
  assert.equal(confirmed.status, 'confirmed')
  const afterWork = await json('GET', '/api/worklist')
  assert.ok(
    !afterWork.items.some((i) => i.type === 'site_visit_soon' && i.entity_id === visit.id),
    'a confirmed visit should no longer be nagging the agent',
  )
})

// === Flow 4: template messaging =============================================

test('FLOW sending an approved template renders variables, sends, and lands in the thread', async () => {
  const sim = await json('POST', '/api/simulate', {
    from: '919611100006',
    name: 'Template Tara',
    text: 'send me the details',
  })
  const leadId = sim.lead.id

  const templates = await json('GET', '/api/templates')
  const tpl = templates.find((t) => t.name === 'site_visit_reminder')
  assert.ok(tpl, 'the seeded workspace ships a site_visit_reminder template')

  const sent = await json('POST', `/api/leads/${leadId}/reply`, {
    template_id: tpl.id,
    variables: { name: 'Tara', property: 'Balewadi High Street 3BHK', visit_time: 'Saturday 11am' },
  })
  assert.equal(sent.role, 'agent', `unexpected reply: ${JSON.stringify(sent)}`)
  assert.match(sent.text, /Tara/)
  assert.match(sent.text, /Balewadi High Street 3BHK/)
  assert.match(sent.text, /Saturday 11am/)
  assert.ok(!/\{\{/.test(sent.text), 'no unfilled placeholders may go out')

  // It really went to Meta, with the rendered body.
  assert.equal(waSends.length, 1, `expected exactly one Graph call, got ${waSends.length}`)
  assert.match(waSends[0].body?.text?.body ?? '', /Saturday 11am/)

  // And it is in the thread the agent sees next.
  const detail = await json('GET', `/api/leads/${leadId}`)
  assert.ok(detail.messages.some((m) => m.role === 'agent' && /Saturday 11am/.test(m.text)), 'template message in thread')
})

test('FLOW a template with blank variables is refused before any send happens', async () => {
  const sim = await json('POST', '/api/simulate', {
    from: '919611100007',
    name: 'Blank Bhavna',
    text: 'hello',
  })
  const templates = await json('GET', '/api/templates')
  const tpl = templates.find((t) => t.name === 'site_visit_reminder')

  const res = await req('POST', `/api/leads/${sim.lead.id}/reply`, {
    template_id: tpl.id,
    variables: { name: 'Bhavna', property: '   ' }, // visit_time missing, property blank
  })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.code, 'TEMPLATE_VARS_MISSING')
  assert.deepEqual(body.missing.sort(), ['property', 'visit_time'])
  assert.equal(waSends.length, 0, 'nothing may be sent when variables are unfilled')
})

test('FLOW a marketing template appends the agent’s RERA number automatically', async () => {
  await json('PUT', '/api/agent/profile', { rera_id: 'A52100001234', rera_state: 'Maharashtra' })

  const sim = await json('POST', '/api/simulate', {
    from: '919611100008',
    name: 'Rera Ravi',
    text: 'what new projects do you have?',
  })
  const templates = await json('GET', '/api/templates')
  const marketing = templates.find((t) => t.name === 'new_listing')
  assert.ok(marketing, 'the seeded workspace ships a new_listing marketing template')

  const sent = await json('POST', `/api/leads/${sim.lead.id}/reply`, {
    template_id: marketing.id,
    variables: { name: 'Ravi', property: 'Baner Skyline 2BHK' },
  })
  assert.match(sent.text, /A52100001234/, 'marketing sends must carry the RERA registration')
  assert.match(sent.text, /Maharashtra/)
})

test('FLOW free text is blocked once the window closes, but a template still goes out', async () => {
  const sim = await json('POST', '/api/simulate', {
    from: '919611100009',
    name: 'Closed Chetan',
    text: 'thinking about it',
  })
  const leadId = sim.lead.id
  await query(`UPDATE leads SET last_inbound_at = now() - interval '26 hours' WHERE id = $1`, [leadId])

  const freeText = await req('POST', `/api/leads/${leadId}/reply`, { text: 'still interested?' })
  assert.equal(freeText.status, 409)
  assert.equal((await freeText.json()).code, 'WINDOW_EXPIRED')
  assert.equal(waSends.length, 0, 'a blocked free-text reply must not reach Meta')

  const templates = await json('GET', '/api/templates')
  const tpl = templates.find((t) => t.name === 'welcome')
  const viaTemplate = await json('POST', `/api/leads/${leadId}/reply`, {
    template_id: tpl.id,
    variables: { name: 'Chetan' },
  })
  assert.equal(viaTemplate.role, 'agent')
  assert.equal(waSends.length, 1, 'the template is the sanctioned way out of a closed window')
})

// === Flow 5: the agent-command path over the same webhook ===================

test('FLOW an agent texting their own business number is handled as a command, not a lead', async () => {
  const res = await postWebhook(
    inboundPayload({
      from: '919600000001', // the agent's own number
      name: 'Priya Nair',
      text: 'help',
      messageId: 'wamid.e2e.cmd.1',
    }),
  )
  assert.equal(res.status, 200)

  // The agent must never become a lead in their own CRM.
  await new Promise((r) => setTimeout(r, 300))
  const asLead = await leadByWaId('919600000001')
  assert.equal(asLead, null, 'the agent themselves must not be captured as a lead')

  // They get a reply on the same number instead.
  await until(() => (waSends.length ? waSends : null), 'the command reply')
  assert.ok(waSends.length >= 1, 'the agent gets an answer to their command')
})

// === Cross-cutting: the whole journey is tenant-scoped =======================

test('FLOW none of this journey is visible to another workspace', async () => {
  const them = await json('POST', '/api/auth/signup', {
    name: 'Outsider',
    phone: '+919600000099',
    password: 'secret123',
  }, null)
  const theirToken = them.token

  const theirLeads = await json('GET', '/api/leads', undefined, theirToken)
  assert.deepEqual(theirLeads, [], 'a fresh workspace sees no leads')

  const theirVisits = await json('GET', '/api/site-visits', undefined, theirToken)
  assert.deepEqual(theirVisits, [], 'a fresh workspace sees no site visits')

  const theirDash = await json('GET', '/api/dashboard', undefined, theirToken)
  assert.deepEqual(theirDash.unanswered, [])
  assert.deepEqual(theirDash.hotLeads, [])

  // And the leads that do exist are unreachable by direct id.
  const mine = await leadByWaId('919611100001')
  assert.equal((await req('GET', `/api/leads/${mine.id}`, undefined, theirToken)).status, 404)
})
