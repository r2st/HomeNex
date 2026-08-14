// Round-trip budgets for the background jobs.
//
// queryBatching.test.js pins the request path. This file pins the other side: the
// scheduler, which is the only thing in HomeNex that runs work for EVERY agent on a
// timer, and so multiplies any per-row round trip by the whole customer base.
//
// Six of the eight jobs read their candidates in one SELECT and then wrote them back
// one INSERT at a time. The service-window watch fires every 15 minutes and the
// no-response nudge every 10, against the same pool the request path is using — so an
// agency with a busy morning made the app slower for everyone else on the box, and the
// cost grew with the number of agents rather than the number of notifications.
//
// The budget is asserted as a CONSTANT number of queries, not a smaller one: a test
// that only says "fewer than before" passes again the moment someone reintroduces a
// per-row query with a slightly smaller loop. The counts here do not move when the
// number of candidate rows does, which is the actual property being defended.
//
// Semantics are asserted alongside the counts, because a batch write is only worth
// having if it still dedupes and still reports how much work it did.
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('schedulerbatching')

const { ready, closePool, query, pool, upsertLead, createNotifications, createFollowups, createNotification } =
  await import('../db.js')
const {
  serviceWindowWatchForAgent,
  detectHotLeadsForAgent,
  noResponseNudgeForAgent,
  generateStaleFollowupsForAgent,
  siteVisitRemindersForAgent,
  commissionOverdueSweepForAgent,
} = await import('../scheduler.js')

let agentId

/** Pool round trips issued while running fn. */
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

const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString()
const hoursAhead = (h) => new Date(Date.now() + h * 3600_000).toISOString()

// Every lead in this file needs its own wa_id — upsertLead is an upsert, so a reused
// number silently returns the existing row and the batch under test is one short.
let waSeq = 0

/** n leads owned by the agent, each with the given columns set. */
async function leads(n, columns = {}) {
  const made = []
  for (let i = 0; i < n; i++) {
    const lead = await upsertLead(agentId, `91900${String(100000 + waSeq++).slice(-6)}`, `Buyer ${i}`)
    const cols = Object.keys(columns)
    if (cols.length) {
      await query(
        `UPDATE leads SET ${cols.map((c, j) => `${c} = $${j + 2}`).join(', ')} WHERE id = $1`,
        [lead.id, ...cols.map((c) => columns[c])],
      )
    }
    made.push(lead)
  }
  return made
}

const notifCount = async () =>
  (await query('SELECT COUNT(*)::int AS n FROM notifications WHERE agent_id = $1', [agentId])).rows[0].n

before(async () => {
  await ready
  const { rows } = await query(
    `INSERT INTO agents (name, phone, password_hash, is_active) VALUES ('Sched Tester', '919800000001', 'x', 1) RETURNING id`,
  )
  agentId = rows[0].id
})

after(async () => {
  await closePool()
  await dropTestDb(dbName)
})

beforeEach(async () => {
  await query('DELETE FROM notifications')
  await query('DELETE FROM followups')
  await query('DELETE FROM site_visits')
  await query('DELETE FROM commissions')
  await query('DELETE FROM messages')
  await query('DELETE FROM leads')
})

// --- The budgets ---------------------------------------------------------------

test('the service-window watch costs the same two queries for 1 lead as for 25', async () => {
  await leads(1, { last_inbound_at: hoursAgo(22) })
  const one = await countQueries(() => serviceWindowWatchForAgent(agentId))

  await query('DELETE FROM notifications')
  await leads(24, { last_inbound_at: hoursAgo(22) })
  const many = await countQueries(() => serviceWindowWatchForAgent(agentId))

  assert.equal(one, 2, 'one SELECT for the candidates, one INSERT for the batch')
  assert.equal(many, one, `25 leads cost ${many} queries and 1 lead cost ${one}`)
  assert.equal(await notifCount(), 25, 'batching dropped notifications on the floor')
})

test('the no-response nudge does not grow a query per unanswered lead', async () => {
  await leads(20, { last_inbound_at: hoursAgo(2), last_outbound_at: null })
  const n = await countQueries(() => noResponseNudgeForAgent(agentId))

  assert.equal(n, 2)
  assert.equal(await notifCount(), 20)
})

