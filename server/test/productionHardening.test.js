// Tests for the production-hardening pass: input bounds on admin plan/ticket/
// subscription routes, team route validation, group member array cap, and the
// Permissions-Policy security header.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('prodharden')

const { app } = await import('../index.js')
const { closePool, setAdmin, addContact, createGroup } = await import('../db.js')

let server, base
let staff, agent1, agent2
let planId

const req = (method, url, body, tok) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
const json = (r) => r.json()
const signup = async (name, phone) =>
  json(await req('POST', '/api/auth/signup', { name, phone, password: 'secret123' }))

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  staff = await signup('Staff Hari', '+919840000001')
  agent1 = await signup('Agent Priya', '+919840000002')
  agent2 = await signup('Agent Ravi', '+919840000003')
  await setAdmin(staff.agent.id, true)

  const planRes = await req('POST', '/api/admin/plans', {
    code: 'hardtest', name: 'Hard Test', price_paise: 10000, conversation_quota: 100,
  }, staff.token)
  planId = (await json(planRes)).id
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// =============================================================================
// §1 Admin plan routes — boundedText + boundedNumber
// =============================================================================

test('POST /plans rejects an oversized plan name', async () => {
  const res = await req('POST', '/api/admin/plans', {
    code: 'big', name: 'x'.repeat(200),
  }, staff.token)
  assert.equal(res.status, 400)
  const body = await json(res)
  assert.equal(body.code, 'FIELD_TOO_LONG')
  assert.equal(body.field, 'name')
})

test('POST /plans rejects an oversized plan code', async () => {
  const res = await req('POST', '/api/admin/plans', {
    code: 'c'.repeat(200), name: 'Fine',
  }, staff.token)
  assert.equal(res.status, 400)
  assert.equal((await json(res)).field, 'code')
})

test('POST /plans rejects a non-numeric price_paise', async () => {
  const res = await req('POST', '/api/admin/plans', {
    code: 'bad', name: 'Bad', price_paise: 'expensive',
  }, staff.token)
  assert.equal(res.status, 400)
  assert.equal((await json(res)).code, 'FIELD_NOT_A_NUMBER')
})

test('POST /plans rejects a negative price_paise', async () => {
  const res = await req('POST', '/api/admin/plans', {
    code: 'neg', name: 'Neg', price_paise: -100,
  }, staff.token)
  assert.equal(res.status, 400)
  assert.equal((await json(res)).code, 'FIELD_OUT_OF_RANGE')
})

test('PUT /plans/:id rejects an oversized name', async () => {
  const res = await req('PUT', `/api/admin/plans/${planId}`, {
    name: 'y'.repeat(200),
  }, staff.token)
  assert.equal(res.status, 400)
  assert.equal((await json(res)).code, 'FIELD_TOO_LONG')
})

test('PUT /plans/:id rejects a non-numeric conversation_quota', async () => {
  const res = await req('PUT', `/api/admin/plans/${planId}`, {
    conversation_quota: 'unlimited',
  }, staff.token)
  assert.equal(res.status, 400)
  assert.equal((await json(res)).code, 'FIELD_NOT_A_NUMBER')
})

// =============================================================================
// §2 Admin subscription route — boundedText + boundedNumber
// =============================================================================

test('PUT /agents/:id/subscription rejects a non-numeric plan_id', async () => {
  const res = await req('PUT', `/api/admin/agents/${agent1.agent.id}/subscription`, {
    plan_id: 'free',
  }, staff.token)
  assert.equal(res.status, 400)
  assert.equal((await json(res)).code, 'FIELD_NOT_A_NUMBER')
})

test('PUT /agents/:id/subscription rejects a negative plan_id', async () => {
  const res = await req('PUT', `/api/admin/agents/${agent1.agent.id}/subscription`, {
    plan_id: -1,
  }, staff.token)
  assert.equal(res.status, 400)
  assert.equal((await json(res)).code, 'FIELD_OUT_OF_RANGE')
})

test('PUT /agents/:id/subscription rejects an oversized status', async () => {
  const res = await req('PUT', `/api/admin/agents/${agent1.agent.id}/subscription`, {
    plan_id: planId, status: 's'.repeat(200),
  }, staff.token)
  assert.equal(res.status, 400)
  assert.equal((await json(res)).code, 'FIELD_TOO_LONG')
})

test('PUT /agents/:id/subscription accepts valid input', async () => {
  const res = await req('PUT', `/api/admin/agents/${agent1.agent.id}/subscription`, {
    plan_id: planId, status: 'active',
  }, staff.token)
  assert.equal(res.status, 200)
})

// =============================================================================
// §3 Admin ticket route — boundedText
// =============================================================================

