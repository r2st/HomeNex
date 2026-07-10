// Tests for WABA registration flow, admin panel, signup with wa_phone_number, and auto-client creation.
// Run with: npm test  (from server/)  — uses Node's built-in test runner.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Isolate a throwaway DB and skip listen() before importing the app.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_FILE = path.join('/tmp', `test-waba-${process.pid}.db`)
process.env.NODE_ENV = 'test'
process.env.DB_FILE = DB_FILE
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN

const { app } = await import('../index.js')
const db = (await import('../db.js')).default
const {
  createAgent,
  getAgent,
  updateWabaStatus,
  listAllAgents,
  adminStats,
  findAgentByPhoneNumberId,
  normalizePhone,
} = await import('../db.js')
const { hashPassword, issueToken } = await import('../auth.js')

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
})

after(() => {
  server?.close()
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    fs.rmSync(DB_FILE + suffix, { force: true })
  }
})

// === Signup with wa_phone_number ===

test('signup with wa_phone_number stores it and sets waba_status to pending', async () => {
  const res = await req('POST', '/api/auth/signup', {
    name: 'Agent Alpha',
    phone: '+919800000001',
    password: 'secret123',
    wa_phone_number: '+919800000099',
  }, null)
  assert.equal(res.status, 200)
  const data = await res.json()
  tokenA = data.token
  agentA = data.agent
  assert.equal(data.agent.wa_phone_number, '+919800000099')
  assert.equal(data.agent.waba_status, 'pending')
})

test('signup without wa_phone_number sets waba_status to none', async () => {
  const res = await req('POST', '/api/auth/signup', {
    name: 'Agent Beta',
    phone: '+919800000002',
    password: 'secret456',
  }, null)
  assert.equal(res.status, 200)
  const data = await res.json()
  tokenB = data.token
  agentB = data.agent
  assert.equal(data.agent.wa_phone_number, null)
  assert.equal(data.agent.waba_status, 'none')
})

test('signup rejects wa_phone_number same as personal phone', async () => {
  const res = await req('POST', '/api/auth/signup', {
    name: 'Agent Gamma',
    phone: '+919800000003',
    password: 'secret789',
    wa_phone_number: '+919800000003',
  }, null)
  assert.equal(res.status, 400)
  const data = await res.json()
  assert.match(data.error, /must be different/)
})

// === Agent updates their WA Business phone from settings ===

test('PUT /api/agent/wa-phone sets business number and status to pending', async () => {
  const res = await req('PUT', '/api/agent/wa-phone', {
    wa_phone_number: '+919800000088',
  }, tokenB)
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.wa_phone_number, '+919800000088')
  assert.equal(data.waba_status, 'pending')
})

test('PUT /api/agent/wa-phone rejects same as personal number', async () => {
  const res = await req('PUT', '/api/agent/wa-phone', {
    wa_phone_number: '+919800000002',
  }, tokenB)
  assert.equal(res.status, 400)
  const data = await res.json()
  assert.match(data.error, /must be different/)
})

test('PUT /api/agent/wa-phone rejects invalid number', async () => {
  const res = await req('PUT', '/api/agent/wa-phone', {
    wa_phone_number: '123',
  }, tokenB)
  assert.equal(res.status, 400)
})

test('PUT /api/agent/wa-phone requires auth', async () => {
  const res = await req('PUT', '/api/agent/wa-phone', {
    wa_phone_number: '+919800000077',
  }, null)
  assert.equal(res.status, 401)
})

// === DB-level WABA status management ===

test('updateWabaStatus transitions none -> pending', () => {
  const agent = getAgent(agentB.id)
  assert.equal(agent.waba_status, 'pending') // was set by PUT /api/agent/wa-phone
  const updated = updateWabaStatus(agentB.id, { status: 'pending' })
  assert.equal(updated.waba_status, 'pending')
})

test('updateWabaStatus transitions pending -> registered with meta IDs', () => {
  const updated = updateWabaStatus(agentA.id, {
    status: 'registered',
    metaWabaId: 'waba_001',
    waPhoneNumberId: 'pnid_001',
  })
  assert.equal(updated.waba_status, 'registered')
  assert.equal(updated.meta_waba_id, 'waba_001')
  assert.equal(updated.wa_phone_number_id, 'pnid_001')
  assert.ok(updated.waba_registered_at, 'registered_at should be set')
})

