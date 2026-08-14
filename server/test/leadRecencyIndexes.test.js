// Migration 025: the two partial indexes that make the recency columns worth having.
//
// Moving "who spoke last" onto the lead row only pays if the planner can find the few
// hundred rows that matter without reading the agent's whole book. Both indexes are
// therefore written to match their query word for word — a partial index is only
// usable when Postgres can prove the query's predicate implies the index's, and that
// proof is textual enough to be broken by a rewrite that looks harmless.
//
// The failure this file exists to catch is the quiet one. Widen a predicate, wrap a
// column in COALESCE, drop the NULL arm into JS, and every row still comes back
// correct while the scan silently goes back to being linear in the agent's leads.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('recencyindexes')

const { closePool, query, ready, AWAITING_REPLY, LAST_CONTACT_AT } = await import('../db.js')

let agentId
let otherId

// Enough leads that a sequential scan is the expensive option and the planner has to
// choose. The rows are written straight into `leads` with their marks already set:
// this file is about the leads-side plan, and seeding the equivalent conversation
// would be 200,000 messages to prove something about a different table.
const LEADS = 8_000

before(async () => {
  await ready
  const agent = async (name, phone) =>
    (await query(`INSERT INTO agents (name, phone, password_hash) VALUES ($1, $2, 'x') RETURNING id`, [name, phone]))
      .rows[0].id
  agentId = await agent('Plan Pranav', '+919760000001')
  // A second agent holding half the book, so "the index found the agent's rows" is a
  // claim about tenant scoping and not just about the table being small.
  otherId = await agent('Other Om', '+919760000002')

  await query(
    `INSERT INTO leads (agent_id, wa_id, name, last_inbound_at, last_outbound_at, closed_at)
     SELECT CASE WHEN i % 2 = 0 THEN $1::int ELSE $2::int END,
            '9199' || lpad(i::text, 8, '0'),
            'Lead ' || i,
            now() - (i % 500) * interval '1 hour',
            -- One lead in twenty-five was never answered; the rest were answered a
            -- minute after they wrote, which is the ordinary case the index skips
            -- past. An odd divisor is deliberate: an even one would put every
            -- unanswered lead on the first agent and leave the second with none.
            CASE WHEN i % 25 = 0 THEN NULL
                 ELSE now() - (i % 500) * interval '1 hour' + interval '1 minute' END,
            CASE WHEN i % 97 = 0 THEN now() ELSE NULL END
       FROM generate_series(1, ${LEADS}) i`,
    [agentId, otherId],
  )
  await query('ANALYZE')
})

after(async () => {
  await closePool()
  await dropTestDb(dbName)
})

const indexdef = async (name) =>
  (await query(`SELECT indexdef FROM pg_indexes WHERE tablename = 'leads' AND indexname = $1`, [name]))
    .rows[0]?.indexdef

const explain = async (sql, params) =>
  (await query(`EXPLAIN (FORMAT TEXT) ${sql}`, params)).rows.map((r) => r['QUERY PLAN']).join('\n')

