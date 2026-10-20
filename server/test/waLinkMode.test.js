// wa.me click-to-chat is the default way a dashboard send goes out: the server logs
// the message and hands back a wa.me link with the text pre-filled, and the agent's
// own WhatsApp app does the sending. No Meta Business setup is needed for any of it.
// The Meta WhatsApp Cloud API stays as an opt-in upgrade per account.
//
// Meta credentials ARE configured on this server throughout, on purpose: the point is
// that an account that hasn't opted in never reaches graph.facebook.com even when the
// server could send — and that one that has opted in goes back to the real API.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_APP_SECRET
process.env.WHATSAPP_ACCESS_TOKEN = 'test-token'
process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-pnid'
const dbName = await createTestDb('walinkmode')

const { app } = await import('../index.js')
const {
  closePool, query, upsertLead, createProperty, createMediaAsset,
  addContact, createGroup, addGroupMembers, getMessages, getAgent,
} = await import('../db.js')
const { waSendMode, waMeLink } = await import('../whatsapp.js')
const { siteVisitWaReminders } = await import('../scheduler.js')
const { ingestLead } = await import('../leadSources.js')

let server, base, token, agentId
let leadId, propertyId, mediaId, groupId

const realFetch = global.fetch
let graphCalls = []
let sendSeq = 0
global.fetch = async (url, options) => {
  const href = String(url)
  if (!href.includes('graph.facebook.com')) return realFetch(url, options)
  graphCalls.push({ href, body: options?.body ? JSON.parse(options.body) : null })
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ messages: [{ id: `wamid.link${++sendSeq}` }] }),
  }
}

const req = (method, url, body) =>
  realFetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
const json = async (...args) => (await req(...args)).json()
const textOf = (link) => new URL(link).searchParams.get('text')

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const out = await (
    await realFetch(base + '/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Linky Lata', phone: '+919860000001', password: 'secret123' }),
    })
  ).json()
  token = out.token
  agentId = out.agent.id

  leadId = (await upsertLead(agentId, '919861000001', 'Ravi Kumar')).id
  propertyId = (await createProperty(agentId, {
    title: 'Lakeview Residency', bhk: 2, locality: 'Baner', city: 'Pune', price_paise: 85_00_00_000,
  })).id
  mediaId = (await createMediaAsset(agentId, {
    title: 'Brochure', kind: 'document', url: 'http://example.test/brochure.pdf', filename: 'brochure.pdf',
  })).id
  const contact = await addContact(agentId, '+919861000002', 'Bulk Bina')
  groupId = (await createGroup(agentId, { name: 'Weekend list' })).id
  await addGroupMembers(groupId, agentId, [contact.id])
})

