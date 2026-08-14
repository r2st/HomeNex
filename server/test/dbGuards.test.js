// The defensive arms of db.js: the argument validation that throws before a query
// is built, the early returns that spare the database a pointless round trip, and
// the "the row wasn't there" arms of functions whose happy path is well covered.
//
// These are the branches a route hits when a client sends half a form, when a
// background job is handed an id that has since been deleted, or when a column that
// is nullable in the schema actually is null. Each one exists because something
// upstream can be empty; none of them had a test.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
const dbName = await createTestDb('dbguards')

const db = await import('../db.js')
const { hashPassword } = await import('../auth.js')

let agent
let lead

// An id no row will ever have — the "missing row" arm of every lookup below.
const GONE = 99_999_999

before(async () => {
  await db.ready
  agent = await db.createAgent('Guard Tester', '+919877000001', null, hashPassword('secret123'))
  lead = await db.upsertLead(agent.id, '919877000123', 'Guarded Buyer')
})

after(async () => {
  await db.closePool()
  await dropTestDb(dbName)
})

// === Required-argument guards: the throw that happens before any SQL ===

test('createSiteVisit refuses a visit with no lead or no time', async () => {
  await assert.rejects(() => db.createSiteVisit(agent.id, {}), /lead_id and scheduled_at are required/)
  await assert.rejects(
    () => db.createSiteVisit(agent.id, { lead_id: lead.id }),
    /lead_id and scheduled_at are required/,
    'a lead without a time is still incomplete',
  )
  await assert.rejects(
    () => db.createSiteVisit(agent.id, { scheduled_at: new Date().toISOString() }),
    /lead_id and scheduled_at are required/,
    'a time without a lead has nobody to visit',
  )
})

test('createFollowup refuses a reminder with no lead or no due date', async () => {
  await assert.rejects(() => db.createFollowup(agent.id, {}), /lead_id and due_at are required/)
  await assert.rejects(
    () => db.createFollowup(agent.id, { lead_id: lead.id }),
    /lead_id and due_at are required/,
  )
})

test('createCommission and createDeal both refuse to exist without a lead', async () => {
  await assert.rejects(() => db.createCommission(agent.id, {}), /lead_id is required/)
  await assert.rejects(() => db.createDeal(agent.id, {}), /lead_id is required/)
})

test('createMediaAsset refuses an asset with no title or no url', async () => {
  await assert.rejects(() => db.createMediaAsset(agent.id, {}), /title and url are required/)
  await assert.rejects(
    () => db.createMediaAsset(agent.id, { title: 'Brochure' }),
    /title and url are required/,
    'a title with nothing behind it is not an asset',
  )
  await assert.rejects(
    () => db.createMediaAsset(agent.id, { url: 'https://example.com/x.pdf' }),
    /title and url are required/,
  )
})

test('createMediaAsset defaults kind and storage when the caller omits them', async () => {
  const asset = await db.createMediaAsset(agent.id, {
    title: '  Floor plan  ',
    url: 'https://example.com/plan.pdf',
  })
  assert.equal(asset.title, 'Floor plan', 'title is trimmed')
  assert.equal(asset.kind, 'document')
  assert.equal(asset.storage, 'url')
  assert.equal(asset.filename, null)
  assert.equal(asset.mime, null)
  assert.equal(asset.size_bytes, null)
  assert.equal(asset.caption, null)
})

test('updateWabaStatus rejects a status change for an agent that no longer exists', async () => {
  await assert.rejects(() => db.updateWabaStatus(GONE, { status: 'pending' }), /Agent not found/)
})

test('updateAgentPassword reports a missing agent rather than silently succeeding', async () => {
  await assert.rejects(
    () => db.updateAgentPassword(GONE, hashPassword('whatever123')),
    (err) => err.code === 'NOT_FOUND' && /Agent not found/.test(err.message),
  )
})

// === Empty input: the early return that skips the query entirely ===

test('getMessagesForLeads([]) returns an empty map without querying', async () => {
  const byLead = await db.getMessagesForLeads([])
  assert.equal(byLead.size, 0)
})

test('recomputeScoresForAgents([]) scores nothing', async () => {
  assert.equal(await db.recomputeScoresForAgents([]), 0)
})

test('applyAutoLabel is a no-op when any of its three arguments is missing', async () => {
  // The unassigned pool calls this with agentId null on every inbound message.
  await db.applyAutoLabel(null, agent.id, 'hot')
  await db.applyAutoLabel(lead.id, null, 'hot')
  await db.applyAutoLabel(lead.id, agent.id, '')
  assert.deepEqual(await db.leadLabels(lead.id), [], 'no label was applied by any of the three')
})

