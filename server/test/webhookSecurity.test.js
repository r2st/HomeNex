// The two things that guard the public Meta webhook, plus the one webhook branch that
// isn't a WhatsApp message at all:
//
//   1. GET /webhook  — Meta's subscription handshake (hub.verify_token).
//   2. POST /webhook — X-Hub-Signature-256 HMAC verification. Every other test file
//      deletes WHATSAPP_APP_SECRET, which makes verifySignature() short-circuit to
//      `true`; this file is the only one that runs with the check actually ARMED, so
//      it is where forged and missing signatures are proven to be rejected.
//   3. Meta Lead Ads (`change.field === 'leadgen'`) — a webhook carrying only a
//      leadgen_id, whose answers are fetched from the Graph API.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
// Armed, unlike every other test file.
process.env.WHATSAPP_APP_SECRET = 'test-app-secret'
process.env.WHATSAPP_VERIFY_TOKEN = 'test-verify-token'
const dbName = await createTestDb('webhooksec')

const { app } = await import('../index.js')
const { closePool, query, setMeta, getLeadByAgentWaId } = await import('../db.js')

let server, base, token, agentId
const APP_SECRET = 'test-app-secret'

const sign = (raw) => 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex')

const api = (method, url, body) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

// POST /webhook with an explicit signature header (or none).
const postWebhook = (payload, signature) => {
  const raw = JSON.stringify(payload)
  return fetch(base + '/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(signature ? { 'x-hub-signature-256': signature } : {}) },
    body: raw,
  })
}

async function until(fn, timeoutMs = 5000) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) return null
    await new Promise((r) => setTimeout(r, 25))
  }
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const out = await (
    await api('POST', '/api/auth/signup', { name: 'Webhook Wasim', phone: '+919800000121', password: 'secret123' })
  ).json()
  token = out.token
  agentId = out.agent.id
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
  delete process.env.WHATSAPP_APP_SECRET
  delete process.env.WHATSAPP_VERIFY_TOKEN
})

// --- GET /webhook: Meta's subscription handshake ------------------------------

