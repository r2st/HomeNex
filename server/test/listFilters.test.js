// Every list function in db.js builds its WHERE clause from optional arguments.
// The happy-path suites call them bare, so the filter arms — and, more importantly,
// the $n parameter numbering that shifts as each one is appended — have never run.
// A mis-numbered placeholder here doesn't throw; it silently filters on the wrong
// value, so each case below asserts on which rows come back, not just on a 200.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb, pinVisitToToday } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('listfilters')

await import('../index.js')
const {
  closePool, query, upsertLead, addContact, listContacts,
  createSiteVisit, listSiteVisits, createDeal, listDeals,
  createCommission, createCommissionInvoice, listCommissionInvoices,
  resolveSegment, createAgent, createTeam, teamLeads,
} = await import('../db.js')

let agentId, mate
let leadA, leadB
const names = (rows) => rows.map((r) => r.name).sort()

before(async () => {
  const agent = await createAgent('Filter Farhan', '+919840000001', null, 'x'.repeat(60))
  agentId = agent.id
  leadA = await upsertLead(agentId, '919841000001', 'Wakad Waman')
  leadB = await upsertLead(agentId, '919841000002', 'Baner Bina')
})

after(async () => {
  await closePool()
  await dropTestDb(dbName)
})

// --- listContacts: search and source ------------------------------------------

test('contacts filter by search text and by source, together and apart', async () => {
  await addContact(agentId, '+919841000001', 'Wakad Waman')
  await addContact(agentId, '+919841000002', 'Baner Bina')
  await query(`UPDATE contacts SET source = 'referral' WHERE phone = '+919841000002'`)
  await query(`UPDATE contacts SET source = 'walk_in' WHERE phone = '+919841000001'`)

  assert.deepEqual(names(await listContacts(agentId, {})), ['Baner Bina', 'Wakad Waman'])
  assert.deepEqual(names(await listContacts(agentId, { search: 'Waman' })), ['Wakad Waman'])
  assert.deepEqual(names(await listContacts(agentId, { source: 'referral' })), ['Baner Bina'])
  // Both filters at once — the second placeholder must still be $3, not $2.
  assert.deepEqual(names(await listContacts(agentId, { search: 'Bina', source: 'referral' })), ['Baner Bina'])
  assert.deepEqual(await listContacts(agentId, { search: 'Bina', source: 'walk_in' }), [])
})

// --- listSiteVisits: lead, status and today -----------------------------------

test('site visits filter by lead, by status and by "today"', async () => {
  const soon = new Date(Date.now() + 2 * 3600_000).toISOString()
  const later = new Date(Date.now() + 40 * 24 * 3600_000).toISOString()
  const visitA = await createSiteVisit(agentId, { lead_id: leadA.id, scheduled_at: soon })
  const visitB = await createSiteVisit(agentId, { lead_id: leadB.id, scheduled_at: later })
  await query(`UPDATE site_visits SET status = 'completed' WHERE id = $1`, [visitB.id])
  // now+2h is tomorrow if the suite runs late enough in the agent's evening.
  await pinVisitToToday(query, visitA.id, agentId)

  assert.equal((await listSiteVisits(agentId, {})).length, 2)
  assert.deepEqual((await listSiteVisits(agentId, { leadId: leadA.id })).map((v) => v.id), [visitA.id])
  assert.deepEqual((await listSiteVisits(agentId, { status: 'completed' })).map((v) => v.id), [visitB.id])
  // today only picks up the visit a couple of hours out, not the one next month.
  assert.deepEqual((await listSiteVisits(agentId, { today: true })).map((v) => v.id), [visitA.id])
  // Stacked: lead + status must intersect, not union.
  assert.deepEqual(await listSiteVisits(agentId, { leadId: leadA.id, status: 'completed' }), [])
})

// --- listDeals: status and deal type ------------------------------------------

test('deals filter by status and by deal type', async () => {
  const sale = await createDeal(agentId, { lead_id: leadA.id, deal_type: 'sale', deal_value_paise: 90_000_00 })
  const rental = await createDeal(agentId, { lead_id: leadB.id, deal_type: 'rental', monthly_rent_paise: 45_000_00 })
  await query(`UPDATE deals SET status = 'won' WHERE id = $1`, [rental.id])

  assert.equal((await listDeals(agentId, {})).length, 2)
  assert.deepEqual((await listDeals(agentId, { dealType: 'sale' })).map((d) => d.id), [sale.id])
  assert.deepEqual((await listDeals(agentId, { status: 'won' })).map((d) => d.id), [rental.id])
  assert.deepEqual(await listDeals(agentId, { status: 'won', dealType: 'sale' }), [])
})

// --- listCommissionInvoices: commission and status ----------------------------

