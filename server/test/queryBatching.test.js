// Round-trip budgets for the API layer's remaining fan-out paths.
//
// Three separate shapes are pinned here, because they fail in three different ways:
//   1. contactSendStatsBatch  — was one query PER RECIPIENT before a blast went out.
//   2. distributeTeamPool     — was five queries PER LEAD in the pool.
//   3. worklist/stats/dashboard — independent queries issued one at a time, so page
//      latency was the SUM of every round trip instead of the slowest one.
//
// (1) and (2) are counted; (3) is measured by peak in-flight concurrency, since
// parallelising doesn't change how many queries run, only how long they take.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('querybatching')

const {
  ready, closePool, query, pool,
  addContact, contactSendStats, contactSendStatsBatch, sendStatsKey, recordSend,
  createTeam, distributeTeamPool, pickRoundRobin, assignTeamLead,
  upsertLead, addMessage, createFollowup, worklist, stats, dashboard,
} = await import('../db.js')

let agentId

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

// Peak number of queries in flight at once — the property that separates
// "issued together" from "issued one after another".
async function peakConcurrency(fn) {
  const original = pool.query.bind(pool)
  let inFlight = 0
  let peak = 0
  pool.query = async (...args) => {
    inFlight++
    peak = Math.max(peak, inFlight)
    try {
      return await original(...args)
    } finally {
      inFlight--
    }
  }
  try {
    await fn()
  } finally {
    pool.query = original
  }
  return peak
}

before(async () => {
  await ready
  const { rows } = await query(
    `INSERT INTO agents (name, phone, password_hash, is_active)
     VALUES ('Batching Agent', '+919800000801', 'x', 1) RETURNING id`,
  )
  agentId = rows[0].id
})

after(async () => {
  await closePool()
  await dropTestDb(dbName)
})

// --- 1. Per-recipient send stats -------------------------------------------

test('contactSendStatsBatch returns exactly what contactSendStats returns per contact', async () => {
  const contacts = []
  for (let i = 0; i < 5; i++) {
    contacts.push(await addContact(agentId, `9198111000${i}`, `Blast ${i}`))
  }
  // Give three of them a send history, one of them two sends.
  await recordSend(agentId, { contact_id: contacts[0].id, phone: contacts[0].phone, kind: 'marketing' })
  await recordSend(agentId, { contact_id: contacts[1].id, phone: contacts[1].phone, kind: 'festive' })
  await recordSend(agentId, { contact_id: contacts[1].id, phone: contacts[1].phone, kind: 'marketing' })
  await recordSend(agentId, { contact_id: contacts[3].id, phone: contacts[3].phone, kind: 'marketing' })

  const batch = await contactSendStatsBatch(agentId, contacts)
  for (const c of contacts) {
    const single = await contactSendStats(agentId, c.id ?? null, c.phone)
    const batched = batch.get(sendStatsKey(c))
    assert.ok(batched, `no batch entry for contact ${c.id}`)
    assert.equal(batched.monthCount, single.monthCount, `monthCount for ${c.phone}`)
    assert.equal(
      batched.lastSentAt == null ? null : new Date(batched.lastSentAt).getTime(),
      single.lastSentAt == null ? null : new Date(single.lastSentAt).getTime(),
      `lastSentAt for ${c.phone}`,
    )
  }
  // Contacts with no history are present with zeroed stats, not absent — the caller
  // must never have to distinguish "no row" from "never messaged".
  assert.deepEqual(batch.get(sendStatsKey(contacts[2])), { lastSentAt: null, monthCount: 0 })
})

test('send-stat round trips stay at one however many recipients', async () => {
  const five = (await query('SELECT * FROM contacts WHERE agent_id = $1 ORDER BY id LIMIT 5', [agentId])).rows
  const qSmall = await countQueries(() => contactSendStatsBatch(agentId, five))

  const many = [...five]
  for (let i = 0; i < 40; i++) many.push(await addContact(agentId, `9198112${String(i).padStart(4, '0')}`, `Bulk ${i}`))
  const qLarge = await countQueries(() => contactSendStatsBatch(agentId, many))

  assert.equal(qSmall, 1)
  assert.equal(qLarge, 1, '45 recipients must still cost one query, not 45')
})

test('an empty recipient list costs no query at all', async () => {
  let out = null
  const n = await countQueries(async () => {
    out = await contactSendStatsBatch(agentId, [])
  })
  assert.equal(n, 0)
  assert.equal(out.size, 0)
})

