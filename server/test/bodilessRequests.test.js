// Every write route reads its payload straight off req.body, on the strength of one
// middleware: ensureBody guarantees an object is there. The requests that test that
// guarantee are the ones nobody sends on purpose — a stripped proxy, a hand-rolled
// curl, a fetch() that forgot its content-type, a client that posted a bare JSON
// array. Each must draw a 4xx the route chose, never a 500 from reading a field off
// something that isn't an object.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'
import { ensureBody } from '../middleware.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('bodiless')

const { app } = await import('../index.js')
const { closePool, getAgent } = await import('../db.js')

let server, base, token, agent

// A request carrying an auth header and nothing else — no content-type, no body.
const bare = (method, url, tok = token) =>
  fetch(base + url, { method, headers: tok ? { authorization: `Bearer ${tok}` } : {} })

// Well-formed JSON that is not an object: the shape express.json() accepts in strict
// mode and no handler expects.
const sendJson = (method, url, payload, tok = token) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify(payload),
  })

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const out = await (
    await fetch(`${base}/api/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bodiless Bina', phone: '+919845000001', password: 'secret123' }),
    })
  ).json()
  token = out.token
  agent = await getAgent(out.agent.id)
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// Ids are deliberately bogus: every one of these handlers reads the body before it
// looks anything up, so a 404 still proves the body fallback held.
const AUTHED_WRITES = [
  ['PUT', '/api/agent/phone'],
  ['PUT', '/api/agent/password'],
  ['PUT', '/api/agent/profile'],
  ['PUT', '/api/agent/preferences'],
  ['PUT', '/api/agent/phone-config'],
  ['PUT', '/api/agent/wa-phone'],
  ['PUT', '/api/leads/999999'],
  ['PUT', '/api/leads/999999/stage'],
  ['POST', '/api/emi'],
  ['PUT', '/api/contacts/999999'],
  ['POST', '/api/network'],
  ['POST', '/api/properties'],
  ['PUT', '/api/properties/999999'],
  ['POST', '/api/properties/999999/send-to-chat'],
  ['POST', '/api/followups'],
  ['PUT', '/api/followups/999999'],
  ['POST', '/api/site-visits'],
  ['PUT', '/api/site-visits/999999'],
  ['POST', '/api/deals'],
  ['PUT', '/api/deals/999999'],
  ['POST', '/api/commissions'],
  ['PUT', '/api/commissions/999999'],
  ['POST', '/api/commissions/999999/invoice'],
  ['PUT', '/api/commission-invoices/999999'],
  ['POST', '/api/templates'],
  ['PUT', '/api/templates/999999'],
  ['POST', '/api/quick-replies'],
  ['PUT', '/api/quick-replies/999999'],
  ['POST', '/api/labels'],
  ['POST', '/api/media'],
  ['POST', '/api/uploads'],
  ['POST', '/api/templates/festive/send'],
  ['POST', '/api/groups'],
  ['PUT', '/api/groups/999999'],
  ['POST', '/api/groups/999999/members'],
  ['POST', '/api/groups/999999/send'],
  ['POST', '/api/segments/preview'],
  ['POST', '/api/leads/quick-add'],
  ['PUT', '/api/portal-integrations/99acres'],
  ['POST', '/api/support/tickets'],
  ['POST', '/api/simulate'],
]

test('no authenticated write route 500s on a request with no body', async () => {
  const broken = []
  for (const [method, url] of AUTHED_WRITES) {
    const res = await bare(method, url)
    if (res.status >= 500) broken.push(`${method} ${url} -> ${res.status}`)
    // Whatever it answers, it must still be JSON with a usable shape — a route that
    // fell through to the SPA catch-all or an HTML error page would fail here.
    if (res.status !== 204) {
      const body = await res.json().catch(() => null)
      if (body === null) broken.push(`${method} ${url} -> non-JSON body`)
    }
  }
  assert.deepEqual(broken, [], 'routes that mishandled an absent body')
})

test('the auth routes reject a bodiless request without crashing', async () => {
  const signup = await bare('POST', '/api/auth/signup', null)
  assert.equal(signup.status, 400)
  assert.ok((await signup.json()).error, 'a real validation message')

  const login = await bare('POST', '/api/auth/login', null)
  assert.equal(login.status, 401)
  assert.ok((await login.json()).error)
})

// The two public ingest endpoints read `req.body || {}` instead — same exposure, and
// they are the routes most likely to be hit by someone else's HTTP client.
test('the public ingest endpoints answer a bodiless POST without crashing', async () => {
  const email = await bare('POST', `/ingest/email/${agent.ingest_token}`, null)
  assert.equal(email.status, 202, 'nothing parseable, so nothing ingested')
  assert.deepEqual(await email.json(), { ok: false, reason: 'no_lead_parsed' })

  const portal = await bare('POST', `/ingest/portal/${agent.ingest_token}/99acres`, null)
  assert.equal(portal.status, 400)
  assert.match((await portal.json()).error, /phone/)
})

// A bodiless write must not be mistaken for an authorised one: the auth check still
// runs first, so an anonymous caller gets 401 rather than a validation error that
// would tell them the route exists and what it wants.
test('a bodiless write from an anonymous caller is still a 401', async () => {
  for (const [method, url] of [['POST', '/api/properties'], ['PUT', '/api/agent/profile'], ['POST', '/api/deals']]) {
    const res = await bare(method, url, null)
    assert.equal(res.status, 401, `${method} ${url}`)
  }
})

// --- ensureBody, the one place the guarantee is made -------------------------

test('ensureBody hands the handler an object whatever the parser left behind', () => {
  const run = (body) => {
    const req = { body }
    let called = false
    ensureBody(req, null, () => {
      called = true
    })
    assert.ok(called, 'the middleware has to call next() on every path')
    return req.body
  }

  // The absent body, which is what Express 5's parser will start producing.
  assert.deepEqual(run(undefined), {})
  assert.deepEqual(run(null), {})
  // Well-formed JSON that isn't an object. An array is the only one express.json()
  // accepts in strict mode; the scalars arrive from a parser configured otherwise.
  assert.deepEqual(run([1, 2, 3]), {})
  assert.deepEqual(run('a string'), {})
  assert.deepEqual(run(7), {})

  // A real body is passed through untouched — the same object, not a copy, so
  // nothing that already ran against req.body is looking at a stale one.
  const real = { name: 'Meera', nested: { keep: true } }
  assert.equal(run(real), real)
  // Including the empty object the parser supplies for a bodiless request.
  const empty = {}
  assert.equal(run(empty), empty)
})

test('a bare JSON array is treated as an empty body, not as fields', async () => {
  // Before ensureBody this reached the handler as an array: every field read as
  // undefined and the route answered whichever complaint happened to come first.
  // Now it is an empty body, and the route says what it actually wanted.
  const res = await sendJson('POST', '/api/followups', [{ lead_id: 1 }])
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /lead_id/)

  // And it does not become a way to skip a required field on the way in.
  const property = await sendJson('POST', '/api/properties', ['Sea View Towers'])
  assert.ok(property.status >= 400 && property.status < 500, `expected a 4xx, got ${property.status}`)
})
