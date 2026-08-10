// GET /api/leads is paged, and GET /api/leads/count answers the pipeline chips and
// board column headers without shipping a single lead row.
//
// The bug being locked down: the list used to have no LIMIT at all, so an agent with
// 10k leads was served a ~12MB body — every 4 seconds, from two screens at once.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('leadspaging')

const { app } = await import('../index.js')
const db = await import('../db.js')
const {
  closePool,
  upsertLead,
  addContact,
  listLeads,
  leadCounts,
  leadsPageLimit,
  leadsPageOffset,
  LEADS_PAGE_DEFAULT,
  LEADS_PAGE_MAX,
} = db

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
    name: 'Paging Agent',
    phone: '+919700000001',
    password: 'secret123',
  })
  token = out.token
  agentId = out.agent.id

  const other = await json('POST', '/api/auth/signup', {
    name: 'Other Agent',
    phone: '+919700000002',
    password: 'secret123',
  })
  otherToken = other.token
  otherAgentId = other.agent.id

  // 12 leads for our agent, spread over three pipelines and two stages.
  for (let i = 0; i < 12; i++) {
    const lead = await upsertLead(agentId, `9198765${String(10000 + i)}`, `Buyer ${i}`)
    const pipeline = ['buy_primary', 'buy_resale', 'rental'][i % 3]
    const stage = i % 2 ? 'Qualified' : 'New'
    await db.updateLeadCrm(lead.id, agentId, { pipeline_type: pipeline, stage })
  }
  // One lead in the shared unassigned pool, and one belonging to the other agent.
  await db.upsertUnassignedLead('919111100001', 'Pool Buyer')
  await upsertLead(otherAgentId, '919222200001', 'Their Buyer')
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- The clamp helpers ------------------------------------------------------

test('leadsPageLimit clamps to [1, MAX] and falls back for junk', () => {
  assert.equal(leadsPageLimit(undefined), LEADS_PAGE_DEFAULT)
  assert.equal(leadsPageLimit(''), LEADS_PAGE_DEFAULT)
  assert.equal(leadsPageLimit(null), LEADS_PAGE_DEFAULT)
  assert.equal(leadsPageLimit('all'), LEADS_PAGE_DEFAULT, 'non-numeric falls back')
  assert.equal(leadsPageLimit(0), LEADS_PAGE_DEFAULT, '0 is not a page')
  assert.equal(leadsPageLimit(-5), LEADS_PAGE_DEFAULT, 'negative is not a page')
  assert.equal(leadsPageLimit(NaN), LEADS_PAGE_DEFAULT)
  assert.equal(leadsPageLimit(Infinity), LEADS_PAGE_MAX, 'Infinity is capped, not defaulted')
  assert.equal(leadsPageLimit('25'), 25, 'a query string arrives as text')
  assert.equal(leadsPageLimit(7.9), 7, 'fractional pages are floored')
  assert.equal(leadsPageLimit(LEADS_PAGE_MAX + 1), LEADS_PAGE_MAX, 'the ceiling holds')
  assert.equal(leadsPageLimit(1e9), LEADS_PAGE_MAX, 'no caller can ask for the whole table')
  assert.equal(leadsPageLimit(undefined, 25), 25, 'callers may set their own default')
})

test('leadsPageOffset treats anything that is not a positive number as the top', () => {
  assert.equal(leadsPageOffset(undefined), 0)
  assert.equal(leadsPageOffset(''), 0)
  assert.equal(leadsPageOffset('abc'), 0)
  assert.equal(leadsPageOffset(-3), 0)
  assert.equal(leadsPageOffset(0), 0)
  assert.equal(leadsPageOffset('40'), 40)
  assert.equal(leadsPageOffset(9.7), 9)
})

// --- The route --------------------------------------------------------------

