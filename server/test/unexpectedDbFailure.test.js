// The `throw err` half of every `catch (err) { if (!pgBadRequest(err)) throw err }`.
//
// A dozen write routes end the same way: catch whatever the database raised, and if
// it is one of the six SQLSTATEs that mean "the value you sent is not acceptable"
// (23514 check, 23503 foreign key, 22P02/22007/22008/22003 malformed number, date,
// interval, overflow), answer 400 with the database's own sentence. Anything else is
// rethrown.
//
// Only the 400 side has ever run. `badValues.test.js` covers it thoroughly — a bad
// invoice status, an out-of-range number — which is exactly why the other side is
// worth pinning down: the rethrow is what separates "you typed something wrong" from
// "our database is broken", and getting it backwards is bad in both directions. An
// agent told to fix their input when the disk is full will retype it forever. And a
// 400 carrying `err.message` verbatim would put the database's own words — table
// names, column names, constraint names — on an agent's screen.
//
// Provoked with a trigger rather than by corrupting the schema: a BEFORE INSERT OR
// UPDATE trigger that raises SQLSTATE 58030 (io_error, deliberately nothing like a
// bad request) is surgical, reversible, and fires for exactly the statement under
// test. The route's own guards, ownership checks and validation all still run first,
// so what these tests reach is genuinely the write and nothing earlier.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('unexpecteddb')

const { app } = await import('../index.js')
const { closePool, query, upsertLead } = await import('../db.js')

let server
let base
let token
let agentId
let leadId
let propertyId
let followupId
let visitId
let dealId
let commissionId
let invoiceId
let templateId

const req = (method, url, body) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

// The sentence the trigger raises. Nothing in the product says it, so finding it in
// a response body proves the database's own words reached the agent.
const DB_WORDS = 'storage subsystem unavailable'

async function breakTable(table) {
  await query(`
    CREATE OR REPLACE FUNCTION homenex_test_boom() RETURNS trigger AS $fn$
    BEGIN RAISE EXCEPTION '${DB_WORDS}' USING ERRCODE = '58030'; END
    $fn$ LANGUAGE plpgsql`)
  await query(`
    CREATE TRIGGER homenex_test_boom_trg BEFORE INSERT OR UPDATE ON ${table}
    FOR EACH ROW EXECUTE FUNCTION homenex_test_boom()`)
}

const healTable = (table) => query(`DROP TRIGGER IF EXISTS homenex_test_boom_trg ON ${table}`)

/**
 * Run one request with `table` writes failing, and assert the failure was reported
 * as ours. Restores the table even if the assertion throws, so one failing case
 * can't cascade into every case after it.
 */
async function whileBroken(table, fn) {
  await breakTable(table)
  try {
    return await fn()
  } finally {
    await healTable(table)
  }
}

