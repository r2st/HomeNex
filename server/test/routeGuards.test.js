// Route guards: the "not found" and "bad request" halves of every :id-addressed API
// route. These are the branches a happy-path test never reaches, and the ones that
// decide whether a typo'd id, a deleted row, or another tenant's id comes back as a
// clean 404/400 or as a 500 with a stack trace.
//
// Two agents are created so every 404 here is also a tenancy assertion: agent B's ids
// must be as invisible to agent A as ids that never existed.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('routeguards')

const { app } = await import('../index.js')
const { closePool, upsertLead, createProperty, createSiteVisit, createFollowup } = await import('../db.js')

let server, base
let tokenA, agentA, tokenB, agentB
// A row of each type owned by agent B — used to prove cross-tenant ids 404 for A.
const bOwned = {}

const MISSING = 99_999_99

const call = (method, url, body, tok) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
const A = (method, url, body) => call(method, url, body, tokenA)

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const signup = async (name, phone) =>
    (await call('POST', '/api/auth/signup', { name, phone, password: 'secret123' })).json()

  const a = await signup('Guard Gauri', '+919800000131')
  tokenA = a.token
  agentA = a.agent.id
  const b = await signup('Other Omkar', '+919800000132')
  tokenB = b.token
  agentB = b.agent.id

  bOwned.lead = (await upsertLead(agentB, '919888840001', 'B Buyer')).id
  bOwned.property = (await createProperty(agentB, { title: 'B Tower', status: 'available' })).id
  bOwned.visit = (
    await createSiteVisit(agentB, { lead_id: bOwned.lead, scheduled_at: new Date(Date.now() + 86400_000).toISOString() })
  ).id
  bOwned.followup = (await createFollowup(agentB, { lead_id: bOwned.lead, due_at: new Date().toISOString() })).id
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- 404s: ids that don't exist, and ids that belong to someone else ----------

// Every entry is [method, url-template, body]. `%s` is replaced by the id under test.
const LEAD_ROUTES = [
  ['GET', '/api/leads/%s'],
  ['GET', '/api/leads/%s/briefing'],
  ['GET', '/api/leads/%s/suggestions'],
  ['GET', '/api/leads/%s/autofill'],
  ['GET', '/api/leads/%s/notes'],
  ['POST', '/api/leads/%s/notes', { body: 'note' }],
  ['POST', '/api/leads/%s/ai', { enabled: false }],
  ['POST', '/api/leads/%s/autofill/apply', { accepted: { bhk: '2' } }],
  ['POST', '/api/leads/%s/reply', { text: 'hello' }],
  ['PUT', '/api/leads/%s', { bhk: '3' }],
  ['PUT', '/api/leads/%s/stage', { stage: 'Qualified' }],
]

test('every lead route 404s on an id that does not exist', async () => {
  for (const [method, tpl, body] of LEAD_ROUTES) {
    const res = await A(method, tpl.replace('%s', String(MISSING)), body)
    assert.equal(res.status, 404, `${method} ${tpl}`)
    assert.equal((await res.json()).error, 'not found', `${method} ${tpl}`)
  }
})

test("every lead route 404s on ANOTHER agent's lead id", async () => {
  for (const [method, tpl, body] of LEAD_ROUTES) {
    const res = await A(method, tpl.replace('%s', String(bOwned.lead)), body)
    assert.equal(res.status, 404, `${method} ${tpl} leaked a cross-tenant lead`)
  }
})

test('property-matches names the missing entity in its 404', async () => {
  for (const id of [MISSING, bOwned.lead]) {
    const res = await A('GET', `/api/leads/${id}/property-matches`)
    assert.equal(res.status, 404)
    assert.equal((await res.json()).error, 'lead not found')
  }
})

// Claiming is not a read: an unassigned-pool lead that someone else already owns is
// not "not found" (the caller can legitimately see it in the pool listing) — it is a
// conflict, and a retryable one, so it says so. It must still be impossible to claim,
// and the message must not confirm who owns it.
test('claiming a lead that is already owned is a 409, and reveals nothing', async () => {
  const res = await A('POST', `/api/leads/${bOwned.lead}/assign`)
  assert.equal(res.status, 409, `assign ${bOwned.lead}`)
  const { error, code } = await res.json()
  assert.equal(code, 'LEAD_ALREADY_CLAIMED')
  assert.match(error, /claimed/i, 'the 409 must say why the claim failed')
  assert.ok(!/Other Omkar|919888840001/.test(error), 'the 409 must not name the real owner')
})

// An id that matches no row at all is a different answer: there is nothing to
// conflict with, and a 409 there invited the client to retry a claim that can never
// succeed. It is the same 404 every other id-bearing lead route gives.
test('claiming an id that does not exist is a 404, not a retryable conflict', async () => {
  const res = await A('POST', `/api/leads/${MISSING}/assign`)
  assert.equal(res.status, 404, `assign ${MISSING}`)
  assert.equal((await res.json()).error, 'not found')
})

test('property routes 404 on missing and cross-tenant ids', async () => {
  const routes = [
    ['GET', '/api/properties/%s'],
    ['GET', '/api/properties/%s/analytics'],
    ['GET', '/api/properties/%s/syndications'],
    ['PUT', '/api/properties/%s', { title: 'Renamed' }],
    ['DELETE', '/api/properties/%s'],
    ['POST', '/api/properties/%s/micro-page', {}],
    ['POST', '/api/properties/%s/syndicate', { portal: '99acres' }],
  ]
  for (const id of [MISSING, bOwned.property]) {
    for (const [method, tpl, body] of routes) {
      const res = await A(method, tpl.replace('%s', String(id)), body)
      assert.equal(res.status, 404, `${method} ${tpl} (id ${id})`)
    }
  }
})

