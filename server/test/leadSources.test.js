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
  formatListingForPortal, freeEntryWindow, ingestLead, ingestAddress, waDeepLink,
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

// --------------------------- ingest failure + auto-reply branches ---------------------------

test('ingestLead refuses a lead with no usable phone and records the failure', async () => {
  for (const phone of [null, '', '12345', 'not-a-number']) {
    const out = await ingestLead({ agent, channel: 'walk_in', phone, name: 'No Number Nandini' })
    assert.deepEqual(out, { ok: false, reason: 'no_phone' }, JSON.stringify(phone))
  }
  const { rows } = await query(
    `SELECT status, error, contact_name FROM lead_source_events
     WHERE agent_id = $1 AND status = 'failed' AND contact_name = 'No Number Nandini'`,
    [agent.id],
  )
  assert.equal(rows.length, 4)
  assert.equal(rows[0].error, 'no valid phone')
  assert.equal(rows[0].contact_name, 'No Number Nandini')
  // Nothing was created for an unreachable enquiry.
  assert.ok(!(await getLeadByAgentWaId(agent.id, '12345')))
})

// The instant WhatsApp intro is best-effort: it must report *why* it did not send
// rather than throwing, because the lead itself has already been created by then.
test('the auto-reply intro reports skipped:not_configured with WhatsApp off', async () => {
  const out = await ingestLead({ agent, channel: 'portal_email', portal: '99acres', phone: '9876500061', name: 'Intro Ila' })
  assert.equal(out.ok, true)
  assert.equal(out.isNew, true)
  assert.equal(out.autoReplyStatus, 'skipped:not_configured')
})

test('autoReply:false skips the intro without touching WhatsApp at all', async () => {
  const out = await ingestLead({ agent, channel: 'walk_in', phone: '9876500062', name: 'Silent Sunil', autoReply: false })
  assert.equal(out.autoReplyStatus, 'skipped:disabled')
})

test('a second touch on the same number merges instead of creating, and sends no intro', async () => {
  await ingestLead({ agent, channel: 'walk_in', phone: '9876500063', name: 'Repeat Rekha' })
  const second = await ingestLead({ agent, channel: 'portal_email', portal: 'housing', phone: '+91 98765 00063' })
  assert.equal(second.ok, true)
  assert.equal(second.isNew, false)
  assert.equal(second.autoReplyStatus, 'skipped:disabled', 'the intro only fires for a genuinely new lead')
  const { rows } = await query(
    `SELECT status FROM lead_source_events WHERE agent_id = $1 AND contact_phone = '+919876500063' ORDER BY id`,
    [agent.id],
  )
  assert.deepEqual(rows.map((r) => r.status), ['created', 'merged'])
})

test('the intro reports skipped:no_template when WhatsApp is live but no template is set', async () => {
  const saved = { ...process.env }
  process.env.WHATSAPP_ACCESS_TOKEN = 'test-token'
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-pnid'
  delete process.env.WHATSAPP_LEAD_INTRO_TEMPLATE
  try {
    const out = await ingestLead({ agent, channel: 'walk_in', phone: '9876500064', name: 'Template-less Tara' })
    assert.equal(out.autoReplyStatus, 'skipped:no_template')
  } finally {
    Object.assign(process.env, saved)
    delete process.env.WHATSAPP_ACCESS_TOKEN
    delete process.env.WHATSAPP_PHONE_NUMBER_ID
  }
})

test('the intro reports sent, with the buyer/source/business names as template params', async () => {
  const realFetch = global.fetch
  const calls = []
  process.env.WHATSAPP_ACCESS_TOKEN = 'test-token'
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-pnid'
  process.env.WHATSAPP_LEAD_INTRO_TEMPLATE = 'lead_intro'
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) })
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.intro' }] }), headers: { get: () => null } }
  }
  try {
    const out = await ingestLead({
      agent, channel: 'portal_email', portal: '99acres', phone: '9876500065',
      name: 'Sent Sameer', source_ref: 'Baner Heights',
    })
    assert.equal(out.autoReplyStatus, 'sent')
    assert.equal(calls.length, 1)
    const params = calls[0].body.template.components[0].parameters.map((p) => p.text)
    assert.deepEqual(params.slice(0, 2), ['Sent Sameer', 'Baner Heights'])
    assert.equal(calls[0].body.template.name, 'lead_intro')
    assert.equal(calls[0].body.template.language.code ?? calls[0].body.template.language, 'en')
  } finally {
    global.fetch = realFetch
    delete process.env.WHATSAPP_ACCESS_TOKEN
    delete process.env.WHATSAPP_PHONE_NUMBER_ID
    delete process.env.WHATSAPP_LEAD_INTRO_TEMPLATE
  }
})

