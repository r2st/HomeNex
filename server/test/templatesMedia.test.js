// Template Messages (curated pack, locking, variable fill, RERA auto-append),
// quick replies, and the media library (register + send tracking + window rules).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('templatesmedia')

const { app } = await import('../index.js')
const { closePool, query, createMediaAsset, recordMediaSend, mediaIdsSentToLead, listMediaAssets } = await import('../db.js')

let server, base, token, agentId, leadId

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
const json = (r) => r.json()

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const out = await json(await req('POST', '/api/auth/signup', { name: 'Tpl Agent', phone: '+919800000081', password: 'secret123' }))
  token = out.token
  agentId = (await json(await req('GET', '/api/auth/me'))).id
  // Give the agent a RERA number so marketing templates can append it.
  await query('UPDATE agents SET rera_id = $1, rera_state = $2 WHERE id = $3', ['A52100012345', 'Maharashtra', agentId])
  const sim = await json(await req('POST', '/api/simulate', { from: '919777700081', name: 'Ravi Buyer', text: '3bhk baner' }))
  leadId = sim.lead.id
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

test('the curated template pack is seeded, locked, and system-owned', async () => {
  const templates = await json(await req('GET', '/api/templates'))
  const welcome = templates.find((t) => t.name === 'welcome')
  const listing = templates.find((t) => t.name === 'new_listing')
  assert.ok(welcome && listing, 'welcome + new_listing seeded')
  assert.equal(welcome.is_system, true)
  assert.equal(welcome.is_locked, true)
  assert.equal(welcome.meta_status, 'approved')
  assert.equal(listing.category, 'marketing')
  assert.equal(listing.rera_auto_append, true)
})

test('locked templates: body edits refused, non-body metadata allowed', async () => {
  const welcome = (await json(await req('GET', '/api/templates'))).find((t) => t.name === 'welcome')
  const bad = await req('PUT', `/api/templates/${welcome.id}`, { body: 'totally different wording' })
  assert.equal(bad.status, 403)
  assert.equal((await json(bad)).code, 'TEMPLATE_LOCKED')
  // A non-body change is allowed even on a locked template.
  assert.equal((await req('PUT', `/api/templates/${welcome.id}`, { rera_auto_append: true })).status, 200)
})

test('system templates cannot be deleted; custom templates can', async () => {
  const welcome = (await json(await req('GET', '/api/templates'))).find((t) => t.name === 'welcome')
  assert.equal((await req('DELETE', `/api/templates/${welcome.id}`)).status, 403)

  const custom = await json(await req('POST', '/api/templates', { name: 'my_followup', category: 'utility', body: 'Hi {{name}}, following up.' }))
  assert.ok(custom.id)
  assert.equal((await req('DELETE', `/api/templates/${custom.id}`)).status, 200)
})

test('sending a template rejects missing variables', async () => {
  // Close the window so the template branch is the intended path (not required, but realistic).
  await query(`UPDATE leads SET last_inbound_at = now() - interval '25 hours' WHERE id = $1`, [leadId])
  const reminder = (await json(await req('GET', '/api/templates'))).find((t) => t.name === 'site_visit_reminder')
  // needs name, property, visit_time — supply none
  const res = await req('POST', `/api/leads/${leadId}/reply`, { template_id: reminder.id, variables: {} })
  assert.equal(res.status, 400)
  const body = await json(res)
  assert.equal(body.code, 'TEMPLATE_VARS_MISSING')
  assert.deepEqual(body.missing, ['name', 'property', 'visit_time'])
})

test('a fully-filled template passes validation (fails only on WA config)', async () => {
  const welcome = (await json(await req('GET', '/api/templates'))).find((t) => t.name === 'welcome')
  const res = await req('POST', `/api/leads/${leadId}/reply`, { template_id: welcome.id, variables: { name: 'Ravi' } })
  // 503 = WhatsApp unconfigured in tests — variable validation already passed.
  assert.equal(res.status, 503)
})

test('quick replies: defaults seeded + full CRUD', async () => {
  const seeded = await json(await req('GET', '/api/quick-replies'))
  assert.ok(seeded.length >= 5, 'default quick replies seeded')

  const created = await json(await req('POST', '/api/quick-replies', { title: 'Thanks', body: 'Thank you {{name}}!' }))
  assert.ok(created.id)
  const updated = await json(await req('PUT', `/api/quick-replies/${created.id}`, { body: 'Thanks a lot, {{name}}!' }))
  assert.match(updated.body, /a lot/)
  assert.equal((await req('DELETE', `/api/quick-replies/${created.id}`)).status, 200)
})

test('media library: register a URL asset and an uploaded (base64) asset', async () => {
  const urlAsset = await json(await req('POST', '/api/media', {
    title: 'Green Acres brochure', kind: 'brochure', url: 'https://example.com/green-acres.pdf',
  }))
  assert.equal(urlAsset.storage, 'url')
  assert.equal(urlAsset.sent_count, undefined) // create returns the row; sent_count is a list-only field

  // 1x1 PNG
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  const uploaded = await json(await req('POST', '/api/media', { title: 'Floor plan', kind: 'floor_plan', data_base64: png, filename: 'plan.png' }))
  assert.equal(uploaded.storage, 'local')
  assert.match(uploaded.url, /\/uploads\/.+\.png$/)

  const list = await json(await req('GET', '/api/media'))
  assert.equal(list.length, 2)
  assert.ok(list.every((a) => a.sent_count === 0))

  // Missing url and data both -> 400
  assert.equal((await req('POST', '/api/media', { title: 'x' })).status, 400)
})

test('media send is blocked outside the 24h window', async () => {
  const asset = (await json(await req('GET', '/api/media')))[0]
  await query(`UPDATE leads SET last_inbound_at = now() - interval '25 hours' WHERE id = $1`, [leadId])
  const res = await req('POST', `/api/media/${asset.id}/send`, { lead_id: leadId })
  assert.equal(res.status, 409)
  assert.equal((await json(res)).code, 'WINDOW_EXPIRED')
})

test('media send tracking (db layer): sent_count and per-lead ids', async () => {
  const asset = await createMediaAsset(agentId, { title: 'Walkthrough', kind: 'video', storage: 'url', url: 'https://example.com/w.mp4' })
  assert.deepEqual(await mediaIdsSentToLead(leadId), [])
  await recordMediaSend(asset.id, leadId, agentId, 'wamid.test')
  assert.deepEqual(await mediaIdsSentToLead(leadId), [asset.id])
  const listed = (await listMediaAssets(agentId)).find((a) => a.id === asset.id)
  assert.equal(listed.sent_count, 1)
})
