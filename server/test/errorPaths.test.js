// Error-path coverage for the HTTP layer.
//
// The happy paths are covered elsewhere; what an agent actually hits on a bad day
// is the other half — a malformed body, a stale id, a locked template, a closed
// service window, someone else's record. Each of these must come back as a specific
// status and code, because the UI branches on them. A route that quietly 500s here
// is a route that shows the agent "Something went wrong" for a fixable mistake.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('errorpaths')

const { app } = await import('../index.js')
const { closePool, query, upsertLead, addMessage, addContact, createProperty } = await import('../db.js')

let server
let base
let token
let agentId
let leadId
let propertyId
let otherToken
let otherLeadId

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

// Raw variant for the malformed-body cases, where JSON.stringify would be wrong.
const rawReq = (method, url, rawBody, contentType = 'application/json') =>
  fetch(base + url, {
    method,
    headers: { 'content-type': contentType, authorization: `Bearer ${token}` },
    body: rawBody,
  })

const signup = async (name, phone) =>
  (await (await req('POST', '/api/auth/signup', { name, phone, password: 'secret123' }, null)).json())

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const me = await signup('Errors Agent', '+919700000001')
  token = me.token
  agentId = me.agent.id

  const lead = await upsertLead(agentId, '919700100001', 'Anita Deshmukh')
  leadId = lead.id
  const property = await createProperty(agentId, { title: 'Baner 2BHK', locality: 'Baner', price_l: 95 })
  propertyId = property.id

  // A second workspace, for cross-tenant checks.
  const them = await signup('Other Agent', '+919700000002')
  otherToken = them.token
  otherLeadId = (await upsertLead(them.agent.id, '919700200001', 'Their Buyer')).id
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- The last-resort error handler -----------------------------------------

test('a malformed JSON body is a 400 BAD_JSON, not a 500', async () => {
  const res = await rawReq('POST', '/api/followups', '{"lead_id": 1,,}')
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.code, 'BAD_JSON')
  assert.match(body.error, /valid JSON/)
})

test('an oversized JSON body is a 413 PAYLOAD_TOO_LARGE', async () => {
  // The JSON limit is 25mb (media arrives as base64); go past it so body-parser
  // raises entity.too.large. The handler must map it rather than let express's
  // raw error reach the client as a 500.
  const huge = JSON.stringify({ note: 'x'.repeat(26 * 1024 * 1024) })
  const res = await rawReq('POST', '/api/followups', huge)
  assert.equal(res.status, 413)
  assert.equal((await res.json()).code, 'PAYLOAD_TOO_LARGE')
})

test('a client-supplied foreign id comes back 404, never 403 — existence is not leaked', async () => {
  // otherLeadId is real, but belongs to the other workspace.
  const res = await req('POST', '/api/followups', {
    lead_id: otherLeadId,
    due_at: new Date(Date.now() + 86_400_000).toISOString(),
  })
  assert.equal(res.status, 404)
  const body = await res.json()
  assert.ok(body.code === 'NOT_FOUND' || res.status === 404, 'foreign id must not resolve')
  assert.ok(!/forbidden|not yours|belongs/i.test(body.error || ''), 'the message must not confirm it exists')
})

// --- Validation 400s --------------------------------------------------------

test('EMI rejects a request with no parseable loan amount', async () => {
  const res = await req('POST', '/api/emi', { text: 'what is the weather like' })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /loan amount/)
})

test('EMI rejects a non-positive principal', async () => {
  const res = await req('POST', '/api/emi', { principal_l: 0 })
  assert.equal(res.status, 400)
})

test('EMI rejects a body with neither text nor principal', async () => {
  const res = await req('POST', '/api/emi', {})
  assert.equal(res.status, 400)
})

test('site visits require both a lead and a time', async () => {
  assert.equal((await req('POST', '/api/site-visits', { lead_id: leadId })).status, 400)
  assert.equal(
    (await req('POST', '/api/site-visits', { scheduled_at: new Date().toISOString() })).status,
    400,
  )
})

