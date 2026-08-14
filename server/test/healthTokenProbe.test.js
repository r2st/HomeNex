// /api/health with WhatsApp actually configured.
//
// The endpoint is polled — by the dashboard while it is open, and by whatever
// uptime monitor watches the box. Each answer needs a live "can this token still
// send?" verdict, which is a Graph API round trip, so the probe is cached for a
// minute. That cache is the whole point of the endpoint being safe to poll, and
// until now nothing exercised it: every other suite deletes the WhatsApp
// credentials, so the route returns `not_configured` before it reaches the cache at
// all.
//
// Time is mocked rather than waited out — the cache window is a minute, and a test
// that sleeps through it is a test nobody runs.
import { test, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
process.env.WHATSAPP_ACCESS_TOKEN = 'health-probe-token'
process.env.WHATSAPP_PHONE_NUMBER_ID = 'health-probe-pnid'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('healthprobe')

const { app } = await import('../index.js')
const { ready, closePool } = await import('../db.js')

await ready

let server, base
const realFetch = global.fetch

// Stands in for the Graph API and counts how often it was asked. Every call is
// recorded, so "the cache held" is a number rather than an impression.
function graph(response) {
  const calls = []
  global.fetch = async (url, options) => {
    const target = String(url)
    // The suite's own requests to the test server must still go over the wire.
    if (target.startsWith(base)) return realFetch(url, options)
    calls.push(target)
    return { ok: response.ok, status: response.status ?? 200, json: async () => response.body ?? {} }
  }
  return calls
}

const health = async () => (await realFetch(`${base}/api/health`)).json()

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
})

after(async () => {
  global.fetch = realFetch
  mock.timers.reset()
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// Moves the clock past the cache window so the next read has to probe again.
// Only Date is faked: the pool's own timers must keep running normally.
//
// The offset is carried across calls rather than recomputed from Date.now(): each
// reset() puts the real clock back, so re-reading it would step *backwards* from the
// time the last entry was cached under, and the entry would look fresh again.
let clock = Date.now()
function expireCache() {
  clock += 61_000
  mock.timers.reset()
  mock.timers.enable({ apis: ['Date'], now: clock })
}

test('a healthy token is probed once and then served from cache', async () => {
  const calls = graph({ ok: true, body: { id: 'health-probe-pnid' } })

  const first = await health()
  assert.equal(first.ok, true)
  assert.equal(first.whatsapp, true, 'credentials are present')
  assert.equal(first.whatsapp_send, true, 'and the token can actually send')
  assert.equal(first.whatsapp_reason, undefined, 'a working token has nothing to explain')
  assert.equal(calls.length, 1)

  // The dashboard polls this. Nine more reads inside the window must cost nothing.
  for (let i = 0; i < 9; i++) assert.deepEqual(await health(), first)
  assert.equal(calls.length, 1, 'the Graph API was hit once for ten reads')
})

test('once the window passes the token is probed again', async () => {
  expireCache()
  const calls = graph({ ok: true, body: { id: 'health-probe-pnid' } })

  assert.equal((await health()).whatsapp_send, true)
  assert.equal(calls.length, 1, 'a stale cache entry is not reused')
})

test('an expired token is named as expired, not as a generic failure', async () => {
  expireCache()
  // Meta reports an expired or revoked token as OAuthException / code 190. That is
  // the one failure an agent can fix themselves, so it gets its own reason string.
  graph({ ok: false, status: 401, body: { error: { code: 190, message: 'Session has expired' } } })

  const body = await health()
  assert.equal(body.ok, true, 'the process is healthy even when the token is not')
  assert.equal(body.whatsapp, true, 'the credentials are still configured')
  assert.equal(body.whatsapp_send, false)
  assert.equal(body.whatsapp_reason, 'token_expired')
})

test('any other Graph failure is reported in Meta’s own words', async () => {
  expireCache()
  graph({ ok: false, status: 500, body: { error: { code: 2, message: 'Service temporarily unavailable' } } })

  const body = await health()
  assert.equal(body.whatsapp_send, false)
  assert.equal(
    body.whatsapp_reason,
    'Service temporarily unavailable',
    'a Meta outage must not be mislabelled as an expired token',
  )
})

test('the failed verdict is cached too — a dead Graph API is not polled harder', async () => {
  expireCache()
  const calls = graph({ ok: false, status: 500, body: { error: { code: 2, message: 'Service temporarily unavailable' } } })

  const first = await health()
  for (let i = 0; i < 4; i++) assert.deepEqual(await health(), first)
  assert.equal(calls.length, 1, 'a failing probe is retried on the same schedule as a passing one')
})
