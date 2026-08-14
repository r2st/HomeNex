// Round-trip budgets for the scheduler ACROSS agents.
//
// schedulerBatching.test.js pins the cost of one agent's job: it must not grow with the
// number of candidate rows. This file pins the other axis, which is the one that grows
// with the business: the cost of a tick must not grow with the number of AGENTS.
//
// Every job used to be invoked once per active agent — its own SELECT, its own INSERT,
// per job, per tick, forever. Eight jobs across a hundred agents was hundreds of round
// trips every ten minutes, against the pool serving requests, to produce nothing at all
// on a quiet morning. The jobs now take the whole agent list and answer it in a fixed
// number of statements.
//
// The budgets are asserted as CONSTANTS, and asserted equal between a one-agent tick and
// a twelve-agent one: "fewer than before" would pass again the moment someone puts the
// per-agent loop back with a smaller body. Tenancy is asserted alongside every budget,
// because a batch that mixes agents is only worth having if each agent still gets
// exactly their own rows — a fan-out bug here is a data leak, not a slow page.
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('schedfanout')

const { ready, closePool, query, pool, upsertLead, addMessage } = await import('../db.js')
const {
  serviceWindowWatch,
  noResponseNudge,
  detectHotLeads,
  generateStaleFollowups,
  siteVisitReminders,
  siteVisitWaReminders,
  commissionOverdueSweep,
  recomputeScores,
  runDueJobs,
  activeAgentIds,
} = await import('../scheduler.js')

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

let agents = [] // 12 active agents
let waSeq = 0

async function makeAgent(i) {
  const { rows } = await query(
    `INSERT INTO agents (name, phone, password_hash, is_active, wa_phone_number_id)
     VALUES ($1, $2, 'x', 1, $3) RETURNING id`,
    [`Fanout ${i}`, `9198111${String(100000 + i).slice(-6)}`, `pn-${i}`],
  )
  return rows[0].id
}

/** One lead per agent, with the given columns set, so every agent has work to do. */
async function leadEach(columns = {}) {
  const made = []
  for (const agentId of agents) {
    const lead = await upsertLead(agentId, `91900${String(100000 + waSeq++).slice(-6)}`, `Buyer ${waSeq}`)
    const cols = Object.keys(columns)
    if (cols.length) {
      await query(
        `UPDATE leads SET ${cols.map((c, j) => `${c} = $${j + 2}`).join(', ')} WHERE id = $1`,
        [lead.id, ...cols.map((c) => columns[c])],
      )
    }
    made.push({ agentId, lead })
  }
  return made
}

const notifsByAgent = async () =>
  (await query('SELECT agent_id, COUNT(*)::int AS n FROM notifications GROUP BY agent_id')).rows

before(async () => {
  await ready
  for (let i = 0; i < 12; i++) agents.push(await makeAgent(i))
})

after(async () => {
  await closePool()
  await dropTestDb(dbName)
})

beforeEach(async () => {
  await query('DELETE FROM notifications')
  await query('DELETE FROM followups')
  await query('DELETE FROM site_visits')
  await query('DELETE FROM commission_invoices')
  await query('DELETE FROM commissions')
  await query('DELETE FROM messages')
  await query('DELETE FROM leads')
})

// --- The budget: a tick costs the same for twelve agents as for one ------------

test('the service-window watch costs the same two queries for 12 agents as for 1', async () => {
  await leadEach({ last_inbound_at: hoursAgo(22) })

  const one = await countQueries(() => serviceWindowWatch([agents[0]]))
  await query('DELETE FROM notifications')
  const twelve = await countQueries(() => serviceWindowWatch(agents))

  assert.equal(one, 2, 'one SELECT for the candidates, one INSERT for the batch')
  assert.equal(twelve, one, `12 agents cost ${twelve} queries and 1 agent cost ${one}`)
  assert.equal((await notifsByAgent()).length, 12, 'every agent should have been served by the one statement')
})

test('the no-response nudge does not grow a query per agent', async () => {
  await leadEach({ last_inbound_at: hoursAgo(2), last_outbound_at: null })

  const one = await countQueries(() => noResponseNudge([agents[0]]))
  await query('DELETE FROM notifications')
  const twelve = await countQueries(() => noResponseNudge(agents))

  assert.equal(one, 2)
  assert.equal(twelve, one)
  assert.equal((await notifsByAgent()).length, 12)
})

test('the hot-lead job reads both its halves for the whole tick in three queries', async () => {
  await leadEach({ last_inbound_at: hoursAgo(1), effective_temp: 'Hot', effective_score: 80 })

  const one = await countQueries(() => detectHotLeads([agents[0]]))
  await query('DELETE FROM notifications')
  const twelve = await countQueries(() => detectHotLeads(agents))

  assert.equal(one, 3, 'two candidate SELECTs and one batched INSERT')
  assert.equal(twelve, one)
  assert.equal((await notifsByAgent()).length, 12)
})

