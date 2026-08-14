// The login limiter, driven through the app it is actually mounted on.
//
// hardening.test.js already tests `rateLimit` as a unit — counting, the 429, the
// Retry-After, the window reset. What it cannot tell you is whether that middleware
// is still mounted in front of /api/auth, and that is the half that regresses
// quietly: rename the route, or move the app.use() below the router, and the login
// limiter is gone with every unit test still green.
//
// The limiter is off under test by default because the suite signs up hundreds of
// agents in seconds. AUTH_RATE_LIMIT turns it on with a small ceiling — the same
// escape hatch UPLOAD_RATE_LIMIT already provides — so this file drives the real
// wiring instead of a stand-in.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
process.env.AUTH_RATE_LIMIT = '4' // must be set BEFORE index.js builds the middleware chain
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('authratelimit')

const { app } = await import('../index.js')
const { closePool } = await import('../db.js')

let server
let base

const post = (url, body) =>
  fetch(base + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
  delete process.env.AUTH_RATE_LIMIT
})

const badLogin = () => post('/api/auth/login', { phone: '+919800000901', password: 'wrong-guess' })

test('a run of failed logins is cut off once the ceiling is passed', async () => {
  // The attack this exists to blunt: the same caller trying passwords in a loop.
  // Four are allowed (AUTH_RATE_LIMIT=4), so the fifth is the interesting one.
  const allowed = []
  for (let i = 0; i < 4; i++) allowed.push(await badLogin())
  for (const res of allowed) {
    assert.notEqual(res.status, 429, 'a caller under the ceiling was throttled')
  }

  const blocked = await badLogin()
  assert.equal(blocked.status, 429, '/api/auth is no longer behind the login limiter')

  const body = await blocked.json()
  assert.equal(body.code, 'RATE_LIMITED')
  // The agent may simply have mistyped their password four times, so the sentence
  // has to be one they can act on rather than an accusation.
  assert.match(body.error, /Too many attempts/)
  assert.ok(Number(blocked.headers.get('retry-after')) > 0, 'no Retry-After to wait on')
})

test('the ceiling counts signups too, not just logins', async () => {
  // Both live under /api/auth and both create work for the database, so a limiter
  // that only covered login would leave the cheaper hole open. The bucket is shared
  // and already spent by the test above.
  const res = await post('/api/auth/signup', { name: 'Late Agent', phone: '+919800000902', password: 'secret123' })
  assert.equal(res.status, 429, 'signup was reachable past a spent auth budget')
})

test('the limiter advertises the budget on every answer, not only when refusing', async () => {
  // Without the headers on a normal response, a well-behaved client has no way to
  // slow down before it is cut off.
  const res = await badLogin()
  assert.equal(res.headers.get('x-ratelimit-limit'), '4')
  assert.equal(res.headers.get('x-ratelimit-remaining'), '0')
})

test('routes outside /api/auth are not caught by the auth budget', async () => {
  // The mount is path-scoped, and a limiter tight enough for login would be wrong
  // for the rest of the API. With the auth bucket fully spent, an unrelated route
  // must still answer normally — a 401 here is the route working.
  const res = await fetch(`${base}/api/leads`)
  assert.notEqual(res.status, 429, 'the auth limiter is throttling the whole API')
  assert.equal(res.status, 401)
})
