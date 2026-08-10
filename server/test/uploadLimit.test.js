// The per-agent upload ceiling. Uploads are the only authenticated route that takes
// a 25MB body and writes to disk, so the limit is keyed by agent id (an office behind
// one NAT address must not share a bucket) rather than by IP.
// UPLOAD_RATE_LIMIT is set before importing the app so the ceiling is reachable here.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
process.env.UPLOAD_RATE_LIMIT = '3'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
const dbName = await createTestDb('uploadlimit')

const { app } = await import('../index.js')
const { closePool } = await import('../db.js')

let server, base, alice, bob

const req = (method, url, body, tok) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

// A 1x1 GIF, small enough that the size limit never enters the picture.
const TINY_GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
const upload = (tok) => req('POST', '/api/uploads', { data_base64: TINY_GIF, filename: 'pin.gif' }, tok)

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const signup = async (name, phone) =>
    (await req('POST', '/api/auth/signup', { name, phone, password: 'secret123' })).json()
  alice = await signup('Alice Broker', '+919811000101')
  bob = await signup('Bob Broker', '+919811000202')
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
  delete process.env.UPLOAD_RATE_LIMIT
})

test('uploads under the ceiling succeed and report remaining budget', async () => {
  const first = await upload(alice.token)
  assert.equal(first.status, 200)
  assert.equal(first.headers.get('x-ratelimit-limit'), '3')
  assert.equal(first.headers.get('x-ratelimit-remaining'), '2')
  const body = await first.json()
  assert.match(body.url, /\/uploads\/[0-9a-f]+\.gif$/)
})

test('the ceiling cuts in at the configured count, with a retry hint', async () => {
  assert.equal((await upload(alice.token)).status, 200) // 2nd
  assert.equal((await upload(alice.token)).status, 200) // 3rd — at the limit
  const blocked = await upload(alice.token) // 4th
  assert.equal(blocked.status, 429)
  const body = await blocked.json()
  assert.equal(body.code, 'RATE_LIMITED')
  assert.ok(body.retry_after > 0)
  assert.ok(blocked.headers.get('retry-after'))
})

test('the media-library route shares the same per-agent budget', async () => {
  const res = await req('POST', '/api/media', { title: 'Brochure', data_base64: TINY_GIF, filename: 'b.gif' }, alice.token)
  assert.equal(res.status, 429)
})

test('one agent hitting the ceiling does not block another', async () => {
  const res = await upload(bob.token)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-ratelimit-remaining'), '2')
})

test('the ceiling does not gate unauthenticated callers into a 429 instead of a 401', async () => {
  const res = await upload(undefined)
  assert.equal(res.status, 401)
})
