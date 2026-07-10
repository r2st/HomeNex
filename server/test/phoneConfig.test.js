// Tests for per-agent WhatsApp Business number configuration.
// Run with: npm test  (from server/)  — needs a local PostgreSQL (docker compose up -d).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

// Isolate a throwaway database and skip listen() before importing the app.
process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
const dbName = await createTestDb('phoneconfig')

const { app } = await import('../index.js')
const {
  closePool,
  updateAgentPhoneConfig,
  findAgentByPhoneNumberId,
} = await import('../db.js')

let server
let base
let tokenA
let tokenB
let agentA
let agentB

const req = (method, url, body, tok = tokenA) =>
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
  // Create two agents
  const resA = await req('POST', '/api/auth/signup', {
    name: 'Agent Alpha',
    phone: '+919800000001',
    password: 'secret123',
  }, null)
  const dataA = await resA.json()
  tokenA = dataA.token
  agentA = dataA.agent

  const resB = await req('POST', '/api/auth/signup', {
    name: 'Agent Beta',
    phone: '+919800000002',
    password: 'secret456',
  }, null)
  const dataB = await resB.json()
  tokenB = dataB.token
  agentB = dataB.agent
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- DB-level tests for updateAgentPhoneConfig ---

test('updateAgentPhoneConfig sets wa_phone_number and wa_phone_number_id', async () => {
  const updated = await updateAgentPhoneConfig(agentA.id, '+13655551234', 'pnid_alpha_001')
  assert.equal(updated.wa_phone_number, '+13655551234')
  assert.equal(updated.wa_phone_number_id, 'pnid_alpha_001')
})

test('updateAgentPhoneConfig normalizes the phone number', async () => {
  const updated = await updateAgentPhoneConfig(agentA.id, '9876543210', 'pnid_alpha_001')
  assert.equal(updated.wa_phone_number, '+919876543210', 'bare 10-digit number gets +91 prefix')
})

test('updateAgentPhoneConfig rejects short phone numbers', async () => {
  await assert.rejects(
    () => updateAgentPhoneConfig(agentA.id, '12345', 'pnid_short'),
    /valid WhatsApp Business number/,
  )
})

test('updateAgentPhoneConfig rejects duplicate wa_phone_number_id', async () => {
  await updateAgentPhoneConfig(agentA.id, '+13655551111', 'pnid_unique_test')
  await assert.rejects(
    () => updateAgentPhoneConfig(agentB.id, '+13655552222', 'pnid_unique_test'),
    /already assigned to another agent/,
  )
  // Clean up
  await updateAgentPhoneConfig(agentA.id, '+13655551234', 'pnid_alpha_001')
})

test('updateAgentPhoneConfig allows clearing config with nulls', async () => {
  await updateAgentPhoneConfig(agentB.id, '+13655559999', 'pnid_beta_temp')
  const cleared = await updateAgentPhoneConfig(agentB.id, null, null)
  assert.equal(cleared.wa_phone_number, null)
  assert.equal(cleared.wa_phone_number_id, null)
})

test('updateAgentPhoneConfig allows same agent to keep their own phone_number_id', async () => {
  const updated = await updateAgentPhoneConfig(agentA.id, '+13655551234', 'pnid_alpha_001')
  assert.equal(updated.wa_phone_number_id, 'pnid_alpha_001', 'agent can update and keep same id')
})

// --- DB-level tests for findAgentByPhoneNumberId ---

test('findAgentByPhoneNumberId returns the correct agent', async () => {
  const found = await findAgentByPhoneNumberId('pnid_alpha_001')
  assert.ok(found)
  assert.equal(found.id, agentA.id)
})

test('findAgentByPhoneNumberId returns null for unknown id', async () => {
  assert.equal(await findAgentByPhoneNumberId('pnid_nonexistent'), null)
})

test('findAgentByPhoneNumberId returns null for null/empty', async () => {
  assert.equal(await findAgentByPhoneNumberId(null), null)
  assert.equal(await findAgentByPhoneNumberId(''), null)
})

// --- API endpoint tests ---

test('GET /api/agent/phone-config returns current config', async () => {
  const res = await req('GET', '/api/agent/phone-config')
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.wa_phone_number, '+13655551234')
  assert.equal(data.wa_phone_number_id, 'pnid_alpha_001')
})

test('PUT /api/agent/phone-config updates the config', async () => {
  const res = await req('PUT', '/api/agent/phone-config', {
    wa_phone_number: '+14155559876',
    wa_phone_number_id: 'pnid_alpha_updated',
  })
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.wa_phone_number, '+14155559876')
  assert.equal(data.wa_phone_number_id, 'pnid_alpha_updated')
})

test('PUT /api/agent/phone-config rejects duplicate phone_number_id via API', async () => {
  // Set up agent B with a phone number id
  await req('PUT', '/api/agent/phone-config', {
    wa_phone_number: '+14155550001',
    wa_phone_number_id: 'pnid_beta_001',
  }, tokenB)

  // Try to give agent A the same phone_number_id
  const res = await req('PUT', '/api/agent/phone-config', {
    wa_phone_number: '+14155550002',
    wa_phone_number_id: 'pnid_beta_001',
  })
  assert.equal(res.status, 409)
  const data = await res.json()
  assert.match(data.error, /already assigned/)
})

test('PUT /api/agent/phone-config allows clearing the config', async () => {
  const res = await req('PUT', '/api/agent/phone-config', {
    wa_phone_number: null,
    wa_phone_number_id: null,
  })
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.wa_phone_number, null)
  assert.equal(data.wa_phone_number_id, null)
})

test('PUT /api/agent/phone-config rejects invalid phone numbers', async () => {
  const res = await req('PUT', '/api/agent/phone-config', {
    wa_phone_number: '123',
    wa_phone_number_id: 'pnid_short',
  })
  assert.equal(res.status, 400)
})

test('phone config endpoints reject unauthenticated requests', async () => {
  assert.equal((await req('GET', '/api/agent/phone-config', undefined, null)).status, 401)
  assert.equal((await req('PUT', '/api/agent/phone-config', { wa_phone_number: '+1234567890' }, null)).status, 401)
})

test('wa_phone_number is included in auth/me response', async () => {
  // Set a number first
  await req('PUT', '/api/agent/phone-config', {
    wa_phone_number: '+14155557777',
    wa_phone_number_id: 'pnid_me_test',
  })
  const res = await req('GET', '/api/auth/me')
  assert.equal(res.status, 200)
  const agent = await res.json()
  assert.equal(agent.wa_phone_number, '+14155557777')
  assert.equal(agent.wa_phone_number_id, 'pnid_me_test')
})
