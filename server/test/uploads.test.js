// API tests for the generic file-upload endpoint that backs the property photo /
// brochure pickers (data URL → hosted /uploads URL).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
const dbName = await createTestDb('uploads')

const { app } = await import('../index.js')
const { closePool } = await import('../db.js')

let server
let base
let token

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

// A 1x1 transparent PNG as a data URL.
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const out = await (
    await req('POST', '/api/auth/signup', { name: 'Upload Agent', phone: '+919800000009', password: 'secret123' })
  ).json()
  token = out.token
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

test('POST /api/uploads stores a data URL and returns a hosted URL', async () => {
  const res = await req('POST', '/api/uploads', { data_base64: PNG_DATA_URL, filename: 'flat.png', mime: 'image/png' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.match(body.url, /\/uploads\/[a-f0-9]+\.png$/)
  assert.equal(body.mime, 'image/png')
  assert.ok(body.size > 0)
})

test('POST /api/uploads rejects a missing payload', async () => {
  const res = await req('POST', '/api/uploads', {})
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.match(body.error, /data_base64/)
})

test('POST /api/uploads requires auth', async () => {
  const res = await req('POST', '/api/uploads', { data_base64: PNG_DATA_URL }, null)
  assert.equal(res.status, 401)
})
