// Arms that need a database but not a running server: the pg type parsers db.js
// installs at import, the transactional rollback in the support-ticket writer, and
// the site-visit reminder for a lead that has never said anything.
//
// Each one is code that runs in production on an ordinary day and had no test,
// because the fixtures the rest of the suite builds happen to avoid it — every lead
// in a reminder test has a transcript, every ticket the ticket tests write is valid.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('lastmilearms')

const db = await import('../db.js')
const { createTicket } = await import('../adminPortal.js')
const { siteVisitWaReminders } = await import('../scheduler.js')
const { hashPassword } = await import('../auth.js')

await db.ready

let agent

before(async () => {
  agent = await db.createAgent('Last Mile', '+919855000001', null, hashPassword('secret123'))
})

after(async () => {
  await db.closePool()
  await dropTestDb(dbName)
})

// === pg type parsers ==========================================================
//
// db.js replaces three of node-postgres's default parsers at import time. Two of
// them guard against a null input. node-postgres itself never calls a parser with
// null — it short-circuits NULL columns before the parser runs — so that guard has
// never executed against a real query, and the only way to state what it does is to
// call the parser the way the guard is written for.

test('the BIGINT parser turns paise into a number, and passes NULL through', () => {
  // COUNT() and every paise column arrive on this parser. Returning the string would
  // make `total + 1` produce "1000001" and silently corrupt a money total.
  const parse = pg.types.getTypeParser(20)
  assert.equal(parse('900000000'), 900000000)
  assert.equal(typeof parse('900000000'), 'number')
  assert.equal(parse(null), null, 'a null bigint parsed to something other than null')
})

test('the NUMERIC parser floats commission_pct, and passes NULL through', () => {
  const parse = pg.types.getTypeParser(1700)
  assert.equal(parse('2.50'), 2.5)
  assert.equal(parse(null), null, 'a null numeric parsed to something other than null')
})

test('the DATE parser hands back the plain YYYY-MM-DD string', () => {
  // Deliberately NOT a Date: constructing one puts it at local midnight, and a RERA
  // expiry or a payout date then reads as the previous day west of UTC.
  const parse = pg.types.getTypeParser(1082)
  assert.equal(parse('2026-03-31'), '2026-03-31')
})

test('a stored bigint really does come back as a number end to end', async () => {
  // The parser tests above call the function directly; this proves it is the one
  // actually installed on the pool every query goes through.
  const { rows } = await db.query('SELECT $1::bigint AS paise, $2::date AS on_date', [
    '123456789012',
    '2026-03-31',
  ])
  assert.equal(rows[0].paise, 123456789012)
  assert.equal(typeof rows[0].paise, 'number')
  assert.equal(rows[0].on_date, '2026-03-31')
})

// === support tickets: the transaction that has to roll back ====================

test('a ticket the database refuses leaves no half-written ticket behind', async () => {
  // createTicket writes the ticket and its first message in one transaction. Only
  // subject and body are validated in Node; category is checked by the column, so a
  // category outside the contract fails on the INSERT — after BEGIN. Without the
  // ROLLBACK the ticket row would survive with no message on it, and the agent's
  // support thread would open empty.
  const before = await countTickets()

  await assert.rejects(
    () => createTicket(agent.id, { subject: 'Cannot send', body: 'Template stuck', category: 'nonsense' }),
    (err) => err.code === '23514', // check_violation
  )

  assert.equal(await countTickets(), before, 'a rejected ticket was left in the table')
})

test('a valid ticket still commits both rows together', async () => {
  const ticket = await createTicket(agent.id, {
    subject: 'Template rejected',
    body: 'Meta rejected the Diwali template',
    category: 'whatsapp',
  })
  assert.equal(ticket.category, 'whatsapp')
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM support_ticket_messages WHERE ticket_id = $1', [
    ticket.id,
  ])
  assert.equal(rows[0].n, 1, 'the ticket committed without its opening message')
})

async function countTickets() {
  return (await db.query('SELECT COUNT(*)::int AS n FROM support_tickets WHERE agent_id = $1', [agent.id]))
    .rows[0].n
}

// === site-visit reminder for a lead with no transcript =========================

test('a visit reminder goes out for a lead who has never sent a message', async () => {
  // The reminder is written in the buyer's own language, read off their transcript.
  // A visit booked by the agent from a phone call has no transcript at all: the
  // batched transcript read returns no entry for that lead, and the language detector
  // has to be handed an empty thread rather than undefined. Every existing reminder
  // fixture chats first, so this walked straight into the fallback and nothing pinned
  // what it does.
  const lead = await db.upsertLead(agent.id, '919855000123', 'Silent Buyer')
  const { rows: countBefore } = await db.query('SELECT COUNT(*)::int AS n FROM messages WHERE lead_id = $1', [
    lead.id,
  ])
  assert.equal(countBefore[0].n, 0, 'the fixture is only meaningful with an empty thread')

  const visit = await db.createSiteVisit(agent.id, {
    lead_id: lead.id,
    scheduled_at: new Date(Date.now() + 23 * 3600_000).toISOString(),
  })

  const sent = []
  const n = await siteVisitWaReminders([agent.id], Date.now(), async (to, text) => {
    sent.push({ to, text })
    return 'wamid.test'
  })

  assert.equal(n, 1, 'the silent lead got no reminder')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].to, '919855000123')
  assert.match(sent[0].text, /visit/i)

  // The guard column is stamped, so a second tick does not message them twice.
  const again = await siteVisitWaReminders([agent.id], Date.now(), async () => 'wamid.test')
  assert.equal(again, 0, 'the same visit was reminded twice')
  assert.ok(visit.id)
})
