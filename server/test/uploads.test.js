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

// /uploads is served same-origin by express.static, so an unrestricted file type
// would let an authenticated agent host a stored-XSS page on our own domain.
test('POST /api/uploads rejects an HTML payload disguised by filename', async () => {
  const html = Buffer.from('<script>alert(document.cookie)</script>').toString('base64')
  const res = await req('POST', '/api/uploads', { data_base64: `data:text/html;base64,${html}`, filename: 'evil.html' })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.match(body.error, /Unsupported file type/)
})

test('POST /api/uploads rejects an SVG payload (script-capable image type)', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')
  const res = await req('POST', '/api/uploads', { data_base64: `data:image/svg+xml;base64,${svg}`, filename: 'evil.svg' })
  assert.equal(res.status, 400)
})

test('POST /api/uploads rejects an unrecognised type with no filename/mime hint', async () => {
  const res = await req('POST', '/api/uploads', { data_base64: PNG_DATA_URL.replace('image/png', 'application/octet-stream') })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.match(body.error, /Unsupported file type/)
})

test('POST /api/uploads accepts an allowed document extension (pdf)', async () => {
  const pdf = Buffer.from('%PDF-1.4 fake pdf content').toString('base64')
  const res = await req('POST', '/api/uploads', { data_base64: `data:application/pdf;base64,${pdf}`, filename: 'brochure.pdf' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.match(body.url, /\.pdf$/)
})

test('POST /api/uploads rejects a payload over the size limit', async () => {
  // Decoded 15MB limit — 16MB raw stays comfortably under the 25MB base64-inflated
  // express.json() body cap, so this exercises saveUpload's own check (400), not the
  // body-parser's separate PAYLOAD_TOO_LARGE 413.
  const big = Buffer.alloc(16 * 1024 * 1024, 1).toString('base64')
  const res = await req('POST', '/api/uploads', { data_base64: `data:image/png;base64,${big}`, filename: 'huge.png' })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.match(body.error, /too large/i)
})
