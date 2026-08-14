// The edges of taking in a lead that did not arrive as a WhatsApp message: the
// click-to-WhatsApp referral that carries only half its fields, the instant intro
// template sent to a lead who gave no name to a workspace that has no business name,
// what that intro records when Meta refuses it, and the contact capture failing
// without taking the lead down with it.
//
// Everything here is best-effort by design. The point of each test is that the lead
// still exists afterwards and the source event says honestly what happened.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
process.env.WHATSAPP_ACCESS_TOKEN = 'ingest-access-token'
process.env.WHATSAPP_PHONE_NUMBER_ID = 'ingest-phone-id'
process.env.WHATSAPP_LEAD_INTRO_TEMPLATE = 'lead_intro'
process.env.WA_MAX_RETRIES = '1' // a refused send must not sit on the wall clock
const dbName = await createTestDb('leadingest')

const { ready, closePool, query, createAgent, getAgent } = await import('../db.js')
const { ingestLead, extractReferral } = await import('../leadSources.js')
const { hashPassword } = await import('../auth.js')

await ready

const realFetch = global.fetch
let sends = []
// What the Graph API answers: 'ok' or 'rejected'.
let graph = 'ok'

let agent

before(async () => {
  agent = await createAgent('Ingest Isha', '+919855000001', null, hashPassword('secret123'))
  global.fetch = async (url, opts) => {
    const target = String(url)
    if (!target.includes('graph.facebook.com')) throw new Error(`unexpected outbound call: ${target}`)
    sends.push(JSON.parse(opts.body))
    const body =
      graph === 'rejected'
        ? { error: { code: 132000, message: 'Template param count mismatch' } }
        : { messages: [{ id: 'wamid.INGEST.1' }] }
    return new Response(JSON.stringify(body), {
      status: graph === 'rejected' ? 400 : 200,
      headers: { 'content-type': 'application/json' },
    })
  }
})

after(async () => {
  global.fetch = realFetch
  await closePool()
  await dropTestDb(dbName)
})

const eventFor = async (leadId) =>
  (await query('SELECT * FROM lead_source_events WHERE lead_id = $1 ORDER BY id DESC LIMIT 1', [leadId])).rows[0]

// --- The referral riding on the first inbound message ------------------------

test('a referral carrying every field is passed through whole', () => {
  const referral = extractReferral({
    referral: {
      ctwa_clid: 'clid-123',
      source_id: '120210',
      source_type: 'ad',
      source_url: 'https://fb.me/ad',
      headline: '2 BHK in Baner',
      body: 'Ready to move',
      media_type: 'image',
    },
  })
  assert.deepEqual(referral, {
    ctwa_clid: 'clid-123',
    source_id: '120210',
    source_type: 'ad',
    source_url: 'https://fb.me/ad',
    headline: '2 BHK in Baner',
    body: 'Ready to move',
    media_type: 'image',
  })
})

test('a referral with only a click id fills the rest with nulls, not undefined', () => {
  // Meta sends whichever subset of these the ad happened to have. `undefined` would
  // reach a jsonb column as the string "undefined"; every absent field must be null.
  const referral = extractReferral({ referral: { ctwa_clid: 'clid-only' } })
  assert.deepEqual(referral, {
    ctwa_clid: 'clid-only',
    source_id: null,
    source_type: null,
    source_url: null,
    headline: null,
    body: null,
    media_type: null,
  })
  assert.ok(!Object.values(referral).includes(undefined))
})

test('a message with no referral, or an empty one, is not an ad click', () => {
  assert.equal(extractReferral({}), null)
  assert.equal(extractReferral(null), null)
  assert.equal(extractReferral({ referral: { headline: 'no ids at all' } }), null)
})

// --- The instant intro template ----------------------------------------------

test('the intro template falls back on every field the lead and workspace lack', async () => {
  // A walk-in whose name nobody wrote down, for an agent who never set a business
  // name and whose own name is blank. All three template parameters fall back.
  await query(`UPDATE agents SET name = '', business_name = NULL WHERE id = $1`, [agent.id])
  const nameless = await getAgent(agent.id)
  sends = []
  graph = 'ok'

  const result = await ingestLead({
    agent: nameless,
    channel: 'walk_in',
    phone: '+919855010001',
  })
  assert.equal(result.ok, true)
  assert.equal(result.autoReplyStatus, 'sent')

  assert.equal(sends.length, 1)
  const params = sends[0].template.components[0].parameters.map((p) => p.text)
  assert.deepEqual(params, ['there', 'your enquiry', 'HomeNex'])

  await query(`UPDATE agents SET name = 'Ingest Isha' WHERE id = $1`, [agent.id])
})