test('GET /webhook echoes the challenge for the right verify token', async () => {
  const res = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=12345`)
  assert.equal(res.status, 200)
  assert.equal(await res.text(), '12345')
})

test('GET /webhook 403s on a wrong or missing verify token', async () => {
  for (const qs of [
    'hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1',
    'hub.mode=subscribe&hub.challenge=1', // no token at all
    'hub.mode=unsubscribe&hub.verify_token=test-verify-token&hub.challenge=1', // wrong mode
    'hub.mode=subscribe&hub.verify_token=test-verify-token&hub.verify_token=x&hub.challenge=1', // repeated: an array
    'hub.mode=subscribe&hub.verify_token=homenex-verify&hub.challenge=1', // the dev default is not a second key
    '', // nothing
  ]) {
    const res = await fetch(`${base}/webhook?${qs}`)
    assert.equal(res.status, 403, qs)
  }
})

// The handshake's answer is a string the CALLER chose, echoed back on the origin that
// serves the SPA and stores every agent's token. res.send(aString) labels that
// text/html, which made /webhook a reflected-XSS sink for anyone who could clear the
// token check — and until this was fixed the token had a published default, so on any
// deploy that hadn't overridden it, "anyone" meant anyone.
test('the echoed challenge is never served as HTML', async () => {
  const payload = '<script>alert(document.cookie)</script>'
  const res = await fetch(
    `${base}/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=${encodeURIComponent(payload)}`,
  )

  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/plain/, 'the challenge is served as HTML')
  // Echoed verbatim — Meta compares the bytes, so escaping it would break the
  // handshake. The content type is what makes it inert, which is why that is asserted.
  assert.equal(await res.text(), payload)
})

// --- POST /webhook: X-Hub-Signature-256 --------------------------------------

const payload = {
  entry: [{ changes: [{ value: {
    metadata: { phone_number_id: 'pnid-sec' },
    contacts: [{ profile: { name: 'Signed Sohan' } }],
    messages: [{ id: 'wamid.sec.1', from: '919888830001', type: 'text', text: { body: 'Hi' } }],
  } }] }],
}

test('POST /webhook rejects a request with no signature header', async () => {
  assert.equal((await postWebhook(payload)).status, 401)
})

test('POST /webhook rejects a forged signature of the right length', async () => {
  const real = sign(JSON.stringify(payload))
  const forged = 'sha256=' + 'f'.repeat(real.length - 'sha256='.length)
  assert.notEqual(forged, real)
  assert.equal((await postWebhook(payload, forged)).status, 401)
})

test('POST /webhook rejects a signature of the wrong length without throwing', async () => {
  // timingSafeEqual throws on mismatched buffer lengths; that must become a 401,
  // not an unhandled 500 that tells the caller their guess was the wrong size.
  for (const bogus of ['sha256=abc', 'sha256=', 'garbage', 'sha1=' + 'a'.repeat(40)]) {
    assert.equal((await postWebhook(payload, bogus)).status, 401, bogus)
  }
})

test("POST /webhook rejects a valid signature computed over a DIFFERENT body", async () => {
  const otherBody = { entry: [] }
  assert.equal((await postWebhook(payload, sign(JSON.stringify(otherBody)))).status, 401)
})

test('POST /webhook accepts a correctly signed payload and processes it', async () => {
  const raw = JSON.stringify(payload)
  const res = await fetch(base + '/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) },
    body: raw,
  })
  assert.equal(res.status, 200)
  // The message lands in the unassigned pool (this phone_number_id belongs to nobody).
  const msg = await until(async () =>
    (await query(`SELECT * FROM messages WHERE wa_message_id = 'wamid.sec.1'`)).rows[0])
  assert.ok(msg, 'a correctly signed inbound message was never processed')
  assert.equal(msg.role, 'buyer')
})

// --- Meta Lead Ads (change.field === 'leadgen') -------------------------------

const leadgenPayload = (value) => ({ entry: [{ changes: [{ field: 'leadgen', value }] }] })

const postSigned = (payload) => {
  const raw = JSON.stringify(payload)
  return fetch(base + '/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) },
    body: raw,
  })
}

const stubGraph = (data) => {
  const real = global.fetch
  global.fetch = async (url, opts) => {
    if (String(url).includes('graph.facebook.com')) {
      return { ok: true, status: 200, json: async () => data, headers: { get: () => null } }
    }
    return real(url, opts)
  }
  return () => { global.fetch = real }
}

test('a leadgen webhook mapped to an agent by form id becomes a real lead', async () => {
  await setMeta('leadgen_form:form-abc', String(agentId))
  process.env.META_PAGE_ACCESS_TOKEN = 'page-token'
  const restore = stubGraph({
    ad_id: 'ad-1', ad_name: 'Baner 2BHK Launch', form_id: 'form-abc', campaign_id: 'camp-1',
    field_data: [
      { name: 'full_name', values: ['Leadgen Lakshmi'] },
      { name: 'phone_number', values: ['+91 98765 43210'] },
      { name: 'email', values: ['lakshmi@example.com'] },
      { name: 'city', values: ['Pune'] },
    ],
  })
  try {
    assert.equal((await postSigned(leadgenPayload({ leadgen_id: 'lg-1', form_id: 'form-abc', ad_id: 'ad-1' }))).status, 200)
    // Wait for the SOURCE STAMP, not merely for the row: ingestLead() inserts the
    // lead before it writes source_channel/source_meta, so polling on existence
    // alone can win the race and read a half-built row.
    const lead = await until(async () => {
      const l = await getLeadByAgentWaId(agentId, '919876543210')
      return l?.source_channel ? l : null
    })
    assert.ok(lead, 'the leadgen never produced a fully-stamped lead')
    assert.equal(lead.name, 'Leadgen Lakshmi')
    assert.equal(lead.source_channel, 'meta_lead_ad')
    assert.equal(lead.source_meta.ad_name, 'Baner 2BHK Launch')
    assert.equal(lead.source_meta.email, 'lakshmi@example.com')
  } finally {
    restore()
    delete process.env.META_PAGE_ACCESS_TOKEN
  }
})

test('the same leadgen id redelivered is deduped, not double-created', async () => {
  process.env.META_PAGE_ACCESS_TOKEN = 'page-token'
  const restore = stubGraph({
    form_id: 'form-abc',
    field_data: [
      { name: 'full_name', values: ['Leadgen Lakshmi'] },
      { name: 'phone_number', values: ['+91 98765 43210'] },
    ],
  })
  try {
    await postSigned(leadgenPayload({ leadgen_id: 'lg-1', form_id: 'form-abc' }))
    await new Promise((r) => setTimeout(r, 250))
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM lead_source_events WHERE external_id = 'lg-1' AND channel = 'meta_lead_ad'`,
    )
    assert.equal(rows[0].n, 1, 'Meta redelivery created a second event')
  } finally {
    restore()
    delete process.env.META_PAGE_ACCESS_TOKEN
  }
})

