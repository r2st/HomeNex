// Route arms in index.js that the happy-path suites never take: deleting something
// that isn't there, creating a second thing with a name that's already taken, and the
// optional halves of every "use this, else that" fallback.
//
// These are cheap to get wrong and expensive when they are — a delete that answers
// 200 for a row it never touched, or a duplicate name that surfaces as a 500 instead
// of a 409, both look fine until an agent trusts them.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('routeedges')

const { app } = await import('../index.js')
const { closePool, query, getAgent, upsertLead } = await import('../db.js')
const { formatPropertyMessage } = await import('../index.js')

let server, base, token, agent
const MISSING = 987654

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

const jreq = async (method, url, body, tok = token) => (await req(method, url, body, tok)).json()

before(async () => {
  await new Promise((r) => (server = app.listen(0, () => r((base = `http://127.0.0.1:${server.address().port}`)))))
  const out = await jreq(
    'POST',
    '/api/auth/signup',
    { name: 'Edge Esha', phone: '+919871000001', password: 'secret123' },
    null,
  )
  token = out.token
  agent = await getAgent(out.agent.id)
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- Deleting what isn't there --------------------------------------------------

// Every one of these answers { ok } with the status carrying the real outcome. A 200
// here would tell the UI it removed a row that was never touched (or belongs to
// someone else), and the list would silently drift from the database.
test('deleting a row that does not exist is a 404, not a cheerful 200', async () => {
  const gone = [
    ['DELETE', '/api/quick-replies/' + MISSING],
    ['DELETE', '/api/media/' + MISSING],
    ['DELETE', '/api/leads/1/notes/' + MISSING],
  ]
  for (const [method, url] of gone) {
    const res = await req(method, url)
    assert.equal(res.status, 404, `${method} ${url}`)
    assert.deepEqual(await res.json(), { ok: false })
  }

  const label = await req('DELETE', '/api/labels/' + MISSING)
  assert.equal(label.status, 404, 'a stale label id is missing, not a protected system label')
  assert.equal((await label.json()).error, 'not found')
})

// --- Names that are already taken -----------------------------------------------

// Each of these has a UNIQUE constraint the route is expected to turn into a 400/409
// rather than let bubble out as an unhandled 23505.
test('a duplicate quick reply, label or template name is a clean 4xx', async () => {
  const first = await jreq('POST', '/api/quick-replies', { title: 'Site visit', body: 'Shall we visit?' })
  assert.ok(first.id, 'the first one is created')
  const dup = await req('POST', '/api/quick-replies', { title: 'Site visit', body: 'Shall we visit?' })
  assert.ok(dup.status >= 400 && dup.status < 500, `duplicate quick reply -> ${dup.status}`)
  assert.ok((await dup.json()).error, 'and it says why')

  await jreq('POST', '/api/labels', { name: 'Hot', color: '#ff0000' })
  const dupLabel = await req('POST', '/api/labels', { name: 'Hot' })
  assert.ok(dupLabel.status >= 400 && dupLabel.status < 500, `duplicate label -> ${dupLabel.status}`)

  await jreq('POST', '/api/templates', { name: 'welcome_v1', body: 'Namaste {{1}}' })
  const dupTemplate = await req('POST', '/api/templates', { name: 'welcome_v1', body: 'Namaste {{1}}' })
  assert.ok(dupTemplate.status >= 400 && dupTemplate.status < 500, `duplicate template -> ${dupTemplate.status}`)
})

// The same routes must still reject an empty payload with the validation message,
// not a constraint error.
test('a quick reply, label or media asset with nothing in it is refused', async () => {
  for (const [url, body] of [
    ['/api/quick-replies', { title: '', body: '' }],
    ['/api/labels', { name: '   ' }],
    ['/api/media', {}],
  ]) {
    const res = await req('POST', url, body)
    assert.equal(res.status, 400, url)
    assert.ok((await res.json()).error, `${url} says what was missing`)
  }
})

// --- 404 arms on threads and their sub-resources --------------------------------

test('thread sub-routes 404 on a lead that is not this agent’s', async () => {
  for (const [method, url] of [
    ['POST', `/api/leads/${MISSING}/read`],
    ['PUT', `/api/leads/${MISSING}/labels/1`],
    ['GET', `/api/leads/${MISSING}/property-matches`],
  ]) {
    const res = await req(method, url)
    assert.equal(res.status, 404, `${method} ${url}`)
  }
})

test('putting a label id that does not exist on a real thread is a label 404', async () => {
  const lead = await upsertLead(agent.id, '919871000900', 'Labelled Lata')
  const res = await req('PUT', `/api/leads/${lead.id}/labels/${MISSING}`)
  assert.equal(res.status, 404)
  assert.equal((await res.json()).error, 'label not found', 'the thread was found; the label was not')
})

// --- Optional-field fallbacks ---------------------------------------------------

// Signup seeds wa_phone_number from the login number, so the empty state only shows
// up once an agent clears it — which the Settings screen lets them do.
test('phone-config reads back nulls for an agent who has not set one', async () => {
  await query('UPDATE agents SET wa_phone_number = NULL, wa_phone_number_id = NULL WHERE id = $1', [agent.id])
  assert.deepEqual(await jreq('GET', '/api/agent/phone-config'), {
    wa_phone_number: null,
    wa_phone_number_id: null,
  })
  await query('UPDATE agents SET wa_phone_number = $2 WHERE id = $1', [agent.id, agent.phone])
})

test('pipeline analytics defaults to buy_primary and rejects an unknown pipeline', async () => {
  const defaulted = await jreq('GET', '/api/pipeline/analytics')
  assert.ok(defaulted.funnel, 'no ?type= still analyses the default pipeline')
  const bad = await req('GET', '/api/pipeline/analytics?type=timeshare')
  assert.equal(bad.status, 400)
  const stages = await jreq('GET', '/api/pipeline-stages')
  assert.ok(Array.isArray(stages) && stages.length, 'no ?type= lists every stage')
})

test('the invoice list filters by commission and by status, and by neither', async () => {
  const all = await jreq('GET', '/api/commission-invoices')
  assert.ok(Array.isArray(all))
  assert.deepEqual(await jreq('GET', `/api/commission-invoices?commission_id=${MISSING}`), [])
  assert.deepEqual(await jreq('GET', '/api/commission-invoices?status=paid'), [])
})

test('an EMI request with no usable loan amount is refused', async () => {
  const res = await req('POST', '/api/emi', { text: 'how much for a house' })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /loan amount/)
})

// --- The property share card ----------------------------------------------------

// formatPropertyMessage drops every line it has no value for, so the card never shows
// a stray bullet or an "undefined". Both the builder and the owner arm are exercised:
// an owner byline only appears when there is no builder.
test('the property card names an owner only when there is no builder', async () => {
  const builder = formatPropertyMessage({
    title: 'Skyline Towers',
    builder_name: 'Godrej',
    owner_name: 'Mr Rao',
    locality: 'Wakad',
    city: 'Pune',
    brochure_url: 'https://example.com/b.pdf',
    rera_project_number: 'P52100012345',
    bhk: 3,
    property_type: 'Apartment',
    size_sqft: 1450,
  })
  assert.match(builder, /🏗️ Godrej/)
  assert.doesNotMatch(builder, /Mr Rao/, 'the builder wins the byline')
  assert.match(builder, /📍 Wakad, Pune/)
  assert.match(builder, /📄 Brochure/)
  assert.match(builder, /3 BHK · Apartment · 1450 sqft/, 'size falls back to sqft with no unit set')

  const owner = formatPropertyMessage({ title: 'Resale Flat', owner_name: 'Mr Rao', city: 'Pune', size_unit: 'sqm', size_sqft: 90 })
  assert.match(owner, /👤 Mr Rao/)
  assert.match(owner, /📍 Pune/, 'a city with no locality still reads cleanly')
  assert.match(owner, /90 sqm/, 'an explicit unit is used')

  // A card with nothing but a title must be exactly one line — no empty bullets.
  const bare = formatPropertyMessage({ title: 'Plot' })
  assert.equal(bare, '🏠 *Plot*')
})

// --- The public portal ingest endpoint ------------------------------------------

test('portal ingest accepts the alternate field names for id and project', async () => {
  const out = await jreq(
    'POST',
    `/ingest/portal/${agent.ingest_token}/99acres`,
    {
      lead_id: 'ALT-1',
      phone: '+919871000501',
      name: 'Portal Priya',
      email: 'priya@example.com',
      project: 'Green Acres',
      message: 'Call me evenings',
      budget: '80L',
      config: '3BHK',
      city: 'Pune',
    },
    null,
  )
  assert.equal(out.ok, true)
  assert.ok(out.lead_id, 'the lead is created and its id comes back')

  const { rows } = await query(
    `SELECT external_id, contact_name, raw FROM lead_source_events
     WHERE agent_id = $1 AND channel = 'portal_api' ORDER BY id DESC LIMIT 1`,
    [agent.id],
  )
  assert.equal(rows[0].external_id, 'ALT-1', 'lead_id stands in for external_id')
  assert.equal(rows[0].contact_name, 'Portal Priya')
  assert.equal(rows[0].raw.project, 'Green Acres', 'project stands in for property')

  const lead = (await query('SELECT source_ref FROM leads WHERE id = $1', [out.lead_id])).rows[0]
  assert.equal(lead.source_ref, 'Green Acres', 'and it lands on the lead as the source reference')
})

test('portal ingest rejects an unknown token and an unknown portal', async () => {
  const badToken = await req('POST', '/ingest/portal/not-a-real-token/99acres', { phone: '+919871000502' }, null)
  assert.equal(badToken.status, 404)
  assert.match((await badToken.json()).error, /ingest token/)

  const badPortal = await req('POST', `/ingest/portal/${agent.ingest_token}/craigslist`, { phone: '+919871000503' }, null)
  assert.equal(badPortal.status, 400)
  assert.match((await badPortal.json()).error, /portal/)
})

// The external_id dedupe gate is checked before any lead work, so a repeat push is
// answered from the gate: duplicate: true and no lead_id, because the second push
// created nothing. One buyer, one thread.
test('the same portal push twice is reported as a duplicate and creates one thread', async () => {
  const payload = { external_id: 'DUP-1', phone: '+919871000504', name: 'Repeat Rehan' }
  const url = `/ingest/portal/${agent.ingest_token}/magicbricks`
  const first = await jreq('POST', url, payload, null)
  const second = await jreq('POST', url, payload, null)

  assert.equal(first.duplicate, false)
  assert.ok(first.lead_id, 'the first push creates the thread')
  assert.equal(second.duplicate, true)
  assert.equal(second.lead_id, null, 'the repeat short-circuits at the dedupe gate')

  const { rows } = await query('SELECT id FROM leads WHERE agent_id = $1 AND wa_id = $2', [
    agent.id,
    '919871000504',
  ])
  assert.equal(rows.length, 1, 'and no second thread was opened for the same buyer')
})

// --- Health ---------------------------------------------------------------------

// Without WhatsApp credentials the live token probe is skipped entirely, so the
// endpoint still answers instead of hanging on a Graph call that cannot be made.
test('health reports the unconfigured state without probing the Graph API', async () => {
  const health = await jreq('GET', '/api/health', undefined, null)
  assert.equal(health.ok, true)
  assert.equal(health.whatsapp, false)
  assert.equal(health.whatsapp_send, false)
  assert.equal(health.whatsapp_reason, 'not_configured')
  assert.equal(health.signature, false, 'no app secret, so inbound signatures are unverified')

  // Called twice in a row it must stay stable — the cache must not turn the second
  // read into a different answer.
  assert.deepEqual(await jreq('GET', '/api/health', undefined, null), health)
})
