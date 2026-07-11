// Lead Source Integrations (migration 010): portal email ingest, direct portal push,
// Meta Lead Ads parsing, click-to-WhatsApp attribution, walk-in quick-add, and listing
// syndication. Parsing is deterministic so this runs with no AI / WhatsApp configured.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
delete process.env.WHATSAPP_PHONE_NUMBER_ID
const dbName = await createTestDb('leadsources')

const { app } = await import('../index.js')
const { closePool, query, getAgent, getLeadByAgentWaId, recordCtwaReferral, upsertLead } = await import('../db.js')
const {
  parsePortalEmail, parseLeadgenFields, detectPortal, extractReferral,
  formatListingForPortal, freeEntryWindow, ingestLead, ingestAddress,
} = await import('../leadSources.js')

let server, base, token, agent

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const out = await (
    await req('POST', '/api/auth/signup', { name: 'Sourcing Sana', phone: '+919800000091', password: 'secret123' })
  ).json()
  token = out.token
  agent = await getAgent(out.agent.id)
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --------------------------- pure parsers ---------------------------

test('detectPortal recognizes the major Indian portals', () => {
  assert.equal(detectPortal({ from: 'noreply@99acres.com' }), '99acres')
  assert.equal(detectPortal({ subject: 'New lead from MagicBricks' }), 'magicbricks')
  assert.equal(detectPortal({ from: 'leads@housing.com' }), 'housing')
  assert.equal(detectPortal({ text: 'via NoBroker' }), 'nobroker')
  assert.equal(detectPortal({ from: 'x@y.com' }), null)
})

test('parsePortalEmail extracts a 99acres lead from a labelled body', () => {
  const parsed = parsePortalEmail({
    from: 'noreply@99acres.com',
    subject: 'You have received a new response on 99acres',
    text: [
      'Dear Advertiser,',
      'Name: Ramesh Kumar',
      'Mobile: 9876543210',
      'Email: ramesh@example.com',
      'Property: 2 BHK in Baner',
      'Message: Please call me for a site visit.',
      'Response ID: 99A-556677',
    ].join('\n'),
  })
  assert.equal(parsed.portal, '99acres')
  assert.equal(parsed.name, 'Ramesh Kumar')
  assert.equal(parsed.phone, '9876543210')
  assert.equal(parsed.email, 'ramesh@example.com')
  assert.equal(parsed.property, '2 BHK in Baner')
  assert.equal(parsed.external_id, '99A-556677')
})

test('parsePortalEmail handles an HTML-only MagicBricks email and +91 numbers', () => {
  const parsed = parsePortalEmail({
    from: 'alerts@magicbricks.com',
    subject: 'New Lead from MagicBricks',
    html: '<div>Name - Priya Shah<br>Mobile - +91 98200 12345<br>Interested In: 3 BHK Wakad<br>Lead ID: MB-889900</div>',
  })
  assert.equal(parsed.portal, 'magicbricks')
  assert.equal(parsed.name, 'Priya Shah')
  assert.equal(parsed.phone, '9820012345')
  assert.equal(parsed.property, '3 BHK Wakad')
  assert.equal(parsed.external_id, 'MB-889900')
})

test('parsePortalEmail returns null when there is no contact number', () => {
  assert.equal(parsePortalEmail({ from: 'noreply@99acres.com', text: 'no phone here' }), null)
})

test('parseLeadgenFields normalizes Meta Lead Ads field_data', () => {
  const parsed = parseLeadgenFields([
    { name: 'full_name', values: ['Anita Desai'] },
    { name: 'phone_number', values: ['+91 99887 66554'] },
    { name: 'email', values: ['anita@example.com'] },
    { name: 'which_property', values: ['Kolte Patil 24K'] },
    { name: 'city', values: ['Pune'] },
  ])
  assert.equal(parsed.name, 'Anita Desai')
  assert.equal(parsed.phone, '9988766554')
  assert.equal(parsed.property, 'Kolte Patil 24K')
  assert.equal(parsed.city, 'Pune')
})

test('extractReferral reads a click-to-WhatsApp referral off a message', () => {
  assert.equal(extractReferral({ text: { body: 'hi' } }), null)
  const r = extractReferral({
    referral: { source_type: 'ad', source_id: '120021', ctwa_clid: 'CLID_ABC', headline: '2BHK Baner ₹85L' },
  })
  assert.equal(r.ctwa_clid, 'CLID_ABC')
  assert.equal(r.source_type, 'ad')
  assert.equal(r.headline, '2BHK Baner ₹85L')
})

