// findContactByWaId decides which agent an inbound message on the shared WhatsApp
// number belongs to. It runs once per message, so it is the hottest read in the
// product — and it used to answer by pulling `SELECT * FROM contacts`, every
// agent's whole address book, into Node and scanning it twice in JavaScript.
//
// These tests pin both halves of the rewrite: the matching rule is unchanged (the
// same digit-normalised exact match, the same 10-digit suffix fallback, the same
// exact-beats-suffix priority), and the cost no longer grows with the table.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('inboundrouting')

const db = await import('../db.js')
const { hashPassword } = await import('../auth.js')
const { findContactByWaId, findAgentByPhoneNumberId, addContact, pool, closePool, query } = db

let agentA, agentB

before(async () => {
  await db.ready
  agentA = await db.createAgent('Route Rekha', '+919813000001', null, hashPassword('secret123'))
  agentB = await db.createAgent('Route Ravi', '+919813000002', null, hashPassword('secret123'))
})

after(async () => {
  await closePool()
  await dropTestDb(dbName)
})

// Runs fn with pool.query instrumented, reporting how many statements ran and how
// many rows they returned in total. A lookup that reads the table shows up here as
// a row count that tracks the table size.
async function measure(fn) {
  const original = pool.query.bind(pool)
  let statements = 0
  let rows = 0
  pool.query = async (...args) => {
    statements++
    const res = await original(...args)
    rows += res.rowCount ?? res.rows?.length ?? 0
    return res
  }
  try {
    const value = await fn()
    return { value, statements, rows }
  } finally {
    pool.query = original
  }
}

// --- The matching rule -----------------------------------------------------

test('an exactly matching number routes to its owner', async () => {
  await addContact(agentA.id, '+919845000001', 'Exact Ekta')
  const found = await findContactByWaId('919845000001')
  assert.equal(found.agent_id, agentA.id)
  assert.equal(found.name, 'Exact Ekta')
})

test('punctuation and spacing in a saved number are ignored', async () => {
  // Agents save numbers however they type them. All of these are one number.
  await addContact(agentA.id, '+91 98450-00002', 'Spaced Sneha')
  for (const incoming of ['919845000002', '+919845000002', '91 98450 00002']) {
    const found = await findContactByWaId(incoming)
    assert.equal(found?.name, 'Spaced Sneha', `"${incoming}" did not route`)
  }
})

test('a contact saved without its country code still routes on the last 10 digits', async () => {
  await addContact(agentB.id, '9845000003', 'Local Lata')
  const found = await findContactByWaId('919845000003')
  assert.equal(found?.agent_id, agentB.id)
  assert.equal(found?.name, 'Local Lata')
})

test('an exact match beats a suffix match', async () => {
  // Two contacts share the last 10 digits; only one is the number that messaged.
  // The suffix arm must not be allowed to steal a message from its real owner.
  await addContact(agentA.id, '9845000004', 'Suffix Only')
  await addContact(agentB.id, '+19845000004', 'Exact Match')
  const found = await findContactByWaId('19845000004')
  assert.equal(found?.name, 'Exact Match')
  assert.equal(found?.agent_id, agentB.id)
})

test('an unknown number routes nowhere, so the message lands in the unassigned pool', async () => {
  assert.equal(await findContactByWaId('919000999888'), null)
})

test('a number with no digits at all is not a lookup', async () => {
  for (const junk of ['', '+', '---', null, undefined]) {
    assert.equal(await findContactByWaId(junk), null, `"${junk}" should not match`)
  }
})

test('a number shorter than a suffix matches on all of itself, never padded', async () => {
  // addContact won't accept a stub this short, so it goes in the way a legacy
  // import or a hand-fixed row would. right(x, 10) on a 5-digit number is the
  // whole number, and a 12-digit sender that happens to end in it must not match.
  await query(`INSERT INTO contacts (agent_id, phone, name) VALUES ($1, '+12345', 'Shorty')`, [agentA.id])
  assert.equal((await findContactByWaId('12345'))?.name, 'Shorty')
  assert.equal(await findContactByWaId('919999912345'), null)
})