test('the intro falls back to generic params when name and source are unknown', async () => {
  const realFetch = global.fetch
  const calls = []
  process.env.WHATSAPP_ACCESS_TOKEN = 'test-token'
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-pnid'
  process.env.WHATSAPP_LEAD_INTRO_TEMPLATE = 'lead_intro'
  global.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body))
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.x' }] }), headers: { get: () => null } }
  }
  try {
    await ingestLead({ agent, channel: 'phone', phone: '9876500066' })
    const params = calls[0].template.components[0].parameters.map((p) => p.text)
    assert.equal(params[0], 'there')
    assert.equal(params[1], 'your enquiry')
    assert.ok(params[2], 'the business/agent name always resolves to something')
  } finally {
    global.fetch = realFetch
    delete process.env.WHATSAPP_ACCESS_TOKEN
    delete process.env.WHATSAPP_PHONE_NUMBER_ID
    delete process.env.WHATSAPP_LEAD_INTRO_TEMPLATE
  }
})

test('a WhatsApp failure is recorded on the event, and never loses the lead', async () => {
  const realFetch = global.fetch
  process.env.WHATSAPP_ACCESS_TOKEN = 'test-token'
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-pnid'
  process.env.WHATSAPP_LEAD_INTRO_TEMPLATE = 'lead_intro'
  global.fetch = async () => { throw new Error('network down') }
  try {
    const out = await ingestLead({ agent, channel: 'walk_in', phone: '9876500067', name: 'Failed Farah' })
    assert.equal(out.ok, true)
    assert.match(out.autoReplyStatus, /^failed:/)
    assert.ok(out.lead, 'the lead survives a dead WhatsApp')
    const { rows } = await query(
      'SELECT auto_reply_status, status FROM lead_source_events WHERE id = $1', [out.event.id],
    )
    assert.match(rows[0].auto_reply_status, /^failed:/)
    assert.equal(rows[0].status, 'created')
  } finally {
    global.fetch = realFetch
    delete process.env.WHATSAPP_ACCESS_TOKEN
    delete process.env.WHATSAPP_PHONE_NUMBER_ID
    delete process.env.WHATSAPP_LEAD_INTRO_TEMPLATE
  }
})

test('formatListingForPortal renders sub-lakh prices in plain rupees', () => {
  const cheap = formatListingForPortal({ title: 'Parking slot', price_paise: 4500000 }, 'nobroker')
  assert.equal(cheap.price_display, '₹45,000')
  const lakhs = formatListingForPortal({ title: 'Studio', price_paise: 4500000_00 }, 'nobroker')
  assert.equal(lakhs.price_display, '₹45 L')
  const crores = formatListingForPortal({ title: 'Villa', price_paise: 25000000_00 }, 'nobroker')
  assert.equal(crores.price_display, '₹2.5 Cr')
  const unpriced = formatListingForPortal({ title: 'Ask us' }, 'nobroker')
  assert.equal(unpriced.price_display, null)
  assert.equal(unpriced.price_per_sqft, null)
})

test('freeEntryWindow reports an open, an expired and an absent window', () => {
  assert.equal(freeEntryWindow({}), null)
  assert.equal(freeEntryWindow(null), null)
  const open = freeEntryWindow({ free_entry_at: new Date(Date.now() - 3600_000).toISOString() })
  assert.equal(open.open, true)
  assert.ok(open.hours_left > 70 && open.hours_left <= 71)
  const closed = freeEntryWindow({ free_entry_at: new Date(Date.now() - 80 * 3600_000).toISOString() })
  assert.equal(closed.open, false)
  assert.equal(closed.hours_left, 0)
})

test('ingestAddress builds the workspace inbox address from the token', () => {
  assert.match(ingestAddress('abc123'), /^lead-abc123@/)
})

// --- parser edges that only show up on real portal mail --------------------

// Some providers ship a text/plain part that is only whitespace. Trusting its
// presence would parse an empty body and lose the lead; the HTML part is the
// one carrying the fields.
test('a whitespace-only text part falls through to the HTML body', () => {
  const parsed = parsePortalEmail({
    from: 'noreply@99acres.com',
    subject: 'New Response',
    text: '   \n\t  ',
    html: '<p>Name: Meera Joshi</p><p>Mobile: 9876543210</p>',
  })
  assert.equal(parsed.phone, '9876543210')
  assert.equal(parsed.name, 'Meera Joshi')
})

