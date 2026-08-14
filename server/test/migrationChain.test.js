// The migration chain itself, as a thing that has to hold together.
//
// Every other test in the suite gets a database by running the whole chain, so a
// migration that throws is caught everywhere at once and immediately. What is NOT
// caught anywhere is the quieter set of failures — the ones where the chain still
// runs clean but no longer says what it claims:
//
//   * a file added out of band, so the directory jumps 021 -> 023 and the reviewer
//     reading the log believes 022 shipped;
//   * two files claiming the same number from two branches, where whichever sorts
//     second silently becomes "the" 025;
//   * a migration whose body was edited after it had already been applied in
//     production, so the column it now describes exists only on machines built
//     since — the chain is recorded as complete on both and they disagree;
//   * a re-run that is not a no-op, which is what makes a half-applied chain
//     (a deploy killed mid-migration) unrecoverable without hand surgery.
//
// So this file asserts the chain's shape rather than its effects, and then asserts
// that the four migrations whose declared objects nothing else checks by name —
// 019, 022, 023, 026 — actually produced them. 024, 025 and 027 have their own
// files (messagesBuyerIndex, leadRecencyIndexes, schedulerIndexes) that go further
// than existence and pin the query plans; those are not repeated here.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('migrationchain')

const { closePool, query, ready } = await import('../db.js')

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()

// The six the production checklist calls out by name. Listed literally rather than
// derived, so deleting one fails here instead of quietly shortening the expectation.
const REQUIRED = [
  '019_agent_token_version.sql',
  '022_contacts_paging_index.sql',
  '023_properties_paging_index.sql',
  '025_lead_message_recency.sql',
  '026_network_and_pool_indexes.sql',
  '027_scheduler_and_notification_indexes.sql',
]

// Enough rows that a sequential scan is the expensive option, so the planner has to
// choose and the assertions below are about the index rather than about a table small
// enough that nothing else was ever on the table.
const ROWS = 4_000
// The co-broking board is the one table nobody's agent_id scopes, so it grows with the
// platform rather than with one brokerage — it gets its own, larger seed.
const BOARD = 20_000
let agentId

before(async () => {
  await ready
  agentId = (
    await query(`INSERT INTO agents (name, phone, password_hash) VALUES ($1, $2, 'x') RETURNING id`, [
      'Chain Chandni',
      '+919760000001',
    ])
  ).rows[0].id

  // last_message_at NULL on most rows: that is the common case for a contact nobody
  // has messaged yet, and it is the arm 022's NULLS LAST exists for.
  await query(
    `INSERT INTO contacts (agent_id, name, phone, source, last_message_at)
     SELECT $1, 'Contact ' || i, '+9198' || lpad(i::text, 8, '0'),
            CASE WHEN i % 3 = 0 THEN 'referral' ELSE 'whatsapp_inbound' END,
            CASE WHEN i % 7 = 0 THEN now() - (i % 400) * interval '1 hour' ELSE NULL END
       FROM generate_series(1, ${ROWS}) i`,
    [agentId],
  )
  await query(
    `INSERT INTO properties (agent_id, title, status, locality, city, updated_at)
     SELECT $1, 'Tower ' || i,
            CASE WHEN i % 4 = 0 THEN 'sold' ELSE 'available' END,
            'Locality ' || (i % 40), 'Pune', now() - (i % 900) * interval '1 hour'
       FROM generate_series(1, ${ROWS}) i`,
    [agentId],
  )
  // The board is deliberately seeded skewed — INVENTORY a minority of a much larger
  // table — because that is the case idx_network_posts_type exists for and the case it
  // is measurably wrong to lose. On a small, evenly split board the planner correctly
  // prefers the primary key, and a test seeded that way would assert nothing.
  await query(
    `INSERT INTO network_posts (type, broker, text, locality)
     SELECT CASE WHEN i % 40 = 0 THEN 'INVENTORY' ELSE 'REQUIREMENT' END,
            'Broker ' || i, 'Post ' || i, 'Locality ' || (i % 40)
       FROM generate_series(1, ${BOARD}) i`,
  )
  await query('ANALYZE')
})

after(async () => {
  await closePool()
  await dropTestDb(dbName)
})

const indexdef = async (name) =>
  (await query('SELECT indexdef FROM pg_indexes WHERE indexname = $1', [name])).rows[0]?.indexdef

const explain = async (sql, params) =>
  (await query(`EXPLAIN (FORMAT TEXT) ${sql}`, params)).rows.map((r) => r['QUERY PLAN']).join('\n')

// --- the chain's shape -------------------------------------------------------