test('a site visit against an unknown property is 404, not a foreign-key 500', async () => {
  const res = await req('POST', '/api/site-visits', {
    lead_id: leadId,
    property_id: 9_999_999,
    scheduled_at: new Date(Date.now() + 86_400_000).toISOString(),
  })
  assert.equal(res.status, 404)
  assert.match((await res.json()).error, /property not found/)
})

test('a site visit against another workspace’s property is 404', async () => {
  const theirs = await createProperty(
    (await query('SELECT id FROM agents WHERE phone = $1', ['+919700000002'])).rows[0].id,
    { title: 'Their Flat', locality: 'Kothrud', price_l: 60 },
  )
  const res = await req('POST', '/api/site-visits', {
    lead_id: leadId,
    property_id: theirs.id,
    scheduled_at: new Date(Date.now() + 86_400_000).toISOString(),
  })
  assert.equal(res.status, 404)
})

test('follow-ups require a lead and a due date', async () => {
  assert.equal((await req('POST', '/api/followups', { lead_id: leadId })).status, 400)
  assert.equal((await req('POST', '/api/followups', {})).status, 400)
})

test('quick-add rejects a missing phone, a bad channel and an unusable number', async () => {
  assert.equal((await req('POST', '/api/leads/quick-add', { name: 'No Phone' })).status, 400)

  const badChannel = await req('POST', '/api/leads/quick-add', { phone: '+919700300001', channel: 'carrier-pigeon' })
  assert.equal(badChannel.status, 400)
  assert.match((await badChannel.json()).error, /invalid channel/)

  const badPhone = await req('POST', '/api/leads/quick-add', { phone: '123' })
  assert.equal(badPhone.status, 400)
  assert.match((await badPhone.json()).error, /valid phone/)
})

test('send-to-chat requires a lead id and rejects unknown property or lead', async () => {
  assert.equal((await req('POST', `/api/properties/${propertyId}/send-to-chat`, {})).status, 400)

  const noProp = await req('POST', '/api/properties/9999999/send-to-chat', { lead_id: leadId })
  assert.equal(noProp.status, 404)
  assert.match((await noProp.json()).error, /property not found/)

  const noLead = await req('POST', `/api/properties/${propertyId}/send-to-chat`, { lead_id: 9_999_999 })
  assert.equal(noLead.status, 404)
  assert.match((await noLead.json()).error, /lead not found/)
})

test('a media asset needs either a url or file data', async () => {
  const res = await req('POST', '/api/media', { title: 'Brochure', kind: 'brochure' })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /url or data_base64/)
})

test('a raw upload with no file data is a 400', async () => {
  const res = await req('POST', '/api/uploads', { filename: 'plan.pdf' })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /data_base64/)
})

test('festive send rejects an unknown festival, an unparseable date and a past date', async () => {
  const unknown = await req('POST', '/api/templates/festive/send', { festival: 'not-a-festival' })
  assert.equal(unknown.status, 400)
  assert.match((await unknown.json()).error, /Unknown festival/)

  const festivals = (await (await req('GET', '/api/templates/festive')).json()).festivals
  const key = festivals[0].key

  const badDate = await req('POST', '/api/templates/festive/send', { festival: key, send_at: 'sometime soon' })
  assert.equal(badDate.status, 400)
  assert.match((await badDate.json()).error, /Invalid send_at/)

  const past = await req('POST', '/api/templates/festive/send', {
    festival: key,
    send_at: new Date(Date.now() - 86_400_000).toISOString(),
  })
  assert.equal(past.status, 400)
  assert.match((await past.json()).error, /future/)
})

test('a leadgen form id must be present and syntactically plausible', async () => {
  assert.equal((await req('POST', '/api/lead-sources/leadgen-form', {})).status, 400)

  const weird = await req('POST', '/api/lead-sources/leadgen-form', { form_id: 'drop table; --' })
  assert.equal(weird.status, 400)
  assert.match((await weird.json()).error, /plain Meta form identifier/)

  const tooLong = await req('POST', '/api/lead-sources/leadgen-form', { form_id: 'f'.repeat(101) })
  assert.equal(tooLong.status, 400)
})

test('a group blast with an empty message is refused before any recipient is touched', async () => {
  const group = await (await req('POST', '/api/groups', { name: 'Blast Group', kind: 'static' })).json()
  const res = await req('POST', `/api/groups/${group.id}/send`, { message: '   ' })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /message is required/)
})