// The buyer's address is usually labelled, but some templates only drop it inline.
test('an unlabelled email address is recovered from the body, and absence stays null', () => {
  const inline = parsePortalEmail({
    from: 'noreply@housing.com',
    text: 'Mobile: 9876500011\nWrite to meera.joshi@example.com about this',
  })
  assert.equal(inline.email, 'meera.joshi@example.com')

  const none = parsePortalEmail({ from: 'noreply@housing.com', text: 'Mobile: 9876500012\nNo address here' })
  assert.equal(none.email, null)
})

// A template with no Name label must still yield the lead — the phone is what matters.
test('a portal email with no name label still parses, with a null name', () => {
  const parsed = parsePortalEmail({ from: 'noreply@99acres.com', text: 'Contact: 9876500013' })
  assert.equal(parsed.phone, '9876500013')
  assert.equal(parsed.name, null)
})

// Names arrive with signature blocks and disclaimers glued on. The column is bounded,
// so an overlong one is truncated rather than dropped or left to blow up the insert.
test('an overlong name is truncated to 80 characters', () => {
  const long = 'Ramesh '.repeat(20).trim() // well past 80
  const parsed = parsePortalEmail({ from: 'noreply@99acres.com', text: `Name: ${long}\nMobile: 9876500014` })
  assert.equal(parsed.name.length, 80)
  assert.ok(long.startsWith(parsed.name))
})

// --- Meta Lead Ads field_data shapes --------------------------------------

test('leadgen fields tolerate a nameless entry and a bare (non-array) value', () => {
  const parsed = parseLeadgenFields([
    { values: ['orphan'] }, // no name at all — nothing to key on
    { name: '', values: ['blank'] }, // empty name, same
    { name: 'full_name', values: 'Anita Rao' }, // Meta sometimes sends a scalar
    { name: 'phone_number', values: ['+91 98765 00015'] },
  ])
  assert.equal(parsed.name, 'Anita Rao')
  assert.equal(parsed.phone, '9876500015')
})

// A number that isn't an Indian mobile still has to reach the agent — we keep the
// digits rather than dropping the lead on the floor.
test('a non-mobile leadgen number degrades to its digits', () => {
  const landline = parseLeadgenFields([{ name: 'phone_number', values: ['020-2233 4455'] }])
  assert.equal(landline.phone, '02022334455')
  assert.equal(parseLeadgenFields([{ name: 'name', values: ['No Phone'] }]).phone, null)
})

// --- referral + deep link edges -------------------------------------------

// An organic post referral carries a source_type and nothing else; the other fields
// must read null instead of undefined so they store cleanly.
test('a referral with only a source_type nulls the rest', () => {
  const r = extractReferral({ referral: { source_type: 'post' } })
  assert.deepEqual(r, {
    ctwa_clid: null, source_id: null, source_type: 'post',
    source_url: null, headline: null, body: null, media_type: null,
  })
})

test('waDeepLink omits the query string when there is no opener text', () => {
  assert.equal(waDeepLink('+91 98765 00016'), 'https://wa.me/919876500016')
  assert.match(waDeepLink('+91 98765 00016', 'Hi there'), /\?text=Hi%20there$/)
})

// --- listing formatting edges ---------------------------------------------

test('listing copy defaults the area unit and survives a floor with no building height', () => {
  const listing = formatListingForPortal(
    { title: 'Tower flat', locality: 'Baner', city: 'Pune', size_sqft: 1180, floor: 7 },
    'housing',
  )
  assert.match(listing.description, /1180 sqft/, 'a missing size_unit defaults to sqft')
  assert.match(listing.description, /floor 7\./, 'no "of N" when total_floors is unknown')

  const withUnit = formatListingForPortal(
    { title: 'Tower flat', size_sqft: 1180, size_unit: 'sqm', floor: 7, total_floors: 14 },
    'housing',
  )
  assert.match(withUnit.description, /1180 sqm/)
  assert.match(withUnit.description, /floor 7 of 14\./)
})

// --- an email from a portal we don't recognise -----------------------------

// detectPortal returns null for an unknown sender, so the activity line has no portal
// to name and falls back to the channel. The lead must still land.
test('a parseable lead from an unrecognised sender is ingested without a portal', async () => {
  const fresh = await getAgent(agent.id)
  const res = await req('POST', `/ingest/email/${fresh.ingest_token}`, {
    from: 'leads@some-local-portal.in',
    subject: 'Enquiry received',
    text: 'Name: Vikram Shetty\nMobile: 9876500017\nProperty: Skyline Residency',
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.portal, null, 'the sender matched no known portal')
  assert.ok(body.lead_id)

  const lead = await getLeadByAgentWaId(agent.id, '919876500017')
  assert.ok(lead, 'the lead landed under its normalized number')
  assert.equal(lead.source_channel, 'portal_email')
})
