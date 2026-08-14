// The public micro-page, /p/:slug, is rate limited — and this drives the real mounted
// middleware, not a stand-in, for the same reason authRateLimit.test.js does: the unit
// is well covered in hardening.test.js, while the half that regresses silently is
// whether the limiter is still in front of the path. Move the app.use() below the
// route, or rename /p, and the ceiling is gone with every unit test still green.
//
// The reason it needs a ceiling at all is that /p/:slug is not a read. Every hit
// INSERTs a row into property_page_views and increments properties.page_views, with no
// credential of any kind — and a slug is meant to be pasted into broker WhatsApp
// groups, so possession of one proves nothing. Two things follow from that. The table
// grows without bound at whatever rate a caller can manage, on a VPS where disk is the
// scarce thing; and the view count becomes forgeable, which matters because it is not
// decoration — the agent reads "94 views this week" off the property card and decides
// which listing to push. An inflated number sends them at the wrong one.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
process.env.PAGE_RATE_LIMIT = '5' // must be set BEFORE index.js builds the middleware chain
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('pageratelimit')

const { app } = await import('../index.js')
const { closePool, query } = await import('../db.js')

let server
let base
let slug
let propertyId

const req = (method, url, body, tok) =>
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
  const { token } = await (
    await req('POST', '/api/auth/signup', { name: 'Page Limit', phone: '+919800000451', password: 'secret123' })
  ).json()
  const property = await (
    await req('POST', '/api/properties', { title: 'Limited Heights 2BHK', city: 'Pune' }, token)
  ).json()
  slug = property.micro_page_slug
  propertyId = property.id
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
  delete process.env.PAGE_RATE_LIMIT
})

// One test rather than three: the limiter keys on IP over a 60-second window, and every
// request in this file comes from the same one. Split across tests, whichever ran first
// would spend the budget and the rest would assert against an already-throttled caller.
test('a run of public page views is cut off at the ceiling, counter and all', async () => {
  // Under the ceiling (PAGE_RATE_LIMIT=5) a real viewer is served normally.
  for (let i = 0; i < 5; i++) {
    assert.equal((await fetch(`${base}/p/${slug}`)).status, 200, `viewer ${i + 1} was throttled under the ceiling`)
  }

  const blocked = await fetch(`${base}/p/${slug}`)
  assert.equal(blocked.status, 429, 'the sixth view was served')
  assert.equal((await blocked.json()).code, 'RATE_LIMITED')
  assert.ok(Number(blocked.headers.get('retry-after')) > 0, 'a throttled caller was not told when to come back')

  // An unknown slug is refused by the same ceiling — the limiter sits in front of the
  // route, not inside the branch that found a property, so guessing slugs in a loop is
  // cut off too.
  assert.equal((await fetch(`${base}/p/no-such-slug`)).status, 429)

  // And the point of all of it: the number the agent reads off the property card and
  // acts on. Forty hits, five of them counted.
  for (let i = 0; i < 34; i++) await fetch(`${base}/p/${slug}`)
  const { rows } = await query('SELECT page_views FROM properties WHERE id = $1', [propertyId])
  assert.ok(rows[0].page_views <= 5, `40 hits inflated the view count to ${rows[0].page_views}`)
})
