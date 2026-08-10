// DB-layer tests: schema creation (all CRM tables), seeded pipeline stages,
// and basic CRUD through the db.js functions.
// Run with: npm test  (from server/)  — needs a local PostgreSQL (docker compose up -d).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
const dbName = await createTestDb('dblayer')

const db = await import('../db.js')
const { hashPassword } = await import('../auth.js')

let agent
let lead
let contact

before(async () => {
  await db.ready
  agent = await db.createAgent('Schema Tester', '+919899000001', null, hashPassword('secret123'))
  lead = await db.upsertLead(agent.id, '919899000123', 'Buyer One')
})

after(async () => {
  await db.closePool()
  await dropTestDb(dbName)
})

// === Schema ===

test('migrations create every expected table', async () => {
  const { rows } = await db.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
  )
  const tables = new Set(rows.map((r) => r.table_name))
  for (const t of [
    'schema_migrations',
    'agents',
    'leads',
    'messages',
    'activity',
    'meta',
    'contacts',
    'network_posts',
    'properties',
    'pipeline_stages',
    'site_visits',
    'followups',
    'commissions',
    'message_templates',
    'audit_logs',
  ]) {
    assert.ok(tables.has(t), `table ${t} should exist`)
  }
})

test('migrations are recorded and idempotent', async () => {
  const { rows } = await db.query('SELECT version FROM schema_migrations ORDER BY version')
  assert.ok(rows.length >= 3)
  assert.equal(rows[0].version, '001_initial_schema.sql')
})

test('default pipeline stages are seeded for every pipeline type', async () => {
  const buyPrimary = await db.listPipelineStages('buy_primary')
  const buyResale = await db.listPipelineStages('buy_resale')
  const rental = await db.listPipelineStages('rental')
  assert.equal(buyPrimary.length, 10)
  assert.equal(buyResale.length, 10)
  assert.equal(rental.length, 8)
  assert.equal(buyPrimary[0].stage_name, 'New')
  assert.equal(buyPrimary.at(-1).stage_name, 'Lost')
  assert.equal(rental[5].stage_name, 'Agreement Signed')
  assert.ok(buyPrimary.every((s) => s.is_default === true))
})

// === Contacts (CRM extensions) ===

test('addContact stores CRM source fields and updateContact edits labels/opt-in', async () => {
  contact = await db.addContact(agent.id, '9899000123', 'Buyer One', null, {
    source: 'referral',
    sourceDetail: 'Friend of Ramesh',
  })
  assert.equal(contact.source, 'referral')
  assert.equal(contact.source_detail, 'Friend of Ramesh')
  assert.equal(contact.opt_in_status, 'unknown')
  assert.deepEqual(contact.labels, [])

  const updated = await db.updateContact(contact.id, agent.id, {
    labels: ['nri', 'hot'],
    opt_in_status: 'opted_in',
  })
  assert.deepEqual(updated.labels, ['nri', 'hot'])
  assert.equal(updated.opt_in_status, 'opted_in')
})

test('recordContactMessage stamps first/last message timestamps', async () => {
  await db.recordContactMessage('+919899000123')
  const c = await db.getContact(contact.id, agent.id)
  assert.ok(c.first_message_at, 'first_message_at set')
  assert.ok(c.last_message_at, 'last_message_at set')
  const firstBefore = c.first_message_at
  await db.recordContactMessage('+919899000123')
  const c2 = await db.getContact(contact.id, agent.id)
  assert.equal(String(c2.first_message_at), String(firstBefore), 'first_message_at is sticky')
})

// === Leads (CRM pipeline fields) ===

test('updateLeadCrm sets pipeline fields with paise budgets (integer-safe)', async () => {
  const updated = await db.updateLeadCrm(lead.id, agent.id, {
    contact_id: contact.id,
    pipeline_type: 'buy_primary',
    stage: 'Qualified',
    budget_min: 500_000_000, // ₹50L in paise
    budget_max: 750_000_000, // ₹75L in paise
    bhk: '2BHK',
    property_type: 'apartment',
    preferred_localities: ['Baner', 'Wakad'],
    financing: 'loan',
    ai_score: 'hot',
    ai_score_reason: 'Clear budget, urgent timeline',
  })
  assert.equal(updated.pipeline_type, 'buy_primary')
  assert.equal(updated.stage, 'Qualified')
  assert.equal(updated.budget_min, 500_000_000)
  assert.equal(updated.budget_max, 750_000_000)
  assert.deepEqual(updated.preferred_localities, ['Baner', 'Wakad'])
  assert.equal(updated.ai_score, 'hot')
  assert.equal(updated.contact_id, contact.id)
})

