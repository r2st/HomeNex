// Tests for an agent changing their own WhatsApp (login) number.
// Run with: npm test  (from server/)  — needs a local PostgreSQL (docker compose up -d).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

// Isolate a throwaway database and skip listen() before importing the app.
process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
const dbName = await createTestDb('agentphone')

const { app } = await import('../index.js')
const { closePool, normalizeIndianMobile, updateAgentPhone, getAgent, listAuditLogs } = await import('../db.js')

let server
let base
let tokenA
let tokenB
let agentA
let agentB

const PASSWORD_A = 'secret123'
const PASSWORD_B = 'secret456'

const req = (method, url, body, tok = tokenA) =>
  fetch(base + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

// Each API test starts from a known number so they stay order-independent.
const resetPhoneA = () => updateAgentPhone(agentA.id, '+919876543210')

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const resA = await req('POST', '/api/auth/signup', {
    name: 'Agent Alpha',
    phone: '+919876543210',
    password: PASSWORD_A,
  }, null)
  const dataA = await resA.json()
  tokenA = dataA.token
  agentA = dataA.agent

  const resB = await req('POST', '/api/auth/signup', {
    name: 'Agent Beta',
    phone: '+919800000002',
    password: PASSWORD_B,
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

// --- normalizeIndianMobile ---

test('normalizeIndianMobile accepts the shapes agents actually type', () => {
  const expected = '+919876543210'
  for (const input of [
    '9876543210',
    '+919876543210',
    '919876543210',
    '09876543210',
    '+91 98765 43210',
    '+91-98765-43210',
    '(+91) 98765.43210',
    '  9876543210  ',
  ]) {
    assert.equal(normalizeIndianMobile(input), expected, `${input} should normalize to ${expected}`)
  }
})

test('normalizeIndianMobile accepts every valid Indian mobile prefix (6-9)', () => {
  for (const first of ['6', '7', '8', '9']) {
    const n = first + '876543210'
    assert.equal(normalizeIndianMobile(n), `+91${n}`)
  }
})

test('normalizeIndianMobile rejects landline-style prefixes (0-5)', () => {
  for (const first of ['0', '1', '2', '3', '4', '5']) {
    assert.equal(normalizeIndianMobile(first + '876543210'), null, `${first}... is not a mobile`)
  }
})

test('normalizeIndianMobile rejects wrong-length numbers', () => {
  assert.equal(normalizeIndianMobile('98765'), null, 'too short')
  assert.equal(normalizeIndianMobile('987654321'), null, '9 digits')
  assert.equal(normalizeIndianMobile('98765432101'), null, '11 digits')
  assert.equal(normalizeIndianMobile('+9198765432100'), null, '+91 with 11 digits')
})

test('normalizeIndianMobile rejects non-Indian country codes', () => {
  assert.equal(normalizeIndianMobile('+13655551234'), null, 'US number')
  assert.equal(normalizeIndianMobile('+442071838750'), null, 'UK number')
})

test('normalizeIndianMobile rejects junk input', () => {
  for (const input of [null, undefined, '', '   ', 'not a phone', '98765abcde', '<script>', '+91;9876543210']) {
    assert.equal(normalizeIndianMobile(input), null, `${JSON.stringify(input)} should be rejected`)
  }
})

// --- updateAgentPhone (DB layer) ---

test('updateAgentPhone stores the normalized number', async () => {
  const updated = await updateAgentPhone(agentA.id, '98765 43211')
  assert.equal(updated.phone, '+919876543211')
  await resetPhoneA()
})

test('updateAgentPhone never leaks the password hash', async () => {
  const updated = await updateAgentPhone(agentA.id, '9876543212')
  assert.equal(updated.password_hash, undefined)
  await resetPhoneA()
})

test('updateAgentPhone is a no-op when the number is unchanged', async () => {
  const updated = await updateAgentPhone(agentA.id, '+919876543210')
  assert.equal(updated.phone, '+919876543210')
  assert.equal(updated.id, agentA.id)
})

test('updateAgentPhone rejects a number already used by another agent', async () => {
  await assert.rejects(
    () => updateAgentPhone(agentA.id, agentB.phone),
    (err) => err.code === 'PHONE_TAKEN' && /Another agent already uses/.test(err.message),
  )
  // The failed attempt must not have changed anything.
  assert.equal((await getAgent(agentA.id)).phone, '+919876543210')
})

test('updateAgentPhone rejects an invalid number', async () => {
  await assert.rejects(
    () => updateAgentPhone(agentA.id, '12345'),
    (err) => err.code === 'INVALID_PHONE',
  )
})

test('updateAgentPhone rejects an unknown agent', async () => {
  await assert.rejects(
    () => updateAgentPhone(999999, '9876543219'),
    (err) => err.code === 'NOT_FOUND',
  )
})

// --- PUT /api/agent/phone ---

test('PUT /api/agent/phone changes the number with the correct password', async () => {
  const res = await req('PUT', '/api/agent/phone', { phone: '9812345678', password: PASSWORD_A })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.phone, '+919812345678')

  // /api/auth/me reflects it, and the old token still works (no forced logout).
  const me = await (await req('GET', '/api/auth/me')).json()
  assert.equal(me.phone, '+919812345678')
  await resetPhoneA()
})

test('PUT /api/agent/phone normalizes a bare 10-digit number to +91', async () => {
  const res = await req('PUT', '/api/agent/phone', { phone: '8765432109', password: PASSWORD_A })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).phone, '+918765432109')
  await resetPhoneA()
})

