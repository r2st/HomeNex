// recomputeAgentScores runs synchronously inside GET /api/worklist, so its cost
// is page-load latency an agent feels. It used to be row-at-a-time: three round
// trips per open lead. These tests pin the two properties that matter — the batch
// path writes exactly what the per-lead path wrote, and its round-trip count does
// not grow with the number of leads.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('recomputebatch')

const {
  ready, closePool, query, pool, upsertLead, addMessage, createSiteVisit,
  recomputeLeadScore, recomputeAgentScores,
} = await import('../db.js')

let agentId

const SCORE_COLS = 'id, engagement_score, effective_score, effective_temp, score_factors'
const scoresFor = async (ids) =>
  (await query(`SELECT ${SCORE_COLS} FROM leads WHERE id = ANY($1::int[]) ORDER BY id`, [ids])).rows

// Count pool round trips while running fn.
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

// A lead with enough history that decay, velocity and the hard rule all have
// something to chew on — so equivalence is a real comparison, not 0 === 0.
async function seedLead(i) {
  const lead = await upsertLead(agentId, `9198000${String(i).padStart(5, '0')}`, `Lead ${i}`)
  await query(
    `UPDATE leads SET budget_max_l = 90, timeline = '1-3 months', locality = 'Whitefield',
       last_inbound_at = now() - ($2 || ' hours')::interval WHERE id = $1`,
    [lead.id, String(i % 48)],
  )
  await addMessage(lead.id, 'buyer', `hello ${i}`)
  await addMessage(lead.id, 'buyer', `still interested ${i}`)
  await addMessage(lead.id, 'ai', `replying ${i}`)
  if (i % 3 === 0) {
    await createSiteVisit(agentId, {
      lead_id: lead.id,
      scheduled_at: new Date(Date.now() + 86_400_000).toISOString(),
    })
  }
  return lead.id
}

before(async () => {
  await ready
  const { rows } = await query(
    `INSERT INTO agents (name, phone, password_hash, is_active)
     VALUES ('Batch Agent', '+919800000901', 'x', 1) RETURNING id`,
  )
  agentId = rows[0].id
})

after(async () => {
  await closePool()
  await dropTestDb(dbName)
})

test('batch recompute writes exactly what per-lead recompute writes', async () => {
  const ids = []
  for (let i = 1; i <= 6; i++) ids.push(await seedLead(i))
  const now = Date.UTC(2026, 7, 10, 12, 0, 0)

  // Per-lead path first — this is the reference behaviour.
  for (const id of ids) await recomputeLeadScore(id, now)
  const perLead = await scoresFor(ids)

  // Wipe the columns so a no-op batch cannot pass by accident.
  await query(
    `UPDATE leads SET engagement_score = NULL, effective_score = NULL,
       effective_temp = NULL, score_factors = NULL WHERE id = ANY($1::int[])`,
    [ids],
  )
  const cleared = await scoresFor(ids)
  assert.equal(cleared.every((r) => r.engagement_score === null), true, 'columns really were cleared')

  const count = await recomputeAgentScores(agentId, now)
  assert.equal(count, ids.length)

  assert.deepEqual(await scoresFor(ids), perLead)
})

test('a lead with no messages, visits or views still scores (no missing-signals crash)', async () => {
  const bare = await upsertLead(agentId, '919800099999', 'Bare')
  await recomputeAgentScores(agentId, Date.now())
  const [row] = await scoresFor([bare.id])
  assert.equal(typeof row.engagement_score, 'number')
  assert.equal(typeof row.effective_score, 'number')
  assert.ok(['Hot', 'Warm', 'Cold'].includes(row.effective_temp))
})

test('round trips stay constant as lead count grows', async () => {
  // Baseline on the leads already seeded above.
  const before6 = (await query('SELECT COUNT(*)::int AS n FROM leads WHERE agent_id = $1 AND closed_at IS NULL', [agentId])).rows[0].n
  const qSmall = await countQueries(() => recomputeAgentScores(agentId))

  for (let i = 100; i < 130; i++) await seedLead(i)
  const after = (await query('SELECT COUNT(*)::int AS n FROM leads WHERE agent_id = $1 AND closed_at IS NULL', [agentId])).rows[0].n
  assert.ok(after >= before6 + 30, 'the second run really has many more leads')

  const qLarge = await countQueries(() => recomputeAgentScores(agentId))

  // Constant, not proportional: fetch leads, fetch signals, one bulk update.
  assert.equal(qSmall, 3)
  assert.equal(qLarge, 3)
})

test('closed leads are skipped and left untouched', async () => {
  const closed = await upsertLead(agentId, '919800088888', 'Closed')
  await addMessage(closed.id, 'buyer', 'hi')
  await recomputeAgentScores(agentId, Date.now())
  const [beforeClose] = await scoresFor([closed.id])

  await query('UPDATE leads SET closed_at = now(), engagement_score = 42 WHERE id = $1', [closed.id])
  await recomputeAgentScores(agentId, Date.now())

  const [afterClose] = await scoresFor([closed.id])
  assert.equal(afterClose.engagement_score, 42, 'closed lead was not recomputed')
  assert.notEqual(beforeClose.engagement_score, undefined)
})

test('an agent with no open leads does no signal or update work', async () => {
  const { rows } = await query(
    `INSERT INTO agents (name, phone, password_hash, is_active)
     VALUES ('Empty Agent', '+919800000902', 'x', 1) RETURNING id`,
  )
  const emptyAgent = rows[0].id
  let recomputed = null
  const queries = await countQueries(async () => {
    recomputed = await recomputeAgentScores(emptyAgent)
  })
  assert.equal(recomputed, 0, 'no leads recomputed')
  assert.equal(queries, 1, 'only the lead fetch ran — no signals query, no update')
})