test('updateWabaStatus transitions registered -> active', () => {
  const updated = updateWabaStatus(agentA.id, { status: 'active' })
  assert.equal(updated.waba_status, 'active')
  assert.ok(updated.waba_registered_at, 'registered_at should persist')
})

test('updateWabaStatus rejects invalid status', () => {
  assert.throws(
    () => updateWabaStatus(agentA.id, { status: 'invalid' }),
    /Invalid WABA status/,
  )
})

test('updateWabaStatus clears registered_at when going back to none', () => {
  const updated = updateWabaStatus(agentB.id, { status: 'none' })
  assert.equal(updated.waba_status, 'none')
  assert.equal(updated.waba_registered_at, null)
})

// === findAgentByPhoneNumberId prioritizes active WABA ===

test('findAgentByPhoneNumberId returns agent with active WABA', () => {
  // agentA has waba_status=active and wa_phone_number_id=pnid_001
  const found = findAgentByPhoneNumberId('pnid_001')
  assert.ok(found)
  assert.equal(found.id, agentA.id)
})

test('findAgentByPhoneNumberId fallback to non-active agent', () => {
  // agentB has no phone_number_id yet, set one without active status
  updateWabaStatus(agentB.id, { status: 'pending', waPhoneNumberId: 'pnid_002' })
  const found = findAgentByPhoneNumberId('pnid_002')
  assert.ok(found, 'should still find by fallback')
  assert.equal(found.id, agentB.id)
})

// === Admin APIs ===

test('admin dashboard auto-promotes first agent and returns stats', async () => {
  // First agent (agentA) should be auto-promoted to admin
  const res = await req('GET', '/api/admin/dashboard')
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.ok(data.totalAgents >= 2)
  assert.ok('pendingWaba' in data)
  assert.ok('activeWaba' in data)
})

test('non-admin agent gets 403 on admin routes', async () => {
  const res = await req('GET', '/api/admin/agents', undefined, tokenB)
  assert.equal(res.status, 403)
})

test('admin can list all agents', async () => {
  const res = await req('GET', '/api/admin/agents')
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.ok(Array.isArray(data))
  assert.ok(data.length >= 2)
  // Each agent should have waba fields
  const a = data.find((x) => x.id === agentA.id)
  assert.ok(a)
  assert.ok('waba_status' in a)
  assert.ok('wa_phone_number' in a)
})

test('admin can update agent WABA status', async () => {
  const res = await req('PUT', `/api/admin/agents/${agentB.id}/waba`, {
    status: 'registered',
    meta_waba_id: 'waba_beta_001',
    wa_phone_number_id: 'pnid_beta_001',
  })
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.waba_status, 'registered')
  assert.equal(data.meta_waba_id, 'waba_beta_001')
  assert.equal(data.wa_phone_number_id, 'pnid_beta_001')
})

test('admin WABA update rejects invalid status', async () => {
  const res = await req('PUT', `/api/admin/agents/${agentB.id}/waba`, {
    status: 'bogus',
  })
  assert.equal(res.status, 400)
})

test('admin WABA update requires status field', async () => {
  const res = await req('PUT', `/api/admin/agents/${agentB.id}/waba`, {
    meta_waba_id: 'some_id',
  })
  assert.equal(res.status, 400)
})

// === listAllAgents and adminStats ===

test('listAllAgents returns all agents with WABA fields', () => {
  const agents = listAllAgents()
  assert.ok(agents.length >= 2)
  for (const a of agents) {
    assert.ok('waba_status' in a)
    assert.ok('wa_phone_number' in a)
    assert.ok('meta_waba_id' in a)
    assert.ok('is_admin' in a)
  }
})

test('adminStats returns correct counts', () => {
  const s = adminStats()
  assert.ok(s.totalAgents >= 2)
  assert.ok(typeof s.pendingWaba === 'number')
  assert.ok(typeof s.activeWaba === 'number')
  assert.ok(typeof s.totalLeads === 'number')
  assert.ok(typeof s.totalContacts === 'number')
})

// === WABA fields in auth/me response ===

test('auth/me includes WABA fields', async () => {
  const res = await req('GET', '/api/auth/me')
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.ok('waba_status' in data)
  assert.ok('wa_phone_number' in data)
  assert.ok('meta_waba_id' in data)
  assert.ok('is_admin' in data)
})
