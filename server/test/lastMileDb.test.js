// The last db.js/adminPortal.js arms with no test: the rollback path of the two
// functions that hand-manage a transaction, the rethrow that distinguishes a real
// database failure from a lost race, the rental half of the two pipeline-family
// switches, and the slug fallback for a property row that predates the guard.
//
// Each one is reachable only from a state the happy path never produces — a value
// the schema permits but the routes never write, or a statement that fails for a
// reason the surrounding catch was not written for.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
const dbName = await createTestDb('lastmiledb')

const db = await import('../db.js')
const { createTicket, listTickets } = await import('../adminPortal.js')
const { hashPassword } = await import('../auth.js')
await db.ready

let agent
const GONE = 99_999_999

before(async () => {
  agent = await db.createAgent('Last Mile Lata', '+919744000001', null, hashPassword('secret123'))
})

after(async () => {
  await db.closePool()
  await dropTestDb(dbName)
})

// === Hand-managed transactions: the ROLLBACK arm ============================
//
// createTicket and createTeam are the two writers that take a client out of the
// pool and drive BEGIN/COMMIT themselves. Their catch blocks roll back and rethrow,
// and the finally returns the client — which is the part that matters, because a
// client leaked on the failure path exhausts the pool and takes the process with it.

test('a ticket whose category the schema rejects rolls back, leaving no half-written ticket', async () => {
  const before = (await listTickets({ agentId: agent.id })).length

  await assert.rejects(
    () =>
      createTicket(agent.id, {
        subject: 'Cannot send templates',
        body: 'Every send comes back rejected.',
        category: 'not_a_real_category',
      }),
    (err) => err.code === '23514', // CHECK violation on support_tickets.category
    'an out-of-vocabulary category must fail at the database, not be silently stored',
  )

  assert.equal(
    (await listTickets({ agentId: agent.id })).length,
    before,
    'the ticket row must not survive the failed first-message insert',
  )
})

test('the ticket writer returns its client to the pool even when the transaction fails', async () => {
  // The pool is small; if the failure path leaked a client, this loop would hang
  // rather than fail. Each iteration must borrow and give back the same one client.
  for (let i = 0; i < 12; i++) {
    await assert.rejects(() =>
      createTicket(agent.id, { subject: `leak probe ${i}`, body: 'x', category: 'nope' }),
    )
  }
  // Still usable afterwards — the proof that nothing was held.
  const ok = await createTicket(agent.id, { subject: 'Real one', body: 'Works fine', category: 'billing' })
  assert.equal(ok.category, 'billing')
})

test('creating a team for an agent that does not exist rolls back and reports the database error', async () => {
  await assert.rejects(
    () => db.createTeam(GONE, 'Ghost Realty'),
    (err) => err.code === '23503', // FK violation on teams.owner_agent_id
    'a missing owner is a foreign-key failure, not the "already in a team" conflict',
  )
  // Neither half of the transaction may survive: the teams row is what the FK
  // rejected, but the member row is inserted after it and would be orphaned.
  const { rows } = await db.query(
    `SELECT (SELECT COUNT(*)::int FROM teams WHERE owner_agent_id = $1) AS teams,
            (SELECT COUNT(*)::int FROM team_members WHERE agent_id = $1) AS members`,
    [GONE],
  )
  assert.deepEqual({ teams: rows[0].teams, members: rows[0].members }, { teams: 0, members: 0 })
})

// === updateAgentProfile: the rethrow that is not a lost race ================

test('a profile update that fails for any reason other than a unique clash is rethrown as-is', async () => {
  // The catch there exists for one case: the clash check above it is a read, so two
  // concurrent edits can still race into the unique index (23505), and that is
  // reported as the same friendly conflict. Anything else must surface unchanged —
  // masking a real database failure as "another agent already uses this phone number"
  // would send the agent chasing a duplicate that does not exist.
  //
  // A NUL byte is the cheapest way to make the UPDATE itself fail: PostgreSQL text
  // cannot hold one, and the name has already passed every guard above the query.
  await assert.rejects(
    () => db.updateAgentProfile(agent.id, { name: 'Naveen\u0000Nayak' }),
    (err) => {
      assert.notEqual(err.code, 'PHONE_TAKEN', 'a driver/database failure was reported as a clash')
      assert.notEqual(err.code, 'EMAIL_TAKEN')
      return true
    },
  )
  assert.equal((await db.getAgent(agent.id)).name, 'Last Mile Lata', 'the name must be unchanged')
})