test('every migration is numbered, and the numbers run unbroken from 001', () => {
  assert.ok(files.length >= 27, `expected at least 27 migrations, found ${files.length}`)
  const numbers = files.map((f) => {
    const m = /^(\d{3})_[a-z0-9_]+\.sql$/.exec(f)
    assert.ok(m, `${f} is not NNN_lower_snake_case.sql — the runner sorts by filename, so the shape is load-bearing`)
    return Number(m[1])
  })
  // A gap means a migration was written and never committed; a duplicate means two
  // branches both claimed a number and only one of them is "the" one after a sort.
  numbers.forEach((n, i) => {
    assert.equal(n, i + 1, `migration numbering jumps at ${files[i]} — expected ${String(i + 1).padStart(3, '0')}`)
  })
  assert.equal(new Set(numbers).size, numbers.length, 'two migrations share a number')
})

test('the six migrations the release checklist names are all present', () => {
  for (const f of REQUIRED) assert.ok(files.includes(f), `${f} is missing from server/migrations/`)
})

test('the chain applied completely: every file on disk is recorded, and nothing else is', async () => {
  const applied = (await query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version)
  assert.deepEqual(applied, files, 'schema_migrations and the migrations directory disagree')
})

test('they were applied in filename order, which is the order they were written to depend on', async () => {
  // 023 adds an index to a table 002 creates; 025 backfills from rows 004 stamped. Out
  // of order the chain does not merely reorder, it fails — so the recorded order is the
  // one thing proving the runner's sort is still the sort it was designed around.
  const rows = (await query('SELECT version FROM schema_migrations ORDER BY applied_at, version')).rows
  assert.deepEqual(rows.map((r) => r.version), files, 'applied order does not match filename order')
})

test('re-running the named migrations on an applied chain is a no-op, not an error', async () => {
  // This is what makes a deploy that dies mid-chain recoverable by simply running it
  // again: every one of these is written with IF NOT EXISTS / CREATE OR REPLACE /
  // DROP ... IF EXISTS, and a rewrite that drops that guard turns a retry into an
  // outage. Counted before and after so "no-op" means no duplicate objects, not just
  // no exception.
  const countObjects = async () =>
    (
      await query(
        `SELECT (SELECT COUNT(*) FROM pg_indexes WHERE schemaname = 'public') AS idx,
                (SELECT COUNT(*) FROM pg_trigger WHERE NOT tgisinternal) AS trg,
                (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public') AS col`,
      )
    ).rows[0]

  const before = await countObjects()
  for (const file of REQUIRED) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    await query(sql) // must not throw
  }
  assert.deepEqual(await countObjects(), before, 're-running the chain changed the schema')
})

// --- 019: session revocation -------------------------------------------------

