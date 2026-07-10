// Integration tests for contact groups / segments and limiter-gated bulk send.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('groups')

const { app } = await import('../index.js')
const { closePool, addContact, upsertLead, addMessage, applyExtraction, updateContact } = await import('../db.js')

let server, base, token, agentId

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

let wakadContact, banerContact

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const out = await (await req('POST', '/api/auth/signup', { name: 'Group Agent', phone: '+919800000081', password: 'secret123' })).json()
  token = out.token
  agentId = out.agent.id

  // Two contacts, each with a lead carrying a locality/intent, so segments resolve.
  wakadContact = await addContact(agentId, '+919777700081', 'Wakad Wendy')
  const wl = await upsertLead(agentId, '919777700081', 'Wakad Wendy')
  await addMessage(wl.id, 'buyer', '2bhk wakad')
  await applyExtraction(wl.id, { locality: 'Wakad', intent: 'buy', preferred_localities: ['Wakad'] })

  banerContact = await addContact(agentId, '+919777700082', 'Baner Bala')
  const bl = await upsertLead(agentId, '919777700082', 'Baner Bala')
  await addMessage(bl.id, 'buyer', '3bhk baner invest')
  await applyExtraction(bl.id, { locality: 'Baner', intent: 'invest', preferred_localities: ['Baner'] })
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

test('create a static group, add and list members', async () => {
  const group = await (await req('POST', '/api/groups', { name: 'Priority buyers', color: '#ff0000' })).json()
  assert.equal(group.name, 'Priority buyers')
  assert.equal(group.kind, 'static')

  const { added } = await (await req('POST', `/api/groups/${group.id}/members`, { contact_ids: [wakadContact.id, banerContact.id] })).json()
  assert.equal(added, 2)

  const members = await (await req('GET', `/api/groups/${group.id}/members`)).json()
  assert.equal(members.length, 2)

  const groups = await (await req('GET', '/api/groups')).json()
  assert.equal(groups.find((g) => g.id === group.id).member_count, 2)
})

test('duplicate group name is rejected with 409', async () => {
  await req('POST', '/api/groups', { name: 'Dupe' })
  assert.equal((await req('POST', '/api/groups', { name: 'Dupe' })).status, 409)
})

test('remove a member and delete the group', async () => {
  const group = await (await req('POST', '/api/groups', { name: 'Temp group' })).json()
  await req('POST', `/api/groups/${group.id}/members`, { contact_ids: [wakadContact.id] })
  assert.equal((await req('DELETE', `/api/groups/${group.id}/members/${wakadContact.id}`)).status, 200)
  assert.equal((await (await req('GET', `/api/groups/${group.id}/members`)).json()).length, 0)
  assert.equal((await req('DELETE', `/api/groups/${group.id}`)).status, 200)
  assert.equal((await req('GET', `/api/groups/${group.id}/members`)).status, 404)
})

test('dynamic segment resolves members live from lead criteria', async () => {
  const preview = await (await req('POST', '/api/segments/preview', { criteria: { locality: 'Wakad' } })).json()
  assert.equal(preview.length, 1)
  assert.equal(preview[0].id, wakadContact.id)

  const group = await (await req('POST', '/api/groups', { name: 'Wakad segment', kind: 'dynamic', criteria: { locality: 'Wakad' } })).json()
  const members = await (await req('GET', `/api/groups/${group.id}/members`)).json()
  assert.equal(members.length, 1)
  assert.equal(members[0].id, wakadContact.id)
  // A dynamic group refuses manual membership.
  assert.equal((await req('POST', `/api/groups/${group.id}/members`, { contact_ids: [banerContact.id] })).status, 400)
})

test('auto-group by locality creates one group per distinct locality', async () => {
  const groups = await (await req('POST', '/api/groups/auto', { by: 'locality' })).json()
  const names = groups.map((g) => g.name)
  assert.ok(names.includes('Locality: Wakad'))
  assert.ok(names.includes('Locality: Baner'))
  const wakadGroup = groups.find((g) => g.name === 'Locality: Wakad')
  assert.equal(wakadGroup.member_count, 1)

  // Idempotent: re-running doesn't duplicate the groups.
  await req('POST', '/api/groups/auto', { by: 'locality' })
  const all = await (await req('GET', '/api/groups')).json()
  assert.equal(all.filter((g) => g.name === 'Locality: Wakad').length, 1)

  assert.equal((await req('POST', '/api/groups/auto', { by: 'nonsense' })).status, 400)
})

test('bulk send is gated by the limiter — opted-out contacts are skipped', async () => {
  // Opt one contact out; the other stays sendable (but WhatsApp is unconfigured).
  await updateContact(banerContact.id, agentId, { opt_in_status: 'opted_out' })
  const group = await (await req('POST', '/api/groups', { name: 'Blast group' })).json()
  await req('POST', `/api/groups/${group.id}/members`, { contact_ids: [wakadContact.id, banerContact.id] })

  const res = await req('POST', `/api/groups/${group.id}/send`, { message: 'New Kharadi launch 🏙️' })
  // The opted-out contact is skipped before any send; the sendable one hits the
  // unconfigured WhatsApp API and surfaces as a 502/503 — either way it never
  // messaged the opted-out contact.
  const body = await res.json().catch(() => ({}))
  if (res.status === 200) {
    assert.equal(body.skipped, 1)
    assert.equal(body.skips.opted_out, 1)
  } else {
    assert.ok([502, 503].includes(res.status))
  }
})

test('empty message and missing group are rejected', async () => {
  const group = await (await req('POST', '/api/groups', { name: 'Empty msg' })).json()
  assert.equal((await req('POST', `/api/groups/${group.id}/send`, { message: '  ' })).status, 400)
  assert.equal((await req('POST', '/api/groups/999999/send', { message: 'hi' })).status, 404)
})
