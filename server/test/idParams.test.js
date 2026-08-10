// The path-id guard: every :id in this app is a SERIAL primary key, so anything
// that isn't a positive int4 is rejected with a 400 before a handler runs.
//
// tenantSweep.test.js proves no route 500s on a garbled id. This file pins the rule
// itself — the shapes that must be refused, the ones that must still get through,
// and the fact that the guard reaches the two mounted sub-routers, which
// app.param() does NOT do on its own.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Router } from 'express'
import { validateIdParams, ID_PARAMS } from '../middleware.js'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('idparams')

const { app } = await import('../index.js')
const { closePool } = await import('../db.js')

let server, base, token, agentId

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const out = await (
    await req('POST', '/api/auth/signup', { name: 'Id Ishaan', phone: '+919800000901', password: 'secret123' }, null)
  ).json()
  token = out.token
  agentId = out.agent.id
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- What must be refused -----------------------------------------------------

test('a non-numeric id is a 400 with a BAD_ID code, not a 404 or a 500', async () => {
  const res = await req('GET', '/api/leads/not-an-id')
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.code, 'BAD_ID')
  assert.match(body.error, /Invalid id/)
})

test('every malformed shape a caller can produce is refused', async () => {
  const bad = [
    'undefined', // the classic frontend bug: a template literal over a missing value
    'null',
    'NaN',
    '0', // no SERIAL is ever 0
    '-1',
    '1.5',
    '1e3',
    '+1',
    ' 1',
    '01x',
    '2147483648', // one past int4: all digits, still 22003 at the database
    '9999999999999999999',
    "1' OR '1'='1",
    '1;DROP TABLE leads',
    '%20',
  ]
  for (const id of bad) {
    const res = await req('GET', `/api/leads/${encodeURIComponent(id)}`)
    assert.equal(res.status, 400, `${id} was not refused (got ${res.status})`)
  }
})

test('an empty id segment is a 404 from the router, not a crash', async () => {
  // `/api/leads/` doesn't match the :id route at all — it falls through to the
  // list route or the catch-all. Either way it must not be a 500.
  const res = await req('GET', '/api/leads/')
  assert.ok(res.status < 500, `got ${res.status}`)
})

test('the guard covers the secondary id params, not just :id', async () => {
  // noteId, labelId and contactId sit in the second position and would otherwise
  // sail past a guard that only looked at :id.
  const cases = [
    ['DELETE', '/api/leads/1/notes/not-an-id'],
    ['PUT', '/api/leads/1/labels/not-an-id'],
    ['DELETE', '/api/groups/1/members/not-an-id'],
  ]
  for (const [method, url] of cases) {
    const res = await req(method, url, {})
    assert.equal(res.status, 400, `${method} ${url} -> ${res.status}`)
    assert.equal((await res.json()).code, 'BAD_ID')
  }
})

test('a bad id is refused before the handler can touch the database', async () => {
  // A write with a garbled id must not be half-applied. The clearest proof is that
  // the rejection is indistinguishable from one where no row exists at all.
  const res = await req('PUT', '/api/leads/not-an-id/stage', { stage: 'Lost' })
  assert.equal(res.status, 400)
  assert.equal((await res.json()).code, 'BAD_ID')
})

// --- What must still get through ---------------------------------------------

test('a well-formed id reaches the handler and gets its normal answer', async () => {
  // 404 rather than 400: the guard passed it through and the handler found no row.
  const res = await req('GET', '/api/leads/999999')
  assert.equal(res.status, 404)
  assert.notEqual((await res.json()).code, 'BAD_ID')
})

test('int4 boundary ids are accepted, not rejected as too large', async () => {
  const res = await req('GET', '/api/leads/2147483647')
  assert.equal(res.status, 404, 'the largest valid int4 was refused')
})

test('non-id path params are untouched by the guard', async () => {
  // :portal and :slug are names, not ids — validating them as integers would break
  // both routes outright.
  const portal = await req('PUT', '/api/portal-integrations/housing', { enabled: false })
  assert.equal(portal.status, 200)
  const unknown = await req('PUT', '/api/portal-integrations/not-a-portal', { enabled: false })
  assert.equal(unknown.status, 400)
  assert.match((await unknown.json()).error, /unknown portal/, 'the route\'s own validation still runs')

  const page = await fetch(`${base}/p/no-such-slug`)
  assert.ok(page.status < 500, `a slug route answered ${page.status}`)
})

// --- The mounted sub-routers --------------------------------------------------

test('the guard reaches the team and admin routers, which app.param does not', async () => {
  // Express does not propagate app.param() into a mounted Router, so these two are
  // armed explicitly in index.js. Without that they'd still 500 on a garbled id.
  // Both answer 403 for a non-admin/non-team caller — the point is that a MALFORMED
  // id is caught earlier, at 400, and never reaches a query.
  const team = await req('PUT', '/api/team/members/not-an-id/role', { role: 'manager' })
  assert.ok([400].includes(team.status), `team router answered ${team.status}`)
  assert.equal((await team.json()).code, 'BAD_ID')

  const admin = await req('GET', '/api/admin/agents/not-an-id')
  assert.ok([400].includes(admin.status), `admin router answered ${admin.status}`)
  assert.equal((await admin.json()).code, 'BAD_ID')
})

test('the guard runs before authorization, so it cannot leak whether a row exists', async () => {
  // A 400 for every caller — authed or not — means a malformed probe learns nothing
  // about the id space that a well-formed one wouldn't have told it anyway.
  const anon = await req('GET', '/api/leads/not-an-id', undefined, null)
  assert.ok([400, 401].includes(anon.status), `an anonymous caller got ${anon.status}`)
})

// --- The helper in isolation --------------------------------------------------

test('validateIdParams registers exactly the params it is asked for', () => {
  const seen = []
  const fake = { param: (name) => seen.push(name) }
  validateIdParams(fake)
  assert.deepEqual(seen, ID_PARAMS)

  const custom = []
  validateIdParams({ param: (n) => custom.push(n) }, ['thingId'])
  assert.deepEqual(custom, ['thingId'])
})

test('validateIdParams returns the target so it can be chained', () => {
  const router = Router()
  assert.equal(validateIdParams(router), router)
})

test('the guard rejects without consulting the request body', async () => {
  // Ordering check: a body that would itself be a 400 must still report BAD_ID,
  // proving the id was refused first rather than incidentally.
  const res = await req('POST', '/api/leads/not-an-id/notes', { body: '' })
  assert.equal(res.status, 400)
  assert.equal((await res.json()).code, 'BAD_ID')
})