test('the migration created both indexes, each carrying its own predicate', async () => {
  const awaiting = await indexdef('idx_leads_awaiting_reply')
  assert.ok(awaiting, 'migration 025 did not create idx_leads_awaiting_reply')
  assert.match(awaiting, /\(agent_id, last_inbound_at DESC\)/, 'agent_id leads, because every read is tenant-scoped')
  assert.match(awaiting, /last_outbound_at IS NULL\) OR \(last_outbound_at < last_inbound_at/,
    'the whole "waiting on a reply" rule has to be in the index, or it indexes every open lead')

  const contact = await indexdef('idx_leads_last_contact')
  assert.ok(contact, 'migration 025 did not create idx_leads_last_contact')
  assert.match(contact, /GREATEST\(last_inbound_at, last_outbound_at\)/,
    'the index is on the expression the stale rule sorts and filters on')
  assert.match(contact, /WHERE \(?closed_at IS NULL/, 'a closed lead is nobody’s follow-up')
})

test('the awaiting-reply predicate reaches its index instead of the agent’s whole book', async () => {
  const plan = await explain(
    `SELECT l.id FROM leads l WHERE l.agent_id = $1 AND l.closed_at IS NULL AND ${AWAITING_REPLY}`,
    [agentId],
  )
  assert.match(plan, /idx_leads_awaiting_reply/, 'the unanswered widget is back to scanning every open lead')
  assert.doesNotMatch(plan, /Seq Scan on leads/, 'and it is not falling back to a sequential scan on the way')
})

test('the dashboard’s own unanswered query uses it, laterals and all', async () => {
  // The predicate in isolation proving usable is not the same as the shipped query
  // using it: the LATERAL join is what the migration set out to stop running 8,400
  // times, and it is the join order that decides whether it does.
  const plan = await explain(
    `SELECT l.id, lm.text
       FROM leads l
       JOIN LATERAL (
         SELECT role, text, created_at FROM messages m
         WHERE m.lead_id = l.id ORDER BY m.id DESC LIMIT 1
       ) lm ON lm.role = 'buyer'
      WHERE l.agent_id = $1 AND l.closed_at IS NULL AND ${AWAITING_REPLY}
      ORDER BY lm.created_at`,
    [agentId],
  )
  assert.match(plan, /idx_leads_awaiting_reply/,
    'the leads are filtered first, so the lateral runs once per waiting lead')
})

test('the stale rule reaches its index, including the never-contacted arm', async () => {
  // The NULL arm is the one most likely to be "simplified" away into JS, or written
  // as COALESCE(..., 'epoch'), either of which costs the index. Postgres reaches it
  // with a bitmap OR over the same index — both halves have to show up.
  const plan = await explain(
    `SELECT l.id FROM leads l
      WHERE l.agent_id = $1 AND l.closed_at IS NULL
        AND (${LAST_CONTACT_AT} IS NULL OR ${LAST_CONTACT_AT} < now() - interval '14 days')`,
    [agentId],
  )
  assert.doesNotMatch(plan, /Seq Scan on leads/, 'the stale sweep is back to reading every open lead')
  assert.equal(plan.match(/idx_leads_last_contact/g)?.length, 2,
    'both the never-contacted and the long-quiet arm should come off the index')
})

test('the marks answer the same leads the messages table would have', async () => {
  // The indexes are only ever as trustworthy as the columns under them. This is the
  // equivalence the rewrite rests on, checked over the whole seeded book rather than
  // a handful of fixtures: two ways of asking, the same agent, the same answer.
  const viaMarks = await query(
    `SELECT count(*)::int AS n FROM leads l
      WHERE l.agent_id = $1 AND l.closed_at IS NULL AND ${AWAITING_REPLY}`,
    [agentId],
  )
  const viaComparison = await query(
    `SELECT count(*)::int AS n FROM leads l
      WHERE l.agent_id = $1 AND l.closed_at IS NULL
        AND l.last_inbound_at IS NOT NULL
        AND COALESCE(l.last_outbound_at, '-infinity'::timestamptz) < l.last_inbound_at`,
    [agentId],
  )
  assert.equal(viaMarks.rows[0].n, viaComparison.rows[0].n)
  assert.ok(viaMarks.rows[0].n > 0, 'the fixture stopped producing any waiting leads, so this proved nothing')

  // And the tenant boundary holds. Both agents hold waiting leads, and neither
  // agent's count is the whole book — an index that ignored agent_id would return
  // the same (larger) number for both.
  const forAgent = async (id) =>
    (
      await query(
        `SELECT count(*)::int AS n FROM leads l WHERE l.agent_id = $1 AND l.closed_at IS NULL AND ${AWAITING_REPLY}`,
        [id],
      )
    ).rows[0].n
  const everyone = (
    await query(`SELECT count(*)::int AS n FROM leads l WHERE l.closed_at IS NULL AND ${AWAITING_REPLY}`)
  ).rows[0].n

  const theirs = await forAgent(otherId)
  assert.ok(theirs > 0, 'the fixture put every waiting lead on one agent, so this proved nothing')
  assert.equal(viaMarks.rows[0].n + theirs, everyone, 'the two books partition the waiting leads exactly')
})
