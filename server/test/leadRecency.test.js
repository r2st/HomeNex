// Migration 025: who spoke last, kept on the lead row.
//
// Seven polled queries used to answer "when did we last hear from this lead, and when
// did we last answer?" by reaching into `messages` once per lead. They now read
// leads.last_inbound_at / leads.last_outbound_at, which the database maintains.
//
// That trade is only safe while the two columns are exactly the newest message in
// each direction. Nothing in the app checks that — the queries simply believe it — so
// this file is where the belief is earned. It pins the trigger's contract from every
// direction a message can move (appended, backdated, re-parented, removed), then
// pins the two shared predicates that every caller is built out of, so a lead that
// looks unanswered to one screen can never look answered to another.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('leadrecency')

const {
  closePool,
  query,
  ready,
  createAgent,
  upsertLead,
  addMessage,
  dashboard,
  worklist,
  AWAITING_REPLY,
  LAST_CONTACT_AT,
} = await import('../db.js')

let agentId
let seq = 0

// Every lead gets its own WhatsApp id so the tests never collide on
// UNIQUE (agent_id, wa_id).
const lead = (name) => upsertLead(agentId, `9198520000${String(++seq).padStart(2, '0')}`, name)

const marks = async (leadId) =>
  (await query('SELECT last_inbound_at, last_outbound_at FROM leads WHERE id = $1', [leadId])).rows[0]

// Append a message the way an importer would — straight into the table, with its own
// timestamp, never touching the lead row.
const insertRaw = (leadId, role, text, at) =>
  query(
    `INSERT INTO messages (lead_id, role, text, created_at) VALUES ($1, $2, $3, $4) RETURNING id`,
    [leadId, role, text, at],
  )

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString()
const HOUR = 3600_000
const DAY = 24 * HOUR

before(async () => {
  await ready
  const agent = await createAgent('Recency Rekha', '+919852000000', null, 'x'.repeat(60))
  agentId = agent.id
})

after(async () => {
  await closePool()
  await dropTestDb(dbName)
})

// --- The trigger's contract -------------------------------------------------

test('a buyer message moves the inbound mark, an agent or AI message the outbound one', async () => {
  const l = await lead('Split Sunita')
  assert.deepEqual(await marks(l.id), { last_inbound_at: null, last_outbound_at: null })

  await addMessage(l.id, 'buyer', 'is it still available?')
  const afterBuyer = await marks(l.id)
  assert.ok(afterBuyer.last_inbound_at, 'the buyer set the inbound mark')
  assert.equal(afterBuyer.last_outbound_at, null, 'and left the outbound one alone')

  await addMessage(l.id, 'agent', 'it is — want to see it Saturday?')
  const afterAgent = await marks(l.id)
  assert.deepEqual(afterAgent.last_inbound_at, afterBuyer.last_inbound_at, 'the agent did not move the inbound mark')
  assert.ok(afterAgent.last_outbound_at, 'the agent set the outbound one')

  // The AI answers on the same side of the conversation as the agent.
  await addMessage(l.id, 'ai', 'Sharing the floor plan now.')
  const afterAi = await marks(l.id)
  assert.ok(afterAi.last_outbound_at > afterAgent.last_outbound_at, 'the AI counts as us, not as them')
})

test('a mark carries the message its own timestamp, not the time it was stored', async () => {
  // This is what the old addMessage got wrong: it stamped now(), so an imported
  // conversation claimed to have happened at import time. A lead backdated three
  // days is three days quiet, and every rule downstream depends on believing that.
  const l = await lead('Imported Irfan')
  const spoke = iso(3 * DAY)
  await insertRaw(l.id, 'buyer', 'saw your listing last week', spoke)

  const m = await marks(l.id)
  assert.equal(new Date(m.last_inbound_at).toISOString(), spoke)
})

test('a message inserted outside addMessage still moves the mark', async () => {
  // The whole reason this lives in the database: an importer, a backfill, a fixture
  // writing a conversation directly cannot forget to do it.
  const l = await lead('Direct Deepa')
  await insertRaw(l.id, 'agent', 'following up on your enquiry', iso(2 * HOUR))
  assert.ok((await marks(l.id)).last_outbound_at, 'the raw INSERT maintained the mark')
})

