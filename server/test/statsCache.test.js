// The /api/stats cache.
//
// Stats is the most-polled read in the app — Home every 10s, Insights every 8s — and
// its counters run over the agent's whole history. The cache exists to stop that
// being recomputed on every poll; the tests here are about the two ways a cache goes
// wrong: serving one agent's numbers to another, and going stale on a write the agent
// is watching for.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('statscache')

const {
  ready,
  closePool,
  query,
  pool,
  stats,
  invalidateStats,
  clearStatsCache,
  upsertLead,
  addMessage,
} = await import('../db.js')

let agentId
let otherId

// How many round trips a call actually made — the only honest way to tell a cache hit
// from a fast query.
async function countQueries(fn) {
  const original = pool.query.bind(pool)
  let n = 0
  pool.query = (...args) => {
    n++
    return original(...args)
  }
  try {
    await fn()
  } finally {
    pool.query = original
  }
  return n
}

const newAgent = async (phone, name) =>
  (
    await query(
      `INSERT INTO agents (name, phone, password_hash, is_active) VALUES ($1, $2, 'x', 1) RETURNING id`,
      [name, phone],
    )
  ).rows[0].id

before(async () => {
  await ready
  agentId = await newAgent('+919800000901', 'Cache Agent')
  otherId = await newAgent('+919800000902', 'Other Agent')
  // Deliberately different lead counts, so "served the wrong agent's entry" is
  // detectable rather than hidden behind two identical payloads.
  await upsertLead(agentId, '919871100001', 'Mine One')
  await upsertLead(agentId, '919871100003', 'Mine Two')
  await upsertLead(otherId, '919871100002', 'Theirs One')
})

beforeEach(() => {
  clearStatsCache()
  delete process.env.STATS_CACHE_MS
})

after(async () => {
  delete process.env.STATS_CACHE_MS
  await closePool()
  await dropTestDb(dbName)
})

test('the cache is off under NODE_ENV=test, so a suite never reads a stale counter', async () => {
  assert.equal(process.env.NODE_ENV, 'test')
  const first = await countQueries(() => stats(agentId))
  const second = await countQueries(() => stats(agentId))
  assert.ok(first > 1)
  assert.equal(second, first, 'every call still hits the database')
})

test('STATS_CACHE_MS=0 disables the cache explicitly', async () => {
  process.env.STATS_CACHE_MS = '0'
  await stats(agentId)
  assert.ok((await countQueries(() => stats(agentId))) > 1)
})

test('a second call inside the TTL is served without touching the database', async () => {
  process.env.STATS_CACHE_MS = '5000'
  const cold = await countQueries(() => stats(agentId))
  assert.ok(cold > 1, 'the first call does the work')
  assert.equal(await countQueries(() => stats(agentId)), 0, 'the second does none of it')
})

test('the cached payload is the same answer, not a stripped one', async () => {
  process.env.STATS_CACHE_MS = '5000'
  const fresh = await stats(agentId)
  const cached = await stats(agentId)
  assert.deepEqual(cached, fresh)
  for (const key of ['total', 'newToday', 'hotNow', 'active24h', 'pipelineCr', 'qualifiedPct', 'afterHours', 'msgsToday']) {
    assert.ok(key in cached, `cached payload is missing ${key}`)
  }
  assert.ok(Array.isArray(cached.sources) && Array.isArray(cached.daily))
})

test('the entry expires once the TTL passes', async () => {
  process.env.STATS_CACHE_MS = '20'
  await stats(agentId)
  assert.equal(await countQueries(() => stats(agentId)), 0)
  await new Promise((r) => setTimeout(r, 40))
  assert.ok((await countQueries(() => stats(agentId))) > 1, 'an expired entry is recomputed')
})

test('one agent is never served another agent’s counters', async () => {
  process.env.STATS_CACHE_MS = '5000'
  const mine = await stats(agentId)
  const theirs = await countQueries(() => stats(otherId))
  assert.ok(theirs > 1, 'a second agent gets their own query, not my cache entry')
  const theirStats = await stats(otherId)
  assert.equal(theirStats.total, 1, 'their own single lead')
  assert.equal(mine.total, 2, 'and mine is untouched by their call')
  // And my entry is untouched by theirs.
  assert.equal(await countQueries(() => stats(agentId)), 0)
  assert.deepEqual(await stats(agentId), mine)
})

test('a new lead shows up immediately instead of waiting out the TTL', async () => {
  process.env.STATS_CACHE_MS = '30000'
  const before = await stats(agentId)
  await upsertLead(agentId, '919871100010', 'Just Arrived')
  const after = await stats(agentId)
  assert.equal(after.total, before.total + 1, 'the dashboard total moves on the next poll')
})

test('a new message freshens the counters of the lead’s owner', async () => {
  process.env.STATS_CACHE_MS = '30000'
  const lead = await upsertLead(agentId, '919871100011', 'Chatty Buyer')
  const before = await stats(agentId)
  await addMessage(lead.id, 'buyer', 'is it still available?')
  const after = await stats(agentId)
  assert.equal(after.msgsToday, before.msgsToday + 1)
  assert.ok(after.active24h >= before.active24h + 1)
})

