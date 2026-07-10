// API tests for the shared-number contacts + unassigned-lead flow.
// Run with: npm test  (from server/)  — needs a local PostgreSQL (docker compose up -d).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

// Isolate a throwaway database and skip listen() before importing the app.
process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY // keep AI/WhatsApp inert during tests
delete process.env.WHATSAPP_ACCESS_TOKEN
const dbName = await createTestDb('contacts')

const { app } = await import('../index.js')
const { closePool, query, upsertUnassignedLead } = await import('../db.js')

let server
let base
let token

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

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
  token = (await res.json()).token
  assert.ok(token, 'signup should return a token')
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

test('POST /api/contacts adds a client and GET lists it', async () => {
  const res = await req('POST', '/api/contacts', { phone: '9876543210', name: 'Priya Sharma' })
  assert.equal(res.status, 200)
  const c = await res.json()
  assert.equal(c.phone, '+919876543210', 'bare 10-digit number defaults to +91')
  assert.equal(c.name, 'Priya Sharma')

  const list = await (await req('GET', '/api/contacts')).json()
  assert.equal(list.length, 1)
  assert.equal(list[0].msg_count, 0, 'brand-new contact has not messaged yet')
})

test('POST /api/contacts rejects a duplicate phone with 409', async () => {
  const res = await req('POST', '/api/contacts', { phone: '+919876543210', name: 'Someone Else' })
  assert.equal(res.status, 409)
})

test('POST /api/contacts requires phone and name', async () => {
  assert.equal((await req('POST', '/api/contacts', { name: 'No Phone' })).status, 400)
  assert.equal((await req('POST', '/api/contacts', { phone: '9000000001' })).status, 400)
})

test('POST /api/contacts/bulk adds new rows and skips duplicates', async () => {
  const res = await req('POST', '/api/contacts/bulk', {
    contacts: [
      { phone: '9811111111', name: 'Amit Patel' },
      { phone: '9822222222', name: 'Neha Gupta' },
      { phone: '9876543210', name: 'Priya Dup' }, // already exists
    ],
  })
  assert.equal(res.status, 200)
  const out = await res.json()
  assert.equal(out.added.length, 2)
  assert.equal(out.skipped.length, 1)
})

test('DELETE /api/contacts/:id removes a client', async () => {
  const list = await (await req('GET', '/api/contacts')).json()
  const target = list.find((c) => c.name === 'Neha Gupta')
  assert.ok(target)
  assert.equal((await req('DELETE', `/api/contacts/${target.id}`)).status, 200)
  const after = await (await req('GET', '/api/contacts')).json()
  assert.ok(!after.some((c) => c.id === target.id))
})

test('DELETE /api/contacts/:id 404s for an unknown id', async () => {
  assert.equal((await req('DELETE', '/api/contacts/999999')).status, 404)
})

test('unassigned lead is visible to the agent and can be claimed once', async () => {
  // Simulate an unknown sender landing in the shared pool.
  const lead = await upsertUnassignedLead('919700000123', 'Walk-in Buyer')
  const leadId = lead.id

  const leads = await (await req('GET', '/api/leads')).json()
  const pooled = leads.find((l) => l.id === leadId)
  assert.ok(pooled, 'unassigned lead shows up in the agent list')
  assert.equal(pooled.unassigned, 1)

  const claim = await req('POST', `/api/leads/${leadId}/assign`)
  assert.equal(claim.status, 200)
  const claimed = await claim.json()
  const { rows } = await query('SELECT id FROM agents LIMIT 1')
  assert.equal(claimed.agent_id, rows[0].id)

  // Claiming also saves the sender as a contact for future routing.
  const contacts = await (await req('GET', '/api/contacts')).json()
  assert.ok(contacts.some((c) => c.phone === '+919700000123'))

  // A second claim now conflicts.
  assert.equal((await req('POST', `/api/leads/${leadId}/assign`)).status, 409)
})

test('contacts endpoints reject unauthenticated requests', async () => {
  assert.equal((await req('GET', '/api/contacts', undefined, null)).status, 401)
})
