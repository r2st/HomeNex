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

// A present-but-empty payload is not the same as a missing one: it gets past the
// route's `data_base64 is required` guard and reaches saveUpload with zero bytes.
// A picker that hands over a 0-byte file, or a data URL whose payload was truncated
// in transit, lands exactly here — and used to write an empty file and hand back a
// URL that renders as a broken image.
test('POST /api/uploads refuses a payload that decodes to nothing', async () => {
  const res = await req('POST', '/api/uploads', { data_base64: 'data:image/png;base64,', filename: 'blank.png' })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /empty upload/)
})

// The two fields the caller may leave out entirely. The stored name is the one on
// disk (a random name, never the caller's), and an unknown type is reported as null
// rather than guessed at — express.static will derive the response Content-Type from
// the extension either way.
test('POST /api/uploads fills in a name of its own, and admits when it has no mime', async () => {
  const png = PNG_DATA_URL.split(',')[1]

  const named = await (await req('POST', '/api/uploads', { data_base64: PNG_DATA_URL })).json()
  assert.match(named.filename, /^[a-f0-9]{24}\.png$/, 'the stored name stands in for the missing one')
  assert.ok(named.url.endsWith(named.filename), 'and it is the name actually served')
  assert.equal(named.mime, 'image/png', 'read off the data URL')

  // Raw base64 with no data URL and no mime: only the filename says what this is.
  const bare = await (await req('POST', '/api/uploads', { data_base64: png, filename: 'flat.jpg' })).json()
  assert.equal(bare.filename, 'flat.jpg', 'a supplied name is kept')
  assert.equal(bare.mime, null)
  assert.match(bare.url, /\.jpg$/)
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

// The filename is attacker-chosen and travels two ways: it decides the stored
// extension, and it is kept verbatim as the display name. Neither may become a path.
test('POST /api/uploads cannot be talked into writing outside the uploads directory', async () => {
  const res = await req('POST', '/api/uploads', {
    data_base64: PNG_DATA_URL,
    filename: '../../../../etc/cron.d/pwn.png',
    mime: 'image/png',
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  // The stored name is generated, not derived: the traversal never reaches the
  // filesystem because none of the caller's string does.
  assert.match(body.url, /^\/uploads\/[a-f0-9]{24}\.png$/)
  assert.doesNotMatch(body.url, /\.\./)
})

test('a filename carrying a null byte still yields a clean generated name', async () => {
  // The classic truncation trick: a name that passes an extension check reading the
  // tail, then gets written under the truncated name by anything handing the string
  // to C. Nothing here concatenates the caller's name into a path, and the extension
  // is scrubbed to [a-z0-9] besides — this pins both.
  const res = await req('POST', '/api/uploads', {
    data_base64: PNG_DATA_URL,
    filename: `shell.php${String.fromCharCode(0)}.png`,
    mime: 'image/png',
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.match(body.url, /^\/uploads\/[a-f0-9]{24}\.png$/)
  assert.doesNotMatch(body.url, /php/)
})

test('an uppercase extension is accepted and normalised, not treated as unknown', async () => {
  // ALLOWED_UPLOAD_EXTENSIONS is lowercase, and a phone gallery hands over
  // IMG_0421.JPG. Rejecting it would look like the uploader being broken.
  const res = await req('POST', '/api/uploads', { data_base64: PNG_DATA_URL, filename: 'IMG_0421.JPG', mime: 'image/jpeg' })
  assert.equal(res.status, 200)
  assert.match((await res.json()).url, /\.jpg$/)
})

test('a double extension is judged on the one that decides the served type', async () => {
  // express.static types the response from the FINAL extension, so that is the one
  // the allowlist has to be reading. `.pdf.html` is served as HTML and must lose;
  // `.html.pdf` is served as a PDF and is only a badly named document.
  const html = Buffer.from('<script>alert(1)</script>').toString('base64')
  const disguised = await req('POST', '/api/uploads', { data_base64: `data:text/html;base64,${html}`, filename: 'safe.pdf.html' })
  assert.equal(disguised.status, 400, 'a .html file passed because an earlier extension looked safe')

  const harmless = await req('POST', '/api/uploads', { data_base64: `data:application/pdf;base64,${html}`, filename: 'notes.html.pdf' })
  assert.equal(harmless.status, 200)
  assert.match((await harmless.json()).url, /\.pdf$/)
})
