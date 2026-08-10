// Cross-tenant access controls and request validation on the routes where a bad or
// hostile value used to reach Postgres directly. Two agents are registered so every
// assertion is "agent B cannot touch agent A's thing", not just "the happy path works".
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('tenancy')

const { app } = await import('../index.js')
const { closePool } = await import('../db.js')

let server, base
let alice, bob // { token, agent }
let aliceLeadId

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
  alice = await signup('Alice Broker', '+919800000101')
  bob = await signup('Bob Broker', '+919800000202')
  const sim = await json(await req('POST', '/api/simulate', { from: '919777000001', text: 'Need a 3BHK' }, alice.token))
  aliceLeadId = sim.lead.id
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- Meta Lead Ads form ownership -------------------------------------------
// The form→agent map decides whose CRM an ad lead lands in. Anyone able to
// overwrite another workspace's entry would silently receive that workspace's leads.

test('leadgen form: the first agent to connect a form owns it', async () => {
  const res = await req('POST', '/api/lead-sources/leadgen-form', { form_id: 'form-abc-123' }, alice.token)
  assert.equal(res.status, 200)
  assert.deepEqual(await json(res), { ok: true, form_id: 'form-abc-123' })
})

test('leadgen form: re-connecting your own form is idempotent', async () => {
  const res = await req('POST', '/api/lead-sources/leadgen-form', { form_id: 'form-abc-123' }, alice.token)
  assert.equal(res.status, 200)
})

test('leadgen form: another agent cannot hijack a connected form', async () => {
  const res = await req('POST', '/api/lead-sources/leadgen-form', { form_id: 'form-abc-123' }, bob.token)
  assert.equal(res.status, 409)
  assert.equal((await json(res)).code, 'FORM_TAKEN')
})

test('leadgen form: a junk form_id is rejected, not stored', async () => {
  for (const form_id of ['', '   ', 'a b c', '<script>', 'x'.repeat(101)]) {
    const res = await req('POST', '/api/lead-sources/leadgen-form', { form_id }, bob.token)
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(form_id)}`)
  }
})

// --- Thread reassignment ------------------------------------------------------
// leads.assigned_agent_id is a foreign key: an unvalidated id used to 500, and an
// arbitrary valid id would have pushed the thread into a stranger's inbox.

test('assign-to: reassigning to yourself works', async () => {
  const res = await req('POST', `/api/leads/${aliceLeadId}/assign-to`, { assignee_id: alice.agent.id }, alice.token)
  assert.equal(res.status, 200)
  assert.equal((await json(res)).assigned_agent_id, alice.agent.id)
})

test('assign-to: null hands the thread back to the owner', async () => {
  const res = await req('POST', `/api/leads/${aliceLeadId}/assign-to`, { assignee_id: null }, alice.token)
  assert.equal(res.status, 200)
  assert.equal((await json(res)).assigned_agent_id, null)
})

test('assign-to: an agent outside your team is refused, not assigned', async () => {
  const res = await req('POST', `/api/leads/${aliceLeadId}/assign-to`, { assignee_id: bob.agent.id }, alice.token)
  assert.equal(res.status, 403)
  assert.equal((await json(res)).code, 'NOT_TEAMMATE')
})

test('assign-to: an unknown agent id is a 404, never a 500', async () => {
  const res = await req('POST', `/api/leads/${aliceLeadId}/assign-to`, { assignee_id: 999999 }, alice.token)
  assert.equal(res.status, 404)
  assert.equal((await json(res)).code, 'ASSIGNEE_NOT_FOUND')
})

test('assign-to: a non-numeric assignee id is a 400, never a 500', async () => {
  for (const assignee_id of ['abc', 0, -3, 1.5, {}]) {
    const res = await req('POST', `/api/leads/${aliceLeadId}/assign-to`, { assignee_id }, alice.token)
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(assignee_id)}`)
  }
})

test('assign-to: a lead you do not own is a 404', async () => {
  const res = await req('POST', `/api/leads/${aliceLeadId}/assign-to`, { assignee_id: bob.agent.id }, bob.token)
  assert.equal(res.status, 404)
})

test('assign-to: teammates can hold each other’s threads', async () => {
  await req('POST', '/api/team', { name: 'Powai Desk' }, alice.token)
  await req('POST', '/api/team/invites', { phone: bob.agent.phone, role: 'agent' }, alice.token)
  const incoming = await json(await req('GET', '/api/team', undefined, bob.token))
  const invite = incoming.incoming_invites?.[0]
  assert.ok(invite, 'bob should see the invitation')
  await req('POST', `/api/team/invites/${invite.id}/accept`, {}, bob.token)

  const res = await req('POST', `/api/leads/${aliceLeadId}/assign-to`, { assignee_id: bob.agent.id }, alice.token)
  assert.equal(res.status, 200)
  assert.equal((await json(res)).assigned_agent_id, bob.agent.id)
})

// --- Network posts ------------------------------------------------------------
// Broadcast to every agent on the platform, so the columns are bounded and coerced.

test('network: a valid post is accepted and normalised', async () => {
  const res = await req('POST', '/api/network', {
    type: 'INVENTORY', broker: 'Alice', text: '3BHK in Powai', budget_min_l: '120', budget_max_l: 150,
  }, alice.token)
  assert.equal(res.status, 200)
  const post = await json(res)
  assert.equal(post.budget_min_l, 120) // numeric string coerced, not passed through
  assert.equal(post.budget_max_l, 150)
  assert.equal(post.firm, null)
})

test('network: a non-numeric budget is a 400, never a 500', async () => {
  const res = await req('POST', '/api/network', {
    type: 'INVENTORY', broker: 'Alice', text: 'hi', budget_min_l: 'not-a-number',
  }, alice.token)
  assert.equal(res.status, 400)
  assert.match((await json(res)).error, /budget_min_l/)
})

test('network: a negative budget is rejected', async () => {
  const res = await req('POST', '/api/network', {
    type: 'INVENTORY', broker: 'Alice', text: 'hi', budget_max_l: -5,
  }, alice.token)
  assert.equal(res.status, 400)
})

test('network: an oversized body is rejected rather than broadcast', async () => {
  const res = await req('POST', '/api/network', {
    type: 'REQUIREMENT', broker: 'Alice', text: 'x'.repeat(2001),
  }, alice.token)
  assert.equal(res.status, 400)
  assert.match((await json(res)).error, /2000 characters/)
})

test('network: type and the required fields are still enforced', async () => {
  const cases = [
    {},
    { type: 'SPAM', broker: 'A', text: 'b' },
    { type: 'INVENTORY', broker: '', text: 'b' },
    { type: 'INVENTORY', broker: 'A', text: '   ' },
  ]
  for (const body of cases) {
    const res = await req('POST', '/api/network', body, alice.token)
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`)
  }
})

test('network: posts require a logged-in agent', async () => {
  const res = await req('POST', '/api/network', { type: 'INVENTORY', broker: 'X', text: 'y' })
  assert.equal(res.status, 401)
})
