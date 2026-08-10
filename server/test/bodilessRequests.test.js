// Every write route reads its payload as `req.body ?? {}`. That fallback only runs
// when body-parser left req.body undefined, which is what a request with no JSON
// content-type produces — a stripped proxy, a hand-rolled curl, a fetch() that forgot
// its headers. The route must answer with a 4xx it chose, never a 500 from
// destructuring undefined.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

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