test('PUT /tickets/:id rejects an oversized status field', async () => {
  // Create a ticket first so there's something to update.
  const ticketRes = await req('POST', '/api/tickets', {
    subject: 'Help', body: 'Please help me', category: 'general',
  }, agent1.token)
  const ticket = await json(ticketRes)

  const res = await req('PUT', `/api/admin/tickets/${ticket.id}`, {
    status: 'x'.repeat(200),
  }, staff.token)
  assert.equal(res.status, 400)
  assert.equal((await json(res)).code, 'FIELD_TOO_LONG')
})

test('PUT /tickets/:id rejects an oversized priority field', async () => {
  const ticketRes = await req('POST', '/api/tickets', {
    subject: 'Help2', body: 'Please help again',
  }, agent1.token)
  const ticket = await json(ticketRes)

  const res = await req('PUT', `/api/admin/tickets/${ticket.id}`, {
    priority: 'p'.repeat(200),
  }, staff.token)
  assert.equal(res.status, 400)
  assert.equal((await json(res)).field, 'priority')
})

// =============================================================================
// §4 Team routes — boundedText on team name, boundedNumber on stale days + assign
// =============================================================================

test('POST /api/team rejects an oversized team name', async () => {
  const res = await req('POST', '/api/team', {
    name: 't'.repeat(200),
  }, agent1.token)
  assert.equal(res.status, 400)
  assert.equal((await json(res)).code, 'FIELD_TOO_LONG')
})

test('POST /api/team accepts a valid team name', async () => {
  const res = await req('POST', '/api/team', { name: 'Good Team' }, agent1.token)
  assert.equal(res.status, 200)
})

test('GET /api/team/stale rejects non-numeric days', async () => {
  const res = await req('GET', '/api/team/stale?days=abc', undefined, agent1.token)
  assert.equal(res.status, 400)
  assert.equal((await json(res)).code, 'FIELD_NOT_A_NUMBER')
})

test('GET /api/team/stale rejects days out of range', async () => {
  const res = await req('GET', '/api/team/stale?days=999', undefined, agent1.token)
  assert.equal(res.status, 400)
  assert.equal((await json(res)).code, 'FIELD_OUT_OF_RANGE')
})

test('GET /api/team/stale rejects fractional days', async () => {
  const res = await req('GET', '/api/team/stale?days=2.5', undefined, agent1.token)
  assert.equal(res.status, 400)
  assert.equal((await json(res)).code, 'FIELD_NOT_A_NUMBER')
})

test('POST /api/team/leads/:id/assign rejects a non-numeric agent_id', async () => {
  const res = await req('POST', '/api/team/leads/1/assign', {
    agent_id: 'bob',
  }, agent1.token)
  assert.equal(res.status, 400)
  assert.equal((await json(res)).code, 'FIELD_NOT_A_NUMBER')
})

// =============================================================================
// §5 Team member localities validation
// =============================================================================

test('PUT /members/:id rejects non-array localities', async () => {
  const res = await req('PUT', `/api/team/members/${agent1.agent.id}`, {
    localities: 'Andheri',
  }, agent1.token)
  assert.equal(res.status, 400)
  assert.match((await json(res)).error, /localities must be an array/)
})

test('PUT /members/:id rejects too many localities', async () => {
  const res = await req('PUT', `/api/team/members/${agent1.agent.id}`, {
    localities: Array.from({ length: 51 }, (_, i) => `Loc ${i}`),
  }, agent1.token)
  assert.equal(res.status, 400)
  assert.match((await json(res)).error, /too many entries/)
})

test('PUT /members/:id rejects an oversized locality entry', async () => {
  const res = await req('PUT', `/api/team/members/${agent1.agent.id}`, {
    localities: ['x'.repeat(200)],
  }, agent1.token)
  assert.equal(res.status, 400)
  assert.match((await json(res)).error, /characters or fewer/)
})

// =============================================================================
// §6 Group member array cap
// =============================================================================

test('POST /api/groups/:id/members rejects > 500 contact_ids', async () => {
  const group = await createGroup(agent1.agent.id, { name: 'Test Group', kind: 'static' })
  const ids = Array.from({ length: 501 }, (_, i) => i + 1)
  const res = await req('POST', `/api/groups/${group.id}/members`, {
    contact_ids: ids,
  }, agent1.token)
  assert.equal(res.status, 400)
  assert.match((await json(res)).error, /too large/)
})

// =============================================================================
// §7 Permissions-Policy header
// =============================================================================

test('every response carries a Permissions-Policy header', async () => {
  const res = await req('GET', '/api/health', undefined, null)
  const pp = res.headers.get('permissions-policy')
  assert.ok(pp, 'Permissions-Policy header must be present')
  assert.match(pp, /camera=\(\)/)
  assert.match(pp, /microphone=\(\)/)
  assert.match(pp, /geolocation=\(\)/)
})