test('the site-visit reminder job costs two queries however many agents have visits', async () => {
  for (const { agentId, lead } of await leadEach()) {
    await query(
      `INSERT INTO site_visits (agent_id, lead_id, scheduled_at, status) VALUES ($1, $2, $3, 'scheduled')`,
      [agentId, lead.id, hoursAhead(12)],
    )
  }

  const one = await countQueries(() => siteVisitReminders([agents[0]]))
  await query('DELETE FROM notifications')
  const twelve = await countQueries(() => siteVisitReminders(agents))

  assert.equal(one, 2)
  assert.equal(twelve, one)
  assert.equal((await notifsByAgent()).length, 12)
})

test('the commission sweep sweeps every agent in one CTE', async () => {
  for (const { agentId, lead } of await leadEach()) {
    await query(
      `INSERT INTO commissions (agent_id, lead_id, status, expected_payout_date, commission_flat_paise)
       VALUES ($1, $2, 'expected', now()::date - 10, 10000000)`,
      [agentId, lead.id],
    )
  }

  const n = await countQueries(() => commissionOverdueSweep(agents))

  assert.equal(n, 2, 'one sweeping CTE, one batched INSERT')
  assert.equal((await notifsByAgent()).length, 12)
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM commissions WHERE status = 'overdue'`)
  assert.equal(rows[0].n, 12, 'a sweep that only flips one agent’s rows has quietly gone back to per-agent')
})

test('the stale-follow-up job files every agent’s batch in one insert', async () => {
  await leadEach({ last_inbound_at: hoursAgo(24 * 30), stage: 'New' })

  const n = await countQueries(() => generateStaleFollowups(agents))

  assert.equal(n, 2)
  const { rows } = await query('SELECT COUNT(DISTINCT agent_id)::int AS n FROM followups')
  assert.equal(rows[0].n, 12)
})

test('an empty tick costs one SELECT per job, not one per agent', async () => {
  // The common case: every job runs on its cadence whether or not anything is due, and
  // on most ticks nothing is. That must be a single SELECT that finds nothing.
  for (const [name, job] of [
    ['service window', serviceWindowWatch],
    ['no-response nudge', noResponseNudge],
    ['site visits', siteVisitReminders],
    ['commissions', commissionOverdueSweep],
    ['stale follow-ups', generateStaleFollowups],
  ]) {
    assert.equal(await countQueries(() => job(agents)), 1, `${name} issued a write with nothing to write`)
  }
})

test('a job handed no agents at all does not query', async () => {
  for (const job of [serviceWindowWatch, noResponseNudge, detectHotLeads, siteVisitReminders, commissionOverdueSweep, generateStaleFollowups, recomputeScores, siteVisitWaReminders]) {
    assert.equal(await countQueries(() => job([])), 0, `${job.name} queried for an empty agent list`)
  }
})

// --- Tenancy: the batch must not mix agents ------------------------------------

test('each agent gets exactly their own notifications out of the shared statement', async () => {
  const made = await leadEach({ last_inbound_at: hoursAgo(22) })
  await serviceWindowWatch(agents)

  const { rows } = await query('SELECT agent_id, entity_id FROM notifications')
  assert.equal(rows.length, 12)
  const leadOwner = new Map(made.map((m) => [m.lead.id, m.agentId]))
  for (const r of rows) {
    assert.equal(r.agent_id, leadOwner.get(r.entity_id), 'a notification landed in the wrong workspace')
  }
})

test('the commission sweep never quotes another agent’s invoice number', async () => {
  // The invoice lookup is a LATERAL beside the swept row. Scoping it to the tick's whole
  // agent list instead of the commission's own agent would let a notification name a
  // number from someone else's books — the LATERAL matches on commission_id, but a
  // commission_invoices row is only ever the right one for its own workspace.
  const [a, b] = agents
  const rowsFor = []
  for (const agentId of [a, b]) {
    const lead = await upsertLead(agentId, `91900${String(100000 + waSeq++).slice(-6)}`, 'Invoice Ishaan')
    const { rows } = await query(
      `INSERT INTO commissions (agent_id, lead_id, status, expected_payout_date, commission_flat_paise)
       VALUES ($1, $2, 'invoiced', now()::date - 5, 10000000) RETURNING id`,
      [agentId, lead.id],
    )
    rowsFor.push({ agentId, commissionId: rows[0].id })
  }
  // Only the FIRST agent's commission has an invoice raised against it.
  await query(
    `INSERT INTO commission_invoices (agent_id, commission_id, invoice_number, status, issued_at,
                                      subtotal_paise, gst_paise, total_paise)
     VALUES ($1, $2, 'INV-A-001', 'issued', now(), 10000000, 1800000, 11800000)`,
    [rowsFor[0].agentId, rowsFor[0].commissionId],
  )

  await commissionOverdueSweep([a, b])

  const { rows: notes } = await query(
    `SELECT agent_id, body FROM notifications WHERE type = 'commission_overdue' ORDER BY agent_id`,
  )
  assert.equal(notes.length, 2)
  const forA = notes.find((n) => n.agent_id === a)
  const forB = notes.find((n) => n.agent_id === b)
  assert.match(forA.body, /INV-A-001/, 'the agent who raised the invoice should be told its number')
  assert.doesNotMatch(forB.body, /INV-A-001/, 'another workspace’s invoice number leaked into this notification')
  assert.match(forB.body, /invoiced and past its payout date/)
})

test('the per-agent follow-up cap stays per agent once the tick is batched', async () => {
  // limit is "20 leads per agent per pass", not "20 leads per tick". A single
  // ORDER BY ... LIMIT over the whole customer base would hand the entire allowance to
  // whichever agent's leads happened to sort first, and starve everyone behind them.
  for (const agentId of agents.slice(0, 3)) {
    for (let i = 0; i < 3; i++) {
      const lead = await upsertLead(agentId, `91900${String(100000 + waSeq++).slice(-6)}`, `Quiet ${i}`)
      await query(
        `UPDATE leads SET last_inbound_at = $2, stage = 'New' WHERE id = $1`,
        [lead.id, hoursAgo(24 * 30)],
      )
    }
  }

  assert.equal(await generateStaleFollowups(agents.slice(0, 3), { limit: 2 }), 6, 'two per agent, three agents')
  const { rows } = await query(
    'SELECT agent_id, COUNT(*)::int AS n FROM followups GROUP BY agent_id ORDER BY agent_id',
  )
  assert.equal(rows.length, 3)
  for (const r of rows) assert.equal(r.n, 2, 'one agent took more than its share of the cap')
})

// --- The WhatsApp reminder job: three reads, then one send per reminder ---------

test('the WhatsApp reminder job reads the agents and the transcripts once for the tick', async () => {
  // This job had three separate fan-outs: the agent row (fetched per agent, right after
  // activeAgentIds had just listed them), the due visits, and the lead's transcript,
  // read once per reminder to pick the language to write in. The sends themselves stay
  // one per reminder — that is an external call, not a round trip we chose.
  for (const agentId of agents) {
    const lead = await upsertLead(agentId, `91900${String(100000 + waSeq++).slice(-6)}`, 'Soon Sneha')
    await query(
      `INSERT INTO site_visits (agent_id, lead_id, scheduled_at, status) VALUES ($1, $2, $3, 'scheduled')`,
      [agentId, lead.id, new Date(Date.now() + 90 * 60_000).toISOString()],
    )
  }

  const sqls = []
  const original = pool.query.bind(pool)
  pool.query = (...args) => {
    sqls.push(typeof args[0] === 'string' ? args[0] : args[0]?.text || '')
    return original(...args)
  }
  let sent
  try {
    let seq = 0
    sent = await siteVisitWaReminders(agents, Date.now(), async () => `wamid.FANOUT.${seq++}`)
  } finally {
    pool.query = original
  }

  assert.equal(sent, 12, 'every agent with a visit due should have been reminded')
  assert.equal(sqls.filter((s) => /FROM agents WHERE id = ANY/.test(s)).length, 1, 'the agent row was fetched per agent')
  assert.equal(
    sqls.filter((s) => /FROM messages WHERE lead_id = t\.lead_id/.test(s)).length,
    1,
    'the transcript was read once per reminder instead of once for the tick',
  )
})

test('a batched transcript read still gives each buyer their own language', async () => {
  // The risk of reading twelve conversations in one statement is handing the wrong one
  // to the wrong reminder — every buyer gets the first lead's language, and the mistake
  // is invisible until someone reads their WhatsApp.
  const [hinglishAgent, englishAgent] = agents
  const hinglish = await upsertLead(hinglishAgent, `91900${String(100000 + waSeq++).slice(-6)}`, 'Hinglish Hema')
  await addMessage(hinglish.id, 'buyer', '2bhk chahiye, budget 80 lakh tak, kal visit kar sakte hain kya')
  const english = await upsertLead(englishAgent, `91900${String(100000 + waSeq++).slice(-6)}`, 'English Elango')
  await addMessage(english.id, 'buyer', 'Could you confirm the visit timing please?')
  for (const [agentId, lead] of [[hinglishAgent, hinglish], [englishAgent, english]]) {
    await query(
      `INSERT INTO site_visits (agent_id, lead_id, scheduled_at, status) VALUES ($1, $2, $3, 'scheduled')`,
      [agentId, lead.id, new Date(Date.now() + 90 * 60_000).toISOString()],
    )
  }

  const sent = new Map()
  await siteVisitWaReminders([hinglishAgent, englishAgent], Date.now(), async (to, text) => {
    sent.set(to, text)
    return `wamid.LANG.${sent.size}`
  })

  assert.match(sent.get(hinglish.wa_id), /ghante mein hai/, 'the Hinglish buyer got an English reminder')
  assert.match(sent.get(english.wa_id), /2 hours/, 'the English buyer got someone else’s language')
})

test('a send that fails costs only its own reminder', async () => {
  // The per-visit catch is the isolation that survives batching: the tick no longer
  // runs per agent, so this is the only thing standing between one unreachable number
  // and every other reminder in the tick.
  const targets = agents.slice(0, 3)
  const leads = []
  for (const agentId of targets) {
    const lead = await upsertLead(agentId, `91900${String(100000 + waSeq++).slice(-6)}`, 'Visit Vinay')
    await query(
      `INSERT INTO site_visits (agent_id, lead_id, scheduled_at, status) VALUES ($1, $2, $3, 'scheduled')`,
      [agentId, lead.id, new Date(Date.now() + 90 * 60_000).toISOString()],
    )
    leads.push(lead)
  }

  const errs = []
  const realError = console.error
  console.error = (...a) => errs.push(a.join(' '))
  let sent
  try {
    let seq = 0
    sent = await siteVisitWaReminders(targets, Date.now(), async (to) => {
      if (to === leads[0].wa_id) throw new Error('number unreachable')
      return `wamid.OK.${seq++}`
    })
  } finally {
    console.error = realError
  }

  assert.equal(sent, 2, 'one failing send took the other reminders down with it')
  assert.ok(errs.some((e) => /site-visit reminder failed/.test(e)))
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM site_visits WHERE lead_id = $1 AND reminder_t2_sent_at IS NOT NULL`,
    [leads[0].id],
  )
  assert.equal(rows[0].n, 0, 'a visit whose send failed must stay unstamped so the next tick retries it')
})