test('two contacts sharing a phone number resolve to the same send history', async () => {
  // The batch de-duplicates by contact id, so both rows must still see the send
  // that was recorded against the shared number.
  const a = await addContact(agentId, '919811999888', 'Shared A')
  await recordSend(agentId, { contact_id: a.id, phone: a.phone, kind: 'marketing' })
  const bLike = { id: null, phone: a.phone }
  const batch = await contactSendStatsBatch(agentId, [a, bLike])
  assert.equal(batch.get(sendStatsKey(a)).monthCount, 1)
  assert.equal(batch.get(sendStatsKey(bLike)).monthCount, 1, 'phone-only recipient sees the same history')
})

// --- 2. Team pool distribution ---------------------------------------------

async function seedTeam(name, phoneBase, memberCount, strategy = 'round_robin') {
  const owner = (
    await query(
      `INSERT INTO agents (name, phone, password_hash, is_active)
       VALUES ($1, $2, 'x', 1) RETURNING id`,
      [`${name} Owner`, `${phoneBase}0`],
    )
  ).rows[0].id
  const team = await createTeam(owner, name)
  // Teams default to 'manual', which auto-placement deliberately leaves alone.
  await query('UPDATE teams SET assignment_strategy = $2 WHERE id = $1', [team.id, strategy])
  team.assignment_strategy = strategy
  const members = [owner]
  for (let i = 1; i <= memberCount; i++) {
    const m = (
      await query(
        `INSERT INTO agents (name, phone, password_hash, is_active)
         VALUES ($1, $2, 'x', 1) RETURNING id`,
        [`${name} M${i}`, `${phoneBase}${i}`],
      )
    ).rows[0].id
    await query(
      `INSERT INTO team_members (team_id, agent_id, role, accepts_leads) VALUES ($1, $2, 'agent', 1)`,
      [team.id, m],
    )
    members.push(m)
  }
  return { team, owner, members }
}

async function poolLeads(teamId, prefix, n) {
  const ids = []
  for (let i = 0; i < n; i++) {
    const { rows } = await query(
      `INSERT INTO leads (wa_id, name, team_id, agent_id) VALUES ($1, $2, $3, NULL) RETURNING id`,
      [`${prefix}${String(i).padStart(4, '0')}`, `Pooled ${i}`, teamId],
    )
    ids.push(rows[0].id)
  }
  return ids
}

test('batched round-robin distribution places leads in the same order a per-lead loop would', async () => {
  // Reference: drive the old per-lead primitives by hand on one team.
  const ref = await seedTeam('RefTeam', '+91980001010', 2)
  const refLeads = await poolLeads(ref.team.id, '9198201', 5)
  const expected = []
  for (const id of refLeads) {
    const target = await pickRoundRobin(ref.team.id)
    await assignTeamLead(ref.team.id, id, target)
    expected.push(target)
  }

  // Same team shape, same lead count, distributed in one batch.
  const bat = await seedTeam('BatTeam', '+91980002020', 2)
  const batLeads = await poolLeads(bat.team.id, '9198202', 5)
  const { assigned } = await distributeTeamPool(bat.team.id)
  assert.equal(assigned, 5)

  const got = (
    await query('SELECT id, agent_id FROM leads WHERE id = ANY($1::int[]) ORDER BY id', [batLeads])
  ).rows.map((r) => r.agent_id)

  // Compare by position in each team's member rotation, since the agent ids differ.
  const seat = (teamMembers, id) => teamMembers.indexOf(id)
  assert.deepEqual(
    got.map((id) => seat(bat.members, id)),
    expected.map((id) => seat(ref.members, id)),
    'batched rotation must match the per-lead rotation seat for seat',
  )
})

test('the round-robin cursor advances by exactly the number of leads placed', async () => {
  const { team } = await seedTeam('CursorTeam', '+91980003030', 2)
  const before = (await query('SELECT rr_cursor FROM teams WHERE id = $1', [team.id])).rows[0].rr_cursor
  await poolLeads(team.id, '9198203', 7)
  await distributeTeamPool(team.id)
  const after = (await query('SELECT rr_cursor FROM teams WHERE id = $1', [team.id])).rows[0].rr_cursor
  assert.equal(after - before, 7, 'cursor must not be over- or under-advanced')
})

test('team-pool distribution round trips do not grow with pool size', async () => {
  const small = await seedTeam('SmallPool', '+91980004040', 2)
  await poolLeads(small.team.id, '9198204', 3)
  const qSmall = await countQueries(() => distributeTeamPool(small.team.id))

  const large = await seedTeam('LargePool', '+91980005050', 2)
  await poolLeads(large.team.id, '9198205', 40)
  const qLarge = await countQueries(() => distributeTeamPool(large.team.id))

  assert.equal(qSmall, qLarge, '40 pooled leads must cost the same as 3')
  // team, leads, members, cursor, bulk update.
  assert.equal(qLarge, 5)
})

