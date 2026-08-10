// The other half of sendUnavailable.test.js: what the send routes do when WhatsApp
// *is* configured and Meta accepts the message. These are the lines after the awaited
// send — the ones that mirror the message into the thread, record the send against
// the limiter, and write the audit row. A send that reaches Meta but is never
// recorded locally is invisible to the agent and uncapped by the limiter, so the
// bookkeeping matters as much as the send.
//
// Only graph.facebook.com is intercepted; the suite's own HTTP calls to the app go
// through the real fetch, so the routes are still exercised over the wire.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_APP_SECRET
process.env.WHATSAPP_ACCESS_TOKEN = 'test-token'
process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-pnid'
const dbName = await createTestDb('sendsuccess')

const { app } = await import('../index.js')
const {
  closePool, query, upsertLead, createProperty, createMediaAsset,
  addContact, createGroup, addGroupMembers, getMessages,
} = await import('../db.js')

let server, base, token, agentId
let leadId, propertyId, mediaId, groupId

const realFetch = global.fetch
let graphCalls = []
// Never reset, unlike graphCalls: messages.wa_message_id is uniquely indexed, so a
// stub that reissues an id across tests trips the inbound de-duplication instead.
let sendSeq = 0

// Meta accepts everything; anything that isn't Meta is a real request to our app.
global.fetch = async (url, options) => {
  const href = String(url)
  if (!href.includes('graph.facebook.com')) return realFetch(url, options)
  graphCalls.push({ href, body: options?.body ? JSON.parse(options.body) : null })
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ messages: [{ id: `wamid.stub${++sendSeq}` }] }),
  }
}

const req = (method, url, body) =>
  realFetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
const json = async (...args) => (await req(...args)).json()
const sends = () => graphCalls.filter((c) => c.body?.messaging_product === 'whatsapp' && c.body.type)

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
      body: JSON.stringify({ name: 'Sending Sana', phone: '+919870000001', password: 'secret123' }),
    })
  ).json()
  token = out.token
  agentId = out.agent.id

  leadId = (await upsertLead(agentId, '919871000001', 'Receiving Rohit')).id
  propertyId = (await createProperty(agentId, {
    title: 'Sent Sanctuary', locality: 'Baner', city: 'Pune', price_paise: 9_50_00_000,
  })).id
  mediaId = (await createMediaAsset(agentId, {
    title: 'Brochure', kind: 'document', url: 'http://example.test/brochure.pdf', filename: 'brochure.pdf',
  })).id
  const contact = await addContact(agentId, '+919871000002', 'Blast Bela')
  groupId = (await createGroup(agentId, { name: 'Launch list' })).id
  await addGroupMembers(groupId, agentId, [contact.id])
})

after(async () => {
  global.fetch = realFetch
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

test('a property card is sent, mirrored into the thread and audited', async () => {
  graphCalls = []
  const res = await req('POST', `/api/properties/${propertyId}/send-to-chat`, { lead_id: leadId })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.message.role, 'agent')
  assert.match(body.message.text, /Sent Sanctuary/)

  // The buyer gets a tracked micro-page link, which is what turns a page open into
  // a per-lead engagement signal rather than an anonymous view.
  const sent = sends()[0]
  assert.equal(sent.body.to, '919871000001')
  assert.match(sent.body.text.body, new RegExp(`/p/[a-z0-9-]+\\?l=${leadId}`))

  const thread = await getMessages(leadId, 50)
  assert.ok(thread.some((m) => m.wa_message_id === sent.id || m.text.includes('Sent Sanctuary')))
  const audit = await query(
    `SELECT * FROM audit_logs WHERE agent_id = $1 AND action = 'send_to_chat'`,
    [agentId],
  )
  assert.equal(audit.rows.length, 1, 'the send is on the audit trail')
})

test('a library asset is sent as its media type and recorded against the lead', async () => {
  graphCalls = []
  const body = await json('POST', `/api/media/${mediaId}/send`, { lead_id: leadId })
  assert.equal(body.media_id, mediaId)
  assert.match(body.message.text, /📎 Brochure/)

  const sent = sends()[0]
  assert.equal(sent.body.type, 'document')
  assert.equal(sent.body.document.link, 'http://example.test/brochure.pdf')
  assert.equal(sent.body.document.filename, 'brochure.pdf')

  const { rows } = await query('SELECT * FROM media_sends WHERE media_id = $1 AND lead_id = $2', [mediaId, leadId])
  assert.equal(rows.length, 1, 'so the library can show "sent"')
})

test('a caption overrides the asset title on the way out', async () => {
  graphCalls = []
  const body = await json('POST', `/api/media/${mediaId}/send`, { lead_id: leadId, caption: 'Floor plans inside' })
  assert.equal(sends()[0].body.document.caption, 'Floor plans inside')
  assert.match(body.message.text, /📎 Brochure — Floor plans inside/)
})

test('a group blast sends to each recipient and books it against the limiter', async () => {
  graphCalls = []
  const result = await json('POST', `/api/groups/${groupId}/send`, { message: 'New launch in Baner' })
  assert.deepEqual(
    { sent: result.sent, failed: result.failed, skipped: result.skipped, recipients: result.recipients },
    { sent: 1, failed: 0, skipped: 0, recipients: 1 },
  )
  assert.equal(sends().length, 1)
  assert.equal(sends()[0].body.text.body, 'New launch in Baner')

  const { rows } = await query('SELECT * FROM message_sends WHERE agent_id = $1', [agentId])
  assert.equal(rows.length, 1, 'recorded, or the per-contact cap could never bind')
})

test('the same group blasted again is skipped, not sent twice in a day', async () => {
  graphCalls = []
  const result = await json('POST', `/api/groups/${groupId}/send`, { message: 'Reminder: new launch' })
  assert.deepEqual(
    { sent: result.sent, skipped: result.skipped },
    { sent: 0, skipped: 1 },
    'the min-gap rule holds on the second run',
  )
  assert.equal(result.skips.too_soon_since_last, 1)
  assert.equal(sends().length, 0, 'nothing reached Meta')
})
