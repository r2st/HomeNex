// Migration 027: the two indexes the batched scheduler and the polled badge need.
//
// Same failure mode as leadRecencyIndexes.test.js, and the same defence. A partial
// index is only usable when Postgres can prove the query's predicate implies the
// index's, and that proof is textual enough to be broken by a rewrite that looks
// harmless — widen a window, wrap a column, move the NULL arm into JS, and every row
// still comes back correct while the scan quietly goes back to reading the whole table
// every fifteen minutes.
//
// The service-window index is also the one place in the schema where agent_id does NOT
// lead, which is a deliberate choice that a later "consistency" tidy-up would undo. The
// reason is in the migration, and the plan assertion here is what makes undoing it fail
// loudly.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('schedindexes')

const { closePool, query, ready } = await import('../db.js')
const { serviceWindowWatch } = await import('../scheduler.js')

let agentIds = []

// Enough leads that a sequential scan is the expensive option and the planner has to
// choose, spread over enough agents that "one statement for the whole customer base"
// is the shape being planned rather than a single-tenant query in disguise.
const LEADS = 8_000
const AGENTS = 8

before(async () => {
  await ready
  for (let i = 0; i < AGENTS; i++) {
    agentIds.push(
      (
        await query(
          `INSERT INTO agents (name, phone, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
          [`Plan Pranav ${i}`, `+91975000000${i}`],
        )
      ).rows[0].id,
    )
  }
  // last_inbound_at spread over three weeks of hours, so the 20-24h window is a small
  // slice of the book rather than most of it — which is the case the index is for.
  await query(
    `INSERT INTO leads (agent_id, wa_id, name, last_inbound_at, last_outbound_at, closed_at)
     SELECT ($1::int[])[1 + i % ${AGENTS}],
            '9199' || lpad(i::text, 8, '0'),
            'Lead ' || i,
            now() - (i % 500) * interval '1 hour',
            CASE WHEN i % 25 = 0 THEN NULL
                 ELSE now() - (i % 500) * interval '1 hour' + interval '1 minute' END,
            CASE WHEN i % 97 = 0 THEN now() ELSE NULL END
       FROM generate_series(1, ${LEADS}) i`,
    [agentIds],
  )
  await query('ANALYZE')
})

after(async () => {
  await closePool()
  await dropTestDb(dbName)
})

const indexdef = async (table, name) =>
  (await query(`SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND indexname = $2`, [table, name]))
    .rows[0]?.indexdef

const explain = async (sql, params) =>
  (await query(`EXPLAIN (FORMAT TEXT) ${sql}`, params)).rows.map((r) => r['QUERY PLAN']).join('\n')

test('the migration created both indexes, each carrying its own predicate', async () => {
  const sw = await indexdef('leads', 'idx_leads_service_window')
  assert.ok(sw, 'migration 027 did not create idx_leads_service_window')
  assert.match(sw, /\(last_inbound_at\)/, 'the window, not the tenant, is the selective half of this read')
  assert.match(sw, /closed_at IS NULL/, 'a closed lead has no window worth warning about')
  assert.match(sw, /last_inbound_at IS NOT NULL/, 'a lead that has never written has no window at all')

  const unread = await indexdef('notifications', 'idx_notifications_unread')
  assert.ok(unread, 'migration 027 did not create idx_notifications_unread')
  assert.match(unread, /\(agent_id, created_at DESC\)/, 'the badge is per agent and the list is newest-first')
  assert.match(unread, /read_at IS NULL/, 'without the predicate this is idx_notifications_agent again')
})

test('the service-window watch reads its window off the index, not the whole book', async () => {
  const plan = await explain(
    `SELECT agent_id, id, name, wa_id, last_inbound_at FROM leads
      WHERE agent_id = ANY($1::int[]) AND closed_at IS NULL AND last_inbound_at IS NOT NULL
        AND last_inbound_at <= now() - interval '20 hours'
        AND last_inbound_at > now() - interval '24 hours'`,
    [agentIds],
  )
  assert.match(plan, /idx_leads_service_window/, 'the 15-minute job is back to scanning every open lead')
  assert.doesNotMatch(plan, /Seq Scan on leads/, 'and it is not falling back to a sequential scan on the way')
})

test('the shipped job returns exactly the leads inside the window', async () => {
  // The plan is only worth having if the index answers the same question the job asks.
  // Counted straight off the table, ignoring every index, and compared with what the
  // job actually filed.
  const expected = (
    await query(
      `SELECT count(*)::int AS n FROM leads
        WHERE agent_id = ANY($1::int[]) AND closed_at IS NULL AND last_inbound_at IS NOT NULL
          AND last_inbound_at <= now() - interval '20 hours'
          AND last_inbound_at > now() - interval '24 hours'`,
      [agentIds],
    )
  ).rows[0].n
  assert.ok(expected > 0, 'the fixture stopped producing any closing windows, so this proved nothing')

  assert.equal(await serviceWindowWatch(agentIds), expected)
  const filed = (
    await query(
      `SELECT count(*)::int AS n FROM notifications WHERE type = 'service_window_closing'`,
    )
  ).rows[0].n
  assert.equal(filed, expected)
})

test('a closed lead is outside the index and outside the job', async () => {
  // The predicate has to keep matching the query word for word. Closing a lead inside
  // the window must take it out of both, and it is the kind of row that comes back if
  // the arm is ever moved into JS.
  const inWindow = (
    await query(
      `SELECT id FROM leads
        WHERE closed_at IS NULL AND last_inbound_at <= now() - interval '20 hours'
          AND last_inbound_at > now() - interval '24 hours' LIMIT 1`,
    )
  ).rows[0]
  await query('UPDATE leads SET closed_at = now() WHERE id = $1', [inWindow.id])
  await query('DELETE FROM notifications')

  await serviceWindowWatch(agentIds)
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM notifications WHERE entity_id = $1 AND type = 'service_window_closing'`,
    [inWindow.id],
  )
  assert.equal(rows[0].n, 0, 'a closed lead was warned about a window it no longer has')
  await query('UPDATE leads SET closed_at = NULL WHERE id = $1', [inWindow.id])
})

test('the unread badge reaches the partial index instead of every notification ever filed', async () => {
  // A year of notifications for one agent, nearly all read — the shape the badge is
  // slow in. The unread ones stay in the index; the read ones leave it.
  await query('DELETE FROM notifications')
  await query(
    `INSERT INTO notifications (agent_id, type, title, read_at, created_at)
     SELECT ($1::int[])[1 + i % ${AGENTS}], 'service_window_closing', 'x',
            CASE WHEN i % 20 = 0 THEN NULL ELSE now() END,
            now() - (i % 300) * interval '1 day'
       FROM generate_series(1, 6000) i`,
    [agentIds],
  )
  await query('ANALYZE notifications')

  const count = await explain(
    'SELECT COUNT(*)::int AS n FROM notifications WHERE agent_id = $1 AND read_at IS NULL',
    [agentIds[0]],
  )
  assert.match(count, /idx_notifications_unread/, 'the polled badge is back to filtering the whole feed')

  const list = await explain(
    'SELECT * FROM notifications WHERE agent_id = $1 AND read_at IS NULL ORDER BY created_at DESC LIMIT 50',
    [agentIds[0]],
  )
  // Only that it comes off the same index — whether the planner walks it in order or
  // bitmaps the handful of rows and sorts them is its call, and asserting which one it
  // picks would be asserting the size of the fixture.
  assert.match(list, /idx_notifications_unread/, 'the unread list is the same slice as the count')
  assert.doesNotMatch(list, /Seq Scan on notifications/)
})

test('reading a notification takes it out of the index, and the count follows', async () => {
  const before = (
    await query('SELECT COUNT(*)::int AS n FROM notifications WHERE agent_id = $1 AND read_at IS NULL', [
      agentIds[0],
    ])
  ).rows[0].n
  assert.ok(before > 0, 'the fixture left this agent with nothing unread')

  const { rows } = await query(
    'UPDATE notifications SET read_at = now() WHERE agent_id = $1 AND read_at IS NULL RETURNING id',
    [agentIds[0]],
  )
  const after = (
    await query('SELECT COUNT(*)::int AS n FROM notifications WHERE agent_id = $1 AND read_at IS NULL', [
      agentIds[0],
    ])
  ).rows[0].n
  assert.equal(rows.length, before)
  assert.equal(after, 0)
})
