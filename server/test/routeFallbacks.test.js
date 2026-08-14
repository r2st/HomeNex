// What the API writes down when the field it wanted to print isn't there.
//
// Six routes format the buyer's name into an activity line the agent later reads to
// remember what happened. A lead only has a name if WhatsApp sent a profile name or
// somebody typed one, so "no name" is the ordinary case — and every one of those
// lines has to fall back to the number rather than logging the word "null".
//
// The rest are the small default arms beside them: a name cleared back to blank, an
// EMI request whose numbers don't produce a schedule, a network post whose fields
// arrive as something other than strings, and a delete aimed at somebody else's row.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_APP_SECRET
process.env.WHATSAPP_ACCESS_TOKEN = 'fallback-access-token'
process.env.WHATSAPP_PHONE_NUMBER_ID = 'fallback-phone-id'
const dbName = await createTestDb('routefallbacks')

const { app } = await import('../index.js')
const { ready, closePool, query, createAgent, createProperty, upsertUnassignedLead } = await import('../db.js')
const { hashPassword } = await import('../auth.js')

await ready

const realFetch = global.fetch
let server, base, token, agentId

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
const json = async (...args) => (await req(...args)).json()

// A lead nobody ever named: wa_id only, exactly as the pool creates it.
async function namelessLead(waId) {
  const { rows } = await query(
    `INSERT INTO leads (agent_id, wa_id, phone, name, stage, pipeline_type)
     VALUES ($1, $2, $2, NULL, 'New', 'buy_primary') RETURNING *`,
    [agentId, waId],
  )
  return rows[0]
}

const activityFor = async (leadId) =>
  (await query('SELECT * FROM activity WHERE lead_id = $1 ORDER BY id', [leadId])).rows.map((a) => a.text)

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  // Every outbound Graph call succeeds; these tests are about what we write down,
  // not about WhatsApp.
  global.fetch = async (url, opts) => {
    const target = String(url)
    if (target.startsWith(base)) return realFetch(url, opts)
    if (!target.includes('graph.facebook.com')) throw new Error(`unexpected outbound call: ${target}`)
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.FB.1' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const out = await json('POST', '/api/auth/signup', {
    name: 'Fallback Farah',
    phone: '+919866000001',
    password: 'secret123',
  }, null)
  token = out.token
  agentId = out.agent.id
  await query('UPDATE agents SET wa_phone_number_id = $2 WHERE id = $1', [agentId, 'fallback-phone-id'])
})

after(async () => {
  global.fetch = realFetch
  server?.close()
  await new Promise((r) => setTimeout(r, 150))
  await closePool()
  await dropTestDb(dbName)
})

// === The buyer with no name ===

test('a stage move on a nameless lead is logged against the number', async () => {
  const lead = await namelessLead('919866010001')
  const moved = await json('PUT', `/api/leads/${lead.id}/stage`, { stage: 'Qualified' })
  assert.equal(moved.stage, 'Qualified')
  const notes = await activityFor(lead.id)
  assert.ok(notes.some((t) => t === '919866010001 moved to Qualified'), notes.join(' | '))
})

test('a lost lead names its reason in the same line, still against the number', async () => {
  const lead = await namelessLead('919866010002')
  await json('PUT', `/api/leads/${lead.id}/stage`, { stage: 'Lost', lost_reason: 'budget' })
  const notes = await activityFor(lead.id)
  assert.ok(
    notes.some((t) => t === '919866010002 moved to Lost (budget)'),
    'the reason is appended for Lost and only for Lost: ' + notes.join(' | '),
  )
})

test('claiming a nameless lead from the pool names it by number everywhere', async () => {
  const pooled = await upsertUnassignedLead('919866010003', null)
  const claimed = await json('POST', `/api/leads/${pooled.id}/assign`)
  assert.equal(claimed.agent_id, agentId)

  const notes = await activityFor(pooled.id)
  assert.ok(notes.some((t) => t === 'Fallback Farah claimed 919866010003'), notes.join(' | '))
  // The claim also remembers the sender as a client, under the same fallback.
  const { rows } = await query('SELECT * FROM contacts WHERE phone = $1', ['+919866010003'])
  assert.equal(rows[0].name, '919866010003')
  assert.equal((await query('SELECT contact_id FROM leads WHERE id = $1', [pooled.id])).rows[0].contact_id, rows[0].id)
})

