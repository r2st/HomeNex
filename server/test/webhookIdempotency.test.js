// Meta redelivers webhook events on any ack hiccup (slow response, network blip,
// restart mid-request). These tests cover the two robustness fixes that came out of
// that: (1) a redelivered inbound message must not be processed twice (duplicate AI
// reply / duplicate lead-source events), and (2) non-text inbound messages (photos,
// documents, location, interactive replies, ...) must be recorded instead of silently
// dropped. See handleInbound() and inboundMessageText() in index.js.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET // webhook signature check off
const dbName = await createTestDb('webhookidem')

const { app, inboundMessageText } = await import('../index.js')
const { closePool, getMessages, query } = await import('../db.js')

let server
let base
let token
let agentId

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

// A Meta webhook payload carrying one inbound message on a given business line.
const webhookPayload = (msg, phoneNumberId, profileName = 'Test Buyer') => ({
  entry: [{ changes: [{ value: {
    metadata: { phone_number_id: phoneNumberId },
    contacts: [{ profile: { name: profileName } }],
    messages: [msg],
  } }] }],
})

async function until(fn, timeoutMs = 5000) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 100))
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
    await req('POST', '/api/auth/signup', { name: 'Webhook Agent', phone: '+919800000031', password: 'secret123' }, null)
  ).json()
  token = out.token
  agentId = out.agent.id
  const cfg = await req('PUT', '/api/agent/phone-config', {
    wa_phone_number: '+919899999931',
    wa_phone_number_id: 'PNID_IDEM_1',
  })
  assert.equal(cfg.status, 200)
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

test('redelivering the same webhook message id does not duplicate it', async () => {
  const from = '919888800031'
  const waMessageId = 'wamid.dedupe-test-1'
  const payload = webhookPayload(
    { from, id: waMessageId, type: 'text', text: { body: 'Looking for a 2BHK in Wakad' } },
    'PNID_IDEM_1',
  )

  const first = await req('POST', '/webhook', payload)
  assert.equal(first.status, 200)
  const lead = await until(async () => {
    const leads = await (await req('GET', '/api/leads')).json()
    return leads.find((l) => l.wa_id === from)
  })
  await until(async () => (await getMessages(lead.id)).length >= 1)

  // Redeliver the exact same webhook payload (same message id).
  const second = await req('POST', '/webhook', payload)
  assert.equal(second.status, 200)
  // Give the async handler a moment to run (it acks before processing).
  await new Promise((r) => setTimeout(r, 300))

  const messages = await getMessages(lead.id)
  const buyerMessages = messages.filter((m) => m.role === 'buyer' && m.wa_message_id === waMessageId)
  assert.equal(buyerMessages.length, 1, 'the redelivered message must not be stored twice')
})

test('two distinct webhook message ids from the same sender both persist', async () => {
  const from = '919888800032'
  const first = webhookPayload(
    { from, id: 'wamid.distinct-1', type: 'text', text: { body: 'Hi' } },
    'PNID_IDEM_1',
  )
  const second = webhookPayload(
    { from, id: 'wamid.distinct-2', type: 'text', text: { body: 'Budget 80L' } },
    'PNID_IDEM_1',
  )
  await req('POST', '/webhook', first)
  const lead = await until(async () => {
    const leads = await (await req('GET', '/api/leads')).json()
    return leads.find((l) => l.wa_id === from)
  })
  await until(async () => (await getMessages(lead.id)).length >= 1)
  await req('POST', '/webhook', second)
  await until(async () => (await getMessages(lead.id)).length >= 2)
  const messages = await getMessages(lead.id)
  assert.equal(messages.filter((m) => m.role === 'buyer').length, 2)
})

test('a non-text message (photo) is recorded, not silently dropped', async () => {
  const from = '919888800033'
  const payload = webhookPayload(
    { from, id: 'wamid.photo-1', type: 'image', image: { caption: 'floor plan' } },
    'PNID_IDEM_1',
  )
  await req('POST', '/webhook', payload)
  const lead = await until(async () => {
    const leads = await (await req('GET', '/api/leads')).json()
    return leads.find((l) => l.wa_id === from)
  })
  await until(async () => (await getMessages(lead.id)).length >= 1)
  const messages = await getMessages(lead.id)
  assert.match(messages[0].text, /floor plan/)
})

test('a non-text message with no caption still gets a readable placeholder', async () => {
  const from = '919888800034'
  const payload = webhookPayload(
    { from, id: 'wamid.doc-1', type: 'document', document: { filename: 'floorplan.pdf' } },
    'PNID_IDEM_1',
  )
  await req('POST', '/webhook', payload)
  const lead = await until(async () => {
    const leads = await (await req('GET', '/api/leads')).json()
    return leads.find((l) => l.wa_id === from)
  })
  await until(async () => (await getMessages(lead.id)).length >= 1)
  const messages = await getMessages(lead.id)
  assert.match(messages[0].text, /floorplan\.pdf/)
})