test('updateLeadCrm rejects an invalid pipeline_type via CHECK constraint', async () => {
  await assert.rejects(
    () => db.updateLeadCrm(lead.id, agent.id, { pipeline_type: 'bogus' }),
    /check constraint|pipeline_type/i,
  )
})

test("updateLeadCrm refuses to touch another agent's lead", async () => {
  const other = await db.createAgent('Other Agent', '+919899000002', null, hashPassword('secret123'))
  const res = await db.updateLeadCrm(lead.id, other.id, { stage: 'Lost' })
  assert.equal(res, undefined, 'no row updated for a non-owner')
  const mine = await db.getLead(lead.id)
  assert.equal(mine.stage, 'Qualified')
})

// === Properties ===

let property

test('createProperty stores inventory with jsonb fields and BIGINT price', async () => {
  property = await db.createProperty(agent.id, {
    title: '2BHK in Baner Greens',
    property_type: 'apartment',
    bhk: '2BHK',
    size_sqft: 980,
    price_paise: 85_000_000_000, // ₹8.5Cr in paise — exceeds int4 on purpose
    locality: 'Baner',
    city: 'Pune',
    rera_project_number: 'P52100000001',
    builder_name: 'Green Homes',
    amenities: ['gym', 'pool'],
    photos: ['https://example.com/1.jpg'],
    micro_page_slug: 'baner-greens-2bhk',
  })
  assert.ok(property.id)
  assert.equal(property.price_paise, 85_000_000_000)
  assert.equal(property.status, 'available')
  assert.deepEqual(property.amenities, ['gym', 'pool'])

  const list = await db.listProperties(agent.id)
  assert.equal(list.length, 1)
})

test('updateProperty transitions status and is agent-scoped', async () => {
  const updated = await db.updateProperty(property.id, agent.id, { status: 'token' })
  assert.equal(updated.status, 'token')
  assert.equal((await db.listProperties(agent.id, { status: 'available' })).length, 0)
  await assert.rejects(
    () => db.updateProperty(property.id, agent.id, { status: 'bogus' }),
    /check constraint|status/i,
  )
})

test('micro_page_slug must be unique', async () => {
  await assert.rejects(
    () => db.createProperty(agent.id, { title: 'Dup slug', micro_page_slug: 'baner-greens-2bhk' }),
    /duplicate key|unique/i,
  )
})

// === Site visits ===

let visit

test('createSiteVisit schedules a visit linked to lead and property', async () => {
  visit = await db.createSiteVisit(agent.id, {
    lead_id: lead.id,
    property_id: property.id,
    scheduled_at: new Date(Date.now() + 24 * 3600 * 1000),
    pickup_required: true,
    pickup_location: 'Baner Road, Pune',
  })
  assert.equal(visit.status, 'scheduled')
  assert.equal(visit.pickup_required, true)
  assert.equal((await db.listSiteVisits(agent.id, { leadId: lead.id })).length, 1)
})

test('updateSiteVisit records the outcome', async () => {
  const updated = await db.updateSiteVisit(visit.id, agent.id, {
    status: 'completed',
    outcome_notes: 'Liked the flat, negotiating price',
  })
  assert.equal(updated.status, 'completed')
  assert.equal(updated.outcome_notes, 'Liked the flat, negotiating price')
})

// === Follow-ups ===

test('followups: create, list pending, complete', async () => {
  const f = await db.createFollowup(agent.id, {
    lead_id: lead.id,
    due_at: new Date(Date.now() + 3600 * 1000),
    type: 'no_response',
    note: 'Nudge about site visit feedback',
  })
  assert.equal(f.type, 'no_response')
  assert.equal((await db.listFollowups(agent.id, { pendingOnly: true })).length, 1)

  const done = await db.completeFollowup(f.id, agent.id)
  assert.ok(done.completed_at)
  assert.equal((await db.listFollowups(agent.id, { pendingOnly: true })).length, 0)
  assert.equal((await db.listFollowups(agent.id)).length, 1)
})

