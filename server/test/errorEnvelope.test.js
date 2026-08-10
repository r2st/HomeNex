// The API's error contract: every failure answers with BOTH a human sentence the
// agent can act on (`error`) and a stable token a client can branch on (`code`).
// The sentence is free to be reworded; the code is the part callers may depend on,
// so it must be present on every 4xx/5xx — not only the handful of routes that
// happen to spell one out.
//
// The codes come from middleware.js: a route may supply a specific one
// (TEMPLATE_LOCKED, WINDOW_EXPIRED, …) and it survives untouched; otherwise the
// status decides. Success bodies and error-shaped-but-not-`error` bodies (the
// /healthz 503) are never rewritten.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'
import { errorCodeForStatus, errorCodes } from '../middleware.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('errorenvelope')

const { app } = await import('../index.js')
const { closePool, upsertLead } = await import('../db.js')

let server, base, token, agentId, leadId

const call = (method, url, body, tok = token, headers = {}) =>
  fetch(base + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  })

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const a = await (await call('POST', '/api/auth/signup', { name: 'Envelope Esha', phone: '+919800000401', password: 'secret123' }, null)).json()
  token = a.token
  agentId = a.agent.id
  leadId = (await upsertLead(agentId, '919888840401', 'Envelope Buyer')).id
})

after(async () => {
  await new Promise((r) => server.close(r))
  await closePool()
  await dropTestDb(dbName)
})

// --- The pure mapping ------------------------------------------------------

test('errorCodeForStatus names every status the API actually returns', () => {
  assert.equal(errorCodeForStatus(400), 'BAD_REQUEST')
  assert.equal(errorCodeForStatus(401), 'UNAUTHORIZED')
  assert.equal(errorCodeForStatus(403), 'FORBIDDEN')
  assert.equal(errorCodeForStatus(404), 'NOT_FOUND')
  assert.equal(errorCodeForStatus(409), 'CONFLICT')
  assert.equal(errorCodeForStatus(413), 'PAYLOAD_TOO_LARGE')
  assert.equal(errorCodeForStatus(429), 'RATE_LIMITED')
  assert.equal(errorCodeForStatus(500), 'INTERNAL')
  assert.equal(errorCodeForStatus(502), 'UPSTREAM_ERROR')
  assert.equal(errorCodeForStatus(503), 'SERVICE_UNAVAILABLE')
})

test('an unlisted status still gets a code — client-side vs our-side', () => {
  assert.equal(errorCodeForStatus(418), 'BAD_REQUEST')
  assert.equal(errorCodeForStatus(507), 'INTERNAL')
})

// --- The middleware in isolation -------------------------------------------

// A res double that records what actually reached the real res.json.
function fakeRes(statusCode) {
  const sent = []
  const res = { statusCode, json: (body) => sent.push(body) }
  errorCodes({}, res, () => {})
  return { res, sent }
}

test('a 2xx body is passed through untouched', () => {
  const { res, sent } = fakeRes(200)
  res.json({ error: 'this is data, not a failure' })
  assert.deepEqual(sent[0], { error: 'this is data, not a failure' })
})

test('an error body without an `error` string is left alone', () => {
  const { res, sent } = fakeRes(503)
  res.json({ ok: false, db: false })
  assert.deepEqual(sent[0], { ok: false, db: false })
})

test('an array body is never rewritten', () => {
  const { res, sent } = fakeRes(400)
  res.json([{ error: 'x' }])
  assert.deepEqual(sent[0], [{ error: 'x' }])
})

test('a null body is passed through rather than crashing', () => {
  const { res, sent } = fakeRes(400)
  res.json(null)
  assert.equal(sent[0], null)
})

test('an explicit code always wins over the status default', () => {
  const { res, sent } = fakeRes(400)
  res.json({ error: 'nope', code: 'MY_OWN_CODE' })
  assert.deepEqual(sent[0], { error: 'nope', code: 'MY_OWN_CODE' })
})