test('formatListingForPortal renders price and portal-specific fields', () => {
  const property = {
    id: 1, title: 'Sunrise Residency', property_type: 'apartment', bhk: '2',
    size_sqft: 950, size_unit: 'sqft', price_paise: 85_0000000, locality: 'Baner', city: 'Pune',
    facing: 'East', floor: 7, total_floors: 14, rera_project_number: 'P52100012345',
    amenities: ['Gym', 'Pool'], builder_name: 'Sunrise Group',
  }
  const acres = formatListingForPortal(property, '99acres')
  assert.equal(acres.price_display, '₹85 L')
  assert.equal(acres.fields.expectedPrice, 8500000)
  assert.equal(acres.fields.reraId, 'P52100012345')
  assert.match(acres.description, /Baner/)
  assert.match(acres.whatsapp_text, /RERA/)
  const cr = formatListingForPortal({ ...property, price_paise: 1_250_000_000 }, 'magicbricks')
  assert.equal(cr.price_display, '₹1.25 Cr')
  assert.throws(() => formatListingForPortal(property, 'olx'))
})

// --------------------------- email ingest endpoint ---------------------------

test('GET /api/lead-sources exposes the workspace ingest email', async () => {
  const data = await (await req('GET', '/api/lead-sources')).json()
  assert.ok(data.ingest_token)
  assert.equal(data.ingest_email, ingestAddress(data.ingest_token))
})

test('POST /ingest/email/:token creates a tagged lead and dedupes on external id', async () => {
  const email = {
    from: 'noreply@99acres.com',
    subject: 'You have received a new response on 99acres',
    text: 'Name: Vikram Rao\nMobile: 9876500011\nProperty: 3 BHK Kharadi\nResponse ID: 99A-DEDUPE-1',
  }
  const r1 = await (await req('POST', `/ingest/email/${agent.ingest_token}`, email)).json()
  assert.equal(r1.ok, true)
  assert.equal(r1.portal, '99acres')
  assert.ok(r1.lead_id)
  assert.equal(r1.auto_reply, 'skipped:not_configured')

  const lead = await getLeadByAgentWaId(agent.id, '919876500011')
  assert.ok(lead, 'lead created for the portal phone number')
  assert.equal(lead.source_channel, 'portal_email')
  assert.equal(lead.source_portal, '99acres')
  assert.equal(lead.source_ref, '3 BHK Kharadi')

  // Re-delivering the same portal response id must not create a second lead.
  const r2 = await (await req('POST', `/ingest/email/${agent.ingest_token}`, email)).json()
  assert.equal(r2.duplicate, true)
  const { rows } = await query('SELECT COUNT(*)::int n FROM leads WHERE agent_id = $1 AND wa_id = $2', [agent.id, '919876500011'])
  assert.equal(rows[0].n, 1)

  const events = await (await req('GET', '/api/lead-sources?channel=portal_email')).json()
  assert.ok(events.events.some((e) => e.external_id === '99A-DEDUPE-1' && e.status === 'created'))
})

test('POST /ingest/email/:token 404s on an unknown token and 202s on an unparseable email', async () => {
  assert.equal((await req('POST', '/ingest/email/nope', { text: 'x' })).status, 404)
  const res = await req('POST', `/ingest/email/${agent.ingest_token}`, { from: 'noreply@99acres.com', text: 'no number' })
  assert.equal(res.status, 202)
  assert.equal((await res.json()).ok, false)
})

// --------------------------- direct portal push ---------------------------

test('POST /ingest/portal/:token/:portal ingests a structured pushed lead', async () => {
  const res = await req('POST', `/ingest/portal/${agent.ingest_token}/magicbricks`, {
    name: 'Push Pooja', phone: '9876500022', property: 'MB Villa', external_id: 'MB-PUSH-1',
  })
  const body = await res.json()
  assert.equal(body.ok, true)
  const lead = await getLeadByAgentWaId(agent.id, '919876500022')
  assert.equal(lead.source_channel, 'portal_api')
  assert.equal(lead.source_portal, 'magicbricks')
  assert.equal((await req('POST', `/ingest/portal/${agent.ingest_token}/olx`, { phone: '9876500099' })).status, 400)
})

// --------------------------- Meta Lead Ads ingest (function-level) ---------------------------