// === Commissions ===

test('commissions: create with pct + paise values, update status', async () => {
  const c = await db.createCommission(agent.id, {
    lead_id: lead.id,
    deal_value_paise: 700_000_000, // ₹70L
    commission_pct: 1.5,
    payer_type: 'builder',
    expected_payout_date: '2026-08-15',
  })
  assert.equal(c.status, 'expected')
  assert.equal(c.deal_value_paise, 700_000_000)
  assert.equal(c.commission_pct, 1.5)

  const updated = await db.updateCommission(c.id, agent.id, { status: 'invoiced' })
  assert.equal(updated.status, 'invoiced')
  assert.equal((await db.listCommissions(agent.id, { status: 'invoiced' })).length, 1)
})

// === Message templates ===

test('message templates: create, meta approval status, unique name per agent', async () => {
  // 'custom_reminder' avoids the curated pack names (welcome, site_visit_reminder, …)
  // that seedWorkspaceDefaults now reserves per agent.
  const t = await db.createMessageTemplate(agent.id, {
    name: 'custom_reminder',
    category: 'utility',
    body: 'Hi {{name}}, reminder for your site visit at {{time}}.',
    variables: ['name', 'time'],
    rera_auto_append: true,
  })
  assert.equal(t.meta_status, 'pending')
  assert.deepEqual(t.variables, ['name', 'time'])
  assert.equal(t.rera_auto_append, true)

  const approved = await db.updateMessageTemplate(t.id, agent.id, {
    meta_status: 'approved',
    meta_template_id: 'meta_tpl_001',
  })
  assert.equal(approved.meta_status, 'approved')

  await assert.rejects(
    () => db.createMessageTemplate(agent.id, { name: 'custom_reminder', body: 'dup' }),
    /duplicate key|unique/i,
  )
})

// === Audit log ===

test('audit log records actions with jsonb details', async () => {
  await db.logAudit(agent.id, 'lead', lead.id, 'stage_change', { from: 'New', to: 'Qualified' })
  const logs = await db.listAuditLogs(agent.id)
  assert.equal(logs.length, 1)
  assert.equal(logs[0].entity_type, 'lead')
  assert.deepEqual(logs[0].details, { from: 'New', to: 'Qualified' })
})

// === Legacy behaviour still intact ===

test('meta key/value roundtrip', async () => {
  await db.setMeta('test_key', 'v1')
  assert.equal(await db.getMeta('test_key'), 'v1')
  await db.setMeta('test_key', 'v2')
  assert.equal(await db.getMeta('test_key'), 'v2')
})

test('upsertLead dedupes on (agent_id, wa_id) and keeps the name', async () => {
  const again = await db.upsertLead(agent.id, '919899000123', null)
  assert.equal(again.id, lead.id)
  assert.equal(again.name, 'Buyer One')
})

test('messages flow: addMessage bumps the lead and getMessages returns in order', async () => {
  await db.addMessage(lead.id, 'buyer', 'Hello, looking for 2BHK')
  await db.addMessage(lead.id, 'ai', 'Great! Which locality?')
  const msgs = await db.getMessages(lead.id)
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0].role, 'buyer')
  assert.equal(msgs[1].role, 'ai')
})

test('stats returns numbers (bigint counts parsed)', async () => {
  const s = await db.stats(agent.id)
  assert.equal(typeof s.total, 'number')
  assert.ok(s.total >= 1)
  assert.equal(typeof s.msgsToday, 'number')
  assert.ok(Array.isArray(s.sources))
})