test('PUT /api/agent/phone lets the agent log in with the new number', async () => {
  await req('PUT', '/api/agent/phone', { phone: '9700000123', password: PASSWORD_A })

  const ok = await req('POST', '/api/auth/login', { phone: '+919700000123', password: PASSWORD_A }, null)
  assert.equal(ok.status, 200, 'new number works')

  const stale = await req('POST', '/api/auth/login', { phone: '+919876543210', password: PASSWORD_A }, null)
  assert.equal(stale.status, 401, 'old number no longer works')
  await resetPhoneA()
})

test('PUT /api/agent/phone rejects a number taken by another agent with 409', async () => {
  const res = await req('PUT', '/api/agent/phone', { phone: agentB.phone, password: PASSWORD_A })
  assert.equal(res.status, 409)
  assert.match((await res.json()).error, /Another agent already uses/)
  assert.equal((await getAgent(agentA.id)).phone, '+919876543210', 'unchanged')
})

test('PUT /api/agent/phone rejects an invalid Indian number with 400', async () => {
  for (const phone of ['12345', '+13655551234', '5876543210', 'not-a-number']) {
    const res = await req('PUT', '/api/agent/phone', { phone, password: PASSWORD_A })
    assert.equal(res.status, 400, `${phone} should be rejected`)
    assert.match((await res.json()).error, /valid Indian mobile/)
  }
  assert.equal((await getAgent(agentA.id)).phone, '+919876543210', 'unchanged')
})

test('PUT /api/agent/phone rejects a wrong password with 403', async () => {
  const res = await req('PUT', '/api/agent/phone', { phone: '9700000999', password: 'wrong-password' })
  assert.equal(res.status, 403)
  assert.match((await res.json()).error, /Wrong password/)
  assert.equal((await getAgent(agentA.id)).phone, '+919876543210', 'unchanged')
})

test('PUT /api/agent/phone rejects a missing password with 403', async () => {
  const res = await req('PUT', '/api/agent/phone', { phone: '9700000999' })
  assert.equal(res.status, 403)
  assert.equal((await getAgent(agentA.id)).phone, '+919876543210', 'unchanged')
})

test('PUT /api/agent/phone checks the password before validating the number', async () => {
  // A wrong password must not let an attacker probe which numbers are valid or taken.
  const res = await req('PUT', '/api/agent/phone', { phone: agentB.phone, password: 'wrong-password' })
  assert.equal(res.status, 403)
})

test('PUT /api/agent/phone rejects unauthenticated requests', async () => {
  const res = await req('PUT', '/api/agent/phone', { phone: '9700000123', password: PASSWORD_A }, null)
  assert.equal(res.status, 401)
})

test('PUT /api/agent/phone only ever changes the caller, never another agent', async () => {
  await req('PUT', '/api/agent/phone', { phone: '9733333333', password: PASSWORD_B }, tokenB)
  assert.equal((await getAgent(agentB.id)).phone, '+919733333333')
  assert.equal((await getAgent(agentA.id)).phone, '+919876543210', 'agent A untouched')
  await updateAgentPhone(agentB.id, '+919800000002')
})

test('PUT /api/agent/phone allows reusing the agent own WA Business number (single-number model)', async () => {
  // Login and WA Business number are the same field now (see db.js updateAgentPhone) —
  // changing the login number to match an already-configured WA Business number must
  // succeed, not be treated as a clash with yourself.
  const { updateAgentPhoneConfig } = await import('../db.js')
  await updateAgentPhoneConfig(agentA.id, '+919888888888', 'pnid_alpha_phone_test')
  const res = await req('PUT', '/api/agent/phone', { phone: '9888888888', password: PASSWORD_A })
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.phone, '+919888888888')
  await updateAgentPhoneConfig(agentA.id, null, null)
  await resetPhoneA()
})

test('PUT /api/agent/phone writes an audit log entry', async () => {
  await req('PUT', '/api/agent/phone', { phone: '9744444444', password: PASSWORD_A })
  const entry = (await listAuditLogs(agentA.id)).find((l) => l.action === 'phone_changed')
  assert.ok(entry, 'phone_changed audit entry exists')
  assert.equal(entry.entity_type, 'agent')
  assert.equal(entry.entity_id, agentA.id)
  assert.equal(entry.details.from, '+919876543210')
  assert.equal(entry.details.to, '+919744444444')
  await resetPhoneA()
})

test('PUT /api/agent/phone does not audit a no-op change', async () => {
  const before = (await listAuditLogs(agentA.id)).filter((l) => l.action === 'phone_changed').length
  const res = await req('PUT', '/api/agent/phone', { phone: '+919876543210', password: PASSWORD_A })
  assert.equal(res.status, 200)
  const after = (await listAuditLogs(agentA.id)).filter((l) => l.action === 'phone_changed').length
  assert.equal(after, before, 'no new audit entry')
})
