// Cross-tenant foreign references.
//
// Deals, commissions and site visits all accept an id that points at another of
// the agent's rows (a property, a deal). The owning row is always written with
// the caller's agent_id so it can't be stolen — but the id it points AT came from
// the client, and these ids are sequential integers, so an agent could point at a
// row belonging to somebody else and read the joined columns back out. That leaked
// property titles and builder names across workspaces; for site visits it could
// also put another agent's property title into a buyer-facing WhatsApp reminder.
//
// Writes are now rejected, and the joins are constrained as well so a row written
// before the fix still can't leak.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('crosstenant')

const { app } = await import('../index.js')
const {
  closePool, query, upsertLead, createProperty, createDeal, createSiteVisit,
  listDeals, getDeal, listSiteVisits, builderReceivables,
} = await import('../db.js')

let server, base
// "mine" is the attacker; "theirs" is the victim whose data must not leak.
const mine = {}
const theirs = {}

const req = (method, url, body, tok) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

async function signup(into, name, phone) {
  const out = await (await req('POST', '/api/auth/signup', { name, phone, password: 'secret123' })).json()
  into.token = out.token
  into.agentId = out.agent.id
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  await signup(mine, 'Attacker Agent', '+919800000701')
  await signup(theirs, 'Victim Agent', '+919800000702')

  mine.lead = await upsertLead(mine.agentId, '919800070001', 'My Buyer')
  theirs.lead = await upsertLead(theirs.agentId, '919800070002', 'Their Buyer')

  mine.property = await createProperty(mine.agentId, { title: 'My Tower', locality: 'Whitefield', city: 'Bengaluru' })
  theirs.property = await createProperty(theirs.agentId, {
    title: 'SECRET Victim Tower',
    locality: 'Koramangala',
    city: 'Bengaluru',
  })
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

test('a deal cannot be created against another agent property', async () => {
  const res = await req('POST', '/api/deals', {
    lead_id: mine.lead.id,
    property_id: theirs.property.id,
    deal_value_paise: 1_000_000,
  }, mine.token)
  assert.equal(res.status, 404)
  assert.match((await res.json()).error, /property not found/)
})

test('the refusal does not reveal whether the property exists', async () => {
  const missing = await req('POST', '/api/deals', {
    lead_id: mine.lead.id, property_id: 999_999, deal_value_paise: 1,
  }, mine.token)
  const notMine = await req('POST', '/api/deals', {
    lead_id: mine.lead.id, property_id: theirs.property.id, deal_value_paise: 1,
  }, mine.token)
  assert.equal(missing.status, notMine.status)
  assert.deepEqual(await missing.json(), await notMine.json())
})

test('a deal can still be created against my own property', async () => {
  const res = await req('POST', '/api/deals', {
    lead_id: mine.lead.id, property_id: mine.property.id, deal_value_paise: 5_000_000,
  }, mine.token)
  assert.equal(res.status, 200)
  const deal = await res.json()
  assert.equal(deal.property_id, mine.property.id)
  mine.deal = deal
})

test('a deal cannot be repointed at another agent property by update', async () => {
  const res = await req('PUT', `/api/deals/${mine.deal.id}`, { property_id: theirs.property.id }, mine.token)
  assert.equal(res.status, 404)

  const after = await (await req('GET', `/api/deals/${mine.deal.id}`, undefined, mine.token)).json()
  assert.equal(after.property_id, mine.property.id, 'still points at my own property')
  assert.equal(after.property_title, 'My Tower')
})

test('a commission cannot be attached to another agent deal', async () => {
  const theirDeal = await createDeal(theirs.agentId, { lead_id: theirs.lead.id, deal_value_paise: 100 })
  const res = await req('POST', '/api/commissions', {
    lead_id: mine.lead.id, deal_id: theirDeal.id, commission_pct: 2,
  }, mine.token)
  assert.equal(res.status, 404)
  assert.match((await res.json()).error, /deal not found/)
  theirs.deal = theirDeal
})

test('a commission cannot be repointed at another agent deal by update', async () => {
  const ok = await (await req('POST', '/api/commissions', {
    lead_id: mine.lead.id, deal_id: mine.deal.id, commission_pct: 2, payer_type: 'builder',
  }, mine.token)).json()

  const res = await req('PUT', `/api/commissions/${ok.id}`, { deal_id: theirs.deal.id }, mine.token)
  assert.equal(res.status, 404)
})

test('a site visit cannot be repointed at another agent property by update', async () => {
  const visit = await (await req('POST', '/api/site-visits', {
    lead_id: mine.lead.id,
    scheduled_at: new Date(Date.now() + 86_400_000).toISOString(),
  }, mine.token)).json()

  const res = await req('PUT', `/api/site-visits/${visit.id}`, { property_id: theirs.property.id }, mine.token)
  assert.equal(res.status, 404)

  const visits = await listSiteVisits(mine.agentId, { leadId: mine.lead.id })
  assert.equal(visits.every((v) => v.property_id !== theirs.property.id), true)
})

test('a foreign property id smuggled straight into the table still does not leak on read', async () => {
  // Defence in depth: write the bad reference behind the API's back, exactly as a
  // row created before the fix would look, and confirm the joins refuse to resolve it.
  // deals.lead_id is unique, so this needs a lead of its own.
  const lead = await upsertLead(mine.agentId, '919800070003', 'Smuggle Buyer')
  const deal = await createDeal(mine.agentId, { lead_id: lead.id, deal_value_paise: 1 })
  await query('UPDATE deals SET property_id = $1 WHERE id = $2', [theirs.property.id, deal.id])

  const one = await getDeal(deal.id, mine.agentId)
  assert.equal(one.property_title, null, 'no title from the other workspace')

  const all = await listDeals(mine.agentId)
  assert.equal(all.every((d) => d.property_title !== 'SECRET Victim Tower'), true)

  const overHttp = await (await req('GET', `/api/deals/${deal.id}`, undefined, mine.token)).json()
  assert.notEqual(overHttp.property_title, 'SECRET Victim Tower')
})

test('a smuggled foreign deal id does not leak a builder name into receivables', async () => {
  await query(`UPDATE deals SET builder_name = 'SECRET Victim Builder' WHERE id = $1`, [theirs.deal.id])
  const { rows } = await query(
    `INSERT INTO commissions (lead_id, agent_id, payer_type, status, commission_flat_paise)
     VALUES ($1, $2, 'builder', 'expected', 50000) RETURNING id`,
    [mine.lead.id, mine.agentId],
  )
  await query('UPDATE commissions SET deal_id = $1 WHERE id = $2', [theirs.deal.id, rows[0].id])

  const report = await builderReceivables(mine.agentId)
  const names = (report.builders ?? report.rows ?? []).map((b) => b.builder_name)
  assert.equal(names.includes('SECRET Victim Builder'), false, 'victim builder name not surfaced')
})

test('a smuggled foreign property id does not leak into a site-visit reminder', async () => {
  const visit = await createSiteVisit(mine.agentId, {
    lead_id: mine.lead.id,
    scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
  })
  await query('UPDATE site_visits SET property_id = $1 WHERE id = $2', [theirs.property.id, visit.id])

  const visits = await listSiteVisits(mine.agentId, { leadId: mine.lead.id })
  const smuggled = visits.find((v) => v.id === visit.id)
  assert.equal(smuggled.property_title, null)
  assert.equal(smuggled.property_locality, null)
})

test('the victim still sees their own property normally', async () => {
  const lead = await upsertLead(theirs.agentId, '919800070004', 'Victim Buyer 2')
  const theirDeal = await createDeal(theirs.agentId, {
    lead_id: lead.id, property_id: theirs.property.id, deal_value_paise: 10,
  })
  const row = await getDeal(theirDeal.id, theirs.agentId)
  assert.equal(row.property_title, 'SECRET Victim Tower', 'the constraint did not break the legitimate join')
})
