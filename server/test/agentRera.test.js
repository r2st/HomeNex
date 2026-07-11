// Tests for the agent RERA registration record: the state and expiry fields added
// in migration 009 alongside the existing rera_id. Run with: npm test (from server/)
// — needs a local PostgreSQL.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
const dbName = await createTestDb('agentrera')

const { app } = await import('../index.js')
const { closePool, getAgent, updateAgentProfileSelf, normalizeReraExpiry } = await import('../db.js')

let server
let base
let token
let agent

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
    name: 'RERA Agent',
    phone: '+919876500011',
    email: 'rera@homenex.in',
    password: 'secret123',
  }, null)
  ;({ token, agent } = await res.json())
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- Defaults from the migration ---

test('a new agent has no RERA state or expiry', async () => {
  const me = await (await req('GET', '/api/auth/me')).json()
  assert.equal(me.rera_id, null)
  assert.equal(me.rera_state, null)
  assert.equal(me.rera_expiry, null)
})

// --- Happy path ---

test('PUT /api/agent/profile saves the full RERA record', async () => {
  const res = await req('PUT', '/api/agent/profile', {
    rera_id: 'A52100012345',
    rera_state: 'Maharashtra',
    rera_expiry: '2029-08-15',
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.rera_id, 'A52100012345')
  assert.equal(body.rera_state, 'Maharashtra')
  assert.equal(body.rera_expiry, '2029-08-15')
})

test('rera_expiry round-trips as a plain YYYY-MM-DD string, not a Date/timestamp', async () => {
  // Regression guard for the DATE type parser: a JS Date would serialize to a full
  // ISO timestamp (and could shift a day across timezones).
  const me = await (await req('GET', '/api/auth/me')).json()
  assert.equal(me.rera_expiry, '2029-08-15')
  assert.equal(typeof me.rera_expiry, 'string')
  const agentRow = await getAgent(agent.id)
  assert.equal(agentRow.rera_expiry, '2029-08-15')
})

test('PUT /api/agent/profile updates RERA state independently', async () => {
  const body = await (await req('PUT', '/api/agent/profile', { rera_state: 'Karnataka' })).json()
  assert.equal(body.rera_state, 'Karnataka')
  assert.equal(body.rera_expiry, '2029-08-15', 'expiry untouched')
  assert.equal(body.rera_id, 'A52100012345', 'id untouched')
  await req('PUT', '/api/agent/profile', { rera_state: 'Maharashtra' })
})

test('PUT /api/agent/profile trims the RERA state', async () => {
  const body = await (await req('PUT', '/api/agent/profile', { rera_state: '  Goa  ' })).json()
  assert.equal(body.rera_state, 'Goa')
  await req('PUT', '/api/agent/profile', { rera_state: 'Maharashtra' })
})

// --- Clearing ---

test('a blank RERA state or expiry clears the field to null', async () => {
  await req('PUT', '/api/agent/profile', { rera_state: '   ', rera_expiry: '' })
  const me = await (await req('GET', '/api/auth/me')).json()
  assert.equal(me.rera_state, null)
  assert.equal(me.rera_expiry, null)
  // restore for any later assertions
  await req('PUT', '/api/agent/profile', { rera_state: 'Maharashtra', rera_expiry: '2029-08-15' })
})

// --- Validation ---

test('PUT /api/agent/profile rejects a malformed RERA expiry', async () => {
  for (const bad of ['not-a-date', '15-08-2029', '2029/08/15', '2029-8-1']) {
    const res = await req('PUT', '/api/agent/profile', { rera_expiry: bad })
    assert.equal(res.status, 400, `${bad} should be rejected`)
    assert.match((await res.json()).error, /RERA expiry must be a date/)
  }
})

test('PUT /api/agent/profile rejects an impossible RERA expiry date', async () => {
  for (const bad of ['2029-02-30', '2029-13-01', '2029-00-10']) {
    const res = await req('PUT', '/api/agent/profile', { rera_expiry: bad })
    assert.equal(res.status, 400, `${bad} should be rejected`)
    assert.match((await res.json()).error, /not a valid date/)
  }
  assert.equal((await getAgent(agent.id)).rera_expiry, '2029-08-15', 'unchanged after bad input')
})

test('PUT /api/agent/profile enforces the RERA state length cap', async () => {
  const res = await req('PUT', '/api/agent/profile', { rera_state: 'x'.repeat(65) })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /RERA state is too long/)
})

// --- DB layer directly ---

test('normalizeReraExpiry accepts valid dates and clears blanks', () => {
  assert.equal(normalizeReraExpiry('2030-01-01'), '2030-01-01')
  assert.equal(normalizeReraExpiry('  2030-12-31  '), '2030-12-31')
  assert.equal(normalizeReraExpiry(''), null)
  assert.equal(normalizeReraExpiry('   '), null)
  assert.equal(normalizeReraExpiry(null), null)
  assert.equal(normalizeReraExpiry(undefined), null)
})

test('normalizeReraExpiry rejects malformed and impossible dates', () => {
  for (const bad of ['15-08-2029', '2029/08/15', 'soon']) {
    assert.throws(() => normalizeReraExpiry(bad), /must be a date/, `${bad} rejected`)
  }
  for (const bad of ['2029-02-30', '2029-13-01']) {
    assert.throws(() => normalizeReraExpiry(bad), /not a valid date/, `${bad} rejected`)
  }
})

test('updateAgentProfileSelf writes the RERA fields directly', async () => {
  const updated = await updateAgentProfileSelf(agent.id, {
    rera_state: 'Telangana',
    rera_expiry: '2031-03-20',
  })
  assert.equal(updated.rera_state, 'Telangana')
  assert.equal(updated.rera_expiry, '2031-03-20')
})