test('findAgentByIngestToken(empty) short-circuits to null', async () => {
  assert.equal(await db.findAgentByIngestToken(''), null)
  assert.equal(await db.findAgentByIngestToken(null), null)
  assert.equal(await db.findAgentByIngestToken(undefined), null)
})

test('updateLeadSourceEvent with no recognised fields updates nothing', async () => {
  const { event } = await db.createLeadSourceEvent({
    agent_id: agent.id,
    channel: 'walk_in',
    contact_phone: '+919877000123',
  })
  assert.equal(await db.updateLeadSourceEvent(event.id, {}), null)
  assert.equal(
    await db.updateLeadSourceEvent(event.id, { not_a_column: 'ignored' }),
    null,
    'an unknown key is not a field to set',
  )
})

test('updateMessageTemplate with no fields hands back the row unchanged', async () => {
  const tpl = await db.createMessageTemplate(agent.id, {
    name: 'Guarded template',
    category: 'utility',
    body: 'Hello {{1}}',
  })
  const same = await db.updateMessageTemplate(tpl.id, agent.id, {})
  assert.equal(same.id, tpl.id)
  assert.equal(same.body, 'Hello {{1}}')
  assert.equal(same.updated_at.getTime(), tpl.updated_at.getTime(), 'not even updated_at moved')
})

test('an explicitly undefined field is stored as NULL, not skipped', async () => {
  // `{ name: undefined }` passes the `col in fields` test but carries no value —
  // pg would reject `undefined` as a parameter, so buildSet coerces it to null.
  const tpl = await db.createMessageTemplate(agent.id, {
    name: 'Undefined-field template',
    category: 'utility',
    body: 'Body',
  })
  const updated = await db.updateMessageTemplate(tpl.id, agent.id, { meta_template_id: undefined })
  assert.equal(updated.meta_template_id, null)
})

// === Missing rows: the arm where the id was valid but the row is gone ===

test('recomputeLeadScore returns null for a lead that no longer exists', async () => {
  assert.equal(await db.recomputeLeadScore(GONE), null)
})

test('regenerateIngestToken returns null when there is no agent to rotate', async () => {
  assert.equal(await db.regenerateIngestToken(GONE), null)
})

test('ensureBulkSendStarted returns null when the agent row is gone', async () => {
  assert.equal(await db.ensureBulkSendStarted(GONE), null)
})

test('a first response is only recorded once both sides have spoken', async () => {
  const quiet = await db.upsertLead(agent.id, '919877000900', 'Only Buyer Spoke')
  await db.addMessage(quiet.id, 'buyer', 'Hi, is this available?')
  // No agent/AI reply yet, so the subtraction is NULL — nothing to record.
  await db.recordFirstResponse(quiet.id)
  assert.equal((await db.getLead(quiet.id)).first_response_s, null)

  await db.addMessage(quiet.id, 'agent', 'Yes it is.')
  await db.recordFirstResponse(quiet.id)
  const after = await db.getLead(quiet.id)
  assert.ok(after.first_response_s != null, 'now both sides have spoken')
  assert.ok(after.first_response_s >= 0, 'never negative')
})

// === Nullable columns that the happy path always fills ===

test('a lead with no pipeline_type is treated as buy_primary when its stage moves', async () => {
  const l = await db.upsertLead(agent.id, '919877000901', 'No Pipeline')
  await db.query('UPDATE leads SET pipeline_type = NULL WHERE id = $1', [l.id])
  const moved = await db.setLeadStage(l.id, agent.id, { stage: 'Qualified' })
  assert.equal(moved.stage, 'Qualified')
  const { rows } = await db.query(
    'SELECT pipeline_type, lost_reason FROM lead_stage_events WHERE lead_id = $1',
    [l.id],
  )
  assert.equal(rows[0].pipeline_type, 'buy_primary', 'the stage event is stamped with the default')
  assert.equal(rows[0].lost_reason, null)
})

test('a booking stage captures a deal even for a lead with no pipeline_type', async () => {
  const l = await db.upsertLead(agent.id, '919877000902', 'No Pipeline Booking')
  await db.query('UPDATE leads SET pipeline_type = NULL WHERE id = $1', [l.id])
  await db.setLeadStage(l.id, agent.id, { stage: 'Token/Booking' })
  const deals = await db.listDeals(agent.id)
  const captured = deals.find((d) => d.lead_id === l.id)
  assert.ok(captured, 'the booking was captured as a deal')
  assert.equal(captured.deal_type, 'sale', 'a null pipeline_type is a sale, not a rental')
})