// === The rental half of the pipeline-family switches ========================
//
// pipeline_type is NULL on every lead until something sets it, and both switches
// read it as buy_primary when it is. The rental arm only runs for a lead that was
// explicitly moved onto the rental pipeline.

test('a completed visit on a rental lead advances it to the rental pipeline’s Visit stage', async () => {
  const lead = await db.upsertLead(agent.id, '919744010001', 'Rental Ravi')
  await db.updateLeadCrm(lead.id, agent.id, { pipeline_type: 'rental' })

  const visit = await db.createSiteVisit(agent.id, {
    lead_id: lead.id,
    scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
  })
  await db.updateSiteVisit(visit.id, agent.id, { status: 'completed' })

  const after = await db.getLead(lead.id)
  assert.equal(after.stage, 'Visit', 'the rental pipeline has no "Site Visit Done" — it has "Visit"')
})

test('a rental lead reaching Deposit/Token captures a rental deal priced as monthly rent', async () => {
  const lead = await db.upsertLead(agent.id, '919744010002', 'Deposit Deepa')
  await db.updateLeadCrm(lead.id, agent.id, { pipeline_type: 'rental', budget_max: 45_000_00 })

  await db.setLeadStage(lead.id, agent.id, { stage: 'Deposit/Token' })

  const { rows } = await db.query('SELECT * FROM deals WHERE lead_id = $1', [lead.id])
  assert.equal(rows.length, 1, 'reaching a booking stage captures exactly one deal')
  assert.equal(rows[0].deal_type, 'rental')
  assert.equal(rows[0].deal_value_paise, null, 'a rental has no sale value')
  assert.equal(
    rows[0].monthly_rent_paise,
    45_000_00,
    'with no property attached, the lead’s own budget stands in as the rent',
  )
})

test('a deal capture that throws does not take the stage move down with it', async () => {
  // §5.4 calls captureDealForLead best-effort, and best-effort is only a claim until
  // something fails: the `.catch` on that call is the last function in db.js that no
  // test enters. Break the insert rather than the lead — taking the table out of the
  // way is the one failure that is certain, immediate, and reverses cleanly, and it
  // leaves the UPDATE the move actually consists of completely untouched.
  const lead = await db.upsertLead(agent.id, '919744010003', 'Unlucky Uma')
  await db.query('ALTER TABLE deals RENAME TO deals_hidden')
  let moved
  try {
    moved = await db.setLeadStage(lead.id, agent.id, { stage: 'Token/Booking' })
  } finally {
    await db.query('ALTER TABLE deals_hidden RENAME TO deals')
  }

  assert.equal(moved.stage, 'Token/Booking', 'the move itself must still land')
  const { rows } = await db.query('SELECT * FROM lead_stage_events WHERE lead_id = $1', [lead.id])
  assert.equal(rows.length, 1, 'and the transition is still logged, capture or no capture')
  const deals = await db.query('SELECT * FROM deals WHERE lead_id = $1', [lead.id])
  assert.deepEqual(deals.rows, [], 'nothing was captured, which is the point of best-effort')
})

// === Micro-page slug for a property with no usable title ====================

test('backfilling a slug for a property with an empty title still produces a usable one', async () => {
  // title is NOT NULL, so the row a pre-micro-page property can actually be in is
  // "titled with an empty string" — createProperty rejects that today, which is why
  // only the backfill path can reach the fallback.
  const { rows } = await db.query(
    `INSERT INTO properties (agent_id, title) VALUES ($1, '') RETURNING *`,
    [agent.id],
  )
  const bare = rows[0]
  assert.equal(bare.micro_page_slug, null, 'the fixture must be a property created before slugs existed')

  const filled = await db.ensurePropertySlug(bare.id, agent.id)
  assert.match(
    filled.micro_page_slug,
    /^property-[a-z0-9]+$/,
    'an untitled property falls back to a generic slug rather than a bare suffix',
  )
  // And the slug resolves — the whole point of backfilling it.
  assert.equal((await db.getPropertyBySlug(filled.micro_page_slug)).id, bare.id)
})
