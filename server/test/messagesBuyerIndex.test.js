// Migration 024: the partial index behind every "what did the buyer say" count.
//
// `role = 'buyer'` is the most-repeated predicate in the polled queries — the unread
// badge in listLeads, msg_count in listContacts, the scorer's buyer aggregates — and
// nothing indexed it, so each read the lead's whole history and discarded the agent's
// and the AI's messages in the heap.
//
// Two things are worth locking down, and they fail in opposite directions. The counts
// must still be right (an index that changed an answer would be a catastrophe rather
// than an optimisation), and the planner must still be able to USE the index — a later
// edit that wraps role in a function, or counts every role and filters in JS, would
// leave every assertion about the numbers passing while quietly restoring the full scan.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('buyerindex')

const {
  closePool,
  query,
  ready,
  upsertLead,
  addMessage,
  addContact,
  listLeads,
  listContacts,
} = await import('../db.js')

let agentId
// A lead the agent has read up to, with buyer messages on both sides of that mark.
let readLeadId

before(async () => {
  await ready
  agentId = (
    await query(
      `INSERT INTO agents (name, phone, password_hash)
       VALUES ('Index Agent', '+919750000001', 'x') RETURNING id`,
    )
  ).rows[0].id

  // 60 leads, each with a conversation that is mostly NOT the buyer — which is the
  // shape the index exists for, and the shape real threads have.
  for (let i = 0; i < 60; i++) {
    // The contact's phone must be the lead's wa_id with a '+' — that equality is how
    // listContacts joins the two, so a mismatch here would make msg_count trivially 0
    // and the assertion below vacuous.
    const waId = `9198770${String(10000 + i)}`
    const lead = await upsertLead(agentId, waId, `Buyer ${i}`)
    await addContact(agentId, `+${waId}`, `Buyer ${i}`)
    for (let m = 0; m < 25; m++) {
      await addMessage(lead.id, m % 5 === 0 ? 'buyer' : 'agent', `msg ${m}`)
    }
  }

  // One lead with a known, hand-countable shape: 3 buyer messages before the agent read
  // the thread, 2 after, and agent/AI noise throughout that must not be counted.
  const lead = await upsertLead(agentId, '919877700001', 'Zeenat Sheikh')
  readLeadId = lead.id
  for (const role of ['buyer', 'agent', 'buyer', 'ai', 'buyer']) await addMessage(lead.id, role, role)
  await query('UPDATE leads SET last_read_at = now() WHERE id = $1', [readLeadId])
  await new Promise((r) => setTimeout(r, 10))
  for (const role of ['buyer', 'agent', 'ai', 'buyer']) await addMessage(lead.id, role, role)

  await query('ANALYZE')
})

// No HTTP server here: these assertions are about the plan and the numbers, both of
// which the db layer answers directly.
after(async () => {
  await closePool()
  await dropTestDb(dbName)
})

test('the migration created the partial index', async () => {
  const { rows } = await query(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'messages' AND indexname = $1`,
    ['idx_messages_lead_buyer'],
  )
  assert.equal(rows.length, 1, 'migration 024 did not create idx_messages_lead_buyer')
  assert.match(rows[0].indexdef, /\(lead_id, created_at\)/,
    'created_at is the second column so unread_count can range-scan from last_read_at')
  assert.match(rows[0].indexdef, /WHERE \(?role = 'buyer'/,
    'the point of the index is that it holds only the buyer messages')
})

test('unread_count still counts buyer messages newer than the last read, and nothing else', async () => {
  const leads = await listLeads(agentId, { limit: 500 })
  const lead = leads.find((l) => l.id === readLeadId)
  assert.ok(lead, 'the lead under test fell off the page')
  assert.equal(lead.unread_count, 2,
    'two buyer messages arrived after the agent read the thread — the agent and ai ones are not unread')
})

test('an unread thread counts every buyer message, and a read one counts none', async () => {
  const fresh = await upsertLead(agentId, '919877700002', 'Never Read')
  for (const role of ['buyer', 'agent', 'buyer']) await addMessage(fresh.id, role, role)
  let lead = (await listLeads(agentId, { limit: 500 })).find((l) => l.id === fresh.id)
  assert.equal(lead.unread_count, 2, 'last_read_at IS NULL means everything from the buyer is unread')

  await query('UPDATE leads SET last_read_at = now() WHERE id = $1', [fresh.id])
  lead = (await listLeads(agentId, { limit: 500 })).find((l) => l.id === fresh.id)
  assert.equal(lead.unread_count, 0, 'reading the thread clears the badge')
})

test('msg_count on a contact still counts only that buyer own messages', async () => {
  const contacts = await listContacts(agentId, { search: 'Buyer 7', limit: 500 })
  const contact = contacts.find((c) => c.name === 'Buyer 7')
  assert.ok(contact, 'the seeded contact was not found')
  // 25 messages, every fifth from the buyer.
  assert.equal(Number(contact.msg_count), 5)
})

test('the planner uses the index instead of reading whole conversations', async () => {
  // The regression this catches is silent: a later edit that counts every role and
  // filters in JS, or wraps role in a function, keeps every count above correct while
  // restoring the full-history scan the index was added to stop.
  const explain = async (sql, params) =>
    (await query(`EXPLAIN (FORMAT TEXT) ${sql}`, params)).rows.map((r) => r['QUERY PLAN']).join('\n')

  const unread = await explain(
    `SELECT (SELECT count(*) FROM messages m
               WHERE m.lead_id = l.id AND m.role = 'buyer'
                 AND (l.last_read_at IS NULL OR m.created_at > l.last_read_at))::int AS unread_count
       FROM leads l WHERE l.agent_id = $1 LIMIT 100`,
    [agentId],
  )
  assert.match(unread, /idx_messages_lead_buyer/,
    'the unread badge is back to scanning every message in the thread')

  const buyerAggs = await explain(
    `SELECT (SELECT MAX(created_at) FROM messages WHERE lead_id = l.id AND role = 'buyer') AS last_buyer_at,
            (SELECT COUNT(*) FROM messages WHERE lead_id = l.id AND role = 'buyer') AS buyer_replies
       FROM leads l WHERE l.agent_id = $1 LIMIT 100`,
    [agentId],
  )
  assert.match(buyerAggs, /idx_messages_lead_buyer/,
    "the scorer's buyer aggregates are back to scanning every message")
})