test('commission invoices filter by commission and by status', async () => {
  const commissionA = await createCommission(agentId, {
    lead_id: leadA.id, deal_value_paise: 50_000_000, commission_pct: 2, status: 'expected',
  })
  const commissionB = await createCommission(agentId, {
    lead_id: leadB.id, deal_value_paise: 80_000_000, commission_pct: 1, status: 'expected',
  })
  const invoiceA = await createCommissionInvoice(agentId, commissionA.id, {})
  const invoiceB = await createCommissionInvoice(agentId, commissionB.id, {})
  await query(`UPDATE commission_invoices SET status = 'paid' WHERE id = $1`, [invoiceB.id])

  assert.equal((await listCommissionInvoices(agentId, {})).length, 2)
  assert.deepEqual(
    (await listCommissionInvoices(agentId, { commissionId: commissionA.id })).map((i) => i.id),
    [invoiceA.id],
  )
  assert.deepEqual((await listCommissionInvoices(agentId, { status: 'paid' })).map((i) => i.id), [invoiceB.id])
  assert.deepEqual(
    await listCommissionInvoices(agentId, { commissionId: commissionA.id, status: 'paid' }),
    [],
  )
})

// --- resolveSegment: every criterion in segmentWhere --------------------------

test('a dynamic segment narrows on locality, intent, temp and both budget ends', async () => {
  await query(
    `UPDATE leads SET locality = 'Wakad', intent = 'buy', temp = 'Hot',
                      budget_min = 8000000, budget_max = 12000000 WHERE id = $1`,
    [leadA.id],
  )
  await query(
    `UPDATE leads SET locality = 'Baner', intent = 'rent', temp = 'Warm',
                      budget_min = 2000000, budget_max = 3000000 WHERE id = $1`,
    [leadB.id],
  )

  assert.deepEqual(names(await resolveSegment(agentId, {})), ['Baner Bina', 'Wakad Waman'])
  assert.deepEqual(names(await resolveSegment(agentId, { locality: 'Wakad' })), ['Wakad Waman'])
  assert.deepEqual(names(await resolveSegment(agentId, { intent: 'rent' })), ['Baner Bina'])
  assert.deepEqual(names(await resolveSegment(agentId, { temp: 'Hot' })), ['Wakad Waman'])
  // budget_min_paise asks "could afford at least this much" -> leads whose max reaches it.
  assert.deepEqual(names(await resolveSegment(agentId, { budget_min_paise: 5000000 })), ['Wakad Waman'])
  // budget_max_paise asks "starts no higher than this" -> leads whose min is under it.
  assert.deepEqual(names(await resolveSegment(agentId, { budget_max_paise: 2500000 })), ['Baner Bina'])
  // All five at once: the placeholder run must stay in step with the pushed params.
  assert.deepEqual(
    names(await resolveSegment(agentId, {
      locality: 'Wakad', intent: 'buy', temp: 'Hot', budget_min_paise: 5000000, budget_max_paise: 9000000,
    })),
    ['Wakad Waman'],
  )
  assert.deepEqual(await resolveSegment(agentId, { locality: 'Wakad', intent: 'rent' }), [])
})

test('an opted-out contact is never in a segment, however it is filtered', async () => {
  await query(`UPDATE contacts SET opt_in_status = 'opted_out' WHERE phone = '+919841000001'`)
  assert.deepEqual(names(await resolveSegment(agentId, {})), ['Baner Bina'])
  assert.deepEqual(await resolveSegment(agentId, { locality: 'Wakad' }), [])
  await query(`UPDATE contacts SET opt_in_status = 'opted_in' WHERE phone = '+919841000001'`)
})

// --- teamLeads: member, unassigned, stage and pipeline ------------------------

test('the team inbox filters by member, pool, pipeline and stage', async () => {
  mate = await createAgent('Filter Firoza', '+919840000002', null, 'x'.repeat(60))
  const team = await createTeam(agentId, 'Filter Realty')
  await query('INSERT INTO team_members (team_id, agent_id, role) VALUES ($1, $2, $3)', [team.id, mate.id, 'agent'])
  await query(`UPDATE leads SET team_id = $1, pipeline_type = 'buy_primary', stage = 'New' WHERE id = $2`,
    [team.id, leadA.id])
  await query(`UPDATE leads SET team_id = $1, agent_id = $2, pipeline_type = 'rental', stage = 'Visit' WHERE id = $3`,
    [team.id, mate.id, leadB.id])
  const { rows: pooled } = await query(
    `INSERT INTO leads (agent_id, team_id, wa_id, name, pipeline_type, stage)
     VALUES (NULL, $1, 'filter-pool-1', 'Pooled Pari', 'buy_primary', 'New') RETURNING id`,
    [team.id],
  )

  assert.equal((await teamLeads(team.id)).length, 3)
  assert.deepEqual(names(await teamLeads(team.id, { memberId: mate.id })), ['Baner Bina'])
  assert.deepEqual((await teamLeads(team.id, { unassigned: true })).map((l) => l.id), [pooled[0].id])
  // unassigned wins over memberId — they're mutually exclusive by construction.
  assert.deepEqual(
    (await teamLeads(team.id, { unassigned: true, memberId: mate.id })).map((l) => l.id),
    [pooled[0].id],
  )
  assert.deepEqual(names(await teamLeads(team.id, { pipelineType: 'rental' })), ['Baner Bina'])
  assert.deepEqual(names(await teamLeads(team.id, { stage: 'New' })), ['Pooled Pari', 'Wakad Waman'])
  assert.deepEqual(
    names(await teamLeads(team.id, { memberId: mate.id, pipelineType: 'rental', stage: 'Visit' })),
    ['Baner Bina'],
  )
  assert.deepEqual(await teamLeads(team.id, { memberId: mate.id, stage: 'New' }), [])
})