test('a leadgen for an unmapped form is parked as unmatched, not dropped', async () => {
  process.env.META_PAGE_ACCESS_TOKEN = 'page-token'
  delete process.env.META_LEADGEN_DEFAULT_AGENT_ID
  const restore = stubGraph({ field_data: [{ name: 'full_name', values: ['Orphan Om'] }] })
  try {
    await postSigned(leadgenPayload({ leadgen_id: 'lg-orphan', form_id: 'form-unknown' }))
    const ev = await until(async () =>
      (await query(`SELECT * FROM lead_source_events WHERE external_id = 'lg-orphan'`)).rows[0])
    assert.ok(ev, 'an unmapped leadgen vanished without a trace')
    assert.equal(ev.status, 'unmatched')
    assert.equal(ev.agent_id, null)
    assert.equal(ev.contact_name, 'Orphan Om')
    assert.match(ev.error, /no agent mapped for form form-unknown/)
  } finally {
    restore()
    delete process.env.META_PAGE_ACCESS_TOKEN
  }
})

test('META_LEADGEN_DEFAULT_AGENT_ID catches leadgens from unmapped forms', async () => {
  process.env.META_PAGE_ACCESS_TOKEN = 'page-token'
  process.env.META_LEADGEN_DEFAULT_AGENT_ID = String(agentId)
  const restore = stubGraph({
    field_data: [
      { name: 'name', values: ['Default Deepa'] },
      { name: 'mobile', values: ['9876543211'] },
    ],
  })
  try {
    await postSigned(leadgenPayload({ leadgen_id: 'lg-default', form_id: 'form-other' }))
    const lead = await until(() => getLeadByAgentWaId(agentId, '919876543211'))
    assert.ok(lead)
    assert.equal(lead.name, 'Default Deepa')
  } finally {
    restore()
    delete process.env.META_PAGE_ACCESS_TOKEN
    delete process.env.META_LEADGEN_DEFAULT_AGENT_ID
  }
})

test('a leadgen with no phone in the answers is recorded as failed, with the reason', async () => {
  process.env.META_PAGE_ACCESS_TOKEN = 'page-token'
  await setMeta('leadgen_form:form-nophone', String(agentId))
  const restore = stubGraph({ field_data: [{ name: 'full_name', values: ['Phoneless Priya'] }] })
  try {
    await postSigned(leadgenPayload({ leadgen_id: 'lg-nophone', form_id: 'form-nophone' }))
    const ev = await until(async () =>
      (await query(`SELECT * FROM lead_source_events WHERE external_id = 'lg-nophone'`)).rows[0])
    assert.ok(ev)
    assert.equal(ev.status, 'failed')
    assert.equal(ev.agent_id, agentId)
    assert.match(ev.error, /no phone in leadgen/)
  } finally {
    restore()
    delete process.env.META_PAGE_ACCESS_TOKEN
  }
})

test('a leadgen change with no leadgen_id is ignored without erroring', async () => {
  const before = (await query('SELECT COUNT(*)::int AS n FROM lead_source_events')).rows[0].n
  assert.equal((await postSigned(leadgenPayload({ form_id: 'form-abc' }))).status, 200)
  assert.equal((await postSigned(leadgenPayload(null))).status, 200)
  await new Promise((r) => setTimeout(r, 200))
  const after = (await query('SELECT COUNT(*)::int AS n FROM lead_source_events')).rows[0].n
  assert.equal(after, before)
})

