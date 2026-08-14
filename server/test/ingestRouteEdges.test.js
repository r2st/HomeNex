// The three ways a lead arrives without a WhatsApp message, fed the least a real
// sender ever sends: a portal notification email that is HTML only, a portal push
// carrying nothing but a phone number, and a Meta Lead Ad whose form nobody has
// mapped to an agent.
//
// Every one of these routes builds its ingestLead() call out of `a || b || null`
// chains over fields the sender is free to omit. The happy-path suites always send
// the full object, so the fallbacks — the half that decides whether a column gets a
// value or the string "undefined" — never run.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_PHONE_NUMBER_ID
delete process.env.WHATSAPP_APP_SECRET
delete process.env.META_LEADGEN_DEFAULT_AGENT_ID
process.env.META_PAGE_ACCESS_TOKEN = 'ingest-page-token'
const dbName = await createTestDb('ingestroutes')

const { app } = await import('../index.js')
const { ready, closePool, query, getAgent } = await import('../db.js')

await ready

const realFetch = global.fetch
let server, base, token, agentId, ingestToken
// What the Graph API returns for a leadgen fetch.
let leadgen = null

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
const json = async (...args) => (await req(...args)).json()

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  global.fetch = async (url, opts) => {
    const target = String(url)
    if (target.startsWith(base)) return realFetch(url, opts)
    if (!target.includes('graph.facebook.com')) throw new Error(`unexpected outbound call: ${target}`)
    return new Response(JSON.stringify(leadgen ?? {}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const out = await json('POST', '/api/auth/signup', {
    name: 'Ingest Ira',
    phone: '+919877500001',
    password: 'secret123',
  }, null)
  token = out.token
  agentId = out.agent.id
  ingestToken = (await query('SELECT ingest_token FROM agents WHERE id = $1', [agentId])).rows[0].ingest_token
})

after(async () => {
  global.fetch = realFetch
  server?.close()
  await new Promise((r) => setTimeout(r, 150))
  await closePool()
  await dropTestDb(dbName)
})

const eventFor = async (leadId) =>
  (await query('SELECT * FROM lead_source_events WHERE lead_id = $1 ORDER BY id DESC LIMIT 1', [leadId])).rows[0]

// --- Portal notification email, HTML only ------------------------------------

test('a portal email that is HTML only is parsed and stored with an empty text body', async () => {
  // Mailgun/SendGrid inbound parse sends `text` empty when the portal only sent
  // HTML. The raw payload we keep for replay has to record that as '' rather than
  // slicing `undefined`.
  const res = await req('POST', `/ingest/email/${ingestToken}`, {
    from: 'noreply@99acres.com',
    subject: 'New response for your property',
    html: '<html><body><p>Name: Meera Joshi</p><p>Mobile: 9876500011</p><p>Project: Lakeview Enclave</p></body></html>',
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.portal, '99acres')

  const event = await eventFor(body.lead_id)
  assert.equal(event.raw.text, '', 'an absent text body is stored as empty, not as "undefined"')
  assert.equal(event.raw.from, 'noreply@99acres.com')

  const { rows } = await query('SELECT * FROM leads WHERE id = $1', [body.lead_id])
  assert.equal(rows[0].name, 'Meera Joshi')
  assert.equal(rows[0].source_ref, 'Lakeview Enclave')
})

test('a portal email with no phone in it is a 202 and a failed event, not a lead', async () => {
  const before = (await query('SELECT COUNT(*)::int AS n FROM leads')).rows[0].n
  const res = await req('POST', `/ingest/email/${ingestToken}`, {
    from: 'noreply@magicbricks.com',
    subject: 'Newsletter',
    text: 'Nothing here resembles a contact number.',
  })
  assert.equal(res.status, 202)
  assert.deepEqual(await res.json(), { ok: false, reason: 'no_lead_parsed' })
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM leads')).rows[0].n, before, 'no lead was created')

  const { rows } = await query(
    `SELECT * FROM lead_source_events WHERE agent_id = $1 AND status = 'failed' ORDER BY id DESC LIMIT 1`,
    [agentId],
  )
  assert.equal(rows[0].error, 'no contact phone parsed from email')
})

test('an unknown ingest address is a 404 rather than a lead for nobody', async () => {
  const res = await req('POST', '/ingest/email/not-a-real-token', { from: 'x@y.com', text: 'call 9876500099' })
  assert.equal(res.status, 404)
})

test('an oversized email body is refused before it reaches the parser', async () => {
  // parsePortalEmail runs ten chained regex passes over the body and then builds a
  // fresh RegExp per label, all on the event loop, at a cost that grows faster than
  // the input: 1MB of HTML measured at 41ms, 25MB at 1.85 SECONDS. So anyone holding
  // an ingest token — which is printed on the agent's public listings — could spend
  // that much of the single-threaded server per request, 240 times a minute, and
  // /healthz would stop answering along with everything else.
  //
  // Two ceilings sit in front of that now, and this is the inner one. ~1MB clears
  // the 2MB body cap on /ingest and so reaches boundedText, which measures `html`
  // against TEXT.EMAIL_PART (512KB) and names the field it refused. Anything past
  // the body cap never gets that far and 413s instead, which is the outer ceiling
  // and is asserted below.
  //
  // Assert the refusal is cheap as well as correct. A 400 that still cost a second
  // to produce would be no defence at all.
  const started = Date.now()
  const res = await req('POST', `/ingest/email/${ingestToken}`, {
    from: 'noreply@99acres.com',
    subject: 'Lead',
    html: '<div>Mobile: 9876500013</div>'.repeat(35_000), // ~1MB: over the field bound, under the body cap
  })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.code, 'FIELD_TOO_LONG')
  assert.equal(body.field, 'html')
  assert.ok(Date.now() - started < 1000, `the rejection itself took ${Date.now() - started}ms`)

  // And the phone number inside it did not become a lead.
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM leads WHERE wa_id LIKE $1', ['%9876500013'])
  assert.equal(rows[0].n, 0)
})

test('a portal email at the edge of the bound is still parsed normally', async () => {
  // The ceiling has to clear a real notification email — an inlined logo and a long
  // quoted thread — or the guard drops leads instead of protecting the box.
  const padding = '<span>Regards, the 99acres team</span>'.repeat(12_000) // ~440KB
  const res = await req('POST', `/ingest/email/${ingestToken}`, {
    from: 'noreply@99acres.com',
    subject: 'New response for your property',
    html: `<p>Name: Padded Priya</p><p>Mobile: 9876500014</p>${padding}`,
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  const { rows } = await query('SELECT name FROM leads WHERE id = $1', [body.lead_id])
  assert.equal(rows[0].name, 'Padded Priya')
})

// --- Direct portal push, minimal body ----------------------------------------

test('a portal push carrying only a phone number still becomes a lead', async () => {
  const body = await json('POST', `/ingest/portal/${ingestToken}/99acres`, { phone: '9876500012' })
  assert.equal(body.ok, true)
  assert.ok(body.lead_id)

  const { rows } = await query('SELECT * FROM leads WHERE id = $1', [body.lead_id])
  assert.equal(rows[0].name, null, 'no name given, no name invented')
  assert.equal(rows[0].source_ref, null)
  assert.equal(rows[0].source_channel, 'portal_api')
  assert.equal(rows[0].source_portal, '99acres')

  const event = await eventFor(body.lead_id)
  assert.equal(event.external_id, null, 'nothing to dedupe on')
  assert.equal(event.contact_name, null)
  assert.deepEqual(rows[0].source_meta.budget ?? null, null)
})

test('a portal push identifies its lead by lead_id when it sends no external_id', async () => {
  const body = await json('POST', `/ingest/portal/${ingestToken}/magicbricks`, {
    phone: '9876500013',
    lead_id: 'MB-88231',
    project: 'Green Meadows',
    name: 'Sanjay Rao',
  })
  const event = await eventFor(body.lead_id)
  assert.equal(event.external_id, 'MB-88231', 'lead_id stands in for external_id')

  // And the same push a second time is recognised as the same lead, not a new one.
  const again = await json('POST', `/ingest/portal/${ingestToken}/magicbricks`, {
    phone: '9876500013',
    lead_id: 'MB-88231',
  })
  assert.equal(again.duplicate, true)

  const { rows } = await query('SELECT * FROM leads WHERE id = $1', [body.lead_id])
  assert.equal(rows[0].source_ref, 'Green Meadows', 'project stands in for property')
})

test('a push to a portal we do not syndicate to, or with no phone, is refused', async () => {
  const unknown = await req('POST', `/ingest/portal/${ingestToken}/craigslist`, { phone: '9876500014' })
  assert.equal(unknown.status, 400)
  assert.equal((await unknown.json()).error, 'unknown portal')

  const phoneless = await req('POST', `/ingest/portal/${ingestToken}/housing`, { name: 'No Number Nikhil' })
  assert.equal(phoneless.status, 400)
  assert.equal((await phoneless.json()).error, 'phone required')
})

// --- What the field bounds don't measure -------------------------------------

test('an ingest body past the ceiling is refused whole, in a key no field bound names', async () => {
  // boundedText measures the fields it is given by name. /ingest/portal names eight,
  // and then hands ingestLead the WHOLE body as `raw`, which lands in a JSONB column.
  // So the cheapest way past the bounds is a key nobody listed: `bulk` here is neither
  // measured nor read, and before the mount below it travelled under express.json()'s
  // 25MB ceiling — the one that exists for the media library posting base64 photos on
  // an authenticated route, extended by accident to a route whose token is printed on
  // public 99acres listings.
  //
  // 240 requests a minute is the ingest limiter's allowance, so the gap was 6GB a
  // minute of attacker-chosen JSONB, on the VPS where disk is the scarce thing.
  const res = await req('POST', `/ingest/portal/${ingestToken}/99acres`, {
    phone: '9876500031',
    bulk: 'x'.repeat(3 * 1024 * 1024),
  })
  assert.equal(res.status, 413)
  assert.equal((await res.json()).code, 'PAYLOAD_TOO_LARGE')

  // Refused before the handler, so there is no lead and no event to show for it.
  assert.equal(
    (await query('SELECT COUNT(*)::int AS n FROM leads WHERE wa_id LIKE $1', ['%9876500031'])).rows[0].n,
    0,
  )
})

test('the tighter ingest ceiling is not the ceiling the media library gets', async () => {
  // The mount is path-scoped (`app.use('/ingest', ...)`) and relies on body-parser
  // marking a request parsed so the general 25MB parser skips it. Get that wrong in
  // the other direction — mount it app-wide, or above the wrong prefix — and photo
  // uploads start failing at 2MB with nothing in the ingest tests to notice.
  //
  // Unauthenticated on purpose: 401 comes from the auth middleware, which sits BELOW
  // the parser, so reaching it at all is the proof that 3MB was parsed rather than
  // refused. It also keeps a multi-megabyte junk file off the uploads directory.
  const res = await req('POST', '/api/uploads', {
    filename: 'brochure.pdf',
    data_base64: 'A'.repeat(3 * 1024 * 1024),
  }, null)
  assert.equal(res.status, 401, 'a 413 here would mean the 2MB cap leaked onto every route')
})

test('a raw payload under the body ceiling but past the column ceiling is stored as a marker', async () => {
  // Between the two bounds sits a band the body cap allows and no field bound
  // measures: ~100KB of unlisted key. Small enough to be ordinary traffic, large
  // enough that lead_source_events.raw grows by 100KB a lead and never shrinks —
  // and the column is diagnostic, so nothing ever reads it back to notice.
  //
  // boundRawEvent is the backstop at the point of storage, which is why it lives in
  // db.js and covers every caller of createLeadSourceEvent rather than this route.
  const body = await json('POST', `/ingest/portal/${ingestToken}/housing`, {
    phone: '9876500032',
    name: 'Bulky Bhaskar',
    notes: 'n'.repeat(100_000),
  })
  assert.equal(body.ok, true)

  const event = await eventFor(body.lead_id)
  assert.equal(event.raw._truncated, true)
  assert.equal(event.raw._limit, 64 * 1024)
  assert.ok(event.raw._bytes > 100_000, 'the size it would have been is kept')
  assert.equal(event.raw.notes, undefined, 'and the payload itself is not')

  // The lead is still a lead: the marker replaces the audit copy, not the ingestion.
  const { rows } = await query('SELECT name FROM leads WHERE id = $1', [body.lead_id])
  assert.equal(rows[0].name, 'Bulky Bhaskar')
})

// --- Meta Lead Ads -----------------------------------------------------------

const postLeadgen = (value) =>
  fetch(`${base}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      object: 'page',
      entry: [{ changes: [{ field: 'leadgen', value }] }],
    }),
  })

async function until(fn, what, timeoutMs = 5000) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

test('a lead ad on an unmapped form is recorded as unmatched, with whatever name it had', async () => {
  leadgen = {
    field_data: [
      { name: 'full_name', values: ['Unmapped Umesh'] },
      { name: 'phone_number', values: ['+919876500021'] },
    ],
  }
  await postLeadgen({ leadgen_id: 'lg-unmapped-1', form_id: 'form-nobody-owns' })

  const event = await until(
    async () =>
      (
        await query(`SELECT * FROM lead_source_events WHERE external_id = $1`, ['lg-unmapped-1'])
      ).rows[0],
    'the unmatched event',
  )
  assert.equal(event.status, 'unmatched')
  assert.equal(event.agent_id, null, 'nobody to attribute it to')
  assert.equal(event.contact_name, 'Unmapped Umesh', 'the name is kept so a human can place it later')
  assert.match(event.error, /no agent mapped for form form-nobody-owns/)
})

test('a lead ad on an unmapped form with no name at all still records the miss', async () => {
  leadgen = { field_data: [{ name: 'phone_number', values: ['+919876500022'] }] }
  await postLeadgen({ leadgen_id: 'lg-unmapped-2' })

  const event = await until(
    async () => (await query(`SELECT * FROM lead_source_events WHERE external_id = $1`, ['lg-unmapped-2'])).rows[0],
    'the nameless unmatched event',
  )
  assert.equal(event.contact_name, null, 'no name, and not the string "undefined"')
  assert.match(event.error, /no agent mapped for form \?/, 'the form id is unknown too')
})

test('a mapped lead ad with no property named sends no "interested in" opener', async () => {
  await query(
    `INSERT INTO meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    ['leadgen_form:form-ira', String(agentId)],
  )
  leadgen = {
    field_data: [
      { name: 'full_name', values: ['Plain Pooja'] },
      { name: 'phone_number', values: ['+919876500023'] },
    ],
    ad_name: 'Baner Launch Q3',
  }
  await postLeadgen({ leadgen_id: 'lg-mapped-1', form_id: 'form-ira' })

  // ingestLead creates the lead first and stamps its provenance a few statements
  // later, so wait for the stamp rather than for the bare row.
  const lead = await until(
    async () => (await query('SELECT * FROM leads WHERE wa_id = $1 AND source_channel IS NOT NULL', ['919876500023'])).rows[0],
    'the mapped lead',
  )
  assert.equal(lead.agent_id, agentId)
  assert.equal(lead.source_channel, 'meta_lead_ad')
  assert.equal(lead.source_ref, 'Baner Launch Q3', 'the ad name stands in for the property')
  assert.equal(
    (await query('SELECT COUNT(*)::int AS n FROM messages WHERE lead_id = $1', [lead.id])).rows[0].n,
    0,
    'no property named, so no opener was invented for the transcript',
  )
})

test('a mapped lead ad naming a property records it and the opener', async () => {
  leadgen = {
    field_data: [
      { name: 'full_name', values: ['Interested Ishaan'] },
      { name: 'phone_number', values: ['+919876500024'] },
      { name: 'which_property', values: ['Lakeview Enclave'] },
      { name: 'city', values: ['Pune'] },
    ],
  }
  await postLeadgen({ leadgen_id: 'lg-mapped-2', form_id: 'form-ira' })

  const lead = await until(
    async () => (await query('SELECT * FROM leads WHERE wa_id = $1 AND source_channel IS NOT NULL', ['919876500024'])).rows[0],
    'the property lead',
  )
  assert.equal(lead.source_ref, 'Lakeview Enclave')
  assert.equal(lead.source_meta.message, 'Interested in Lakeview Enclave')
  assert.equal(lead.source_meta.city, 'Pune')
})

test('a leadgen change with no id at all is ignored', async () => {
  const before = (await query('SELECT COUNT(*)::int AS n FROM lead_source_events')).rows[0].n
  await postLeadgen({ form_id: 'form-ira' })
  await new Promise((r) => setTimeout(r, 150))
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM lead_source_events')).rows[0].n, before)
  assert.ok(await getAgent(agentId), 'and the agent is untouched')
})