test('ingestLead(meta_lead_ad) creates a lead and dedupes on leadgen id', async () => {
  const r1 = await ingestLead({
    agent, channel: 'meta_lead_ad', external_id: 'LEADGEN-777',
    name: 'Adwait Ad', phone: '9876500033', source_ref: 'FB: 2BHK Baner',
    source_meta: { ad_id: 'AD1', form_id: 'F1' },
  })
  assert.equal(r1.ok, true)
  assert.equal(r1.isNew, true)
  const lead = await getLeadByAgentWaId(agent.id, '919876500033')
  assert.equal(lead.source_channel, 'meta_lead_ad')
  assert.equal(lead.source_meta.ad_id, 'AD1')

  const r2 = await ingestLead({ agent, channel: 'meta_lead_ad', external_id: 'LEADGEN-777', phone: '9876500033' })
  assert.equal(r2.duplicate, true)
})

// --------------------------- CTWA 72h window ---------------------------

test('recordCtwaReferral opens a 72-hour free-entry window on the lead', async () => {
  const lead = await upsertLead(agent.id, '919876500044', 'CTWA Chetan')
  await recordCtwaReferral(lead.id, { ctwa_clid: 'CLID_XYZ', source_type: 'ad', headline: 'Ready 2BHK' })
  const full = await (await req('GET', `/api/leads/${lead.id}`)).json()
  assert.ok(full.free_entry_window)
  assert.equal(full.free_entry_window.open, true)
  assert.ok(full.free_entry_window.hours_left > 71 && full.free_entry_window.hours_left <= 72)
  assert.equal(full.ctwa_clid, 'CLID_XYZ')

  // A non-ad lead has no free-entry window.
  const plain = await upsertLead(agent.id, '919876500045', 'Plain Priya')
  assert.equal(freeEntryWindow(plain), null)
})

// --------------------------- walk-in / phone quick-add ---------------------------

test('POST /api/leads/quick-add creates a walk-in lead with tags and a wa.me deep link', async () => {
  const res = await req('POST', '/api/leads/quick-add', {
    phone: '9876500055', name: 'Walkin Waman', tags: ['hot', 'baner', '2bhk'],
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.match(body.wa_deeplink, /^https:\/\/wa\.me\/919876500055\?text=/)
  const lead = await getLeadByAgentWaId(agent.id, '919876500055')
  assert.equal(lead.source_channel, 'walk_in')
  assert.equal(lead.source_meta.tags.length, 3)
  // Tags were written onto the linked contact as labels.
  const contact = (await query('SELECT labels FROM contacts WHERE phone = $1', ['+919876500055'])).rows[0]
  assert.deepEqual(contact.labels, ['hot', 'baner', '2bhk'])

  assert.equal((await req('POST', '/api/leads/quick-add', { name: 'no phone' })).status, 400)
})

// --------------------------- portal integrations + syndication ---------------------------

test('PUT /api/portal-integrations/:portal stores config and never returns secrets', async () => {
  const row = await (await req('PUT', '/api/portal-integrations/99acres', {
    enabled: true, api_key: 'SECRETKEY123', config: { feed: 'daily' },
  })).json()
  assert.equal(row.enabled, true)
  assert.equal(row.has_api_key, true)
  assert.equal(row.api_key, undefined, 'secret is masked out of the response')
  const list = await (await req('GET', '/api/portal-integrations')).json()
  assert.ok(list.some((p) => p.portal === '99acres' && p.has_api_key === true))
})

test('syndication previews all portals and exports one', async () => {
  const property = await (await req('POST', '/api/properties', {
    title: 'Baner Heights', property_type: 'apartment', bhk: '2', size_sqft: 900,
    price_paise: 85_0000000, locality: 'Baner', city: 'Pune', status: 'available',
    rera_project_number: 'P52100099999',
  })).json()

  const synd = await (await req('GET', `/api/properties/${property.id}/syndications`)).json()
  assert.equal(synd.portals.length, 4)
  assert.equal(synd.preview.length, 4)
  assert.ok(synd.preview.find((p) => p.portal === '99acres').price_display)
  assert.equal(synd.saved.length, 0)

  const exported = await (await req('POST', `/api/properties/${property.id}/syndicate`, { portal: '99acres' })).json()
  assert.equal(exported.portal, '99acres')
  assert.equal(exported.status, 'exported')
  assert.ok(exported.exported_at)
  assert.equal(exported.formatted.fields.reraId, 'P52100099999')

  const after = await (await req('GET', `/api/properties/${property.id}/syndications`)).json()
  assert.equal(after.saved.length, 1)
  assert.equal((await req('POST', `/api/properties/${property.id}/syndicate`, { portal: 'olx' })).status, 400)
})