test('stats().hotNow and dashboard().hotLeads follow decayed temp, not the stale AI temp', async () => {
  const other = await db.createAgent('Hot Count Tester', '+919899000099', null, hashPassword('secret123'))
  const hot = await db.upsertLead(other.id, '919899000201', 'Once Hot')
  await db.addMessage(hot.id, 'buyer', 'looking urgently')
  await db.applyExtraction(hot.id, { temp: 'Hot', score: 90 })
  // Silence it: the AI's raw `temp` column stays 'Hot' forever, but the decayed
  // effective_temp should cool — and that's what hotNow/hotLeads must honor.
  await db.query(`UPDATE messages SET created_at = now() - interval '5 days' WHERE lead_id = $1`, [hot.id])
  await db.query(`UPDATE leads SET last_inbound_at = now() - interval '5 days' WHERE id = $1`, [hot.id])
  await db.recomputeLeadScore(hot.id)

  const s = await db.stats(other.id)
  assert.equal(s.hotNow, 0, 'a silent lead must not count as hot just because the AI once said Hot')

  const d = await db.dashboard(other.id)
  assert.equal(d.hotLeads.length, 0)
})

test('normalizePhone canonicalizes Indian numbers', () => {
  assert.equal(db.normalizePhone('9876543210'), '+919876543210')
  assert.equal(db.normalizePhone('+91 98765 43210'), '+919876543210')
  assert.equal(db.normalizePhone('+1 (365) 555-1234'), '+13655551234')
})

// === Auth primitives ===
//
// The failure branches matter more than the happy path here: every one of them is
// what stops a malformed or forged credential from being accepted.

test('verifyPassword accepts the right password and rejects everything else', async () => {
  const { verifyPassword } = await import('../auth.js')
  const stored = hashPassword('correct horse battery')
  assert.equal(verifyPassword('correct horse battery', stored), true)
  assert.equal(verifyPassword('wrong', stored), false)
})

test('verifyPassword returns false (never throws) on a malformed stored hash', async () => {
  const { verifyPassword } = await import('../auth.js')
  // No salt separator, a non-hex hash, and a truncated hash all reach timingSafeEqual
  // with mismatched buffers — that throws, and must be caught into a plain `false`.
  assert.equal(verifyPassword('secret123', 'no-separator-at-all'), false)
  assert.equal(verifyPassword('secret123', 'salt:zzzz'), false)
  assert.equal(verifyPassword('secret123', 'salt:ab'), false)
  assert.equal(verifyPassword('secret123', ':'), false)
})

test('verifyToken rejects missing, malformed and forged tokens', async () => {
  const { issueToken, verifyToken } = await import('../auth.js')
  const good = await issueToken(agent.id)
  assert.equal((await verifyToken(good)).id, agent.id)

  assert.equal(await verifyToken(null), null)
  assert.equal(await verifyToken(''), null)
  assert.equal(await verifyToken('no-dot'), null, 'no signature part')
  assert.equal(await verifyToken(`${agent.id}.`), null, 'empty signature')
  assert.equal(await verifyToken(`.${good.split('.')[1]}`), null, 'empty id')
  // A signature of the right length but the wrong bytes.
  const [id, sig] = good.split('.')
  const flipped = sig[0] === 'a' ? `b${sig.slice(1)}` : `a${sig.slice(1)}`
  assert.equal(await verifyToken(`${id}.${flipped}`), null, 'forged signature')
  // A signature of the WRONG length makes timingSafeEqual throw — caught, not 500.
  assert.equal(await verifyToken(`${id}.abc`), null, 'short signature')
})

test("verifyToken rejects a valid signature over an agent id that doesn't exist", async () => {
  const { issueToken, verifyToken } = await import('../auth.js')
  assert.equal(await verifyToken(await issueToken(9_999_999)), null)
})

test('verifyToken stops working the moment an agent is deactivated', async () => {
  const { issueToken, verifyToken } = await import('../auth.js')
  const victim = await db.createAgent('Deactivated Dev', '+919899000777', null, hashPassword('secret123'))
  const token = await issueToken(victim.id)
  assert.equal((await verifyToken(token)).id, victim.id)

  await db.query('UPDATE agents SET is_active = 0, deactivated_at = now() WHERE id = $1', [victim.id])
  assert.equal(await verifyToken(token), null, 'a deactivated agent keeps no live session')
})

test('hashPassword salts every hash, so identical passwords store differently', () => {
  assert.notEqual(hashPassword('same'), hashPassword('same'))
})