test('a visit outcome on a lead with no pipeline_type advances the buy pipeline', async () => {
  const l = await db.upsertLead(agent.id, '919877000903', 'Null Pipeline Visit')
  await db.query('UPDATE leads SET pipeline_type = NULL WHERE id = $1', [l.id])
  const visit = await db.createSiteVisit(agent.id, {
    lead_id: l.id,
    scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
  })
  await db.updateSiteVisit(visit.id, agent.id, { status: 'completed' })
  assert.equal((await db.getLead(l.id)).stage, 'Site Visit Done')
})

test('a visit outcome is dropped when the target stage is not in the lead pipeline', async () => {
  const l = await db.upsertLead(agent.id, '919877000904', 'Unknown Pipeline Visit')
  // A workspace that pruned a stage out of its resale pipeline: 'Site Visit Done'
  // no longer exists there, so the outcome has nowhere to move the lead to and must
  // leave it where it is rather than writing a stage the pipeline doesn't have.
  await db.query(
    `DELETE FROM pipeline_stages WHERE pipeline_type = 'buy_resale' AND stage_name = 'Site Visit Done'`,
  )
  await db.query(`UPDATE leads SET pipeline_type = 'buy_resale', stage = 'New' WHERE id = $1`, [l.id])
  const visit = await db.createSiteVisit(agent.id, {
    lead_id: l.id,
    scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
  })
  await db.updateSiteVisit(visit.id, agent.id, { status: 'completed' })
  assert.equal((await db.getLead(l.id)).stage, 'New', 'the lead did not move')
})

test('a property whose title slugifies to nothing still gets a usable slug', async () => {
  const p = await db.createProperty(agent.id, { title: '!!! ###' })
  assert.match(p.micro_page_slug, /^property-[a-z0-9]{6}$/)
})

test('setAgentWaPhone only moves a fresh number to pending', async () => {
  const fresh = await db.createAgent('Waba Guard', '+919877000002', null, hashPassword('secret123'))
  assert.equal(fresh.waba_status, 'none')

  const first = await db.setAgentWaPhone(fresh.id, '+919877111111')
  assert.equal(first.waba_status, 'pending', 'first-time set moves to pending')

  await db.updateWabaStatus(fresh.id, { status: 'active' })
  const second = await db.setAgentWaPhone(fresh.id, '+919877222222')
  assert.equal(second.waba_status, 'active', 'changing an existing number leaves the status alone')
  assert.equal(second.wa_phone_number, '+919877222222')
})

test('a blank profile text field is stored as NULL, not as an empty string', async () => {
  const updated = await db.updateAgentProfileSelf(agent.id, { business_name: 'Guard Realty' })
  assert.equal(updated.business_name, 'Guard Realty')
  const cleared = await db.updateAgentProfileSelf(agent.id, { business_name: null })
  assert.equal(cleared.business_name, null, 'null in, null stored')
  const blanked = await db.updateAgentProfileSelf(agent.id, { city: '   ' })
  assert.equal(blanked.city, null, 'whitespace is not a city')
})

test('createGroup accepts a null criteria as an empty one', async () => {
  const group = await db.createGroup(agent.id, { name: 'Null criteria', criteria: null })
  assert.deepEqual(group.criteria, {})
})

// === Notifications, send stats, provenance: the defaults nobody passes ===

test('a repeated notification for the same reason is deduped to null', async () => {
  const first = await db.createNotification(agent.id, {
    type: 'followup_due',
    title: 'Follow up with Guarded Buyer',
    dedupe_key: 'guard-dedupe-1',
  })
  assert.ok(first, 'the first one is created')
  const second = await db.createNotification(agent.id, {
    type: 'followup_due',
    title: 'Follow up with Guarded Buyer',
    dedupe_key: 'guard-dedupe-1',
  })
  assert.equal(second, null, 'the second is swallowed by the dedupe key')
})

test('contactSendStats works for a caller that has no contact id to give', async () => {
  await db.recordSend(agent.id, { phone: '+919877000555', kind: 'marketing' })
  const stats = await db.contactSendStats(agent.id, undefined, '+919877000555')
  assert.equal(stats.monthCount, 1)
  assert.ok(stats.lastSentAt instanceof Date)

  const none = await db.contactSendStats(agent.id, undefined, '+919877000556')
  assert.equal(none.lastSentAt, null)
  assert.equal(none.monthCount, 0)
})

test('contactSendStatsBatch tolerates a recipient with an id but no phone', async () => {
  const { rows } = await db.query(
    'INSERT INTO contacts (agent_id, phone, name) VALUES ($1, $2, $3) RETURNING id',
    [agent.id, '+919877000557', 'Phoneless Key'],
  )
  const stats = await db.contactSendStatsBatch(agent.id, [{ id: rows[0].id }])
  const entry = stats.get(db.sendStatsKey({ id: rows[0].id }))
  assert.deepEqual(entry, { lastSentAt: null, monthCount: 0 })
})