test('GET /api/leads still answers with a plain array', async () => {
  const list = await json('GET', '/api/leads')
  assert.ok(Array.isArray(list), 'the body shape is unchanged for existing clients')
  assert.equal(list.length, 13, '12 owned + 1 unassigned, all within the default page')
})

test('limit and offset walk the list without dropping or repeating a lead', async () => {
  const all = await json('GET', '/api/leads?limit=500')
  const seen = []
  for (let offset = 0; offset < all.length; offset += 5) {
    const page = await json('GET', `/api/leads?limit=5&offset=${offset}`)
    assert.ok(page.length <= 5, 'a page never exceeds its limit')
    seen.push(...page.map((l) => l.id))
  }
  assert.deepEqual(seen, all.map((l) => l.id), 'paging reproduces the full list, in order')
  assert.equal(new Set(seen).size, seen.length, 'no lead appears on two pages')
})

test('an offset past the end is an empty page, not an error', async () => {
  const res = await req('GET', '/api/leads?offset=10000')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), [])
})

test('a junk limit falls back to the default page instead of 500ing', async () => {
  for (const bad of ['abc', '-1', '0', '1e9', '']) {
    const res = await req('GET', `/api/leads?limit=${bad}`)
    assert.equal(res.status, 200, `limit=${bad} is tolerated`)
    const body = await res.json()
    assert.ok(Array.isArray(body) && body.length <= LEADS_PAGE_MAX)
  }
})

test('the page limit is capped server-side however loudly the client asks', async () => {
  const rows = await listLeads(agentId, { limit: 100000 })
  assert.ok(rows.length <= LEADS_PAGE_MAX)
})

test('the sort is deterministic when updated_at ties', async () => {
  // A batch rescore stamps a whole set of leads inside one transaction, so updated_at
  // alone cannot order them — without the id tiebreak, OFFSET paging silently drops
  // and duplicates rows between pages.
  const ids = (await listLeads(agentId, { limit: 500 })).map((l) => l.id)
  const first = await listLeads(agentId, { limit: 4, offset: 0 })
  const second = await listLeads(agentId, { limit: 4, offset: 4 })
  assert.deepEqual([...first, ...second].map((l) => l.id), ids.slice(0, 8))
})

// --- Search -----------------------------------------------------------------

test('search matches the lead name, the number, and the agent contact name', async () => {
  const lead = await upsertLead(agentId, '919333300001', 'Zeenat Sheikh')
  await addContact(agentId, '+919333300002', 'Contactonly Name')
  await upsertLead(agentId, '919333300002', null)

  const byName = await json('GET', '/api/leads?q=zeenat')
  assert.deepEqual(byName.map((l) => l.id), [lead.id], 'case-insensitive name match')

  const byPhone = await json('GET', '/api/leads?q=919333300001')
  assert.deepEqual(byPhone.map((l) => l.id), [lead.id])

  const byContact = await json('GET', '/api/leads?q=Contactonly')
  assert.equal(byContact.length, 1, 'found through the agent’s own contact name')
  assert.equal(byContact[0].contact_name, 'Contactonly Name')

  assert.deepEqual(await json('GET', '/api/leads?q=nobodyhere'), [])
})

test('search treats % and _ as text, not as wildcards', async () => {
  const odd = await upsertLead(agentId, '919333300003', '100% Cash Buyer')
  const hit = await json('GET', '/api/leads?q=' + encodeURIComponent('100%'))
  assert.deepEqual(hit.map((l) => l.id), [odd.id], 'a literal % matches only the literal')
  // A bare % searches for leads containing the character '%' — it does not mean
  // "match everything", which is what an unescaped wildcard would have done.
  assert.deepEqual(
    (await json('GET', '/api/leads?q=' + encodeURIComponent('%'))).map((l) => l.id),
    [odd.id],
    'a bare % is not "everyone"',
  )
  assert.deepEqual(await json('GET', '/api/leads?q=' + encodeURIComponent('_')), [], 'a bare _ is not "any character"')
})