test('the intro template uses the business name and the enquiry it came from', async () => {
  await query(`UPDATE agents SET business_name = 'Isha Realty' WHERE id = $1`, [agent.id])
  const named = await getAgent(agent.id)
  sends = []
  graph = 'ok'

  await ingestLead({
    agent: named,
    channel: 'portal_email',
    portal: '99acres',
    name: 'Rohit Sharma',
    phone: '+919855010002',
    source_ref: 'Skyline Towers',
  })
  const params = sends[0].template.components[0].parameters.map((p) => p.text)
  assert.deepEqual(params, ['Rohit Sharma', 'Skyline Towers', 'Isha Realty'])
})

test('a template parameter longer than Meta allows is truncated, not rejected', async () => {
  sends = []
  graph = 'ok'
  await ingestLead({
    agent: await getAgent(agent.id),
    channel: 'walk_in',
    name: 'N'.repeat(400),
    phone: '+919855010003',
  })
  const [name] = sends[0].template.components[0].parameters.map((p) => p.text)
  assert.equal(name.length, 120)
})

test('a refused intro is recorded on the source event, and the lead still stands', async () => {
  sends = []
  graph = 'rejected'
  const result = await ingestLead({
    agent: await getAgent(agent.id),
    channel: 'walk_in',
    name: 'Refused Rekha',
    phone: '+919855010004',
  })
  graph = 'ok'

  assert.equal(result.ok, true, 'the lead was still created')
  assert.match(result.autoReplyStatus, /^failed:/)
  const event = await eventFor(result.lead.id)
  assert.match(event.auto_reply_status, /^failed:WA_SEND_FAILED/)
  assert.equal(event.status, 'created')
})

test('no intro template configured is a skip, not a failure', async () => {
  const configured = process.env.WHATSAPP_LEAD_INTRO_TEMPLATE
  delete process.env.WHATSAPP_LEAD_INTRO_TEMPLATE
  try {
    sends = []
    const result = await ingestLead({
      agent: await getAgent(agent.id),
      channel: 'walk_in',
      name: 'No Template Nita',
      phone: '+919855010005',
    })
    assert.equal(result.autoReplyStatus, 'skipped:no_template')
    assert.equal(sends.length, 0)
  } finally {
    process.env.WHATSAPP_LEAD_INTRO_TEMPLATE = configured
  }
})

// --- Contact capture is allowed to fail --------------------------------------

test('a lead survives the contact capture failing outright', async () => {
  // The capture is wrapped in a bare catch for the "number claimed elsewhere"
  // case. Make the write itself refuse — the lead, its provenance and its source
  // event must all land anyway, because none of them depend on the contact row.
  await query(`
    CREATE OR REPLACE FUNCTION test_contacts_boom() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'induced failure writing contacts'; END $$
  `)
  await query(`
    CREATE TRIGGER test_contacts_boom BEFORE INSERT ON contacts
    FOR EACH ROW EXECUTE FUNCTION test_contacts_boom()
  `)
  try {
    sends = []
    const result = await ingestLead({
      agent: await getAgent(agent.id),
      channel: 'phone',
      name: 'Uncaptured Uma',
      phone: '+919855010006',
      source_ref: 'called the office',
    })
    assert.equal(result.ok, true)
    assert.equal(result.lead.wa_id, '919855010006')
    assert.equal(result.lead.source_channel, 'phone', 'provenance was still stamped')
    assert.equal(result.lead.contact_id, null, 'no contact to attach')
    const event = await eventFor(result.lead.id)
    assert.equal(event.status, 'created')
  } finally {
    await query('DROP TRIGGER IF EXISTS test_contacts_boom ON contacts')
  }
})

test('a lead whose phone is too short is refused and logged as failed', async () => {
  const result = await ingestLead({
    agent: await getAgent(agent.id),
    channel: 'walk_in',
    name: 'Short Number',
    phone: '12345',
  })
  assert.deepEqual(result, { ok: false, reason: 'no_phone' })
  const { rows } = await query(
    `SELECT * FROM lead_source_events WHERE agent_id = $1 AND status = 'failed' ORDER BY id DESC LIMIT 1`,
    [agent.id],
  )
  assert.equal(rows[0].error, 'no valid phone')
})
