// GET /api/properties is paged, and GET /api/properties/count answers the header total
// without shipping a single property row.
//
// The bug being locked down: the list had no LIMIT at all. This is the widest row of the
// three paged lists — a property carries two JSONB arrays (amenities, photos) plus
// free-text notes, and `SELECT *` returns all of it. The Properties screen polls it every
// 8 seconds and the dashboard polled it every 30 purely to call .length on the result, so
// an agent with a large inventory was downloading their whole catalogue, twice over, to
// render a screen that shows six cards.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('propertiespaging')

const { app } = await import('../index.js')
const {
  closePool,
  query,
  createProperty,
  listProperties,
  propertyCount,
  PAGE_DEFAULT,
  PAGE_MAX,
} = await import('../db.js')

let server
let base
let token
let agentId
let otherToken
let otherAgentId

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

const json = (...args) => req(...args).then((r) => r.json())

const TYPES = ['apartment', 'villa', 'plot', 'commercial']

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const out = await json('POST', '/api/auth/signup', {
    name: 'Inventory Agent',
    phone: '+919740000001',
    password: 'secret123',
  })
  token = out.token
  agentId = out.agent.id

  const other = await json('POST', '/api/auth/signup', {
    name: 'Other Agent',
    phone: '+919740000002',
    password: 'secret123',
  })
  otherToken = other.token
  otherAgentId = other.agent.id

  // 12 properties for our agent, spread across the filter set the dashboard sends so the
  // count and the list have something to disagree about if they ever stop sharing a WHERE.
  for (let i = 0; i < 12; i++) {
    const p = await createProperty(agentId, {
      title: `Tower ${i} Residences`,
      property_type: TYPES[i % TYPES.length],
      bhk: String((i % 3) + 1),
      price_paise: (i + 1) * 10_000_000,
      locality: i % 2 === 0 ? 'Whitefield' : 'Indiranagar',
      city: 'Bengaluru',
      status: i % 4 === 0 ? 'sold' : 'available',
      builder_name: i % 3 === 0 ? 'Prestige' : 'Sobha',
    })
    // Spread updated_at so the default sort has a real order to reproduce.
    await query(`UPDATE properties SET updated_at = now() - ($1 || ' minutes')::interval WHERE id = $2`, [
      String(i),
      p.id,
    ])
  }
  // One belonging to the other agent, which must never appear in our pages or counts.
  await createProperty(otherAgentId, { title: 'Their Penthouse', city: 'Bengaluru' })
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- The route ---------------------------------------------------------------

test('GET /api/properties still answers with a plain array', async () => {
  const list = await json('GET', '/api/properties')
  assert.ok(Array.isArray(list), 'the body shape is unchanged for existing clients')
  assert.equal(list.length, 12, 'all 12 fit inside the default page')
})

test('limit and offset walk the inventory without dropping or repeating a property', async () => {
  const all = await json('GET', '/api/properties?limit=500')
  const seen = []
  for (let offset = 0; offset < all.length; offset += 5) {
    const page = await json('GET', `/api/properties?limit=5&offset=${offset}`)
    assert.ok(page.length <= 5, 'a page never exceeds its limit')
    seen.push(...page.map((p) => p.id))
  }
  assert.deepEqual(seen, all.map((p) => p.id), 'paging reproduces the full list, in order')
  assert.equal(new Set(seen).size, seen.length, 'no property appears on two pages')
})

test('an offset past the end is an empty page, not an error', async () => {
  const res = await req('GET', '/api/properties?offset=10000')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), [])
})

test('a junk limit falls back to the default page instead of 500ing', async () => {
  for (const bad of ['abc', '-1', '0', '1e9', '']) {
    const res = await req('GET', `/api/properties?limit=${bad}`)
    assert.equal(res.status, 200, `limit=${bad} is tolerated`)
    const body = await res.json()
    assert.ok(Array.isArray(body) && body.length <= PAGE_MAX)
  }
})

test('the page limit is capped server-side however loudly the client asks', async () => {
  const rows = await listProperties(agentId, { limit: 100000 })
  assert.ok(rows.length <= PAGE_MAX)
  assert.ok(PAGE_DEFAULT <= PAGE_MAX, 'the default is inside the ceiling')
})