test('taking over and handing back a nameless chat both log the number', async () => {
  const lead = await namelessLead('919866010004')
  await json('POST', `/api/leads/${lead.id}/ai`, { enabled: false })
  await json('POST', `/api/leads/${lead.id}/ai`, { enabled: true })
  const notes = await activityFor(lead.id)
  assert.ok(notes.includes('Fallback Farah took over the chat with 919866010004'), notes.join(' | '))
  assert.ok(notes.includes('AI re-enabled for 919866010004'), notes.join(' | '))
})

test('sending a property to a nameless chat logs which listing went where', async () => {
  const lead = await namelessLead('919866010005')
  const property = await createProperty(agentId, { title: 'Riverdale Residency' })
  await query(`UPDATE leads SET last_inbound_at = now() WHERE id = $1`, [lead.id])

  const res = await req('POST', `/api/properties/${property.id}/send-to-chat`, { lead_id: lead.id })
  assert.equal(res.status, 200)
  const notes = await activityFor(lead.id)
  assert.ok(
    notes.some((t) => t === 'Sent "Riverdale Residency" to 919866010005'),
    notes.join(' | '),
  )
})

test('booking a site visit for a nameless lead logs the number', async () => {
  const lead = await namelessLead('919866010006')
  const res = await req('POST', '/api/site-visits', {
    lead_id: lead.id,
    scheduled_at: new Date(Date.now() + 86_400_000).toISOString(),
  })
  assert.equal(res.status, 200)
  const notes = await activityFor(lead.id)
  assert.ok(notes.some((t) => t === 'Site visit scheduled for 919866010006'), notes.join(' | '))
})

// === The small default arms ===

test('clearing a lead name stores NULL, not an empty string', async () => {
  const lead = await namelessLead('919866010007')
  const named = await json('PUT', `/api/leads/${lead.id}`, { name: 'Temporarily Named' })
  assert.equal(named.name, 'Temporarily Named')
  const cleared = await json('PUT', `/api/leads/${lead.id}`, { name: '   ' })
  assert.equal(cleared.name, null, 'whitespace clears the name rather than becoming it')
})

test('an EMI request with a real amount but no tenure is refused as bad input', async () => {
  // The amount parses and is positive, so the "no loan amount" arm doesn't fire —
  // but a zero-month schedule has no EMI to report.
  const res = await req('POST', '/api/emi', { principal_l: 50, years: 0 })
  assert.equal(res.status, 400)
  assert.equal((await res.json()).error, 'Invalid EMI inputs')

  const ok = await json('POST', '/api/emi', { principal_l: 50 })
  assert.ok(ok.message.includes('Monthly EMI'), 'the same amount with the default tenure still works')
})

test('a network post whose fields are not strings is coerced, not 500', async () => {
  // A client that posts numbers (or a JSON null) instead of strings must get the
  // same validation as one that posts text.
  const bad = await req('POST', '/api/network', { type: 12345, broker: 'B', text: 'T' })
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).error, 'bad type', 'a numeric type is stringified, then rejected by name')

  const missing = await req('POST', '/api/network', { broker: null, text: 'T' })
  assert.equal(missing.status, 400)
  assert.equal(
    (await missing.json()).error,
    'type, broker, text required',
    'an absent type reads as absent, not as the string "null"',
  )

  const post = await json('POST', '/api/network', {
    type: 'INVENTORY',
    broker: 'Fallback Farah',
    text: '3 BHK available in Baner',
    config: 3,
    locality: null,
  })
  assert.equal(post.config, '3', 'a numeric config is stored as its digits')
  assert.equal(post.locality, null, 'an absent locality stays absent')
})

test('deleting media that is not yours is a 404, not a silent success', async () => {
  const stranger = await createAgent('Media Manoj', '+919866000002', null, hashPassword('secret123'))
  const { rows } = await query(
    `INSERT INTO media_assets (agent_id, title, kind, storage, url)
     VALUES ($1, 'Their brochure', 'document', 'url', 'https://example.com/x.pdf') RETURNING id`,
    [stranger.id],
  )
  const res = await req('DELETE', `/api/media/${rows[0].id}`)
  assert.equal(res.status, 404)
  assert.deepEqual(await res.json(), { ok: false })
  assert.equal(
    (await query('SELECT 1 FROM media_assets WHERE id = $1', [rows[0].id])).rowCount,
    1,
    'and their asset is still there',
  )
})
