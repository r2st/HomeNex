// "A bad value is the caller's fault, not a crash."
//
// Nearly every write route in index.js ends in the same shape:
//
//   catch (err) { if (!pgBadRequest(err)) throw err; res.status(400)... }
//
// which turns a Postgres cast/check/FK violation into a 400 and lets anything else
// through to the 500 handler. That arm is the one an agent hits by typing "eighty
// lakh" into a number field, and until now none of it was covered — a regression
// there would surface as a 500 in production, not a red test.
//
// This file drives one malformed value through each of those routes, plus the
// service-unavailable arms that fire when WhatsApp is not configured.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_PHONE_NUMBER_ID
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('badinput')

const { app } = await import('../index.js')
const { closePool, query, upsertLead, upsertUnassignedLead, createProperty, addContact } = await import('../db.js')

let server, base, token, agentId, leadId, propertyId

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
const json = async (...args) => (await req(...args)).json()

// Asserts the status and that the body is a real error message, not a stack trace
// or the generic 500 envelope leaking out.
const expectStatus = async (status, method, url, body, note = '') => {
  const res = await req(method, url, body)
  const payload = await res.json().catch(() => ({}))
  assert.equal(res.status, status, `${method} ${url} ${note} -> ${res.status} ${JSON.stringify(payload)}`)
  assert.notEqual(payload.code, 'INTERNAL', `${method} ${url} must not fall through to the 500 handler`)
  return payload
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const out = await json('POST', '/api/auth/signup', { name: 'Fuzzy Farah', phone: '+919730000001', password: 'secret123' }, null)
  token = out.token
  agentId = out.agent.id
  leadId = (await upsertLead(agentId, '919730010001', 'Test Lead')).id
  propertyId = (await createProperty(agentId, { title: 'Bad Input Bhavan', locality: 'Baner', city: 'Pune' })).id
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- Numbers that aren't numbers ----------------------------------------------

test('a non-numeric budget on a lead is a 400', async () => {
  await expectStatus(400, 'PUT', `/api/leads/${leadId}`, { budget_max: 'eighty lakh' })
})

test('renaming a lead goes through the name path, and a blank name clears it', async () => {
  // `name` is handled outside the CRM allowlist, so it is its own branch of the route.
  const renamed = await json('PUT', `/api/leads/${leadId}`, { name: '  Renamed Rekha  ', timeline: '3 months' })
  assert.equal(renamed.name, 'Renamed Rekha', 'trimmed')
  assert.equal(renamed.timeline, '3 months', 'the other CRM fields still applied in the same call')

  const cleared = await json('PUT', `/api/leads/${leadId}`, { name: '   ' })
  assert.equal(cleared.name, null, 'a blank name clears it rather than storing whitespace')

  await expectStatus(404, 'PUT', '/api/leads/999999', { name: 'Ghost' })
  await json('PUT', `/api/leads/${leadId}`, { name: 'Test Lead' })
})

test('a non-numeric value through autofill-apply is a 400', async () => {
  await expectStatus(400, 'POST', `/api/leads/${leadId}/autofill/apply`, {
    accepted: { budget_max: 'about a crore' },
  })
})

test('a non-numeric deal value is a 400 on create and on update', async () => {
  await expectStatus(400, 'POST', '/api/deals', { lead_id: leadId, deal_value_paise: 'a lot' })
  const deal = await json('POST', '/api/deals', { lead_id: leadId, deal_value_paise: 10_000_00 })
  await expectStatus(400, 'PUT', `/api/deals/${deal.id}`, { deal_value_paise: 'more' })
})

test('a non-numeric commission is a 400 on create and on update', async () => {
  await expectStatus(400, 'POST', '/api/commissions', { lead_id: leadId, commission_pct: 'two percent' })
  const commission = await json('POST', '/api/commissions', { lead_id: leadId, deal_value_paise: 10_000_00, commission_pct: 2 })
  await expectStatus(400, 'PUT', `/api/commissions/${commission.id}`, { deal_value_paise: 'unknown' })

  // And an invalid status is a check violation, not a cast failure — same answer.
  await expectStatus(400, 'PUT', `/api/commissions/${commission.id}`, { status: 'maybe-someday' })
})

// --- Dates that aren't dates ---------------------------------------------------

test('an unparseable follow-up due date is a 400', async () => {
  await expectStatus(400, 'POST', '/api/followups', { lead_id: leadId, due_at: 'next tuesday-ish' })
  const followup = await json('POST', '/api/followups', {
    lead_id: leadId,
    due_at: new Date().toISOString(),
    note: 'call back',
  })
  await expectStatus(400, 'PUT', `/api/followups/${followup.id}`, { due_at: 'whenever' })
})

test('an unparseable site-visit time is a 400', async () => {
  await expectStatus(400, 'POST', '/api/site-visits', { lead_id: leadId, scheduled_at: 'saturday morning' })
  const visit = await json('POST', '/api/site-visits', {
    lead_id: leadId,
    scheduled_at: new Date(Date.now() + 86400_000).toISOString(),
  })
  await expectStatus(400, 'PUT', `/api/site-visits/${visit.id}`, { scheduled_at: 'later' })
})

test('an unparseable commission payout date is a 400', async () => {
  await expectStatus(400, 'POST', '/api/commissions', {
    lead_id: leadId,
    deal_value_paise: 100_000_00,
    commission_pct: 1,
    expected_payout_date: 'end of the quarter',
  })
})

// --- Values outside the allowed set -------------------------------------------

test('an unknown enum value is a 400 rather than a check-constraint 500', async () => {
  await expectStatus(400, 'PUT', `/api/contacts/999999999999`, { name: 'x' }, 'out-of-range id')
  await expectStatus(400, 'PUT', `/api/properties/${propertyId}`, { status: 'teleported' })
  await expectStatus(400, 'POST', '/api/properties', { title: 'Odd', property_type: 'houseboat' })
})

test('a malformed id in the path is a 400, not a 500', async () => {
  // Postgres refuses to cast 'abc' to an integer; that has to read as a bad request.
  for (const url of [
    '/api/contacts/abc',
    '/api/properties/abc',
    '/api/followups/abc',
    '/api/commission-invoices/abc',
  ]) {
    await expectStatus(400, 'PUT', url, { notes: 'x' }, 'non-numeric id')
  }
})

// --- Uniqueness ----------------------------------------------------------------

test('a duplicate template name is a 400, and so is a rename onto one', async () => {
  await json('POST', '/api/templates', { name: 'welcome_note', category: 'utility', body: 'Hello' })
  await expectStatus(400, 'POST', '/api/templates', { name: 'welcome_note', category: 'utility', body: 'Hello again' })

  const other = await json('POST', '/api/templates', { name: 'other_note', category: 'utility', body: 'Hi' })
  await expectStatus(400, 'PUT', `/api/templates/${other.id}`, { name: 'welcome_note' })
})

test('a template or quick reply with nothing in it is a 400', async () => {
  await expectStatus(400, 'POST', '/api/templates', { name: '', body: '' })
  await expectStatus(400, 'POST', '/api/quick-replies', { title: '', body: '' })
  await expectStatus(400, 'POST', '/api/quick-replies', {})
})

test('a duplicate group name is a 409 and a nameless group is a 400', async () => {
  const group = await json('POST', '/api/groups', { name: 'Baner buyers', kind: 'static' })
  await expectStatus(409, 'POST', '/api/groups', { name: 'Baner buyers', kind: 'static' })
  await expectStatus(400, 'POST', '/api/groups', { name: '' })

  const renamed = await json('PUT', `/api/groups/${group.id}`, { name: 'Baner + Wakad buyers', color: '#ff8800' })
  assert.equal(renamed.name, 'Baner + Wakad buyers')
  assert.equal(renamed.color, '#ff8800')
})

test('a media asset needs a source, and a bad one is a 400', async () => {
  await expectStatus(400, 'POST', '/api/media', { title: 'Brochure' }, 'neither url nor data_base64')
  await expectStatus(400, 'POST', '/api/media', { title: 'Brochure', data_base64: 'not-base64-at-all', mime: 'application/zip' })
})

// --- Signup / account routes ---------------------------------------------------

test('signup and login reject bad input over HTTP with a 400', async () => {
  await expectStatus(400, 'POST', '/api/auth/signup', { name: 'No Password', phone: '+919730009999' })
  await expectStatus(400, 'POST', '/api/auth/signup', {}, 'empty body')
  await expectStatus(401, 'POST', '/api/auth/login', { phone: '+919730000001', password: 'wrong-one' })
})

test('changing the WhatsApp Business number rejects a malformed one', async () => {
  await expectStatus(400, 'PUT', '/api/agent/wa-phone', { wa_phone_number: '123' })
  await expectStatus(400, 'PUT', '/api/agent/wa-phone', {})
})

// --- Not-found arms on the agent-facing §7 routes -------------------------------

test('the agent-facing support, billing and template-review routes 404 cleanly', async () => {
  await expectStatus(404, 'GET', '/api/support/tickets/999999')
  await expectStatus(404, 'POST', '/api/support/tickets/999999/reply', { body: 'hello?' })
  await expectStatus(404, 'GET', '/api/billing/invoices/999999')
  await expectStatus(404, 'POST', '/api/templates/999999/request-review', {})
  await expectStatus(404, 'PUT', '/api/groups/999999', { name: 'ghost' })
  await expectStatus(404, 'DELETE', '/api/groups/999999')
})

// createTicket validates before it ever reaches Postgres, so these errors carry no
// pg code. The route must still answer 400 with the reason, not fall through to a 500.
test('opening a ticket without a subject or a message is a 400 that says which', async () => {
  const noSubject = await expectStatus(400, 'POST', '/api/support/tickets', { subject: '   ', body: 'It broke' })
  assert.match(noSubject.error, /subject is required/i)
  const noBody = await expectStatus(400, 'POST', '/api/support/tickets', { subject: 'Help', body: '   ' })
  assert.match(noBody.error, /message is required/i)
})

test('a ticket reply still needs a body even on a ticket the agent owns', async () => {
  const ticket = await json('POST', '/api/support/tickets', { subject: 'Help', body: 'Something is wrong' })
  await expectStatus(400, 'POST', `/api/support/tickets/${ticket.id}/reply`, { body: '   ' })
  assert.equal((await req('GET', `/api/support/tickets/${ticket.id}`)).status, 200)
})

// --- Claiming from the unassigned pool -----------------------------------------

test('claiming a pool lead works once, and the second claim is a 409', async () => {
  const pooled = await upsertUnassignedLead('919730020001', 'Pooled Priya')
  const claimed = await json('POST', `/api/leads/${pooled.id}/assign`)
  assert.equal(claimed.agent_id, agentId)
  await expectStatus(409, 'POST', `/api/leads/${pooled.id}/assign`, undefined, 'already claimed')
})

test('claiming a lead whose number is already a contact still assigns it', async () => {
  // The addContact inside the claim throws on the duplicate; the claim must stand.
  await addContact(agentId, '+919730020002', 'Known Kiran')
  const pooled = await upsertUnassignedLead('919730020002', 'Known Kiran')
  const claimed = await json('POST', `/api/leads/${pooled.id}/assign`)
  assert.equal(claimed.agent_id, agentId, 'the duplicate contact did not block the claim')
})

// --- AI takeover ---------------------------------------------------------------

test('taking over from the AI and handing it back are both logged', async () => {
  // ai_enabled is a SMALLINT 0/1 flag, per the schema's convention.
  const off = await json('POST', `/api/leads/${leadId}/ai`, { enabled: false })
  assert.equal(off.ai_enabled, 0)
  const on = await json('POST', `/api/leads/${leadId}/ai`, { enabled: true })
  assert.equal(on.ai_enabled, 1)

  const activity = (await query('SELECT text FROM activity WHERE lead_id = $1 ORDER BY id', [leadId])).rows.map((r) => r.text)
  assert.ok(activity.some((t) => /took over the chat/.test(t)))
  assert.ok(activity.some((t) => /AI re-enabled/.test(t)))
  await expectStatus(404, 'POST', '/api/leads/999999/ai', { enabled: true })
})

// --- WhatsApp not configured ----------------------------------------------------

test('every send route answers 503 when WhatsApp is not configured', async () => {
  const media = await json('POST', '/api/media', { title: 'Floor plan', kind: 'document', url: 'https://example.com/f.pdf' })
  const group = await json('POST', '/api/groups', { name: 'Blast list', kind: 'static' })
  // An empty group short-circuits before it ever reaches WhatsApp, so give it someone.
  const contact = await addContact(agentId, '+919730050001', 'Blast Bhoomi')
  await json('POST', `/api/groups/${group.id}/members`, { contact_ids: [contact.id] })

  for (const [method, url, body] of [
    ['POST', `/api/properties/${propertyId}/send-to-chat`, { lead_id: leadId }],
    ['POST', `/api/media/${media.id}/send`, { lead_id: leadId }],
    ['POST', `/api/groups/${group.id}/send`, { message: 'New launch in Baner' }],
  ]) {
    const payload = await expectStatus(503, method, url, body, 'WhatsApp unconfigured')
    assert.equal(payload.code, 'WA_NOT_CONFIGURED', `${method} ${url} names the actual cause`)
  }
})

// --- Health ---------------------------------------------------------------------

test('the health endpoint reports each integration honestly when none are configured', async () => {
  const health = await json('GET', '/api/health')
  assert.equal(health.ok, true, 'the process itself is up')
  assert.equal(health.whatsapp, false)
  assert.equal(health.whatsapp_send, false)
  assert.equal(health.whatsapp_reason, 'not_configured')
  assert.equal(health.ai, false)
  assert.equal(health.signature, false, 'no app secret means webhook signatures are unverified')
})

test('the liveness probe answers without auth', async () => {
  const res = await fetch(base + '/healthz')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.db, true)
  assert.equal(typeof body.uptime, 'number')
})

// --- Ingest token rotation --------------------------------------------------------

test('rotating the ingest address invalidates the old one', async () => {
  const before = await json('GET', '/api/lead-sources')
  const rotated = await json('POST', '/api/lead-sources/regenerate')
  assert.ok(rotated.ingest_token)
  assert.match(rotated.ingest_email, /^lead-/)
  assert.notEqual(rotated.ingest_token, before.ingest_token, 'a fresh token, not the same one back')

  // The old address must no longer accept mail.
  if (before.ingest_token) {
    const res = await fetch(`${base}/ingest/email/${before.ingest_token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'portal@example.com', subject: 'Lead', text: 'Name: X\nPhone: +919730030001' }),
    })
    assert.equal(res.status, 404, 'the rotated-away address is dead')
  }
})