test('the hot-lead job writes both of its halves in a single statement', async () => {
  // A lead can qualify on repeat views AND on waiting, and the two used to be two
  // separate loops. One INSERT now carries both, so the budget is three queries
  // whatever the mix: two SELECTs and one write.
  const [viewer] = await leads(1, { last_inbound_at: hoursAgo(1), effective_temp: 'Hot', effective_score: 80 })
  const { rows: props } = await query(
    `INSERT INTO properties (agent_id, title, status) VALUES ($1, 'Sea View 3BHK', 'available') RETURNING id`,
    [agentId],
  )
  for (let i = 0; i < 3; i++) {
    await query(
      `INSERT INTO property_page_views (property_id, lead_id, viewed_at) VALUES ($1, $2, now())`,
      [props[0].id, viewer.id],
    )
  }
  await leads(9, { last_inbound_at: hoursAgo(1), effective_temp: 'Hot', effective_score: 70 })

  const n = await countQueries(() => detectHotLeadsForAgent(agentId))

  assert.equal(n, 3, 'two candidate SELECTs and one batched INSERT')
  // The viewer qualifies twice, under two different dedupe keys, and must not lose
  // one of them to the other now that they share a statement.
  const { rows } = await query(
    `SELECT dedupe_key FROM notifications WHERE agent_id = $1 AND entity_id = $2 ORDER BY dedupe_key`,
    [agentId, viewer.id],
  )
  assert.equal(rows.length, 2, 'a lead qualifying on both counts lost one of its notifications')
  assert.match(rows[0].dedupe_key, /^hotview:/)
  assert.match(rows[1].dedupe_key, /^hotwait:/)
})

test('the stale-follow-up job files its whole batch in one insert', async () => {
  await leads(15, { last_inbound_at: hoursAgo(24 * 30), stage: 'New' })
  const n = await countQueries(() => generateStaleFollowupsForAgent(agentId))

  assert.equal(n, 2)
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM followups WHERE agent_id = $1', [agentId])
  assert.equal(rows[0].n, 15)
})

test('the site-visit reminder job costs two queries however many visits are booked', async () => {
  const made = await leads(12)
  for (const l of made) {
    await query(
      `INSERT INTO site_visits (agent_id, lead_id, scheduled_at, status) VALUES ($1, $2, $3, 'scheduled')`,
      [agentId, l.id, hoursAhead(12)],
    )
  }
  const n = await countQueries(() => siteVisitRemindersForAgent(agentId))

  assert.equal(n, 2)
  assert.equal(await notifCount(), 12)
})

test('the commission sweep costs two queries however many are overdue', async () => {
  const made = await leads(8)
  for (const l of made) {
    await query(
      `INSERT INTO commissions (agent_id, lead_id, status, expected_payout_date, commission_flat_paise)
       VALUES ($1, $2, 'expected', now()::date - 10, 10000000)`,
      [agentId, l.id],
    )
  }
  const n = await countQueries(() => commissionOverdueSweepForAgent(agentId))

  assert.equal(n, 2, 'one sweeping CTE, one batched INSERT')
  assert.equal(await notifCount(), 8)
})

test('a job with no candidates writes nothing at all', async () => {
  // The empty batch must not cost a round trip either — every job runs on its cadence
  // for every agent, and most agents have nothing due on most ticks. That is the
  // common case, and it should be one SELECT.
  for (const [name, job] of [
    ['service window', serviceWindowWatchForAgent],
    ['no-response nudge', noResponseNudgeForAgent],
    ['site visits', siteVisitRemindersForAgent],
    ['commissions', commissionOverdueSweepForAgent],
    ['stale follow-ups', generateStaleFollowupsForAgent],
  ]) {
    const n = await countQueries(() => job(agentId))
    assert.equal(n, 1, `${name} issued a write with nothing to write`)
  }
})

// --- The semantics the batch has to keep --------------------------------------