test('setLeadSourceProvenance with an empty payload leaves every column alone', async () => {
  const l = await db.upsertLead(agent.id, '919877000905', 'Provenance')
  await db.setLeadSourceProvenance(l.id, {
    source: '99acres',
    source_channel: 'portal_email',
    source_portal: '99acres',
    source_ref: 'Skyline Towers',
    source_meta: { budget: '80L' },
  })
  const stamped = await db.setLeadSourceProvenance(l.id, {})
  assert.equal(stamped.source, '99acres', 'an empty merge does not blank the source')
  assert.equal(stamped.source_channel, 'portal_email')
  assert.equal(stamped.source_ref, 'Skyline Towers')
  assert.deepEqual(stamped.source_meta, { budget: '80L' })
  assert.equal(stamped.ctwa_clid, null)
})

test('recordCtwaReferral works for a referral carrying no click id', async () => {
  const l = await db.upsertLead(agent.id, '919877000906', 'Ctwa No Clid')
  const updated = await db.recordCtwaReferral(l.id, {})
  assert.equal(updated.source, 'ctwa')
  assert.equal(updated.source_channel, 'ctwa')
  assert.equal(updated.ctwa_clid, null)
  assert.ok(updated.free_entry_at, 'the 72h window opened anyway')
})

test('a source event with no external id takes every default', async () => {
  const { event, duplicate } = await db.createLeadSourceEvent({
    agent_id: agent.id,
    channel: 'walk_in',
  })
  assert.equal(duplicate, false)
  assert.equal(event.status, 'received', 'status defaults to received')
  assert.equal(event.portal, null)
  assert.equal(event.external_id, null)
  assert.equal(event.contact_phone, null)
  assert.equal(event.contact_name, null)
  assert.equal(event.auto_reply_status, null)
  assert.equal(event.error, null)
  assert.deepEqual(event.raw, {})
})

// === The worklist, built from leads that never gave their name ===

test('every worklist item falls back to the wa_id when the lead has no name', async () => {
  const nameless = await db.createAgent('Nameless Board', '+919877000003', null, hashPassword('secret123'))
  const mk = async (waId) => {
    const { rows } = await db.query(
      'INSERT INTO leads (agent_id, wa_id, phone, name) VALUES ($1, $2, $2, NULL) RETURNING *',
      [nameless.id, waId],
    )
    return rows[0]
  }

  // 1. Service window closing: last heard from 22h ago.
  const closing = await mk('919877001001')
  await db.query(`UPDATE leads SET last_inbound_at = now() - interval '22 hours' WHERE id = $1`, [closing.id])

  // 2. Hot lead awaiting a reply.
  const hot = await mk('919877001002')
  await db.query(
    `UPDATE leads SET effective_temp = 'Hot', effective_score = 88,
       last_inbound_at = now() - interval '2 hours', last_outbound_at = NULL WHERE id = $1`,
    [hot.id],
  )

  // 3. Overdue follow-up carrying no note.
  const chase = await mk('919877001003')
  await db.query(
    `INSERT INTO followups (lead_id, agent_id, due_at, type, note)
     VALUES ($1, $2, now() - interval '2 days', 'manual', NULL)`,
    [chase.id, nameless.id],
  )

  // 4. Micro-page re-opened twice today.
  const reopen = await mk('919877001004')
  const prop = await db.createProperty(nameless.id, { title: 'Nameless Heights' })
  await db.query(
    `INSERT INTO property_page_views (property_id, lead_id, viewed_at)
     VALUES ($1, $2, now() - interval '3 hours'), ($1, $2, now() - interval '1 hour')`,
    [prop.id, reopen.id],
  )

  // 5. Brokerage past its payout date.
  const owed = await mk('919877001005')
  await db.query(
    `INSERT INTO commissions (agent_id, lead_id, status, expected_payout_date, commission_flat_paise)
     VALUES ($1, $2, 'expected', now()::date - 5, 100000)`,
    [nameless.id, owed.id],
  )

  const board = await db.worklist(nameless.id)
  const byType = new Map(board.items.map((i) => [i.type, i]))
  for (const type of [
    'service_window_closing',
    'hot_lead_waiting',
    'overdue_followup',
    'micro_page_reopened',
    'commission_overdue',
  ]) {
    const item = byType.get(type)
    assert.ok(item, `${type} is on the board`)
    assert.match(item.title, /^9198770010\d\d$/, `${type} titled by wa_id, not "null"`)
  }
  assert.equal(
    byType.get('overdue_followup').reason,
    'Follow-up is overdue.',
    'a note-less follow-up gets the generic reason, not "Overdue follow-up: null"',
  )
})
