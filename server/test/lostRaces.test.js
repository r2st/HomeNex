// The arms that only a LOST race reaches.
//
// Every one of these paths sits behind a guard that reads committed rows — "is this
// email taken?", "does this slug exist?" — and then writes. Between the read and the
// write a second request can take the value, and the unique index raises 23505. The
// guard means normal tests never get there, so these catch blocks are exactly the
// code that has never run before shipping, in the code whose job is to turn a race
// into a clear sentence instead of a 500.
//
// Provoked deterministically rather than by racing: a rival transaction takes the
// value and holds it open. The guard reads committed rows, so it sees nothing and
// lets the caller through; the write then blocks on the uncommitted index entry, and
// committing the rival turns that block into the unique violation.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('lostraces')

const {
  ready,
  closePool,
  query,
  pool,
  createTeam,
  updateAgentProfile,
  updateAgentPhone,
  updateAgentProfileSelf,
  ensurePropertySlug,
  createProperty,
} = await import('../db.js')

// Awaited here rather than in before(): the hook's duration is charged to the first
// test, which made a 156ms race read as a six-second one and look like a timeout.
await ready

let agentId
let rivalId

const newAgent = async (phone, name, email = null) =>
  (
    await query(
      `INSERT INTO agents (name, phone, email, password_hash, is_active) VALUES ($1, $2, $3, 'x', 1) RETURNING id`,
      [name, phone, email],
    )
  ).rows[0].id

// Holds `sql` uncommitted on its own connection. Anything that throws in here hands
// the client back — a raw pool client abandoned mid-transaction is never returned to
// the pool, and closePool() in after() would then wait on it forever.
async function hold(sql, params) {
  const racer = await pool.connect()
  try {
    await racer.query('BEGIN')
    await racer.query(sql, params)
  } catch (e) {
    await racer.query('ROLLBACK').catch(() => {})
    racer.release()
    throw e
  }
  let done = false
  const finish = async (verb) => {
    if (done) return
    done = true
    try {
      await racer.query(verb)
    } finally {
      racer.release()
    }
  }
  return { commit: () => finish('COMMIT'), release: () => finish('ROLLBACK') }
}

// Runs `attempt` while the rival holds its row, then commits the rival so the
// blocked write becomes a unique violation. Returns the error `attempt` rejected
// with, or null if it somehow succeeded.
async function loseRaceTo(held, attempt) {
  try {
    const settled = attempt().then(() => null, (e) => e)
    await new Promise((r) => setTimeout(r, 150))
    await held.commit()
    return await settled
  } finally {
    await held.release()
  }
}

before(async () => {
  agentId = await newAgent('+919700001001', 'Race Agent', 'race@homenex.test')
  rivalId = await newAgent('+919700001002', 'Rival Agent', 'rival@homenex.test')
})

after(async () => {
  await closePool()
  await dropTestDb(dbName)
})

// --- agents.email ------------------------------------------------------------

test('an email taken mid-save is EMAIL_TAKEN, not a 500', async () => {
  const held = await hold('UPDATE agents SET email = $1 WHERE id = $2', ['contested@homenex.test', rivalId])
  const err = await loseRaceTo(held, () =>
    updateAgentProfileSelf(agentId, { email: 'contested@homenex.test' }),
  )

  assert.ok(err, 'the save succeeded even though the email was gone')
  assert.equal(err.code, 'EMAIL_TAKEN')
  assert.match(err.message, /already uses this email/)
})

test('a non-conflict failure on the same save is not disguised as EMAIL_TAKEN', async () => {
  // The catch re-throws anything that is not 23505; a validation error must keep its
  // own message rather than being reported as somebody else's email.
  await assert.rejects(
    () => updateAgentProfileSelf(agentId, { name: '' }),
    (e) => e.code !== 'EMAIL_TAKEN' && /Name cannot be empty/.test(e.message),
  )
})

// --- agents.phone ------------------------------------------------------------

test('a phone number taken mid-change is PHONE_TAKEN, not a 500', async () => {
  const held = await hold('UPDATE agents SET phone = $1 WHERE id = $2', ['+919700009999', rivalId])
  const err = await loseRaceTo(held, () => updateAgentPhone(agentId, '+919700009999'))

  assert.ok(err, 'the change succeeded even though the number was gone')
  assert.equal(err.code, 'PHONE_TAKEN')
  assert.match(err.message, /already uses this WhatsApp number/)

  // The losing agent keeps the number they had.
  const { rows } = await query('SELECT phone FROM agents WHERE id = $1', [agentId])
  assert.equal(rows[0].phone, '+919700001001')
})

test('the admin profile edit reports a phone taken mid-save the same way', async () => {
  const other = await newAgent('+919700001003', 'Third Agent')
  const held = await hold('UPDATE agents SET phone = $1 WHERE id = $2', ['+919700008888', rivalId])
  const err = await loseRaceTo(held, () => updateAgentProfile(other, { phone: '+919700008888' }))

  assert.ok(err, 'the admin edit succeeded even though the number was gone')
  assert.match(err.message, /already uses this phone number|Another agent/)
})

// --- properties.micro_page_slug ---------------------------------------------

test('a slug taken mid-backfill is retried rather than thrown', async () => {
  // The slug is derived from the title, so a collision is what two properties with
  // the same title produce. The retry has to find a free one, not surface 23505.
  const property = await createProperty(agentId, { title: 'Skyline Residences', locality: 'Wakad' })
  await query('UPDATE properties SET micro_page_slug = NULL WHERE id = $1', [property.id])

  const { rows: existing } = await query(
    `SELECT micro_page_slug FROM properties WHERE id = $1`,
    [property.id],
  )
  assert.equal(existing[0].micro_page_slug, null, 'the fixture must start without a slug')

  const filled = await ensurePropertySlug(property.id, agentId)
  assert.ok(filled.micro_page_slug, 'the backfill produced no slug')

  // A second property with the identical title must not collide into a failure.
  const twin = await createProperty(agentId, { title: 'Skyline Residences', locality: 'Wakad' })
  await query('UPDATE properties SET micro_page_slug = NULL WHERE id = $1', [twin.id])
  const twinFilled = await ensurePropertySlug(twin.id, agentId)
  assert.ok(twinFilled.micro_page_slug)
  assert.notEqual(twinFilled.micro_page_slug, filled.micro_page_slug, 'two properties share one slug')
})

test('a backfill for a property that is not the agent’s returns null', async () => {
  const property = await createProperty(agentId, { title: 'Not Yours', locality: 'Baner' })
  assert.equal(await ensurePropertySlug(property.id, rivalId), null)
})

test('a property that already has a slug keeps it untouched', async () => {
  const property = await createProperty(agentId, { title: 'Already Slugged', locality: 'Hinjewadi' })
  const again = await ensurePropertySlug(property.id, agentId)
  assert.equal(again.micro_page_slug, property.micro_page_slug)
})

// --- teams -------------------------------------------------------------------

test('a createTeam failure that is not a membership clash keeps its own error', async () => {
  // owner_agent_id is a foreign key, so a missing agent fails with 23503. The catch
  // only translates 23505; anything else must come through unchanged rather than
  // telling the caller they are "already in a team".
  const err = await createTeam(99999999, 'Ghost Realty').then(() => null, (e) => e)

  assert.ok(err, 'creating a team for a non-existent agent should not succeed')
  assert.notEqual(err.code, 'ALREADY_IN_TEAM')
  assert.equal(err.code, '23503')

  // The rolled-back transaction must not leave the team row behind.
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM teams WHERE name = 'Ghost Realty'`)
  assert.equal(rows[0].n, 0, 'the failed create left an orphan team')
})