test('a job run twice notifies once — the dedupe key still holds across batches', async () => {
  await leads(6, { last_inbound_at: hoursAgo(22) })

  assert.equal(await serviceWindowWatchForAgent(agentId), 6, 'the first run should report 6 new notifications')
  assert.equal(await serviceWindowWatchForAgent(agentId), 0, 'the second run announced the same leads again')
  assert.equal(await notifCount(), 6)
})

test('a partly-notified batch reports only what was new', async () => {
  const made = await leads(5, { last_inbound_at: hoursAgo(22) })
  const windowHour = Math.floor(new Date((await query('SELECT last_inbound_at FROM leads WHERE id = $1', [made[0].id])).rows[0].last_inbound_at).getTime() / 3600_000)
  await createNotification(agentId, {
    type: 'service_window_closing',
    title: 'already told you',
    entity_type: 'lead',
    entity_id: made[0].id,
    dedupe_key: `sw:${made[0].id}:${windowHour}`,
  })

  assert.equal(await serviceWindowWatchForAgent(agentId), 4, 'the count included one the agent already had')
  assert.equal(await notifCount(), 5)
})

// --- The batch helpers on their own -------------------------------------------

test('createNotifications collapses duplicate keys inside one batch', async () => {
  // Two rows with the same key in one statement: the unique index would count them
  // once, and a caller trusting the input length would count them twice.
  const created = await createNotifications(agentId, [
    { type: 'lead', title: 'A', dedupe_key: 'dup:1' },
    { type: 'lead', title: 'B', dedupe_key: 'dup:1' },
    { type: 'lead', title: 'C', dedupe_key: 'dup:2' },
  ])

  assert.equal(created, 2)
  assert.equal(await notifCount(), 2)
})

test('createNotifications keeps every keyless notification', async () => {
  // A null dedupe_key is outside the partial unique index — those are notifications
  // that are deliberately allowed to repeat, and must not be collapsed into one.
  const created = await createNotifications(agentId, [
    { type: 'lead', title: 'One' },
    { type: 'lead', title: 'Two' },
  ])

  assert.equal(created, 2)
  assert.equal(await notifCount(), 2)
})

test('createNotifications carries every column through', async () => {
  await createNotifications(agentId, [
    { type: 'commission_overdue', title: 'Money', body: 'Chase it', entity_type: 'commission', entity_id: 42, dedupe_key: 'k:1' },
  ])

  const { rows } = await query('SELECT * FROM notifications WHERE agent_id = $1', [agentId])
  assert.equal(rows[0].type, 'commission_overdue')
  assert.equal(rows[0].title, 'Money')
  assert.equal(rows[0].body, 'Chase it')
  assert.equal(rows[0].entity_type, 'commission')
  assert.equal(rows[0].entity_id, 42)
  assert.equal(rows[0].read_at, null, 'a fresh notification must arrive unread')
})

test('an empty batch is a no-op for both helpers', async () => {
  assert.equal(await createNotifications(agentId, []), 0)
  assert.equal(await createNotifications(agentId), 0)
  assert.equal(await createFollowups(agentId, []), 0)
  assert.equal(await notifCount(), 0)
})

test('createFollowups still refuses a row with no lead or no due date', async () => {
  const [lead] = await leads(1)
  await assert.rejects(
    () => createFollowups(agentId, [{ lead_id: lead.id, due_at: new Date().toISOString() }, { due_at: new Date().toISOString() }]),
    /lead_id and due_at are required/,
  )
  // The guard runs before the insert, so the valid row in the same batch is not
  // written either — a rejected batch leaves nothing half-applied.
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM followups WHERE agent_id = $1', [agentId])
  assert.equal(rows[0].n, 0)
})

test('createFollowups defaults the type and allows a null note', async () => {
  const [lead] = await leads(1)
  const due = new Date().toISOString()
  assert.equal(await createFollowups(agentId, [{ lead_id: lead.id, due_at: due }]), 1)

  const { rows } = await query('SELECT * FROM followups WHERE agent_id = $1', [agentId])
  assert.equal(rows[0].type, 'manual')
  assert.equal(rows[0].note, null)
  assert.equal(rows[0].completed_at, null)
})