// --- Scores: bounded working set, still every agent -----------------------------

test('the score recompute walks the agent list in slices, and scores every agent’s leads', async () => {
  // Scoring is the one job that materialises rows in Node, so it trades one statement
  // for a bounded working set: SCORE_CHUNK agents per pass. Twelve agents is inside one
  // slice, so the cost is the same three queries as for a single agent.
  const made = await leadEach({ last_inbound_at: hoursAgo(3) })

  const one = await countQueries(() => recomputeScores([agents[0]]))
  const twelve = await countQueries(() => recomputeScores(agents))

  assert.equal(twelve, one, `12 agents cost ${twelve} queries and 1 agent cost ${one}`)
  assert.equal(await recomputeScores(agents), 12, 'every agent’s live lead should have been rescored')
  const { rows } = await query(
    'SELECT COUNT(*)::int AS n FROM leads WHERE last_decay_at IS NOT NULL AND id = ANY($1::int[])',
    [made.map((m) => m.lead.id)],
  )
  assert.equal(rows[0].n, 12)
})

// --- The tick itself ------------------------------------------------------------

test('runDueJobs reads the active agent list once for the whole tick', async () => {
  await query(`DELETE FROM meta WHERE key LIKE 'job:%'`)
  const listReads = []
  const original = pool.query.bind(pool)
  pool.query = (...args) => {
    const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text || ''
    if (/FROM agents WHERE is_active = 1/.test(sql)) listReads.push(sql)
    return original(...args)
  }
  try {
    await runDueJobs()
  } finally {
    pool.query = original
  }
  assert.equal(listReads.length, 1, 'the agent list was re-read once per job instead of once per tick')
})

test('a tick with nothing due does not even ask who the agents are', async () => {
  await runDueJobs() // everything runs and stamps its cadence
  const listReads = []
  const original = pool.query.bind(pool)
  pool.query = (...args) => {
    const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text || ''
    if (/FROM agents WHERE is_active = 1/.test(sql)) listReads.push(sql)
    return original(...args)
  }
  try {
    assert.deepEqual(await runDueJobs(), {}, 'no job is due one tick after a full run')
  } finally {
    pool.query = original
  }
  assert.equal(listReads.length, 0)
})

test('activeAgentIds is the list every job is handed', async () => {
  const ids = await activeAgentIds()
  for (const agentId of agents) assert.ok(ids.includes(agentId))
  const gone = await makeAgent(99)
  await query('UPDATE agents SET is_active = 0, deactivated_at = now() WHERE id = $1', [gone])
  assert.ok(!(await activeAgentIds()).includes(gone), 'a deactivated workspace is still being given background work')
})