// --- Not-found 404s ---------------------------------------------------------

test('stale ids on templates, media, labels, groups and notifications all 404', async () => {
  const cases = [
    ['PUT', '/api/templates/9999999', { name: 'x' }],
    ['DELETE', '/api/templates/9999999', undefined],
    ['DELETE', '/api/media/9999999', undefined],
    // A stale label id must be a 404, not the system-label 403 — deleteLabel()
    // used to return a bare false for both.
    ['DELETE', '/api/labels/9999999', undefined],
    ['GET', '/api/groups/9999999/members', undefined],
    ['PUT', '/api/groups/9999999', { name: 'x' }],
    ['DELETE', '/api/groups/9999999', undefined],
    ['DELETE', '/api/templates/festive/9999999', undefined],
    ['PUT', '/api/notifications/9999999/read', undefined],
  ]
  for (const [method, url, body] of cases) {
    const res = await req(method, url, body)
    assert.equal(res.status, 404, `${method} ${url} should 404, got ${res.status}`)
  }
})

test('sending media to an unknown lead or an unknown asset both 404', async () => {
  const noLead = await req('POST', '/api/media/1/send', { lead_id: 9_999_999 })
  assert.equal(noLead.status, 404)
  assert.match((await noLead.json()).error, /lead not found/)

  const noAsset = await req('POST', '/api/media/9999999/send', { lead_id: leadId })
  assert.equal(noAsset.status, 404)
  assert.match((await noAsset.json()).error, /media not found/)
})

test('adding members to a dynamic group is refused as a 400, not silently ignored', async () => {
  const dynamic = await (
    await req('POST', '/api/groups', { name: 'Dynamic Seg', kind: 'dynamic', criteria: { temp: 'Hot' } })
  ).json()
  const contact = await addContact(agentId, '919700400001', 'Segment Contact')
  const res = await req('POST', `/api/groups/${dynamic.id}/members`, { contact_ids: [contact.id] })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /not a static group/)
})

// --- Conflict 409s ----------------------------------------------------------

test('a duplicate group name is a 409, not a raw unique-violation 500', async () => {
  await req('POST', '/api/groups', { name: 'Unique Group', kind: 'static' })
  const again = await req('POST', '/api/groups', { name: 'Unique Group', kind: 'static' })
  assert.equal(again.status, 409)
  assert.match((await again.json()).error, /group with that name exists/)
})

test('claiming a leadgen form another workspace already owns is a 409 FORM_TAKEN', async () => {
  assert.equal((await req('POST', '/api/lead-sources/leadgen-form', { form_id: 'form-shared-1' })).status, 200)

  const stolen = await req('POST', '/api/lead-sources/leadgen-form', { form_id: 'form-shared-1' }, otherToken)
  assert.equal(stolen.status, 409)
  assert.equal((await stolen.json()).code, 'FORM_TAKEN')

  // Re-claiming your own form stays idempotent.
  assert.equal((await req('POST', '/api/lead-sources/leadgen-form', { form_id: 'form-shared-1' })).status, 200)
})

test('a duplicate invoice number on a commission is a 409', async () => {
  const commission = await (
    await req('POST', '/api/commissions', {
      lead_id: leadId,
      deal_value_paise: 95_00_000_00, // ₹95L
      commission_pct: 2,
      status: 'expected',
    })
  ).json()
  assert.ok(commission.id, `commission not created: ${JSON.stringify(commission)}`)

  const first = await req('POST', `/api/commissions/${commission.id}/invoice`, { invoice_number: 'INV-DUP-1' })
  assert.equal(first.status, 200)

  const second = await req('POST', `/api/commissions/${commission.id}/invoice`, { invoice_number: 'INV-DUP-1' })
  assert.equal(second.status, 409)
  assert.match((await second.json()).error, /invoice number already exists/)
})

test('an invoice for an unknown commission is a 404', async () => {
  const res = await req('POST', '/api/commissions/9999999/invoice', {})
  assert.equal(res.status, 404)
})

// --- Forbidden 403s ---------------------------------------------------------