test('locality distribution honours member localities and only rotates the leftovers', async () => {
  const { team, members } = await seedTeam('LocalityTeam', '+91980006060', 2)
  await query(`UPDATE teams SET assignment_strategy = 'locality' WHERE id = $1`, [team.id])
  // Second member (index 1) covers Baner.
  await query(`UPDATE team_members SET localities = $2 WHERE team_id = $1 AND agent_id = $3`,
    [team.id, JSON.stringify(['Baner']), members[1]])

  const { rows: baner } = await query(
    `INSERT INTO leads (wa_id, name, team_id, agent_id, locality)
     VALUES ('919820600001', 'Baner Buyer', $1, NULL, 'Baner') RETURNING id`, [team.id])
  const { rows: nowhere } = await query(
    `INSERT INTO leads (wa_id, name, team_id, agent_id, locality)
     VALUES ('919820600002', 'Elsewhere Buyer', $1, NULL, 'Kothrud') RETURNING id`, [team.id])

  const cursorBefore = (await query('SELECT rr_cursor FROM teams WHERE id = $1', [team.id])).rows[0].rr_cursor
  const { assigned } = await distributeTeamPool(team.id)
  assert.equal(assigned, 2)

  const placed = (await query('SELECT id, agent_id FROM leads WHERE id = ANY($1::int[])',
    [[baner[0].id, nowhere[0].id]])).rows
  assert.equal(placed.find((r) => r.id === baner[0].id).agent_id, members[1], 'locality match wins')
  assert.ok(placed.find((r) => r.id === nowhere[0].id).agent_id, 'unmatched lead still placed by rotation')

  const cursorAfter = (await query('SELECT rr_cursor FROM teams WHERE id = $1', [team.id])).rows[0].rr_cursor
  assert.equal(cursorAfter - cursorBefore, 1, 'only the unmatched lead consumed a rotation slot')
})

test('a team with no assignable members places nothing and does not advance the cursor', async () => {
  const owner = (
    await query(
      `INSERT INTO agents (name, phone, password_hash, is_active)
       VALUES ('Lonely Owner', '+919800070701', 'x', 1) RETURNING id`,
    )
  ).rows[0].id
  const team = await createTeam(owner, 'NoMembers')
  await query(`UPDATE teams SET assignment_strategy = 'round_robin' WHERE id = $1`, [team.id])
  await query('UPDATE team_members SET accepts_leads = 0 WHERE team_id = $1', [team.id])
  const leads = await poolLeads(team.id, '9198207', 3)

  const cursorBefore = (await query('SELECT rr_cursor FROM teams WHERE id = $1', [team.id])).rows[0].rr_cursor
  assert.deepEqual(await distributeTeamPool(team.id), { assigned: 0 })
  const cursorAfter = (await query('SELECT rr_cursor FROM teams WHERE id = $1', [team.id])).rows[0].rr_cursor

  assert.equal(cursorAfter, cursorBefore)
  const still = (await query('SELECT agent_id FROM leads WHERE id = ANY($1::int[])', [leads])).rows
  assert.equal(still.every((r) => r.agent_id === null), true, 'leads stay in the pool')
})

test('a manual team is left alone after a single team read', async () => {
  const { team } = await seedTeam('ManualTeam', '+91980009090', 2, 'manual')
  const leads = await poolLeads(team.id, '9198209', 4)
  const n = await countQueries(async () => {
    assert.deepEqual(await distributeTeamPool(team.id), { assigned: 0 })
  })
  assert.equal(n, 1, 'manual placement must not even read the pool')
  const still = (await query('SELECT agent_id FROM leads WHERE id = ANY($1::int[])', [leads])).rows
  assert.equal(still.every((r) => r.agent_id === null), true)
})

test('an empty pool short-circuits before touching members or the cursor', async () => {
  const { team } = await seedTeam('EmptyPool', '+91980008080', 1)
  const n = await countQueries(() => distributeTeamPool(team.id))
  assert.equal(n, 2, 'only the team read and the (empty) lead read')
})

// --- 3. Dashboard fan-out concurrency --------------------------------------