test('the filters still narrow the page they always narrowed', async () => {
  // Paging must not have quietly changed what a filter means.
  const available = await json('GET', '/api/properties?status=available&limit=500')
  assert.equal(available.length, 9)
  assert.ok(available.every((p) => p.status === 'available'))

  const villas = await json('GET', '/api/properties?type=villa&limit=500')
  assert.ok(villas.length > 0 && villas.every((p) => p.property_type === 'villa'))

  const whitefield = await json('GET', '/api/properties?locality=whitefield&limit=500')
  assert.equal(whitefield.length, 6, 'locality matching stays case-insensitive')

  const band = await json('GET', '/api/properties?min_price=30000000&max_price=50000000&limit=500')
  assert.ok(band.every((p) => p.price_paise >= 30_000_000 && p.price_paise <= 50_000_000))

  const search = await json('GET', '/api/properties?q=Prestige&limit=500')
  assert.ok(search.length > 0 && search.every((p) => p.builder_name === 'Prestige'),
    'the search arm still reaches builder_name, not just the title')
})

// --- The deterministic sort ---------------------------------------------------

test('the sort is deterministic when updated_at ties across every row', async () => {
  // Saving a property and its photos stamps several rows inside one transaction, so
  // updated_at alone cannot order them. Without the id tiebreak, postgres is free to
  // return them in a different order per query, and OFFSET paging silently drops and
  // duplicates rows across pages.
  await query(`UPDATE properties SET updated_at = '2026-01-01T00:00:00Z' WHERE agent_id = $1`, [agentId])
  const walk = async () => {
    const seen = []
    for (let offset = 0; offset < 12; offset += 3) {
      const page = await listProperties(agentId, { limit: 3, offset })
      seen.push(...page.map((p) => p.id))
    }
    return seen
  }
  const first = await walk()
  assert.equal(new Set(first).size, 12, 'every property appears exactly once')
  assert.deepEqual(await walk(), first, 'and the same walk twice gives the same order')
  // Restore the spread the later tests read.
  await query(
    `UPDATE properties SET updated_at = now() - (id || ' minutes')::interval WHERE agent_id = $1`,
    [agentId],
  )
})

// --- The count ----------------------------------------------------------------

test('GET /api/properties/count is the total, not the page', async () => {
  const page = await json('GET', '/api/properties?limit=3')
  assert.equal(page.length, 3)
  assert.deepEqual(await json('GET', '/api/properties/count?limit=3'), { total: 12 },
    'the count ignores paging — that is the whole point of it')
})

test('"count" is a route, not a property id', async () => {
  // /api/properties/:id is registered after it; if that order ever flips, this asks for
  // the property whose id is "count" and gets a 404 or a 500 instead of a total.
  const res = await req('GET', '/api/properties/count')
  assert.equal(res.status, 200)
  assert.equal(typeof (await res.json()).total, 'number')
})

test('the count applies the same filters as the list it heads', async () => {
  // A header saying 12 above a list of 4 is worse than no header: the numbers have to
  // describe the same set of rows.
  const filters = [
    '',
    'status=available',
    'type=villa',
    'bhk=2',
    'locality=whitefield',
    'city=bengaluru',
    'q=Prestige',
    'min_price=30000000&max_price=50000000',
    'status=available&type=apartment&q=Tower',
    'q=nothing matches this',
  ]
  for (const filter of filters) {
    const list = await json('GET', `/api/properties?limit=500${filter ? `&${filter}` : ''}`)
    const { total } = await json('GET', `/api/properties/count${filter ? `?${filter}` : ''}`)
    assert.equal(total, list.length, `count and list disagree for "${filter}"`)
  }
  assert.deepEqual(await json('GET', '/api/properties/count?q=nothing matches this'), { total: 0 })
})

test('the count is scoped to the agent, like every other property route', async () => {
  assert.deepEqual(await json('GET', '/api/properties/count', undefined, otherToken), { total: 1 },
    'the other agent sees only their own property, not our 12')
  assert.equal((await req('GET', '/api/properties/count', undefined, null)).status, 401)
})

test('a page never leaks another agent inventory', async () => {
  const theirs = await json('GET', '/api/properties?limit=500', undefined, otherToken)
  assert.equal(theirs.length, 1)
  assert.equal(theirs[0].title, 'Their Penthouse')
  const ours = await json('GET', '/api/properties?limit=500')
  assert.ok(ours.every((p) => p.agent_id === agentId))
})

test('propertyCount and listProperties agree at the db layer too', async () => {
  assert.deepEqual(await propertyCount(agentId), { total: 12 })
  assert.deepEqual(await propertyCount(agentId, { status: 'available' }), {
    total: (await listProperties(agentId, { status: 'available', limit: 500 })).length,
  })
  assert.deepEqual(await propertyCount(otherAgentId), { total: 1 })
  assert.deepEqual(await propertyCount(agentId, { search: 'nothing at all' }), { total: 0 })
})