test('inboundMessageText: every WhatsApp message type', () => {
  assert.equal(inboundMessageText({ type: 'text', text: { body: 'hi' } }), 'hi')
  assert.equal(inboundMessageText({ type: 'text', text: { body: '' } }), null)
  assert.equal(inboundMessageText({ type: 'image', image: {} }), '📷 Photo')
  assert.match(inboundMessageText({ type: 'image', image: { caption: 'nice' } }), /nice/)
  assert.match(inboundMessageText({ type: 'video', video: {} }), /Video/)
  assert.match(inboundMessageText({ type: 'document', document: { filename: 'x.pdf' } }), /x\.pdf/)
  assert.match(inboundMessageText({ type: 'document', document: {} }), /Document/)
  assert.match(inboundMessageText({ type: 'audio', audio: { voice: true } }), /Voice/)
  assert.match(inboundMessageText({ type: 'audio', audio: { voice: false } }), /Audio/)
  assert.match(inboundMessageText({ type: 'sticker' }), /Sticker/)
  assert.match(inboundMessageText({ type: 'location', location: {} }), /location/)
  assert.match(inboundMessageText({ type: 'contacts' }), /contact/)
  assert.equal(
    inboundMessageText({ type: 'interactive', interactive: { button_reply: { title: 'Yes please' } } }),
    'Yes please',
  )
  assert.equal(
    inboundMessageText({ type: 'interactive', interactive: { list_reply: { title: 'Option B' } } }),
    'Option B',
  )
  assert.equal(inboundMessageText({ type: 'interactive', interactive: {} }), null)
  assert.equal(inboundMessageText({ type: 'button', button: { text: 'Confirm' } }), 'Confirm')
  // Reactions and unrecognised types have no useful text — must be skippable.
  assert.equal(inboundMessageText({ type: 'reaction', reaction: { emoji: '👍' } }), null)
  assert.equal(inboundMessageText({ type: 'unsupported' }), null)
  assert.equal(inboundMessageText({ type: 'system' }), null)
})

test('POST /api/simulate: passing the same wa_message_id twice is idempotent', async () => {
  const from = 'sim-idem-test'
  const first = await req('POST', '/api/simulate', {
    from, text: 'Hi there', wa_message_id: 'wamid.sim-dedupe-1',
  })
  assert.equal(first.status, 200)
  const firstBody = await first.json()
  assert.equal(firstBody.duplicate, undefined)

  const second = await req('POST', '/api/simulate', {
    from, text: 'Hi there', wa_message_id: 'wamid.sim-dedupe-1',
  })
  assert.equal(second.status, 200)
  const secondBody = await second.json()
  assert.equal(secondBody.duplicate, true)

  const messages = await getMessages(firstBody.lead.id)
  assert.equal(messages.filter((m) => m.wa_message_id === 'wamid.sim-dedupe-1').length, 1)
})

// --- The unconfigured-secret branch, end to end -------------------------------
//
// webhookSignatureUnit.test.js proves the pure function fails closed in production.
// What it can't prove is that the route is wired to it: that the secret really is
// plumbed through from the environment, that isProd is computed per REQUEST (a value
// captured at import would be frozen as 'test' for the life of the process, and the
// fail-closed branch would be dead code in production), and that a false answer
// becomes a 401 rather than an unhandled throw.
//
// This file boots the app with WHATSAPP_APP_SECRET deleted — the exact production
// misconfiguration at issue — so it is the only place that wiring is observable.
const unsignedWebhook = () =>
  fetch(base + '/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(webhookPayload(
      { id: 'wamid.failclosed.1', from: '919888840001', type: 'text', text: { body: 'Forged' } },
      'pnid-failclosed',
    )),
  })

test('with no app secret configured, an unsigned webhook is accepted in dev', async () => {
  assert.equal(process.env.WHATSAPP_APP_SECRET, undefined)
  assert.equal((await unsignedWebhook()).status, 200)
})

test('with no app secret configured, an unsigned webhook is REJECTED in production', async () => {
  // Anyone who knows the URL could otherwise inject fabricated buyer messages: fake
  // leads, AI replies sent from the broker's real WhatsApp number, poisoned scores.
  const realEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    const res = await unsignedWebhook()
    assert.equal(res.status, 401, 'a missing app secret left the public webhook wide open in production')
  } finally {
    process.env.NODE_ENV = realEnv
  }
})

test('a signature that cannot be checked is rejected in production, however plausible', async () => {
  // No secret means nothing to check against — a well-formed sha256= header must not
  // buy its way in by looking right.
  const realEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    const res = await fetch(base + '/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=' + 'a'.repeat(64),
      },
      body: JSON.stringify(webhookPayload(
        { id: 'wamid.failclosed.2', from: '919888840002', type: 'text', text: { body: 'Forged' } },
        'pnid-failclosed',
      )),
    })
    assert.equal(res.status, 401)
  } finally {
    process.env.NODE_ENV = realEnv
  }
})

test('a rejected webhook leaves no trace of the forged message in the database', async () => {
  // A 401 that had already persisted the lead would defeat the point. The webhook
  // acks before it finishes processing, so wait for the ACCEPTED message from the
  // dev-mode test above to land first — that proves the pipeline has drained and
  // makes the absence of the rejected one meaningful rather than merely early.
  const countOf = async (id) =>
    (await query(`SELECT COUNT(*)::int AS n FROM messages WHERE wa_message_id = $1`, [id])).rows[0].n

  await until(async () => (await countOf('wamid.failclosed.1')) === 1)
  assert.equal(await countOf('wamid.failclosed.2'), 0, 'a rejected webhook still wrote a message')
})
