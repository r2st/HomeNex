// What the data layer does with a number, a name or a search term that isn't one.
//
// Every paged and windowed reader in db.js opens with the same one-liner:
//
//   const size = Math.min(Math.max(1, Number(limit) || 100), 500)
//
// Three guards in one expression, and they exist because the values reaching them
// come off a query string: `?limit=abc`, `?limit=0`, `?limit=999999`, `?page=-1`.
// The route layer bounds what an agent can POST (numberLimits.test.js), but these
// readers are also called with defaults from the scheduler and the admin portal, so
// the clamp is the last thing standing between a typo and a query that reads the
// whole table. Only the ordinary path — a sensible number, already in range — has
// been exercised, which leaves the guards themselves untested.
//
// The same shape covers the text side: `String(x ?? '').trim()` in front of a search
// term, a name, a note, a property title. Blank has to mean "no filter", not "match
// the empty string", and a title made entirely of punctuation has to still produce a
// usable URL slug.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('inputbounds')

const {
  ready,
  closePool,
  query,
  upsertLead,
  listLeads,
  listAgentsAdmin,
  listAllAuditLogs,
  listLeadSourceEvents,
  teamStaleLeads,
  createProperty,
  getPropertyBySlug,
  addContact,
  addLeadNote,
  createAgent,
  createTeam,
  setLeadStage,
  listDeals,
} = await import('../db.js')

await ready

let agentId
let leadId

const newAgentId = async (name, phone) => (await createAgent(name, phone, null, 'x')).id

before(async () => {
  agentId = await newAgentId('Bounds Bhavna', '+919800000201')
  leadId = (await upsertLead(agentId, '919777700201', 'Limit Lakshmi')).id
})

after(async () => {
  await closePool()
  await dropTestDb(dbName)
})

// --- Numbers that aren't numbers ------------------------------------------------

test('a non-numeric page size falls back to the default instead of NULL', async () => {
  // `Number('abc')` is NaN, and NaN reaches the query as a NULL LIMIT — which
  // postgres reads as "no limit at all". The `|| 20` is what keeps a typo in an admin
  // URL from selecting every agent on the platform.
  for (let i = 0; i < 25; i++) await newAgentId(`Filler ${i}`, `+9198000012${String(i).padStart(2, '0')}`)

  const { agents } = await listAgentsAdmin({ pageSize: 'twenty' })

  assert.equal(agents.length, 20)
})

test('a page size of zero or below is raised to one, not left empty', async () => {
  const zero = await listAgentsAdmin({ pageSize: 0 })
  const negative = await listAgentsAdmin({ pageSize: -5 })

  // 0 is falsy, so `|| 20` catches it; -5 is truthy and only Math.max saves it. Both
  // are asserted because they take different routes through the same expression.
  assert.equal(zero.agents.length, 20)
  assert.equal(negative.agents.length, 1)
})

test('a page size past the cap is clamped to it', async () => {
  const { agents, total } = await listAgentsAdmin({ pageSize: 5000 })

  assert.ok(total > 20, 'fixture should have more agents than one default page')
  assert.ok(agents.length <= 100, `expected at most 100 rows, got ${agents.length}`)
})

test('a page number below one is treated as the first page', async () => {
  const first = await listAgentsAdmin({ page: 1, pageSize: 3 })
  const zero = await listAgentsAdmin({ page: 0, pageSize: 3 })
  const nonsense = await listAgentsAdmin({ page: 'first', pageSize: 3 })

  // A page of 0 would compute a negative OFFSET, which postgres rejects outright.
  assert.deepEqual(zero.agents.map((a) => a.id), first.agents.map((a) => a.id))
  assert.deepEqual(nonsense.agents.map((a) => a.id), first.agents.map((a) => a.id))
})

test('the audit log limit falls back and clamps the same way', async () => {
  for (let i = 0; i < 4; i++) {
    await query(
      `INSERT INTO audit_logs (agent_id, entity_type, entity_id, action, details) VALUES ($1, 'lead', $2, 'test.event', $3)`,
      [agentId, leadId, JSON.stringify({ entry: i })],
    )
  }

  assert.equal((await listAllAuditLogs(2)).length, 2)
  assert.ok((await listAllAuditLogs('all')).length >= 4, 'a non-numeric limit must not return nothing')
  assert.ok((await listAllAuditLogs(0)).length >= 1, 'a zero limit must not return nothing')
  assert.ok((await listAllAuditLogs(10_000)).length <= 500)
})

test('the lead-source event limit falls back and clamps the same way', async () => {
  for (let i = 0; i < 3; i++) {
    await query(
      `INSERT INTO lead_source_events (agent_id, channel, status, raw) VALUES ($1, 'portal_email', 'received', '{}')`,
      [agentId],
    )
  }

  assert.equal((await listLeadSourceEvents(agentId, { limit: 2 })).length, 2)
  assert.equal((await listLeadSourceEvents(agentId, { limit: 'lots' })).length, 3)
  assert.equal((await listLeadSourceEvents(agentId, { limit: 0 })).length, 3)
})

test('a stale-lead window of zero days still means at least one', async () => {
  // `days` reaches this straight off `?days=`. Zero would mean "idle for longer than
  // 0 days" — every open lead in the team, including the one touched a second ago.
  const teamOwner = await newAgentId('Team Tara', '+919800000202')
  const team = await createTeam(teamOwner, 'Bounds Realty')
  const fresh = await upsertLead(teamOwner, '919777700202', 'Fresh Farhan')
  await query(`UPDATE leads SET team_id = $1 WHERE id = $2`, [team.id, fresh.id])

  assert.deepEqual(await teamStaleLeads(team.id, 0), [], 'a lead touched just now is not stale')
  assert.deepEqual(await teamStaleLeads(team.id, 'three'), [])

  // And the window is real: age the lead past it and it appears.
  await query(`UPDATE leads SET updated_at = now() - interval '5 days' WHERE id = $1`, [fresh.id])
  assert.equal((await teamStaleLeads(team.id, 0)).length, 1)
})