async function assertReportedAsOurFault(table, method, url, body) {
  const res = await whileBroken(table, () => req(method, url, body))
  const out = await res.json()

  assert.equal(res.status, 500, `${method} ${url} should be a server error, got ${res.status}: ${JSON.stringify(out)}`)
  assert.equal(out.code, 'INTERNAL', `${method} ${url} should carry the INTERNAL code`)
  // The whole point of the rethrow: the agent is not told they typed something wrong.
  assert.match(out.error, /our side/, `${method} ${url} should not blame the agent`)
  assert.ok(
    !JSON.stringify(out).includes(DB_WORDS),
    `${method} ${url} leaked the database's own error text to the client`,
  )
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const signup = await (
    await req('POST', '/api/auth/signup', { name: 'Broken Bharat', phone: '+919800000191', password: 'secret123' })
  ).json()
  token = signup.token
  agentId = signup.agent.id

  const lead = await upsertLead(agentId, '919777700191', 'Fragile Farida')
  leadId = lead.id

  // Seeded directly rather than through the routes: these rows are the SUBJECT of the
  // tests below, not the thing under test, and creating them through the API would
  // make every case depend on the create route it isn't about.
  propertyId = (
    await query(
      `INSERT INTO properties (agent_id, title, property_type, status, price_paise)
       VALUES ($1, 'Fragile Heights 2BHK', 'apartment', 'available', 9500000000) RETURNING id`,
      [agentId],
    )
  ).rows[0].id
  followupId = (
    await query(
      `INSERT INTO followups (agent_id, lead_id, due_at, note) VALUES ($1, $2, now() + interval '1 day', 'call back') RETURNING id`,
      [agentId, leadId],
    )
  ).rows[0].id
  visitId = (
    await query(
      `INSERT INTO site_visits (agent_id, lead_id, scheduled_at, status) VALUES ($1, $2, now() + interval '1 day', 'scheduled') RETURNING id`,
      [agentId, leadId],
    )
  ).rows[0].id
  dealId = (
    await query(
      `INSERT INTO deals (agent_id, lead_id, deal_type, stage_captured) VALUES ($1, $2, 'sale', 'Negotiation') RETURNING id`,
      [agentId, leadId],
    )
  ).rows[0].id
  commissionId = (
    await query(
      `INSERT INTO commissions (agent_id, lead_id, deal_value_paise, commission_pct, status)
       VALUES ($1, $2, 100000000, 2.0, 'expected') RETURNING id`,
      [agentId, leadId],
    )
  ).rows[0].id
  invoiceId = (
    await query(
      `INSERT INTO commission_invoices (agent_id, commission_id, invoice_number, subtotal_paise, gst_paise, total_paise)
       VALUES ($1, $2, 'INV-BROKEN-1', 5000000, 900000, 5900000) RETURNING id`,
      [agentId, commissionId],
    )
  ).rows[0].id
  templateId = (
    await query(
      `INSERT INTO message_templates (agent_id, name, body) VALUES ($1, 'Fragile', 'Hello {{1}}') RETURNING id`,
      [agentId],
    )
  ).rows[0].id
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- Every route that rethrows -------------------------------------------------
//
// One case per `throw err`. Grouped by the table each write lands in, which is also
// what makes each one reachable: breaking `followups` leaves `leads` writable, so
// the ownership lookups the route does first still succeed and the failure happens
// where the test says it does.

test('a broken lead_notes table is a server error, not a rejected note', async () => {
  // This route's guard is a message match — `if (!/note body is required/…) throw` —
  // so anything the database raises that is not that sentence must escape.
  await assertReportedAsOurFault('lead_notes', 'POST', `/api/leads/${leadId}/notes`, { body: 'Wants a corner unit' })
})

test('a broken leads table is a server error, not a rejected autofill', async () => {
  await assertReportedAsOurFault('leads', 'POST', `/api/leads/${leadId}/autofill/apply`, {
    accepted: { name: 'Farida Khan' },
  })
})

test('a broken properties table is a server error, not a rejected edit', async () => {
  await assertReportedAsOurFault('properties', 'PUT', `/api/properties/${propertyId}`, { locality: 'Baner' })
})

test('a broken followups table is a server error, not a rejected follow-up', async () => {
  await assertReportedAsOurFault('followups', 'POST', '/api/followups', {
    lead_id: leadId,
    due_at: new Date(Date.now() + 86_400_000).toISOString(),
    note: 'ring back',
  })
})

test('a broken followups table is a server error when completing one too', async () => {
  await assertReportedAsOurFault('followups', 'PUT', `/api/followups/${followupId}`, { completed: true })
})

test('a broken site_visits table is a server error, not a rejected booking', async () => {
  await assertReportedAsOurFault('site_visits', 'POST', '/api/site-visits', {
    lead_id: leadId,
    scheduled_at: new Date(Date.now() + 86_400_000).toISOString(),
  })
})

test('a broken site_visits table is a server error when advancing one too', async () => {
  await assertReportedAsOurFault('site_visits', 'PUT', `/api/site-visits/${visitId}`, { status: 'confirmed' })
})

test('a broken deals table is a server error, not a rejected deal edit', async () => {
  // `notes` rather than a stage: the route picks a fixed field list off the body, so a
  // field it doesn't accept leaves nothing to update and the write never happens.
  await assertReportedAsOurFault('deals', 'PUT', `/api/deals/${dealId}`, { notes: 'Buyer wants possession by Diwali' })
})

test('a broken commission_invoices table is a server error, not a rejected invoice', async () => {
  // This route's guard has a third arm (`&& !rejected`) for the business rule that
  // refuses a second invoice. A database failure is none of those things.
  await assertReportedAsOurFault('commission_invoices', 'POST', `/api/commissions/${commissionId}/invoice`, {})
})

test('a broken commission_invoices table is a server error when marking one paid', async () => {
  await assertReportedAsOurFault('commission_invoices', 'PUT', `/api/commission-invoices/${invoiceId}`, { status: 'paid' })
})

test('a broken message_templates table is a server error, not a rejected template', async () => {
  // Guarded by message match AND by 23505 (the duplicate-name race). 58030 is neither.
  await assertReportedAsOurFault('message_templates', 'POST', '/api/templates', {
    name: 'Site visit reminder',
    body: 'See you at {{1}}',
  })
})

test('a broken message_templates table is a server error when editing one too', async () => {
  await assertReportedAsOurFault('message_templates', 'PUT', `/api/templates/${templateId}`, { body: 'Hello again {{1}}' })
})

test('a broken labels table is a server error, not a rejected label', async () => {
  await assertReportedAsOurFault('labels', 'POST', '/api/labels', { name: 'Investor', color: '#22c55e' })
})

// --- And the half that must NOT be reported as ours -----------------------------

test('a value the database refuses is still the agent′s to fix, not a server error', async () => {
  // The other side of the same branch, asserted here so a change that widened the
  // rethrow to swallow everything would fail this file rather than pass it quietly.
  const res = await req('PUT', `/api/commission-invoices/${invoiceId}`, { status: 'not-a-status' })
  const out = await res.json()

  assert.equal(res.status, 400)
  assert.notEqual(out.code, 'INTERNAL')
  assert.match(out.error, /issued|paid|cancelled|status/i)
})

test('the trigger really is what broke the write, and nothing else', async () => {
  // Guards the mechanism the whole file rests on: without this, a route that 500s for
  // an unrelated reason (a typo in a URL, a seeded row that isn't there) would look
  // like a passing test. Healthy before, healthy after, 500 only in between.
  const before = await req('PUT', `/api/followups/${followupId}`, { note: 'still fine' })
  assert.equal(before.status, 200)

  const during = await whileBroken('followups', () => req('PUT', `/api/followups/${followupId}`, { note: 'mid-outage' }))
  assert.equal(during.status, 500)

  const after = await req('PUT', `/api/followups/${followupId}`, { note: 'fine again' })
  assert.equal(after.status, 200)
  assert.equal((await after.json()).note, 'fine again')
})