test('other fields on the error body survive alongside the code', () => {
  const { res, sent } = fakeRes(429)
  res.json({ error: 'slow down', retry_after: 30 })
  assert.deepEqual(sent[0], { error: 'slow down', retry_after: 30, code: 'RATE_LIMITED' })
})

// --- End to end over real routes -------------------------------------------

test('a missing token is 401 UNAUTHORIZED', async () => {
  const res = await call('GET', '/api/leads', undefined, null)
  assert.equal(res.status, 401)
  const body = await res.json()
  assert.equal(body.code, 'UNAUTHORIZED')
  assert.ok(body.error)
})

test('an unknown :id is 404 NOT_FOUND', async () => {
  const res = await call('GET', '/api/leads/9999999')
  assert.equal(res.status, 404)
  assert.equal((await res.json()).code, 'NOT_FOUND')
})

test('an unknown /api path is 404 NOT_FOUND (and keeps its explicit code)', async () => {
  const res = await call('GET', '/api/no-such-route')
  assert.equal(res.status, 404)
  assert.equal((await res.json()).code, 'NOT_FOUND')
})

test('a validation failure is 400 BAD_REQUEST', async () => {
  const res = await call('POST', '/api/commissions', {})
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.code, 'BAD_REQUEST')
  assert.match(body.error, /lead_id/)
})

test('malformed JSON keeps its own BAD_JSON code, not the 400 default', async () => {
  const res = await call('POST', '/api/leads', '{not json')
  assert.equal(res.status, 400)
  assert.equal((await res.json()).code, 'BAD_JSON')
})

test('a locked template keeps TEMPLATE_LOCKED rather than the 403 default', async () => {
  const tpl = await (await call('GET', '/api/templates')).json()
  const locked = tpl.find((t) => t.is_locked || t.meta_status === 'approved')
  assert.ok(locked, 'the seeded template pack should ship at least one locked template')
  const res = await call('PUT', `/api/templates/${locked.id}`, { body: 'rewritten' })
  assert.equal(res.status, 403)
  assert.equal((await res.json()).code, 'TEMPLATE_LOCKED')
})

test('every write route answers a bad payload with both halves of the envelope', async () => {
  const cases = [
    ['POST', '/api/deals', {}],
    ['POST', '/api/commissions', {}],
    ['POST', '/api/followups', {}],
    ['POST', '/api/site-visits', {}],
    ['POST', '/api/templates', {}],
    ['POST', '/api/quick-replies', {}],
    ['POST', '/api/labels', {}],
    ['POST', '/api/groups', {}],
  ]
  for (const [method, url, body] of cases) {
    const res = await call(method, url, body)
    assert.ok(res.status >= 400, `${url} should reject an empty payload`)
    const parsed = await res.json()
    assert.equal(typeof parsed.error, 'string', `${url} must explain itself`)
    assert.ok(/^[A-Z][A-Z0-9_]*$/.test(parsed.code || ''), `${url} returned code ${parsed.code}`)
  }
})

test('the healthz 503 payload is not an error envelope and stays untouched', async () => {
  // /healthz reports liveness as {ok, db} with no `error` key — the middleware must
  // not graft a code onto a body that isn't an error envelope.
  const res = await call('GET', '/healthz', undefined, null)
  const body = await res.json()
  assert.equal(body.code, undefined)
  assert.equal(typeof body.ok, 'boolean')
})

test('a cross-tenant id is 404 NOT_FOUND, never 403', async () => {
  const other = await (await call('POST', '/api/auth/signup', { name: 'Other Om', phone: '+919800000402', password: 'secret123' }, null)).json()
  const theirLead = await upsertLead(other.agent.id, '919888840402', 'Their Buyer')
  const res = await call('GET', `/api/leads/${theirLead.id}`)
  assert.equal(res.status, 404)
  assert.equal((await res.json()).code, 'NOT_FOUND')
})