// --- Text that isn't text -------------------------------------------------------

test('a blank search term filters nothing rather than matching nothing', async () => {
  const all = await listLeads(agentId)

  // undefined, null and "   " all have to mean "the agent typed nothing yet" — the
  // state the search box is in every time a screen mounts.
  assert.equal((await listLeads(agentId, { search: undefined })).length, all.length)
  assert.equal((await listLeads(agentId, { search: null })).length, all.length)
  assert.equal((await listLeads(agentId, { search: '   ' })).length, all.length)
  // A term that IS something still filters, so the guard above isn't just disabling search.
  assert.equal((await listLeads(agentId, { search: 'Lakshmi' })).length, 1)
  assert.equal((await listLeads(agentId, { search: 'Nobody By This Name' })).length, 0)
})

test('a property titled only in punctuation still gets a usable slug', async () => {
  // The slug is the public micro-page URL. Slugifying "—— ***" leaves an empty
  // string, and a page at `/p/-a1b2c3` reads as broken; the `|| 'property'` fallback
  // is what keeps the link shareable.
  const prop = await createProperty(agentId, { title: '—— *** ——', property_type: 'plot' })

  assert.match(prop.micro_page_slug, /^property-[a-z0-9]{6}$/)
  // And it resolves — a slug nothing can look up would be worse than an ugly one.
  assert.equal((await getPropertyBySlug(prop.micro_page_slug))?.id, prop.id)
})

test('a note that is only whitespace is refused, not stored blank', async () => {
  await assert.rejects(() => addLeadNote(leadId, agentId, '   \n\t '), /note body is required/i)
  await assert.rejects(() => addLeadNote(leadId, agentId, null), /note body is required/i)
})

test('a contact with no real name or number is refused with the reason', async () => {
  // Two separate guards, and the messages are what the agent sees on the Quick-add
  // form — so the test asserts WHICH one fired, not just that something did.
  await assert.rejects(() => addContact(agentId, '12345', 'Short Number'), /valid phone number/i)
  await assert.rejects(() => addContact(agentId, '+919777700299', '   '), /name is required/i)
  await assert.rejects(() => addContact(agentId, '+919777700299', null), /name is required/i)
})

test('an agent signing up with a too-short WhatsApp number is refused', async () => {
  await assert.rejects(
    () => createAgent('Stubby Sanjay', '+919800000203', null, 'x', '12345'),
    /valid WhatsApp Business number/i,
  )
})

// --- The rental half of deal capture --------------------------------------------

test('a rental lead reaching booking captures rent, not a sale value', async () => {
  // captureDealForLead splits on pipeline_type twice — once for the deal type, once
  // to decide whether the number it found is a flat value or a monthly rent. Only the
  // sale side had been exercised, so a rental deal's money went untested end to end.
  const rentalAgent = await newAgentId('Rental Rekha', '+919800000204')
  const lead = await upsertLead(rentalAgent, '919777700204', 'Renter Ramesh')
  await query(`UPDATE leads SET pipeline_type = 'rental', budget_max = 4500000 WHERE id = $1`, [lead.id])

  const property = await createProperty(rentalAgent, { title: 'Baner Rental 2BHK', price_paise: 5000000 })
  await query(
    `INSERT INTO site_visits (agent_id, lead_id, property_id, scheduled_at) VALUES ($1, $2, $3, now())`,
    [rentalAgent, lead.id, property.id],
  )

  await setLeadStage(lead.id, rentalAgent, { stage: 'Deposit/Token' })
  const [deal] = await listDeals(rentalAgent)

  assert.equal(deal.deal_type, 'rental')
  assert.equal(Number(deal.monthly_rent_paise), 5000000, "the visited property's rent")
  assert.equal(deal.deal_value_paise, null, 'a rental has no flat deal value')
})

test('a rental lead with no property falls back to the buyer′s own budget', async () => {
  const rentalAgent = await newAgentId('Budget Bina', '+919800000205')
  const lead = await upsertLead(rentalAgent, '919777700205', 'Budget Bala')
  await query(`UPDATE leads SET pipeline_type = 'rental', budget_max = 3200000 WHERE id = $1`, [lead.id])

  await setLeadStage(lead.id, rentalAgent, { stage: 'Deposit/Token' })
  const [deal] = await listDeals(rentalAgent)

  assert.equal(deal.property_id, null)
  assert.equal(Number(deal.monthly_rent_paise), 3200000)
  assert.equal(deal.deal_value_paise, null)
})

test('a rental lead with neither property nor budget captures a deal anyway', async () => {
  // The last arm of both ternaries. A deal with no number is still a deal the agent
  // needs in their ledger — dropping it would lose the booking entirely.
  const rentalAgent = await newAgentId('Blank Bipin', '+919800000206')
  const lead = await upsertLead(rentalAgent, '919777700206', 'Blank Bhavesh')
  await query(`UPDATE leads SET pipeline_type = 'rental' WHERE id = $1`, [lead.id])

  await setLeadStage(lead.id, rentalAgent, { stage: 'Deposit/Token' })
  const [deal] = await listDeals(rentalAgent)

  assert.ok(deal, 'the deal is captured even with nothing to value it at')
  assert.equal(deal.monthly_rent_paise, null)
  assert.equal(deal.deal_value_paise, null)
})