test('worklist, stats and dashboard issue their independent queries together', async () => {
  // Seed enough that every branch has rows to shape, so nothing is skipped.
  const lead = await upsertLead(agentId, '919833000001', 'Fanout Buyer')
  await addMessage(lead.id, 'buyer', 'is it still available?')
  await query(
    `UPDATE leads SET last_inbound_at = now() - interval '21 hours', effective_temp = 'Hot',
       effective_score = 88, budget_max_l = 90, budget_min_l = 70, timeline = '1-3 months',
       locality = 'Baner', config = '2BHK' WHERE id = $1`,
    [lead.id],
  )
  await createFollowup(agentId, {
    lead_id: lead.id,
    due_at: new Date(Date.now() - 86_400_000).toISOString(),
    note: 'call back',
  })

  const worklistPeak = await peakConcurrency(() => worklist(agentId))
  assert.ok(worklistPeak > 1, `worklist ran its queries serially (peak in-flight ${worklistPeak})`)

  const statsPeak = await peakConcurrency(() => stats(agentId))
  assert.ok(statsPeak > 1, `stats ran its queries serially (peak in-flight ${statsPeak})`)

  const dashPeak = await peakConcurrency(() => dashboard(agentId))
  assert.ok(dashPeak > 1, `dashboard ran its queries serially (peak in-flight ${dashPeak})`)
})

test('parallelising the worklist did not change what it reports', async () => {
  const { items, counts } = await worklist(agentId)
  const types = items.map((i) => i.type)
  // The seeded lead is inside its 24h window, Hot with a buyer-last message, and
  // carries an overdue follow-up — all three must still surface.
  assert.ok(types.includes('service_window_closing'), `got ${JSON.stringify(types)}`)
  assert.ok(types.includes('hot_lead_waiting'))
  assert.ok(types.includes('overdue_followup'))
  // worklistCounts returns by_type/by_priority. Reading counts.byType instead left
  // this comparing items.length to itself, so the roll-up was never actually checked.
  assert.equal(Object.values(counts.by_type).reduce((a, b) => a + b, 0), items.length)
  assert.equal(Object.values(counts.by_priority).reduce((a, b) => a + b, 0), items.length)
  assert.equal(counts.total, items.length)
})

test('stats still totals the seeded leads after the fan-out change', async () => {
  const s = await stats(agentId)
  const total = (await query('SELECT COUNT(*)::int AS n FROM leads WHERE agent_id = $1', [agentId])).rows[0].n
  assert.equal(Number(s.total), total)
  assert.ok(Number(s.hotNow) >= 1, 'the Hot lead is counted')
  assert.ok(Array.isArray(s.sources))
  assert.ok(Array.isArray(s.daily))
})

test('dashboard still returns every widget key', async () => {
  const d = await dashboard(agentId)
  for (const key of ['unanswered', 'followupsToday', 'overdueFollowups', 'siteVisitsToday', 'hotLeads', 'activity']) {
    assert.ok(Array.isArray(d[key]), `${key} missing or not an array`)
  }
  assert.ok(d.hotLeads.some((l) => l.name === 'Fanout Buyer'), 'the Hot lead shows on the dashboard')
})

// --- 4. Stats round-trip budget --------------------------------------------
// The counters behind /api/stats used to be eleven separate aggregates plus a
// timezone lookup — twelve round trips, seven of them scanning the same `leads`
// rows. The pg pool holds ten connections, so a single dashboard poll could not
// even fit in it: at twelve concurrent callers the old shape measured ~34ms per
// wave against ~22ms for this one.

test('stats answers in a handful of round trips, not one per counter', async () => {
  const n = await countQueries(() => stats(agentId))
  assert.ok(n <= 5, `stats issued ${n} round trips; the eleven-aggregate shape is back`)
})

test('the leads counters come from one pass, not one query each', async () => {
  const original = pool.query.bind(pool)
  const texts = []
  pool.query = (...args) => {
    texts.push(typeof args[0] === 'string' ? args[0] : args[0]?.text || '')
    return original(...args)
  }
  try {
    await stats(agentId)
  } finally {
    pool.query = original
  }
  // `FROM messages` is excluded: its tenant scope is a `lead_id IN (SELECT id FROM
  // leads …)` subquery, not a scan of its own. `GROUP BY` excludes the two rollups
  // (sources, last 7 days) that genuinely need their own shape.
  const leadScans = texts.filter(
    (t) => /FROM leads\b/i.test(t) && !/FROM messages\b/i.test(t) && !/GROUP BY/i.test(t),
  )
  assert.equal(leadScans.length, 1, `expected one rollup over leads, saw ${leadScans.length}`)
})