test('019 gave agents a token_version that every existing row already satisfies', async () => {
  const col = (
    await query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'agents' AND column_name = 'token_version'`,
    )
  ).rows[0]
  assert.ok(col, 'migration 019 did not add agents.token_version')
  assert.equal(col.data_type, 'integer')
  // NOT NULL with a default is what lets this ship without a backfill step: the ALTER
  // fills every existing row, so no agent is logged out by the deploy itself.
  assert.equal(col.is_nullable, 'NO', 'a NULL token_version would fail every signature check')
  assert.match(col.column_default, /1/, 'existing sessions must land on a version, not on NULL')
  assert.equal((await query('SELECT token_version FROM agents WHERE id = $1', [agentId])).rows[0].token_version, 1)
})

// --- 022: the paged contact list ---------------------------------------------

test('022 created both contact indexes, and the recency one keeps its NULLS LAST', async () => {
  const recent = await indexdef('idx_contacts_agent_recent')
  assert.ok(recent, 'migration 022 did not create idx_contacts_agent_recent')
  // The ordering has to match the query's exactly or the planner sorts anyway, and a
  // DESC index defaults to NULLS FIRST — so this clause is the whole point of the index.
  assert.match(recent, /last_message_at DESC NULLS LAST/, 'without NULLS LAST this index does not serve the sort')
  assert.match(recent, /id DESC/, 'the id tiebreak is what makes OFFSET paging stable')

  const source = await indexdef('idx_contacts_agent_source')
  assert.ok(source, 'migration 022 did not create idx_contacts_agent_source')
  assert.match(source, /agent_id, source/, 'the ?source= filter narrows by equality before the sort')
})

test('the paged contact list stops at a page instead of sorting every contact', async () => {
  const plan = await explain(
    `SELECT * FROM contacts c WHERE c.agent_id = $1
      ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC, c.id DESC LIMIT 50`,
    [agentId],
  )
  assert.match(plan, /idx_contacts_agent_recent/, 'the contact list is back to sorting the agent whole book per poll')
  assert.doesNotMatch(plan, /Sort Key/, 'a Sort node means the index ordering did not match the query')
})

test('the source filter reaches its own index rather than filtering the recency one', async () => {
  const plan = await explain(
    `SELECT * FROM contacts c WHERE c.agent_id = $1 AND c.source = $2
      ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC, c.id DESC LIMIT 50`,
    [agentId, 'referral'],
  )
  assert.match(plan, /idx_contacts_agent_source/, 'the source chip is back to a filter over every contact')
})

// --- 023: the paged property list --------------------------------------------

test('023 created both property indexes, without a NULLS clause it does not need', async () => {
  const recent = await indexdef('idx_properties_agent_recent')
  assert.ok(recent, 'migration 023 did not create idx_properties_agent_recent')
  assert.match(recent, /updated_at DESC/, 'the inventory list is newest-first')
  assert.match(recent, /id DESC/, 'the id tiebreak is what makes OFFSET paging stable')
  // properties.updated_at is NOT NULL DEFAULT now(), so the NULLS arm cannot occur and
  // spelling it would only make this index differ from the one 022 deliberately needed.
  assert.doesNotMatch(recent, /NULLS/, 'updated_at is NOT NULL — a NULLS clause here describes nothing')

  const status = await indexdef('idx_properties_agent_status_recent')
  assert.ok(status, 'migration 023 did not create idx_properties_agent_status_recent')
  assert.match(status, /agent_id, status/, 'the status chip narrows by equality before the sort')
})

test('the paged property list stops at a page instead of sorting the whole inventory', async () => {
  const plan = await explain(
    `SELECT * FROM properties WHERE agent_id = $1 ORDER BY updated_at DESC, id DESC LIMIT 50`,
    [agentId],
  )
  assert.match(plan, /idx_properties_agent_recent/, 'the inventory list is back to a full sort per poll')
  assert.doesNotMatch(plan, /Sort Key/, 'a Sort node means the index ordering did not match the query')
})

test('the status chip — the one the default view sends — reaches its index', async () => {
  const plan = await explain(
    `SELECT * FROM properties WHERE agent_id = $1 AND status = $2 ORDER BY updated_at DESC, id DESC LIMIT 50`,
    [agentId, 'available'],
  )
  assert.match(plan, /idx_properties_agent_status_recent/, 'the default Properties view is back to a filtered sort')
})

// --- 026: the two reads nobody's agent_id scopes ------------------------------

test('026 indexed the broker board by type, newest first', async () => {
  const def = await indexdef('idx_network_posts_type')
  assert.ok(def, 'migration 026 did not create idx_network_posts_type')
  assert.match(def, /\(type, id DESC\)/, 'id DESC is what makes this a covering order for a per-type feed')
})

test('the match cross-join reads only inventory, off the index', async () => {
  // computeMatches() takes `type = 'INVENTORY'` as the inner side of a cross join
  // against the agent's buyers, which is exactly where a sequential scan costs most.
  const plan = await explain(`SELECT * FROM network_posts WHERE type = 'INVENTORY'`)
  assert.match(plan, /idx_network_posts_type/, 'matching is back to scanning the whole board, requirements included')
})

test('a per-type feed is served in id order, which is what the id column is in the index for', async () => {
  const plan = await explain(`SELECT * FROM network_posts WHERE type = 'INVENTORY' ORDER BY id DESC LIMIT 50`)
  assert.match(plan, /idx_network_posts_type/, 'the (type, id DESC) ordering no longer covers a per-type feed')
  assert.doesNotMatch(plan, /Sort Key/, 'a Sort node means the index ordering did not match the query')
})

test('026 kept the unassigned-pool index tiny by indexing only the pool', async () => {
  const def = await indexdef('idx_leads_unassigned_team')
  assert.ok(def, 'migration 026 did not create idx_leads_unassigned_team')
  assert.match(def, /\(team_id\)/, 'every pool read now filters on team_id as well as agent_id')
  // WHERE agent_id IS NULL is what keeps this index the size of the pool rather than
  // the size of the leads table — the pool is a rounding error next to assigned leads.
  assert.match(def, /WHERE \(agent_id IS NULL\)/, 'without the predicate this indexes every lead ever created')
})

// --- 025 / 027: present, and the objects the other files assume ---------------

test('025 left both recency markers and both triggers in place', async () => {
  const col = (
    await query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = 'leads' AND column_name = 'last_outbound_at'`,
    )
  ).rows[0]
  assert.ok(col, 'migration 025 did not add leads.last_outbound_at')

  // The triggers are the reason the columns are trustworthy: a denormalised column
  // maintained by one call site is a bug waiting for the second one, and the resync
  // trigger is what lets the suite backdate a conversation and have the lead row agree.
  const triggers = (
    await query(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'messages'::regclass AND NOT tgisinternal ORDER BY tgname`,
    )
  ).rows.map((r) => r.tgname)
  assert.ok(triggers.includes('trg_lead_message_recency'), 'the insert-side recency trigger is gone')
  assert.ok(triggers.includes('trg_lead_message_recency_resync'), 'the resync trigger is gone')
})

test('027 left both of its partial indexes in place', async () => {
  assert.ok(await indexdef('idx_leads_service_window'), 'migration 027 did not create idx_leads_service_window')
  assert.ok(await indexdef('idx_notifications_unread'), 'migration 027 did not create idx_notifications_unread')
})
