// WhatsApp 24h service window: anchor tracking, free-text enforcement,
// template bypass, and the AI reply-suggestions endpoint's graceful degradation.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('window24h')

const { app } = await import('../index.js')
const { closePool, query, serviceWindow } = await import('../db.js')

let server
let base
let token
let leadId

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
    await req('POST', '/api/auth/signup', { name: 'Window Agent', phone: '+919800000061', password: 'secret123' })
  ).json()
  token = out.token

  const sim = await (
    await req('POST', '/api/simulate', { from: '919777700061', name: 'Window Wren', text: '2bhk chahiye wakad me' })
  ).json()
  leadId = sim.lead.id
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

test('a buyer message opens the 24h service window', async () => {
  const lead = await (await req('GET', `/api/leads/${leadId}`)).json()
  assert.ok(lead.last_inbound_at, 'last_inbound_at should be stamped')
  assert.equal(lead.service_window.open, true)
  const msLeft = new Date(lead.service_window.expires_at).getTime() - Date.now()
  assert.ok(msLeft > 23.9 * 3600_000 && msLeft <= 24 * 3600_000, `unexpected window: ${msLeft}ms`)
})

test('serviceWindow helper handles missing and stale anchors', () => {
  assert.deepEqual(serviceWindow({ last_inbound_at: null }), { open: false, expires_at: null })
  const stale = serviceWindow({ last_inbound_at: new Date(Date.now() - 25 * 3600_000).toISOString() })
  assert.equal(stale.open, false)
  assert.ok(stale.expires_at)
  const fresh = serviceWindow({ last_inbound_at: new Date().toISOString() })
  assert.equal(fresh.open, true)
})

test('free-text reply passes the window check while open (fails only on WA config)', async () => {
  const res = await req('POST', `/api/leads/${leadId}/reply`, { text: 'Sure, sharing options now' })
  // 503 = WhatsApp unconfigured in tests — the window check was passed.
  assert.equal(res.status, 503)
})

test('free-text reply is rejected 409 once the window expires', async () => {
  await query(`UPDATE leads SET last_inbound_at = now() - interval '25 hours' WHERE id = $1`, [leadId])
  const res = await req('POST', `/api/leads/${leadId}/reply`, { text: 'hello again' })
  assert.equal(res.status, 409)
  const body = await res.json()
  assert.equal(body.code, 'WINDOW_EXPIRED')
  assert.equal(body.service_window.open, false)
})

test('template messages bypass the expired window', async () => {
  const tpl = await (
    await req('POST', '/api/templates', { name: 'reopen', category: 'utility', body: 'Hi {name}, following up on your enquiry.' })
  ).json()
  assert.ok(tpl.id, 'template should be created')

  const list = await (await req('GET', '/api/templates')).json()
  assert.ok(list.some((t) => t.id === tpl.id))

  const res = await req('POST', `/api/leads/${leadId}/reply`, { template_id: tpl.id })
  // Past the 409 gate; fails 503 only because WhatsApp creds are absent in tests.
  assert.equal(res.status, 503)

  assert.equal((await req('POST', `/api/leads/${leadId}/reply`, { template_id: 999999 })).status, 404)
})

test('a new buyer message re-opens the window', async () => {
  await req('POST', '/api/simulate', { from: '919777700061', name: 'Window Wren', text: 'aur options?' })
  const lead = await (await req('GET', `/api/leads/${leadId}`)).json()
  assert.equal(lead.service_window.open, true)

  const res = await req('POST', `/api/leads/${leadId}/reply`, { text: 'back in business' })
  assert.equal(res.status, 503) // window check passed again
})

test('GET /api/leads/:id/suggestions degrades to an empty list without AI', async () => {
  // Last message is from the buyer (simulate above), so suggestions are in scope —
  // but with no OPENROUTER_API_KEY the endpoint must return [] rather than fail.
  const res = await req('GET', `/api/leads/${leadId}/suggestions`)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { suggestions: [] })

  assert.equal((await req('GET', '/api/leads/999999/suggestions')).status, 404)
})
