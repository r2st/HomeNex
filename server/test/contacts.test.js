// API tests for auto-captured contacts: inbound WhatsApp messages create contacts
// (no manual add flow), dedupe by phone, and link a pipeline lead to each contact.
// Run with: npm test  (from server/)  — needs a local PostgreSQL (docker compose up -d).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

// Isolate a throwaway database and skip listen() before importing the app.
process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY // keep AI/WhatsApp inert during tests
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET // webhook signature check off
const dbName = await createTestDb('contacts')

const { app } = await import('../index.js')
const { closePool, query, upsertUnassignedLead } = await import('../db.js')

let server
let base
let token
let agentId

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

// A Meta webhook payload for one inbound text on a given business line.
const webhookPayload = (from, text, profileName, phoneNumberId) => ({
  entry: [
    {
      changes: [
        {
          value: {
            metadata: { phone_number_id: phoneNumberId },
            contacts: [{ profile: { name: profileName } }],
            messages: [{ from, id: 'wamid.' + Math.random(), type: 'text', text: { body: text } }],
          },
        },
      ],
    },
  ],
})

// The webhook acks before processing; poll until the async pipeline lands.
async function until(fn, timeoutMs = 5000) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 100))
  }
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const res = await req('POST', '/api/auth/signup', {
    name: 'Test Agent',
    phone: '+919800000000',
    password: 'secret123',
  })
  const out = await res.json()
  token = out.token
  agentId = out.agent.id
  assert.ok(token, 'signup should return a token')
  // Give the agent their own WhatsApp Business line so inbound routes to them.
  const cfg = await req('PUT', '/api/agent/phone-config', {
    wa_phone_number: '+919899999999',
    wa_phone_number_id: 'PNID_TEST_1',
  })
  assert.equal(cfg.status, 200)
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

test('inbound message from an unknown number auto-creates a contact and a pipeline lead', async () => {
  const res = await req('POST', '/webhook', webhookPayload('919876543210', 'Hi, looking for a 2BHK', 'Priya Sharma', 'PNID_TEST_1'))
  assert.equal(res.status, 200)

  // Wait for the full async pipeline: contact created AND message timestamp stamped.
  const contact = await until(async () => {
    const list = await (await req('GET', '/api/contacts')).json()
    return list.find((c) => c.phone === '+919876543210' && c.first_message_at)
  })
  assert.equal(contact.name, 'Priya Sharma', 'name pulled from the WhatsApp profile')
  assert.equal(contact.source, 'whatsapp_inbound')

  // The lead was created, linked to the contact, and dropped into the pipeline.
  const lead = await until(async () => {
    const leads = await (await req('GET', '/api/leads')).json()
    return leads.find((l) => l.wa_id === '919876543210' && l.contact_id === contact.id)
  })
  assert.equal(lead.pipeline_type, 'buy_primary')
  assert.equal(lead.stage, 'New')
  assert.equal(lead.agent_id, agentId)
})

test('a second message from the same number dedupes on phone (one contact, one lead)', async () => {
  await req('POST', '/webhook', webhookPayload('919876543210', 'Budget is 80L', 'Priya Sharma', 'PNID_TEST_1'))
  await until(async () => {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM messages m JOIN leads l ON l.id = m.lead_id WHERE l.wa_id = '919876543210'`,
    )
    return rows[0].n >= 2
  })
  const contacts = await (await req('GET', '/api/contacts')).json()
  assert.equal(contacts.filter((c) => c.phone === '+919876543210').length, 1)
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM leads WHERE wa_id = '919876543210'`)
  assert.equal(rows[0].n, 1)
})

test('manual add-contact endpoints are gone — contacts come from conversations only', async () => {
  assert.equal((await req('POST', '/api/contacts', { phone: '9811111111', name: 'Manual Add' })).status, 404)
  assert.equal((await req('POST', '/api/contacts/bulk', { contacts: [] })).status, 404)
})

test('GET /api/contacts?q= searches by name and phone', async () => {
  const byName = await (await req('GET', '/api/contacts?q=priya')).json()
  assert.equal(byName.length, 1)
  const byPhone = await (await req('GET', '/api/contacts?q=76543210')).json()
  assert.equal(byPhone.length, 1)
  const none = await (await req('GET', '/api/contacts?q=nobody')).json()
  assert.equal(none.length, 0)
})

test('GET /api/contacts/:id returns the contact with its linked leads', async () => {
  const [contact] = await (await req('GET', '/api/contacts?q=priya')).json()
  const res = await req('GET', `/api/contacts/${contact.id}`)
  assert.equal(res.status, 200)
  const detail = await res.json()
  assert.equal(detail.leads.length, 1)
  assert.equal(detail.leads[0].contact_id, contact.id)
})

test('PUT /api/contacts/:id updates notes/labels without touching other fields', async () => {
  const [contact] = await (await req('GET', '/api/contacts?q=priya')).json()
  const res = await req('PUT', `/api/contacts/${contact.id}`, { notes: 'Prefers Baner', labels: ['hot-area'] })
  assert.equal(res.status, 200)
  const updated = await res.json()
  assert.equal(updated.notes, 'Prefers Baner')
  assert.deepEqual(updated.labels, ['hot-area'])
  assert.equal(updated.name, 'Priya Sharma', 'name unchanged')
})

test('claiming a pooled lead saves the sender as a contact and links the lead', async () => {
  const lead = await upsertUnassignedLead('919700000123', 'Walk-in Buyer')

  const leads = await (await req('GET', '/api/leads')).json()
  const pooled = leads.find((l) => l.id === lead.id)
  assert.ok(pooled, 'unassigned lead shows up in the agent list')
  assert.equal(pooled.unassigned, 1)

  const claim = await req('POST', `/api/leads/${lead.id}/assign`)
  assert.equal(claim.status, 200)
  const claimed = await claim.json()
  assert.equal(claimed.agent_id, agentId)
  assert.equal(claimed.stage, 'New', 'claimed lead lands in the pipeline')

  const contacts = await (await req('GET', '/api/contacts')).json()
  const saved = contacts.find((c) => c.phone === '+919700000123')
  assert.ok(saved, 'claiming saved the sender as a contact')
  assert.equal(claimed.contact_id, saved.id)

  // A second claim now conflicts.
  assert.equal((await req('POST', `/api/leads/${lead.id}/assign`)).status, 409)
})

test('DELETE /api/contacts/:id removes a contact and unlinks its leads', async () => {
  const contacts = await (await req('GET', '/api/contacts')).json()
  const target = contacts.find((c) => c.phone === '+919700000123')
  assert.ok(target)
  assert.equal((await req('DELETE', `/api/contacts/${target.id}`)).status, 200)
  assert.equal((await req('DELETE', `/api/contacts/${target.id}`)).status, 404)
  const { rows } = await query(`SELECT contact_id FROM leads WHERE wa_id = '919700000123'`)
  assert.equal(rows[0].contact_id, null, 'lead survives with the link cleared')
})

test('contacts endpoints reject unauthenticated requests', async () => {
  assert.equal((await req('GET', '/api/contacts', undefined, null)).status, 401)
})