test('a backdated arrival never drags a mark backwards', async () => {
  // Messages arrive out of order — a webhook retried, a batch replayed. The newest
  // message in each direction is the mark, whichever order the rows land in.
  const l = await lead('Late Lakshmi')
  await addMessage(l.id, 'buyer', 'today')
  const now = (await marks(l.id)).last_inbound_at

  await insertRaw(l.id, 'buyer', 'sent last week, delivered now', iso(7 * DAY))
  assert.deepEqual((await marks(l.id)).last_inbound_at, now, 'the older message did not win')
})

test('correcting a message re-derives the mark, in whichever direction it moves', async () => {
  // The append path can only push a mark forward. Editing history has to be able to
  // pull it back, or a corrected timestamp would leave the lead claiming a
  // conversation that no longer exists.
  const l = await lead('Corrected Chirag')
  await addMessage(l.id, 'buyer', 'call me')
  await query(`UPDATE messages SET created_at = now() - interval '30 days' WHERE lead_id = $1`, [l.id])

  const aged = await marks(l.id)
  assert.ok(Date.now() - new Date(aged.last_inbound_at).getTime() > 29 * DAY, 'the mark aged with the message')

  await query(`UPDATE messages SET created_at = now() - interval '1 hour' WHERE lead_id = $1`, [l.id])
  const restored = await marks(l.id)
  assert.ok(Date.now() - new Date(restored.last_inbound_at).getTime() < 2 * HOUR, 'and came forward again')
})

test('re-deriving reads the newest message left, not the one that changed', async () => {
  // Backdating the older of two messages must leave the mark on the newer one.
  const l = await lead('Pair Parveen')
  const older = await insertRaw(l.id, 'buyer', 'first', iso(2 * HOUR))
  await insertRaw(l.id, 'buyer', 'second', iso(1 * HOUR))
  const before = await marks(l.id)

  await query(`UPDATE messages SET created_at = now() - interval '9 days' WHERE id = $1`, [older.rows[0].id])
  assert.deepEqual((await marks(l.id)).last_inbound_at, before.last_inbound_at, 'the newer message still holds the mark')
})

test('a message moved to another lead updates both leads', async () => {
  const from = await lead('Misfiled Mira')
  const to = await lead('Rightful Rohit')
  const m = await insertRaw(from.id, 'buyer', 'wrong thread', iso(1 * HOUR))
  assert.ok((await marks(from.id)).last_inbound_at)

  await query('UPDATE messages SET lead_id = $1 WHERE id = $2', [to.id, m.rows[0].id])
  assert.equal((await marks(from.id)).last_inbound_at, null, 'the lead it left has nothing left to show')
  assert.ok((await marks(to.id)).last_inbound_at, 'the lead it landed on now does')
})

test('removing the only message clears the mark rather than stranding it', async () => {
  const l = await lead('Retracted Ravi')
  const m = await insertRaw(l.id, 'buyer', 'sent by mistake', iso(1 * HOUR))
  assert.ok((await marks(l.id)).last_inbound_at)

  await query('DELETE FROM messages WHERE id = $1', [m.rows[0].id])
  assert.deepEqual(await marks(l.id), { last_inbound_at: null, last_outbound_at: null })
})

// --- The two shared predicates ---------------------------------------------

// Ask the awaiting-reply question the way every caller asks it.
const awaiting = async (leadId) =>
  (await query(`SELECT ${AWAITING_REPLY} AS yes FROM leads l WHERE l.id = $1`, [leadId])).rows[0].yes

test('a lead is awaiting a reply only while the buyer has the last word', async () => {
  const l = await lead('Waiting Wasim')
  assert.equal(await awaiting(l.id), false, 'a lead nobody has spoken to is not waiting on us')

  await insertRaw(l.id, 'agent', 'checking in', iso(3 * HOUR))
  assert.equal(await awaiting(l.id), false, 'nor is one we spoke to first')

  await insertRaw(l.id, 'buyer', 'yes, interested', iso(2 * HOUR))
  assert.equal(await awaiting(l.id), true, 'their reply is now the last word')

  await insertRaw(l.id, 'agent', 'great — Saturday at 11?', iso(1 * HOUR))
  assert.equal(await awaiting(l.id), false, 'and answering it settles the question')
})

