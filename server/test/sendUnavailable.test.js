// What every "send" route does when WhatsApp isn't configured.
//
// This is the single most common state for a HomeNex deploy in its first hour — the
// dashboard is up, the agent hasn't finished WABA registration, and every send fails.
// The distinction that matters is the status code: 503 says "this server can't send
// yet, the request was fine", 502 says "Meta rejected it". Getting that wrong sends
// the agent to the wrong half of the setup guide, and none of these arms had run.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_PHONE_NUMBER_ID
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('sendunavailable')

const { app } = await import('../index.js')
const {
  closePool, upsertLead, createProperty, createMediaAsset,
  addContact, createGroup, addGroupMembers,
} = await import('../db.js')

let server, base, token
let leadId, propertyId, mediaId, groupId

const req = (method, url, body) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

// Every one of these must be "the server can't send", never a 500 or a silent 200.
const expectUnavailable = async (method, url, body) => {
  const res = await req(method, url, body)
  const payload = await res.json()
  assert.equal(res.status, 503, `${method} ${url} -> ${res.status} ${JSON.stringify(payload)}`)
  assert.equal(payload.code, 'WA_NOT_CONFIGURED')
  assert.match(payload.error, /WhatsApp is not configured/)
  return payload
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const out = await (
    await fetch(base + '/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Unsent Usha', phone: '+919860000001', password: 'secret123' }),
    })
  ).json()
  token = out.token
  const agentId = out.agent.id

  leadId = (await upsertLead(agentId, '919861000001', 'Waiting Wahid')).id
  propertyId = (await createProperty(agentId, { title: 'Unsent Heights', locality: 'Baner', city: 'Pune' })).id
  mediaId = (await createMediaAsset(agentId, {
    title: 'Floor plan', kind: 'document', url: 'http://example.test/plan.pdf', filename: 'plan.pdf',
  })).id
  const contact = await addContact(agentId, '+919861000002', 'Group Gita')
  groupId = (await createGroup(agentId, { name: 'Baner buyers' })).id
  await addGroupMembers(groupId, agentId, [contact.id])
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

test('pushing a property card into a chat reports the server, not the request', async () => {
  await expectUnavailable('POST', `/api/properties/${propertyId}/send-to-chat`, { lead_id: leadId })
})

test('sending a library asset reports the same', async () => {
  await expectUnavailable('POST', `/api/media/${mediaId}/send`, { lead_id: leadId })
})

// The blast loop counts a failure per recipient, but a missing configuration is not
// worth retrying for the rest of the group — it gives up on the first one.
test('a group blast gives up on the first recipient instead of failing all of them', async () => {
  await expectUnavailable('POST', `/api/groups/${groupId}/send`, { message: 'New launch in Baner' })
})

test('the argument checks still run first — an unsendable request is a 400/404', async () => {
  assert.equal((await req('POST', `/api/groups/${groupId}/send`, { message: '   ' })).status, 400)
  assert.equal((await req('POST', `/api/properties/${propertyId}/send-to-chat`, {})).status, 400)
  assert.equal(
    (await req('POST', `/api/properties/${propertyId}/send-to-chat`, { lead_id: 999999 })).status,
    404,
  )
  assert.equal((await req('POST', '/api/media/999999/send', { lead_id: leadId })).status, 404)
})