test('a message on an unassigned pool lead does not throw looking for an owner', async () => {
  process.env.STATS_CACHE_MS = '30000'
  const { rows } = await query(
    `INSERT INTO leads (agent_id, wa_id, name, phone) VALUES (NULL, '919871100012', 'Pool', '919871100012') RETURNING id`,
  )
  await addMessage(rows[0].id, 'buyer', 'hello?') // agent_id is NULL — nothing to invalidate
  assert.ok((await stats(agentId)).total > 0)
})

test('invalidateStats drops only the agent it names', async () => {
  process.env.STATS_CACHE_MS = '30000'
  await stats(agentId)
  await stats(otherId)
  invalidateStats(agentId)
  assert.ok((await countQueries(() => stats(agentId))) > 1, 'named agent recomputes')
  assert.equal(await countQueries(() => stats(otherId)), 0, 'the other agent keeps their entry')
})

test('invalidateStats accepts the id as a string, as a route param would give it', async () => {
  process.env.STATS_CACHE_MS = '30000'
  await stats(agentId)
  invalidateStats(String(agentId))
  assert.ok((await countQueries(() => stats(agentId))) > 1)
})

test('a junk STATS_CACHE_MS is treated as off, never as negative or NaN', async () => {
  for (const raw of ['abc', '-100']) {
    process.env.STATS_CACHE_MS = raw
    clearStatsCache()
    await stats(agentId)
    assert.ok((await countQueries(() => stats(agentId))) > 1, `STATS_CACHE_MS=${raw} must not cache`)
  }
})

// The default TTL is the whole point of the cache, and it is the one value no test
// covered: it used to equal Insights' 8s poll exactly, so every request arrived just
// as its own entry expired and the cache never once hit in production.
test('the production default outlives the fastest poll that reads it', async () => {
  const FASTEST_POLL_MS = 8000 // InsightsTab.jsx: usePoll(api.stats, 8000)
  delete process.env.STATS_CACHE_MS
  const realEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    clearStatsCache()
    await stats(agentId)
    // Nothing has expired, so a poll landing a full interval later is still a hit —
    // which is only true if the default TTL is comfortably above the poll interval.
    assert.equal(await countQueries(() => stats(agentId)), 0)

    // Pin the invariant on the number itself, so lowering it back to the poll
    // interval fails here rather than silently costing four aggregates per poll.
    process.env.NODE_ENV = realEnv
    process.env.STATS_CACHE_MS = String(FASTEST_POLL_MS)
    clearStatsCache()
    await stats(agentId)
    assert.equal(
      await countQueries(() => stats(agentId)),
      0,
      'a TTL equal to the poll interval is a coin flip against the clock',
    )
  } finally {
    process.env.NODE_ENV = realEnv
  }
})

test('an extraction that moves the counters does not sit behind a cache entry', async () => {
  const { applyExtraction } = await import('../db.js')
  process.env.STATS_CACHE_MS = '30000'

  const lead = await upsertLead(agentId, '919871100009', 'Extraction Esha')
  const warm = await stats(agentId)
  assert.equal(await countQueries(() => stats(agentId)), 0, 'the entry is warm')

  // The inbound path invalidates on the buyer's message, which lands BEFORE the
  // extraction — so this write is the one that has to drop the entry itself.
  await applyExtraction(lead.id, { temp: 'Hot', score: 91, budget_max_l: 120, budget_min_l: 80 })

  assert.ok((await countQueries(() => stats(agentId))) > 1, 'the extraction must drop the entry')
  assert.equal((await stats(agentId)).hotNow, warm.hotNow + 1, 'the new Hot lead should be counted')
})

test('an extraction on an unassigned pool lead does not throw looking for an owner', async () => {
  const { applyExtraction } = await import('../db.js')
  process.env.STATS_CACHE_MS = '30000'
  const { rows } = await query(
    `INSERT INTO leads (agent_id, wa_id, name, phone) VALUES (NULL, $1, $2, $1) RETURNING id`,
    ['919871100010', 'Pooled Pooja'],
  )
  await applyExtraction(rows[0].id, { temp: 'Hot', score: 70 })
})

test('an extraction against a lead that no longer exists is a no-op, not a crash', async () => {
  const { applyExtraction } = await import('../db.js')
  process.env.STATS_CACHE_MS = '30000'
  await applyExtraction(99999999, { temp: 'Hot', score: 70 })
})

// The index behind the cache misses. A cache only moves the cost; the query still
// runs on every expiry, and its old plan read the agent's whole message history to
// answer a question about one day.
test('the message aggregate is backed by a recency index, not a full history scan', async () => {
  const { rows } = await query(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'messages' AND indexname = 'idx_messages_created_lead'`,
  )
  assert.equal(rows.length, 1, 'migration 021 did not create the index')
  // created_at must lead: with lead_id first this degrades into one index scan per
  // lead, which measured slower and read 100x the buffers.
  assert.match(rows[0].indexdef, /\(created_at, lead_id\)/)
})