test('two messages at the same instant count as answered', async () => {
  // A tie is the one case the predicate has to decide by fiat. It resolves to
  // answered, so an outbound stamped in the same transaction as the inbound it
  // replies to can never leave the lead stuck on the unanswered list forever.
  const l = await lead('Simultaneous Sameer')
  const at = iso(HOUR)
  await insertRaw(l.id, 'buyer', 'hi', at)
  await insertRaw(l.id, 'agent', 'hello', at)
  assert.equal(await awaiting(l.id), false)
})

test('last contact is the later of the two marks, and null before either exists', async () => {
  const contact = async (leadId) =>
    (await query(`SELECT ${LAST_CONTACT_AT} AS at FROM leads l WHERE l.id = $1`, [leadId])).rows[0].at

  const l = await lead('Quiet Qamar')
  assert.equal(await contact(l.id), null, 'a lead with no messages has never been in contact')

  const older = iso(5 * DAY)
  await insertRaw(l.id, 'buyer', 'five days ago', older)
  assert.equal(new Date(await contact(l.id)).toISOString(), older, 'one mark is the answer while it is the only one')

  const newer = iso(2 * DAY)
  await insertRaw(l.id, 'agent', 'two days ago', newer)
  assert.equal(new Date(await contact(l.id)).toISOString(), newer, 'the later of the two wins')
})

// --- What the screens do with them ------------------------------------------

test('the unanswered widget lists exactly the leads whose last word was the buyer’s', async () => {
  const agent = await createAgent('Widget Wahid', '+919852000900', null, 'x'.repeat(60))
  const mk = async (waId, name) => upsertLead(agent.id, waId, name)

  const waiting = await mk('919852000901', 'Waiting Wanda')
  await addMessage(waiting.id, 'buyer', 'what is the carpet area?')

  const answered = await mk('919852000902', 'Answered Anand')
  await addMessage(answered.id, 'buyer', 'price?')
  await addMessage(answered.id, 'agent', '1.2 Cr all-in')

  const silent = await mk('919852000903', 'Silent Sameena')

  const closed = await mk('919852000904', 'Closed Kabir')
  await addMessage(closed.id, 'buyer', 'still thinking')
  await query('UPDATE leads SET closed_at = now() WHERE id = $1', [closed.id])

  const { unanswered } = await dashboard(agent.id)
  assert.deepEqual(unanswered.map((u) => u.name), ['Waiting Wanda'])
  // The widget renders an age timer off last_at, so the message has to come back
  // with the row, not just the fact that there is one.
  assert.equal(unanswered[0].last_msg, 'what is the carpet area?')
  assert.ok(unanswered[0].last_at)
  assert.ok([answered.id, silent.id, closed.id].every((id) => !unanswered.some((u) => u.id === id)))
})

test('the stale rule counts silence in both directions, not just the buyer’s', async () => {
  // A lead we messaged a week ago is not quiet, even though the buyer has said
  // nothing for a month. Deriving this from buyer messages alone would resurface a
  // conversation the agent is already in the middle of.
  const agent = await createAgent('Stale Salim', '+919852000910', null, 'x'.repeat(60))
  const mk = async (waId, name) => {
    const l = await upsertLead(agent.id, waId, name)
    await query(`UPDATE leads SET stage = 'Contacted', temp = 'Warm' WHERE id = $1`, [l.id])
    return l
  }

  const quiet = await mk('919852000911', 'Gone Gauri')
  await insertRaw(quiet.id, 'buyer', 'let me discuss at home', iso(40 * DAY))

  const chased = await mk('919852000912', 'Chased Chetan')
  await insertRaw(chased.id, 'buyer', 'let me discuss at home', iso(40 * DAY))
  await insertRaw(chased.id, 'agent', 'any thoughts on the 3BHK?', iso(6 * DAY))

  const never = await mk('919852000913', 'Never Neha')

  const { items } = await worklist(agent.id)
  const stale = items.filter((i) => i.type === 'stale_lead').map((i) => i.title).sort()
  assert.deepEqual(stale, ['Gone Gauri', 'Never Neha'])
  assert.ok(!stale.includes('Chased Chetan'), 'a lead we chased last week is not stale')
  // A lead nobody has ever messaged is stale by definition, and its card has no
  // recency to show — the ranking has to tolerate that rather than sort on NaN.
  assert.equal(items.find((i) => i.title === 'Never Neha').recency_at, null)
})
