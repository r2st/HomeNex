// The worklist is the screen an agent opens first every morning, and it is built
// from eight independent signals. queryBatching.test.js proves three of them still
// surface after the fan-out refactor; this file gives each of the eight its own
// lead, so every builder runs and none of them can quietly stop firing.
//
// One lead per signal also keeps the assertions honest: the stale-lead rule
// deliberately suppresses leads already surfaced by two of the other rules, which
// only shows up when the signals don't overlap.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('worklistitems')

await import('../index.js')
const {
  closePool, query, createAgent, upsertLead, addMessage, worklist,
  createProperty, recordPropertyView, createSiteVisit, createFollowup, createCommission,
} = await import('../db.js')

let agentId
let items, counts
const byType = (type) => items.filter((i) => i.type === type)
const titled = (type) => byType(type).map((i) => i.title).sort()

const ago = (ms) => new Date(Date.now() - ms).toISOString()
const HOUR = 3600_000
const DAY = 24 * HOUR

// A lead with no message at all is stale by definition — silent for 14 days is
// trivially true of one that has never spoken. Every lead below therefore gets a
// recent buyer message, so it only carries the one signal it was seeded for. The
// message is from the buyer, which leaves the "gone quiet after a visit" rule
// (agent/ai messages only) free to fire.
const lead = async (waId, name) => {
  const l = await upsertLead(agentId, waId, name)
  await addMessage(l.id, 'buyer', 'hello')
  return l
}

before(async () => {
  const agent = await createAgent('Worklist Wasim', '+919850000001', null, 'x'.repeat(60))
  agentId = agent.id
  const property = await createProperty(agentId, { title: 'Worklist Towers', locality: 'Baner', city: 'Pune' })

  // 1. Service window closing: her one message came in 21h ago, so ~3h of the 24h
  // is left. Backdating the message is all it takes — the lead's last_inbound_at
  // follows it, which is the property the stale rule now leans on.
  const closing = await lead('919851000001', 'Closing Chandni')
  await query(`UPDATE messages SET created_at = now() - interval '21 hours' WHERE lead_id = $1`, [closing.id])

  // 2. Site visit inside 48h and not yet confirmed.
  const soon = await lead('919851000002', 'Soon Sohail')
  await createSiteVisit(agentId, {
    lead_id: soon.id, property_id: property.id,
    scheduled_at: new Date(Date.now() + 20 * HOUR).toISOString(),
  })

  // 3. Hot lead whose last message is the buyer's — waiting on a reply.
  const hot = await lead('919851000003', 'Hot Hema')
  await query(`UPDATE leads SET effective_temp = 'Hot', effective_score = 91 WHERE id = $1`, [hot.id])

  // 4. Overdue follow-up.
  const overdue = await lead('919851000004', 'Overdue Omkar')
  await createFollowup(agentId, { lead_id: overdue.id, due_at: ago(2 * DAY), note: 'send the floor plan' })

  // 5. Micro-page re-opened: two attributed views inside 24h.
  const reopened = await lead('919851000005', 'Reopen Reena')
  await recordPropertyView(property.id, 'wa', reopened.id)
  await recordPropertyView(property.id, 'wa', reopened.id)

  // 6. Visited 4 days ago and nothing sent since.
  const quiet = await lead('919851000006', 'Quiet Qadir')
  const visit = await createSiteVisit(agentId, { lead_id: quiet.id, scheduled_at: ago(4 * DAY) })
  await query(`UPDATE site_visits SET status = 'completed' WHERE id = $1`, [visit.id])

  // 7. Commission past its payout date.
  const owed = await lead('919851000007', 'Owed Osman')
  await createCommission(agentId, {
    lead_id: owed.id, deal_value_paise: 60_000_000, commission_pct: 2,
    expected_payout_date: '2020-01-01', status: 'expected',
  })

  // 8. Stale: in an active stage, not Hot, silent for well over a fortnight.
  const stale = await lead('919851000008', 'Stale Sneha')
  await query(`UPDATE messages SET created_at = now() - interval '30 days' WHERE lead_id = $1`, [stale.id])
  await query(`UPDATE leads SET stage = 'Contacted', temp = 'Warm' WHERE id = $1`, [stale.id])
  ;({ items, counts } = await worklist(agentId))
})

after(async () => {
  await closePool()
  await dropTestDb(dbName)
})

test('every one of the eight signals produces its item', async () => {
  assert.deepEqual(titled('service_window_closing'), ['Closing Chandni'])
  assert.deepEqual(titled('site_visit_soon'), ['Soon Sohail'])
  assert.deepEqual(titled('hot_lead_waiting'), ['Hot Hema'])
  assert.deepEqual(titled('overdue_followup'), ['Overdue Omkar'])
  assert.deepEqual(titled('micro_page_reopened'), ['Reopen Reena'])
  assert.deepEqual(titled('site_visit_no_followup'), ['Quiet Qadir'])
  assert.deepEqual(titled('commission_overdue'), ['Owed Osman'])
  assert.deepEqual(titled('stale_lead'), ['Stale Sneha'])
})

test('a re-opened page says how many times, so the agent knows why it surfaced', async () => {
  assert.match(byType('micro_page_reopened')[0].reason, /2× in the last day/)
})

test('a lead that went quiet after a visit is chased on the visit, not the silence', async () => {
  const item = byType('site_visit_no_followup')[0]
  assert.match(item.reason, /Visited but you.{1,3}ve gone quiet since/)
  // Ranked on when the visit happened, which is what makes it urgent.
  assert.ok(new Date(item.recency_at).getTime() < Date.now() - 3 * DAY)
})

test('a single reply after the visit takes the lead off the quiet list', async () => {
  const quiet = (await query(`SELECT id FROM leads WHERE wa_id = '919851000006'`)).rows[0]
  await addMessage(quiet.id, 'agent', 'How did you find the flat?')
  const after = await worklist(agentId)
  assert.deepEqual(after.items.filter((i) => i.type === 'site_visit_no_followup'), [])
})

test('the counts roll up exactly the items that were returned', async () => {
  assert.equal(Object.values(counts.by_type).reduce((a, b) => a + b, 0), items.length)
  assert.equal(Object.values(counts.by_priority).reduce((a, b) => a + b, 0), items.length)
  assert.equal(counts.by_type.micro_page_reopened, 1)
  assert.equal(counts.by_type.site_visit_no_followup, 1)
})

// A lead used to be able to appear as both a closing service window and a stale
// lead, and the stale rule dropped the duplicate afterwards. It can't any more:
// both rules read the same two columns, and a message 21h ago is not silence. These
// two tests hold the exclusivity in place from either end, so the dropped filter
// can't quietly become necessary again.
test('a lead inside its service window is never also called stale', async () => {
  const chandni = items.filter((i) => i.title === 'Closing Chandni')
  assert.deepEqual(chandni.map((i) => i.type), ['service_window_closing'])
})

test('a hot lead gone quiet is chased as hot, not filed as stale', async () => {
  // Hema last spoke a month ago and has never been answered: silent long enough for
  // the stale rule, but Hot, which is the one temperature that rule skips.
  const hema = (await query(`SELECT id FROM leads WHERE wa_id = '919851000003'`)).rows[0]
  await query(`UPDATE messages SET created_at = now() - interval '30 days' WHERE lead_id = $1`, [hema.id])
  const after = await worklist(agentId)
  const hers = after.items.filter((i) => i.title === 'Hot Hema')
  assert.deepEqual(hers.map((i) => i.type), ['hot_lead_waiting'])
})