test('a leadgen value delivered as an ARRAY of changes is fanned out', async () => {
  process.env.META_PAGE_ACCESS_TOKEN = 'page-token'
  await setMeta('leadgen_form:form-batch', String(agentId))
  let n = 0
  const real = global.fetch
  global.fetch = async (url, opts) => {
    if (String(url).includes('graph.facebook.com')) {
      n += 1
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({
          form_id: 'form-batch',
          field_data: [
            { name: 'full_name', values: [`Batch Buyer ${n}`] },
            { name: 'phone_number', values: [`98765432${19 + n}`] },
          ],
        }),
      }
    }
    return real(url, opts)
  }
  try {
    await postSigned(leadgenPayload([
      { leadgen_id: 'lg-batch-1', form_id: 'form-batch' },
      { leadgen_id: 'lg-batch-2', form_id: 'form-batch' },
    ]))
    await until(async () =>
      (await query(`SELECT COUNT(*)::int AS n FROM lead_source_events WHERE external_id LIKE 'lg-batch-%'`)).rows[0].n === 2)
    const { rows } = await query(`SELECT external_id FROM lead_source_events WHERE external_id LIKE 'lg-batch-%' ORDER BY external_id`)
    assert.deepEqual(rows.map((r) => r.external_id), ['lg-batch-1', 'lg-batch-2'])
  } finally {
    global.fetch = real
    delete process.env.META_PAGE_ACCESS_TOKEN
  }
})

test('a Graph API outage during leadgen fetch does not take the webhook down', async () => {
  process.env.META_PAGE_ACCESS_TOKEN = 'page-token'
  await setMeta('leadgen_form:form-down', String(agentId))
  const real = global.fetch
  const errs = []
  const realError = console.error
  console.error = (...a) => errs.push(a.join(' '))
  global.fetch = async (url, opts) => {
    if (String(url).includes('graph.facebook.com')) throw new Error('graph is down')
    return real(url, opts)
  }
  try {
    assert.equal((await postSigned(leadgenPayload({ leadgen_id: 'lg-down', form_id: 'form-down' }))).status, 200)
    // No answers means no phone — recorded as failed, and the process stays up.
    const ev = await until(async () =>
      (await query(`SELECT * FROM lead_source_events WHERE external_id = 'lg-down'`)).rows[0])
    assert.equal(ev.status, 'failed')
  } finally {
    global.fetch = real
    console.error = realError
    delete process.env.META_PAGE_ACCESS_TOKEN
  }
})

test('an oversized webhook body is refused before the signature is even considered', async () => {
  // The signature check is what makes this route Meta-only, and it lives INSIDE the
  // handler — so until the body cap above it, the parse ran first. Anyone on the
  // internet could make the server buffer 25MB and JSON.parse it, synchronously, on
  // the way to a 401 they were always going to get. That is the event loop, 240 times
  // a minute, and /healthz stops answering with it.
  //
  // Signed correctly on purpose: a valid signature must not buy a caller a bigger
  // body. The cap sits above the route, so Meta itself would be refused too — which
  // is the intent, since Meta has no reason to send one.
  const payload = { object: 'whatsapp_business_account', filler: 'x'.repeat(2 * 1024 * 1024) }
  const raw = JSON.stringify(payload)
  const started = Date.now()
  const res = await fetch(base + '/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) },
    body: raw,
  })

  assert.equal(res.status, 413)
  assert.equal((await res.json()).code, 'PAYLOAD_TOO_LARGE')
  assert.ok(Date.now() - started < 2000, `the refusal itself took ${Date.now() - started}ms`)
})

test('a real-sized Meta payload still clears the cap and is processed', async () => {
  // The ceiling has to leave a genuine batched delivery alone. Meta sends `entry[]`
  // with several changes at once; this is far larger than that and still ordinary.
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: 'pn-cap-test' },
          contacts: [{ profile: { name: 'Capacity Kavya' } }],
          messages: [{ from: '919876512345', id: 'wamid-cap-1', type: 'text', text: { body: 'Is the 3BHK still available? '.repeat(200) } }],
        },
      }],
    }],
  }
  const res = await postWebhook(payload, sign(JSON.stringify(payload)))
  assert.equal(res.status, 200)

  const lead = await until(async () =>
    (await query('SELECT * FROM leads WHERE wa_id = $1', ['919876512345'])).rows[0])
  assert.ok(lead, 'the message became a lead rather than being refused at the parser')
})

test('the server is still answering after a refused webhook body', async () => {
  const res = await fetch(base + '/healthz')
  assert.equal(res.status, 200)
  assert.equal((await res.json()).ok, true)
})