test('an approved template rejects wording edits but accepts metadata', async () => {
  const templates = await (await req('GET', '/api/templates')).json()
  const locked = templates.find((t) => t.is_locked || t.meta_status === 'approved')
  assert.ok(locked, 'the seeded workspace should ship a locked template')

  const edit = await req('PUT', `/api/templates/${locked.id}`, { body: 'Completely different wording' })
  assert.equal(edit.status, 403)
  assert.equal((await edit.json()).code, 'TEMPLATE_LOCKED')

  // Metadata-only changes are still allowed on the same template.
  const meta = await req('PUT', `/api/templates/${locked.id}`, { rera_auto_append: true })
  assert.equal(meta.status, 200)
})

test('system templates and system labels cannot be deleted', async () => {
  const templates = await (await req('GET', '/api/templates')).json()
  const sys = templates.find((t) => t.is_system)
  assert.ok(sys, 'the seeded workspace should ship system templates')
  const delTpl = await req('DELETE', `/api/templates/${sys.id}`)
  assert.equal(delTpl.status, 403)
  assert.equal((await delTpl.json()).code, 'TEMPLATE_SYSTEM')

  const labels = await (await req('GET', '/api/labels')).json()
  const sysLabel = labels.find((l) => l.is_system)
  assert.ok(sysLabel, 'the seeded workspace should ship system labels')
  assert.equal((await req('DELETE', `/api/labels/${sysLabel.id}`)).status, 403)
})

test('a label the agent created still deletes, and deleting it twice then 404s', async () => {
  const label = await (await req('POST', '/api/labels', { name: 'Investor', color: '#0ea5e9' })).json()
  assert.ok(label.id, `label not created: ${JSON.stringify(label)}`)

  assert.equal((await req('DELETE', `/api/labels/${label.id}`)).status, 200)
  // Second delete: gone, so 404 — not the system-label 403.
  const again = await req('DELETE', `/api/labels/${label.id}`)
  assert.equal(again.status, 404)
  assert.notEqual((await again.json()).code, 'LABEL_SYSTEM')
})

test('another workspace’s label is a 404, not a 403 that confirms it exists', async () => {
  const theirs = await (await req('POST', '/api/labels', { name: 'Their Label' }, otherToken)).json()
  const res = await req('DELETE', `/api/labels/${theirs.id}`)
  assert.equal(res.status, 404)
})

// --- Service-window 409s ----------------------------------------------------

test('media cannot be pushed into a chat whose 24h window has closed', async () => {
  const stale = await upsertLead(agentId, '919700500001', 'Stale Window')
  await addMessage(stale.id, 'buyer', 'hello?')
  await query(`UPDATE leads SET last_inbound_at = now() - interval '30 hours' WHERE id = $1`, [stale.id])

  const asset = await (
    await req('POST', '/api/media', { title: 'Floor plan', kind: 'floor_plan', url: 'https://example.com/fp.pdf' })
  ).json()

  const res = await req('POST', `/api/media/${asset.id}/send`, { lead_id: stale.id })
  assert.equal(res.status, 409)
  const body = await res.json()
  assert.equal(body.code, 'WINDOW_EXPIRED')
  assert.equal(body.service_window.open, false)
})

// --- Auth 401s --------------------------------------------------------------

test('every authenticated route rejects a missing or garbage bearer token', async () => {
  const routes = ['/api/leads', '/api/dashboard', '/api/worklist', '/api/stats', '/api/templates', '/api/groups']
  for (const url of routes) {
    assert.equal((await req('GET', url, undefined, null)).status, 401, `${url} without a token`)
    assert.equal((await req('GET', url, undefined, 'not-a-real-token')).status, 401, `${url} with a bad token`)
  }
})

test('login with a wrong password does not reveal whether the account exists', async () => {
  const wrongPass = await req('POST', '/api/auth/login', { phone: '+919700000001', password: 'wrong-one' }, null)
  const noAccount = await req('POST', '/api/auth/login', { phone: '+919700999999', password: 'wrong-one' }, null)
  assert.equal(wrongPass.status, noAccount.status, 'both must fail the same way')
  assert.equal(await (await wrongPass).text(), await (await noAccount).text())
})
