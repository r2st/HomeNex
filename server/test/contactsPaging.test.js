// GET /api/contacts is paged, and GET /api/contacts/count answers the header total
// without shipping a single contact row.
//
// The bug being locked down: the list had no LIMIT at all. The contact row is narrow,
// so the body size was never the alarming part — the cost is that each row carries two
// correlated subqueries over messages and leads, and the Contacts screen re-polls every
// 6 seconds. Unbounded, an agent with 10k captured numbers made postgres do 20k index
// scans per poll to render a screen showing about eight of them.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('contactspaging')

const { app } = await import('../index.js')
const {
  closePool,
  query,
  addContact,
  listContacts,
  contactCount,
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

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const out = await json('POST', '/api/auth/signup', {
    name: 'Contacts Agent',
    phone: '+919730000001',
    password: 'secret123',
  })
  token = out.token
  agentId = out.agent.id

  const other = await json('POST', '/api/auth/signup', {
    name: 'Other Agent',
    phone: '+919730000002',
    password: 'secret123',
  })
  otherToken = other.token
  otherAgentId = other.agent.id

  // 12 contacts for our agent. Half carry a last_message_at so both arms of the
  // `NULLS LAST` sort are populated; the rest sort by created_at behind them.
  for (let i = 0; i < 12; i++) {
    const c = await addContact(agentId, `+9198760${String(10000 + i)}`, `Client ${i}`)
    if (i % 2 === 0) {
      await query('UPDATE contacts SET last_message_at = now() - ($1 || \' minutes\')::interval WHERE id = $2', [
        String(i),
        c.id,
      ])
    }
    if (i % 3 === 0) await query(`UPDATE contacts SET source = 'referral' WHERE id = $1`, [c.id])
  }
  // One belonging to the other agent, which must never appear in our pages or counts.
  await addContact(otherAgentId, '+919777700001', 'Their Client')
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- The route ---------------------------------------------------------------

test('GET /api/contacts still answers with a plain array', async () => {
  const list = await json('GET', '/api/contacts')
  assert.ok(Array.isArray(list), 'the body shape is unchanged for existing clients')
  assert.equal(list.length, 12, 'all 12 fit inside the default page')
})

test('limit and offset walk the list without dropping or repeating a contact', async () => {
  const all = await json('GET', '/api/contacts?limit=500')
  const seen = []
  for (let offset = 0; offset < all.length; offset += 5) {
    const page = await json('GET', `/api/contacts?limit=5&offset=${offset}`)
    assert.ok(page.length <= 5, 'a page never exceeds its limit')
    seen.push(...page.map((c) => c.id))
  }
  assert.deepEqual(seen, all.map((c) => c.id), 'paging reproduces the full list, in order')
  assert.equal(new Set(seen).size, seen.length, 'no contact appears on two pages')
})

test('an offset past the end is an empty page, not an error', async () => {
  const res = await req('GET', '/api/contacts?offset=10000')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), [])
})

test('a junk limit falls back to the default page instead of 500ing', async () => {
  for (const bad of ['abc', '-1', '0', '1e9', '']) {
    const res = await req('GET', `/api/contacts?limit=${bad}`)
    assert.equal(res.status, 200, `limit=${bad} is tolerated`)
    const body = await res.json()
    assert.ok(Array.isArray(body) && body.length <= PAGE_MAX)
  }
})

test('the page limit is capped server-side however loudly the client asks', async () => {
  const rows = await listContacts(agentId, { limit: 100000 })
  assert.ok(rows.length <= PAGE_MAX)
  assert.ok(PAGE_DEFAULT <= PAGE_MAX, 'the default is inside the ceiling')
})

// --- The deterministic sort ---------------------------------------------------

test('the sort is deterministic when last_message_at and created_at both tie', async () => {
  // A bulk import stamps a whole set of contacts inside one transaction, so neither
  // timestamp can order them. Without the id tiebreak, postgres is free to return them
  // in a different order per query, and OFFSET paging silently drops and duplicates.
  await query(
    `UPDATE contacts SET last_message_at = NULL, created_at = '2026-01-01T00:00:00Z' WHERE agent_id = $1`,
    [agentId],
  )
  const walk = async () => {
    const seen = []
    for (let offset = 0; offset < 12; offset += 3) {
      const page = await listContacts(agentId, { limit: 3, offset })
      seen.push(...page.map((c) => c.id))
    }
    return seen
  }
  const first = await walk()
  assert.equal(new Set(first).size, 12, 'every contact appears exactly once')
  assert.deepEqual(await walk(), first, 'and the same walk twice gives the same order')
  // Restore the timestamps the later tests read.
  await query(
    `UPDATE contacts SET last_message_at = now() - (id || ' minutes')::interval
      WHERE agent_id = $1 AND id % 2 = 0`,
    [agentId],
  )
})

// --- The count ----------------------------------------------------------------

test('GET /api/contacts/count is the total, not the page', async () => {
  const page = await json('GET', '/api/contacts?limit=3')
  assert.equal(page.length, 3)
  assert.deepEqual(await json('GET', '/api/contacts/count?limit=3'), { total: 12 },
    'the count ignores paging — that is the whole point of it')
})

test('"count" is a route, not a contact id', async () => {
  // /api/contacts/:id is registered after it; if that order ever flips, this asks for
  // the contact whose id is "count" and gets a 404 or a 400 instead of a total.
  const res = await req('GET', '/api/contacts/count')
  assert.equal(res.status, 200)
  assert.equal(typeof (await res.json()).total, 'number')
})

test('the count applies the same filters as the list it heads', async () => {
  // A header saying 12 above a list of 4 is worse than no header: the numbers have to
  // describe the same set of rows.
  for (const filter of ['', 'source=referral', 'q=Client 1', 'q=Client 1&source=referral', 'q=nobody']) {
    const list = await json('GET', `/api/contacts?limit=500${filter ? `&${filter}` : ''}`)
    const { total } = await json('GET', `/api/contacts/count${filter ? `?${filter}` : ''}`)
    assert.equal(total, list.length, `count and list disagree for "${filter}"`)
    if (filter === 'q=nobody') assert.equal(total, 0, 'a filter matching nothing counts nothing')
  }
})

test('the count is scoped to the agent, like every other contact route', async () => {
  assert.deepEqual(await json('GET', '/api/contacts/count', undefined, otherToken), { total: 1 },
    "the other agent sees only their own contact, not our 12")
  assert.equal((await req('GET', '/api/contacts/count', undefined, null)).status, 401)
})

test('contactCount and listContacts agree at the db layer too', async () => {
  assert.deepEqual(await contactCount(agentId), { total: 12 })
  assert.deepEqual(await contactCount(agentId, { source: 'referral' }), {
    total: (await listContacts(agentId, { source: 'referral', limit: 500 })).length,
  })
  assert.deepEqual(await contactCount(otherAgentId), { total: 1 })
  assert.deepEqual(await contactCount(agentId, { search: 'nobody at all' }), { total: 0 })
})