test('when several contacts tie on the suffix, the oldest wins — deterministically', async () => {
  // Same last 10 digits, different country codes, so neither is an exact match for
  // the incoming number and both qualify only on the suffix.
  const first = await addContact(agentA.id, '+919845000005', 'First Saved')
  await addContact(agentB.id, '+19845000005', 'Second Saved')
  // Same answer every time: the JS scan settled this by whatever order the table
  // happened to come back in, which is no rule at all.
  for (let i = 0; i < 5; i++) {
    assert.equal((await findContactByWaId('449845000005'))?.id, first.id)
  }
})

// --- The cost --------------------------------------------------------------

test('the lookup reads one row, not the address book', async () => {
  const before = await measure(() => findContactByWaId('919845000001'))
  assert.equal(before.statements, 1, 'one statement, not a fetch-then-filter')
  assert.ok(before.rows <= 1, `read ${before.rows} rows to find one contact`)

  // Grow the table by 200 unrelated contacts and measure again. A lookup whose cost
  // tracks the table size shows up as a row count that grew with it.
  const values = Array.from({ length: 200 }, (_, i) => `(${agentB.id}, '+9198460${String(i).padStart(5, '0')}', 'Bulk ${i}')`)
  await query(`INSERT INTO contacts (agent_id, phone, name) VALUES ${values.join(',')}`)
  assert.ok(
    Number((await query('SELECT COUNT(*)::int AS n FROM contacts')).rows[0].n) > 200,
    'the table really did grow',
  )

  const after = await measure(() => findContactByWaId('919845000001'))
  assert.equal(after.statements, 1)
  assert.ok(after.rows <= 1, `read ${after.rows} rows after the table grew to 200+`)
  assert.equal(after.rows, before.rows, 'cost is flat in the size of the contacts table')

  // A miss must be just as cheap — that's the unknown-sender path.
  const miss = await measure(() => findContactByWaId('919111222333'))
  assert.equal(miss.statements, 1)
  assert.equal(miss.rows, 0)
})

// --- The other per-message lookup ------------------------------------------

test('an inbound line resolves to its active-WABA owner', async () => {
  await query(`UPDATE agents SET wa_phone_number_id = 'pnid-active', waba_status = 'active' WHERE id = $1`, [agentA.id])
  const found = await findAgentByPhoneNumberId('pnid-active')
  assert.equal(found?.id, agentA.id)
})

test('a line whose agent was deactivated stops capturing leads', async () => {
  // deactivated_at is set exactly when is_active is 0 (a CHECK enforces the pair).
  await query(
    `UPDATE agents SET wa_phone_number_id = 'pnid-off', waba_status = 'active',
            is_active = 0, deactivated_at = now() WHERE id = $1`,
    [agentB.id],
  )
  assert.equal(await findAgentByPhoneNumberId('pnid-off'), null)
  await query('UPDATE agents SET is_active = 1, deactivated_at = NULL WHERE id = $1', [agentB.id])
})

test('a pre-WABA line still resolves through the compatibility arm', async () => {
  await query(
    `UPDATE agents SET wa_phone_number_id = 'pnid-legacy', waba_status = 'pending' WHERE id = $1`,
    [agentB.id],
  )
  assert.equal((await findAgentByPhoneNumberId('pnid-legacy'))?.id, agentB.id)
})

test('no phone_number_id is not a lookup', async () => {
  for (const empty of [null, undefined, '']) {
    const { value, statements } = await measure(() => findAgentByPhoneNumberId(empty))
    assert.equal(value, null)
    assert.equal(statements, 0, 'a missing id must short-circuit before touching the database')
  }
})

test('an unknown phone_number_id costs both arms and no more', async () => {
  const { value, statements } = await measure(() => findAgentByPhoneNumberId('pnid-nobody'))
  assert.equal(value, null)
  assert.equal(statements, 2, 'active-WABA arm, then the compatibility arm')
})
