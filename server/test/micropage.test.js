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
const { closePool, query, pool, recordPropertyView } = await import('../db.js')

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

// View recording is fire-and-forget: /p/:slug answers the buyer before the row is
// written. A fixed sleep is the wrong instrument for that — it was 200ms, which is
// plenty on an idle machine and not always enough with four test files sharing the
// box, so this test failed on timing rather than on behaviour. Poll instead: fast
// when the write lands fast, and only slow on a real failure.
async function until(fn, what, timeoutMs = 10_000) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

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

  const page = await until(
    async () => {
      const p = await (await req('POST', `/api/properties/${property.id}/micro-page`)).json()
      return p.stats.total >= 3 ? p : null
    },
    'three recorded page views',
  )
  assert.ok(page.url.endsWith(`/p/${property.micro_page_slug}`))

  // Both views above are recorded fire-and-forget: the response returns before the
  // insert lands, so the referred view can be written before the plain one and the
  // newest row is not reliably the last request made. Select the referrer by value
  // instead of trusting the insert order — the poll above already guarantees all
  // three views are in.
  const { rows } = await query(
    'SELECT referrer FROM property_page_views WHERE property_id = $1 AND referrer IS NOT NULL',
    [property.id],
  )
  assert.deepEqual(
    rows.map((r) => r.referrer),
    ['https://chat.whatsapp.com/xyz'],
    'exactly one view carried a referrer, and it is the one we sent',
  )
  // The counter on the property and the rows it counts are written by one statement,
  // so a reader that can see the third row can never still see a counter of two. As
  // two statements this assertion was flaky, and in production the counter drifted
  // permanently low whenever anything interrupted the gap between them.
  const prop = await (await req('GET', `/api/properties/${property.id}`)).json()
  assert.equal(prop.page_views, page.stats.total, 'page_views drifted from the rows it counts')
  assert.ok(prop.page_views >= 3)
})

test('a view row is never visible before the counter that counts it', async () => {
  // The race this guards is microseconds wide in the wild, so provoke it deterministically:
  // lock the properties row from another connection and the counter UPDATE must wait.
  //
  // As two statements the INSERT had already committed by then, so an observer could see
  // the row while the counter still read one lower — and if the process died in that gap
  // the counter stayed permanently short, since nothing recomputes it. As one statement
  // there is nothing to see until the whole thing commits.
  const rows = async () =>
    (await query('SELECT COUNT(*)::int AS n FROM property_page_views WHERE property_id = $1', [property.id])).rows[0].n
  const counter = async () =>
    (await query('SELECT page_views FROM properties WHERE id = $1', [property.id])).rows[0].page_views

  const rowsBefore = await rows()
  const counterBefore = await counter()
  assert.equal(rowsBefore, counterBefore, 'the fixture is already inconsistent')

  const locker = await pool.connect()
  let recorded
  try {
    await locker.query('BEGIN')
    // FOR NO KEY UPDATE, not FOR UPDATE: it blocks the counter UPDATE (which takes the
    // same mode on a non-key column) while still permitting the KEY SHARE lock that the
    // view row's foreign key needs. FOR UPDATE would stall the INSERT too and the two
    // implementations would look identical.
    await locker.query('SELECT id FROM properties WHERE id = $1 FOR NO KEY UPDATE', [property.id])

    recorded = recordPropertyView(property.id, 'https://example.test/locked', null)
    await new Promise((r) => setTimeout(r, 300)) // long enough to have committed, if it were going to

    assert.equal(await rows(), rowsBefore, 'the view row landed while its counter was still blocked')
    assert.equal(await counter(), counterBefore)
  } finally {
    await locker.query('COMMIT').catch(() => {})
    locker.release()
  }

  await recorded
  assert.equal(await rows(), rowsBefore + 1)
  assert.equal(await counter(), counterBefore + 1)
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