test('site-visit and follow-up updates 404 on missing and cross-tenant ids', async () => {
  for (const id of [MISSING, bOwned.visit]) {
    const res = await A('PUT', `/api/site-visits/${id}`, { status: 'completed' })
    assert.equal(res.status, 404, `site visit ${id}`)
  }
  for (const id of [MISSING, bOwned.followup]) {
    const res = await A('PUT', `/api/followups/${id}`, { status: 'done' })
    assert.equal(res.status, 404, `followup ${id}`)
  }
})

test('contact, template, label, group and quick-reply routes 404 rather than 500', async () => {
  const routes = [
    ['GET', `/api/contacts/${MISSING}`],
    ['PUT', `/api/contacts/${MISSING}`, { name: 'x' }],
    ['PUT', `/api/templates/${MISSING}`, { body: 'x' }],
    ['DELETE', `/api/templates/${MISSING}`],
    ['PUT', `/api/quick-replies/${MISSING}`, { text: 'x' }],
    ['GET', `/api/groups/${MISSING}/members`],
    ['PUT', `/api/groups/${MISSING}`, { name: 'x' }],
    ['GET', `/api/billing/invoices/${MISSING}`],
    ['GET', `/api/deals/${MISSING}`],
    ['PUT', `/api/deals/${MISSING}`, { status: 'won' }],
    ['PUT', `/api/commissions/${MISSING}`, { status: 'received' }],
    ['POST', `/api/commissions/${MISSING}/invoice`, {}],
    ['GET', `/api/support/tickets/${MISSING}`],
    ['PUT', `/api/notifications/${MISSING}/read`],
  ]
  for (const [method, url, body] of routes) {
    const res = await A(method, url, body)
    assert.equal(res.status, 404, `${method} ${url} returned ${res.status}`)
  }
})

// --- 400s: bodies the routes must refuse -------------------------------------

test('routes with required fields reject an empty body with 400, not 500', async () => {
  const lead = await upsertLead(agentA, '919888840010', 'Guarded Girish')
  const cases = [
    ['POST', '/api/followups', {}], // no lead_id / due_at
    ['POST', '/api/site-visits', {}], // no lead_id / scheduled_at
    ['POST', '/api/site-visits', { lead_id: lead.id }], // no scheduled_at
    ['POST', '/api/site-visits', { scheduled_at: new Date().toISOString() }], // no lead_id
    ['POST', '/api/leads/quick-add', { name: 'no phone' }],
    ['POST', `/api/leads/${lead.id}/autofill/apply`, {}], // no accepted map
    ['POST', `/api/leads/${lead.id}/autofill/apply`, { accepted: 'nope' }], // not an object
    ['PUT', `/api/leads/${lead.id}/stage`, {}], // no stage
    ['POST', '/api/properties', {}], // no title
    ['POST', '/api/groups', {}], // no name
    ['POST', '/api/labels', {}], // no name
  ]
  for (const [method, url, body] of cases) {
    const res = await A(method, url, body)
    assert.equal(res.status, 400, `${method} ${url} ${JSON.stringify(body)} -> ${res.status}`)
    assert.ok((await res.json()).error, 'a 400 must say what was wrong')
  }
})

test('an invalid pipeline stage is a 400 with the allowed values, not a 500', async () => {
  const lead = await upsertLead(agentA, '919888840011', 'Stage Sunita')
  const res = await A('PUT', `/api/leads/${lead.id}/stage`, { stage: 'Teleported' })
  assert.equal(res.status, 400)
  assert.ok((await res.json()).error)
})

test('a site visit for another agent\'s lead is a 404, not a silent cross-tenant booking', async () => {
  const res = await A('POST', '/api/site-visits', {
    lead_id: bOwned.lead, scheduled_at: new Date(Date.now() + 86400_000).toISOString(),
  })
  assert.equal(res.status, 404)
  assert.equal((await res.json()).error, 'lead not found')
})

test("a site visit against another agent's property is a 404", async () => {
  const lead = await upsertLead(agentA, '919888840012', 'Cross Chetan')
  const res = await A('POST', '/api/site-visits', {
    lead_id: lead.id, property_id: bOwned.property, scheduled_at: new Date(Date.now() + 86400_000).toISOString(),
  })
  assert.equal(res.status, 404)
  assert.equal((await res.json()).error, 'property not found')
})

test('syndicating to an unknown portal is a 400', async () => {
  const property = await createProperty(agentA, { title: 'A Tower', status: 'available' })
  assert.equal((await A('POST', `/api/properties/${property.id}/syndicate`, { portal: 'gumtree' })).status, 400)
  assert.equal((await A('POST', `/api/properties/${property.id}/syndicate`, {})).status, 400)
})

// --- Auth guard --------------------------------------------------------------

test('every /api route rejects an anonymous or forged token with 401', async () => {
  const urls = ['/api/leads', '/api/properties', '/api/dashboard', '/api/stats', '/api/contacts', '/api/worklist']
  for (const url of urls) {
    assert.equal((await call('GET', url, undefined, null)).status, 401, `${url} anonymous`)
    assert.equal((await call('GET', url, undefined, 'garbage')).status, 401, `${url} garbage token`)
    assert.equal((await call('GET', url, undefined, `${agentA}.deadbeef`)).status, 401, `${url} forged signature`)
  }
})
