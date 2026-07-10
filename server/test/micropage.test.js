// Property micro-pages: slug generation, the public /p/:slug page, and view tracking.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('micropage')

const { app } = await import('../index.js')
const { closePool, query } = await import('../db.js')

let server
let base
let token
let property

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
    await req('POST', '/api/auth/signup', {
      name: 'Page Agent',
      phone: '+919800000041',
      password: 'secret123',
    })
  ).json()
  token = out.token

  property = await (
    await req('POST', '/api/properties', {
      title: 'Skyline Heights — 3BHK East Facing',
      property_type: 'apartment',
      bhk: '3',
      size_sqft: 1450,
      price_paise: 145 * 1e7,
      locality: 'Baner',
      city: 'Pune',
      rera_project_number: 'P52100099999',
      builder_name: 'Skyline Group',
      amenities: ['Gym', 'Pool'],
      photos: ['https://example.com/photo1.jpg'],
      notes: 'Corner unit <script>alert(1)</script>',
    })
  ).json()
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

test('creating a property auto-generates a micro-page slug', () => {
  assert.ok(property.micro_page_slug, 'expected a slug')
  assert.match(property.micro_page_slug, /^skyline-heights-3bhk-east-facing-[a-z0-9]{6}$/)
})

test('GET /p/:slug serves the public page with specs, price, RERA and WhatsApp CTA', async () => {
  const res = await fetch(`${base}/p/${property.micro_page_slug}`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/html/)
  const html = await res.text()
  assert.match(html, /Skyline Heights — 3BHK East Facing/)
  assert.match(html, /₹ 1\.45Cr/)
  assert.match(html, /RERA: P52100099999/)
  assert.match(html, /3 BHK/)
  assert.match(html, /Baner, Pune/)
  assert.match(html, /wa\.me\/919800000041/) // agent's WhatsApp CTA
  assert.match(html, /https:\/\/example\.com\/photo1\.jpg/)
  // Agent-entered text is escaped, never emitted as markup.
  assert.ok(!html.includes('<script>alert(1)</script>'))
  assert.match(html, /&lt;script&gt;/)
})

test('page views are tracked as engagement signals', async () => {
  await fetch(`${base}/p/${property.micro_page_slug}`)
  await fetch(`${base}/p/${property.micro_page_slug}`, { headers: { referer: 'https://chat.whatsapp.com/xyz' } })
  // View recording is fire-and-forget; give it a beat.
  await new Promise((r) => setTimeout(r, 200))

  const page = await (await req('POST', `/api/properties/${property.id}/micro-page`)).json()
  assert.ok(page.stats.total >= 3, `expected >=3 views, got ${page.stats.total}`)
  assert.ok(page.url.endsWith(`/p/${property.micro_page_slug}`))

  const { rows } = await query('SELECT referrer FROM property_page_views WHERE property_id = $1 ORDER BY id DESC LIMIT 1', [property.id])
  assert.equal(rows[0].referrer, 'https://chat.whatsapp.com/xyz')
  const prop = await (await req('GET', `/api/properties/${property.id}`)).json()
  assert.ok(prop.page_views >= 3)
})

test('unknown slug returns 404, not the SPA', async () => {
  const res = await fetch(`${base}/p/does-not-exist-abc123`)
  assert.equal(res.status, 404)
  assert.match(await res.text(), /no longer available/)
})

test('micro-page endpoint backfills a slug for legacy properties', async () => {
  const { rows } = await query(
    `INSERT INTO properties (agent_id, title, micro_page_slug) VALUES ((SELECT id FROM agents LIMIT 1), 'Legacy Villa', NULL) RETURNING id`,
  )
  const page = await (await req('POST', `/api/properties/${rows[0].id}/micro-page`)).json()
  assert.match(page.slug, /^legacy-villa-[a-z0-9]{6}$/)
  // Idempotent: a second call returns the same slug.
  const again = await (await req('POST', `/api/properties/${rows[0].id}/micro-page`)).json()
  assert.equal(again.slug, page.slug)
})

test('micro-page endpoint is agent-scoped', async () => {
  const other = await (
    await req('POST', '/api/auth/signup', { name: 'Other', phone: '+919800000042', password: 'secret123' })
  ).json()
  const res = await req('POST', `/api/properties/${property.id}/micro-page`, undefined, other.token)
  assert.equal(res.status, 404)
})
