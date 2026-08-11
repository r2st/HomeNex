// Values the database rejects, on the routes that translate that rejection.
//
// Several PUT routes wrap their update in `catch (err) { if (!pgBadRequest(err))
// throw err; res.status(400) }`. Bad *ids* are covered elsewhere (idParams); what
// is not is a well-formed id carrying a value a CHECK constraint refuses. That arm
// is the difference between "Enter one of: issued, paid, cancelled" and a 500, and
// the `throw err` beside it is what keeps a genuine bug from being reported to the
// agent as if they had typed something wrong.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('badvalues')

const { app } = await import('../index.js')
const { closePool, query, upsertLead } = await import('../db.js')

let server
let base
let token
let agentId
let contactId
let invoiceId

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
const jreq = async (...a) => (await req(...a)).json()

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const out = await jreq('POST', '/api/auth/signup', {
    name: 'Values Agent',
    phone: '+919800000077',
    password: 'secret123',
  })
  token = out.token
  agentId = out.agent.id

  // Contacts are auto-captured by the inbound webhook, not by /api/simulate, and
  // that capture is asynchronous. Inserted directly so these tests assert on the
  // route's error handling rather than on how fast the pipeline settles.
  const { rows: contact } = await query(
    `INSERT INTO contacts (agent_id, phone, name) VALUES ($1, $2, $3) RETURNING id`,
    [agentId, '+919777700077', 'Values Vikram'],
  )
  contactId = contact[0].id

  const lead = await upsertLead(agentId, '919777700078', 'Deal Deepa')
  const { rows: commission } = await query(
    `INSERT INTO commissions (agent_id, lead_id, deal_value_paise, commission_pct, status)
     VALUES ($1, $2, 100000000, 2.0, 'expected') RETURNING id`,
    [agentId, lead.id],
  )
  const { rows: invoice } = await query(
    `INSERT INTO commission_invoices
       (agent_id, commission_id, invoice_number, subtotal_paise, gst_paise, total_paise)
     VALUES ($1, $2, 'INV-BAD-1', 5000000, 900000, 5900000) RETURNING id`,
    [agentId, commission[0].id],
  )
  invoiceId = invoice[0].id
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- contacts.opt_in_status IN ('unknown','opted_in','opted_out') ------------

test('an opt-in status the constraint refuses is a 400, not a 500', async () => {
  assert.ok(contactId, 'the fixture contact was not captured')
  const res = await req('PUT', `/api/contacts/${contactId}`, { opt_in_status: 'maybe_later' })

  assert.equal(res.status, 400, 'a value the database refuses must not surface as a server error')
  assert.ok((await res.json()).error, 'the 400 should say something')
})

test('the contact is left exactly as it was', async () => {
  const before = await jreq('GET', `/api/contacts/${contactId}`)
  await req('PUT', `/api/contacts/${contactId}`, { opt_in_status: 'nonsense' })
  const after = await jreq('GET', `/api/contacts/${contactId}`)

  assert.equal(after.opt_in_status, before.opt_in_status)
})

test('a valid opt-in status still goes through', async () => {
  const res = await req('PUT', `/api/contacts/${contactId}`, { opt_in_status: 'opted_out' })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).opt_in_status, 'opted_out')
})

// --- commission_invoices.status IN ('issued','paid','cancelled') -------------

test('an invoice status the constraint refuses is a 400, not a 500', async () => {
  const res = await req('PUT', `/api/commission-invoices/${invoiceId}`, { status: 'part_paid' })

  assert.equal(res.status, 400)
  assert.ok((await res.json()).error)
})

test('a valid invoice status still goes through', async () => {
  const res = await req('PUT', `/api/commission-invoices/${invoiceId}`, { status: 'cancelled' })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).status, 'cancelled')
})

test('an invoice belonging to another agent is 404, never 400', async () => {
  const other = await jreq('POST', '/api/auth/signup', {
    name: 'Other Values',
    phone: '+919800000078',
    password: 'secret123',
  })
  const res = await req('PUT', `/api/commission-invoices/${invoiceId}`, { status: 'paid' }, other.token)

  // Not found for them, and the bad-value arm must not turn a scoping miss into a 400.
  assert.equal(res.status, 404)
})