test('a blank or whitespace-only search is no filter at all', async () => {
  const all = await json('GET', '/api/leads?limit=500')
  assert.equal((await json('GET', '/api/leads?q=&limit=500')).length, all.length)
  assert.equal((await json('GET', '/api/leads?q=%20%20&limit=500')).length, all.length)
})

test('search still respects the tenant boundary', async () => {
  const mine = await json('GET', '/api/leads?q=Their')
  assert.deepEqual(mine, [], 'another agent’s lead is not findable by name')
})

// --- The count endpoint -----------------------------------------------------

test('GET /api/leads/count breaks the agent’s leads down by pipeline and stage', async () => {
  const counts = await json('GET', '/api/leads/count')
  const all = await json('GET', '/api/leads?limit=500')
  assert.equal(counts.total, all.length, 'total matches what the list would return')
  assert.equal(counts.unassigned, 1, 'the shared pool lead is counted and flagged')

  const summed = Object.values(counts.by_pipeline).reduce((a, b) => a + b, 0)
  assert.equal(summed, counts.total, 'the pipeline split accounts for every lead')

  for (const [type, stages] of Object.entries(counts.by_stage)) {
    const perType = Object.values(stages).reduce((a, b) => a + b, 0)
    assert.equal(perType, counts.by_pipeline[type], `${type}: stage split sums to its pipeline`)
  }
})

test('the counts agree with the filtered list, lead for lead', async () => {
  const counts = await json('GET', '/api/leads/count')
  for (const [type, n] of Object.entries(counts.by_pipeline)) {
    const rows = await json('GET', `/api/leads?pipeline_type=${type}&limit=500`)
    assert.equal(rows.length, n, `${type} count matches the filtered list`)
  }
  for (const [type, stages] of Object.entries(counts.by_stage)) {
    for (const [stage, n] of Object.entries(stages)) {
      const rows = await json(
        'GET',
        `/api/leads?pipeline_type=${type}&stage=${encodeURIComponent(stage)}&limit=500`,
      )
      assert.equal(rows.length, n, `${type}/${stage} count matches the filtered list`)
    }
  }
})

test('a lead with no pipeline_type counts as buy_primary/New, like the list does', async () => {
  const before = await leadCounts(agentId)
  const bare = await upsertLead(agentId, '919444400001', 'Legacy Lead')
  assert.equal(bare.pipeline_type ?? null, null, 'seeded without CRM columns')
  const after = await leadCounts(agentId)
  assert.equal(after.by_pipeline.buy_primary, before.by_pipeline.buy_primary + 1)
  assert.equal(after.by_stage.buy_primary.New, before.by_stage.buy_primary.New + 1)
})

test('the count endpoint is scoped to the caller', async () => {
  const mine = await json('GET', '/api/leads/count')
  const theirs = await json('GET', '/api/leads/count', undefined, otherToken)
  assert.equal(theirs.total, 2, 'their own lead plus the shared pool — never mine')
  assert.ok(mine.total > theirs.total)
})

test('the count endpoint needs a token', async () => {
  assert.equal((await req('GET', '/api/leads/count', undefined, null)).status, 401)
})

test('"count" is routed as the count endpoint, not parsed as a lead id', async () => {
  const res = await req('GET', '/api/leads/count')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(typeof body.total, 'number', 'not the BAD_ID 400 the :id validator would give')
})

test('an agent with no leads gets zeroes, not undefined', async () => {
  const fresh = await json('POST', '/api/auth/signup', {
    name: 'Empty Agent',
    phone: '+919700000003',
    password: 'secret123',
  })
  const counts = await json('GET', '/api/leads/count', undefined, fresh.token)
  assert.equal(counts.unassigned, 1, 'the shared pool is visible to everyone')
  assert.deepEqual(Object.keys(counts.by_stage).sort(), ['buy_primary'])
  const bare = await leadCounts(fresh.agent.id)
  assert.equal(bare.total, 1)
})