after(async () => {
  global.fetch = realFetch
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

test('waMeLink keeps only digits and URL-encodes the pre-filled text', () => {
  assert.equal(waMeLink('+91 98765-43210', 'Hi Ravi & family? 2BHK ✓'),
    'https://wa.me/919876543210?text=Hi%20Ravi%20%26%20family%3F%202BHK%20%E2%9C%93')
  assert.equal(waMeLink('919876543210'), 'https://wa.me/919876543210')
  assert.equal(waMeLink(null, 'hello'), 'https://wa.me/?text=hello')
})

test('waSendMode is link unless the account opted in to the Cloud API', () => {
  assert.equal(waSendMode(null), 'link')
  assert.equal(waSendMode({}), 'link')
  assert.equal(waSendMode({ wa_api_enabled: false }), 'link')
  assert.equal(waSendMode({ wa_api_enabled: true }), 'api')
})

test('a new account starts on wa.me links, and every surface says so', async () => {
  assert.equal((await getAgent(agentId)).wa_api_enabled, false)
  assert.equal((await json('GET', '/api/auth/me')).wa_send_mode, 'link')
  assert.equal((await json('GET', `/api/leads/${leadId}`)).wa_send_mode, 'link')
  const cfg = await json('GET', '/api/agent/phone-config')
  assert.equal(cfg.wa_send_mode, 'link')
  assert.equal(cfg.wa_api_enabled, false)
  assert.equal(cfg.wa_api_available, true)
})

test('a reply comes back as a wa.me link and is logged — nothing is sent to Meta', async () => {
  graphCalls = []
  const res = await req('POST', `/api/leads/${leadId}/reply`, { text: 'Hi Ravi, site visit at 11?' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.mode, 'link')
  assert.equal(body.wa_link, 'https://wa.me/919861000001?text=Hi%20Ravi%2C%20site%20visit%20at%2011%3F')
  assert.equal(body.sent_via, 'wa_link')
  assert.equal(body.wa_message_id, null)
  assert.equal(graphCalls.length, 0)
  const thread = await getMessages(leadId)
  assert.ok(thread.some((m) => m.role === 'agent' && m.sent_via === 'wa_link' && m.text === 'Hi Ravi, site visit at 11?'))
})

test('the 24-hour window does not apply to a message sent from the agent\'s own WhatsApp', async () => {
  await query(`UPDATE leads SET last_inbound_at = now() - interval '3 days' WHERE id = $1`, [leadId])
  const res = await req('POST', `/api/leads/${leadId}/reply`, { text: 'Still looking?' })
  assert.equal(res.status, 200)
  assert.equal(textOf((await res.json()).wa_link), 'Still looking?')
})

test('an approved template is rendered into the link text', async () => {
  const { rows } = await query(
    `INSERT INTO message_templates (agent_id, name, body, category)
     VALUES ($1, 'Visit nudge', 'Hi {{name}}, shall we fix a visit?', 'utility') RETURNING id`,
    [agentId],
  )
  const body = await json('POST', `/api/leads/${leadId}/reply`, { template_id: rows[0].id, variables: { name: 'Ravi' } })
  assert.equal(body.mode, 'link')
  assert.equal(textOf(body.wa_link), 'Hi Ravi, shall we fix a visit?')
})

test('a property card is pre-filled with the client\'s name and the listing details', async () => {
  graphCalls = []
  const body = await json('POST', `/api/properties/${propertyId}/send-to-chat`, { lead_id: leadId })
  assert.equal(body.ok, true)
  assert.equal(body.mode, 'link')
  const text = textOf(body.wa_link)
  assert.equal(text, body.text)
  assert.match(text, /^Hi Ravi Kumar, sharing a property you may like:/)
  assert.match(text, /Lakeview Residency/)
  assert.match(text, /Baner/)
  assert.match(text, new RegExp(`/p/[a-z0-9-]+\\?l=${leadId}`), 'keeps the lead-tracked micro-page link')
  assert.ok(body.wa_link.startsWith('https://wa.me/919861000001?text='))
  assert.equal(graphCalls.length, 0)
  const audit = await query(`SELECT details FROM audit_logs WHERE agent_id = $1 AND action = 'send_to_chat'`, [agentId])
  assert.equal(audit.rows.at(-1).details.mode, 'link')
})

test('a library asset is shared as its link, since wa.me cannot carry a file', async () => {
  graphCalls = []
  const body = await json('POST', `/api/media/${mediaId}/send`, { lead_id: leadId, caption: 'Floor plans inside' })
  assert.equal(body.mode, 'link')
  assert.equal(textOf(body.wa_link), 'Brochure — Floor plans inside\nhttp://example.test/brochure.pdf')
  assert.equal(graphCalls.length, 0)
  const { rows } = await query('SELECT * FROM media_sends WHERE media_id = $1 AND lead_id = $2', [mediaId, leadId])
  assert.equal(rows.length, 1, 'the library still shows it as sent')
})

test('a booked site visit hands back the confirmation as a link instead of sending it', async () => {
  graphCalls = []
  const at = new Date(Date.now() + 2 * 86400_000).toISOString()
  const body = await json('POST', '/api/site-visits', { lead_id: leadId, property_id: propertyId, scheduled_at: at })
  assert.equal(body.confirmation_sent, false)
  assert.ok(body.confirmation_text)
  assert.equal(textOf(body.confirmation_wa_link), body.confirmation_text)
  assert.equal(graphCalls.length, 0)
})

test('automated visit reminders skip an account on wa.me links', async () => {
  const at = new Date(Date.now() + 2 * 3600_000).toISOString()
  await json('POST', '/api/site-visits', { lead_id: leadId, scheduled_at: at })
  graphCalls = []
  assert.equal(await siteVisitWaReminders([agentId]), 0)
  assert.equal(graphCalls.length, 0)
})

test('a lead-ad intro is skipped rather than sent from a number the account never connected', async () => {
  process.env.WHATSAPP_LEAD_INTRO_TEMPLATE = 'lead_intro'
  try {
    graphCalls = []
    const r = await ingestLead({ agent: await getAgent(agentId), channel: 'walk_in', name: 'Walk Wanda', phone: '9861000003' })
    assert.equal(r.autoReplyStatus, 'skipped:wa_link_mode')
    assert.equal(graphCalls.length, 0)
  } finally {
    delete process.env.WHATSAPP_LEAD_INTRO_TEMPLATE
  }
})

test('a bulk send says it needs the Business API upgrade, and sends nothing', async () => {
  graphCalls = []
  const res = await req('POST', `/api/groups/${groupId}/send`, { message: 'Weekend open house!' })
  assert.equal(res.status, 503)
  const body = await res.json()
  assert.equal(body.code, 'WA_NOT_CONFIGURED')
  assert.match(body.error, /WhatsApp Business API/)
  assert.match(body.error, /optional upgrade/)
  assert.equal(graphCalls.length, 0)
})

test('turning the Cloud API on is refused while the server has no Meta credentials', async () => {
  const saved = process.env.WHATSAPP_ACCESS_TOKEN
  delete process.env.WHATSAPP_ACCESS_TOKEN
  try {
    const res = await req('PUT', '/api/agent/wa-api', { enabled: true })
    assert.equal(res.status, 409)
    assert.equal((await res.json()).code, 'WA_NOT_CONFIGURED')
    assert.equal((await getAgent(agentId)).wa_api_enabled, false)
  } finally {
    process.env.WHATSAPP_ACCESS_TOKEN = saved
  }
})

test('an account that opts in sends through the Cloud API, and can switch back', async () => {
  const on = await json('PUT', '/api/agent/wa-api', { enabled: true })
  assert.deepEqual(on, { wa_api_enabled: true, wa_send_mode: 'api' })
  assert.equal((await json('GET', `/api/leads/${leadId}`)).wa_send_mode, 'api')

  await query('UPDATE leads SET last_inbound_at = now() WHERE id = $1', [leadId])
  graphCalls = []
  const sent = await json('POST', `/api/leads/${leadId}/reply`, { text: 'Sent via Meta' })
  assert.equal(sent.mode, 'api')
  assert.equal(sent.wa_link, undefined)
  assert.equal(sent.sent_via, null)
  assert.equal(graphCalls.length, 1)
  assert.equal(graphCalls[0].body.to, '919861000001')
  assert.equal(graphCalls[0].body.text.body, 'Sent via Meta')

  const off = await json('PUT', '/api/agent/wa-api', { enabled: false })
  assert.deepEqual(off, { wa_api_enabled: false, wa_send_mode: 'link' })
  graphCalls = []
  assert.equal((await json('POST', `/api/leads/${leadId}/reply`, { text: 'Back to wa.me' })).mode, 'link')
  assert.equal(graphCalls.length, 0)
})

test('the migration keeps accounts already wired to Meta on the Cloud API', async () => {
  const { rows } = await query(
    `INSERT INTO agents (name, phone, password_hash, wa_phone_number_id, waba_status)
     VALUES ('Wired Wasim', '+919860000009', '', 'pnid-wired', 'active') RETURNING id`,
  )
  assert.equal((await getAgent(rows[0].id)).wa_api_enabled, false, 'the column default is off')
  // The migration is idempotent; replaying it is exactly what a deploy onto an
  // existing database does.
  await query(readFileSync(new URL('../migrations/031_wa_send_mode.sql', import.meta.url), 'utf8'))
  assert.equal((await getAgent(rows[0].id)).wa_api_enabled, true)
  assert.equal((await getAgent(agentId)).wa_api_enabled, false, 'an unconnected account stays on wa.me')
})
