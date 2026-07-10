// Integration tests for property view analytics + per-lead view attribution.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('analytics')

const { app } = await import('../index.js')
const { closePool, upsertLead, addMessage, createProperty, ensurePropertySlug } = await import('../db.js')

let server, base, token, agentId, leadId, propertyId, slug

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

// The public /p route records views fire-and-forget (for page speed), so view
// counts are eventually consistent. Poll analytics until the total settles.
const analyticsWhenTotal = async (n) => {
  for (let i = 0; i < 40; i++) {
    const a = await (await req('GET', `/api/properties/${propertyId}/analytics`)).json()
    if (a.total >= n) return a
    await new Promise((r) => setTimeout(r, 25))
  }
  return (await req('GET', `/api/properties/${propertyId}/analytics`)).json()
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const out = await (await req('POST', '/api/auth/signup', { name: 'Analytics Agent', phone: '+919800000091', password: 'secret123' })).json()
  token = out.token
  agentId = out.agent.id
  const lead = await upsertLead(agentId, '919777700091', 'Viewer Vinod')
  await addMessage(lead.id, 'buyer', 'send me the link')
  leadId = lead.id
  const prop = await createProperty(agentId, { title: 'Analytics Heights', locality: 'Kharadi', city: 'Pune' })
  propertyId = prop.id
  const withSlug = await ensurePropertySlug(prop.id, agentId)
  slug = withSlug.micro_page_slug
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

test('a public micro-page hit with ?l= attributes the view to the lead', async () => {
  // Three hits carrying the lead ref (as the tracked share link would).
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${base}/p/${slug}?l=${leadId}`)
    assert.equal(res.status, 200)
  }
  // An anonymous hit (no ref) still counts toward totals but not to the lead.
  await fetch(`${base}/p/${slug}`)

  const a = await analyticsWhenTotal(4)
  assert.equal(a.total, 4)
  assert.equal(a.distinct_leads, 1)
  const viewer = a.viewers.find((v) => v.lead_id === leadId)
  assert.equal(viewer.views, 3)
  assert.equal(viewer.lead_name, 'Viewer Vinod')
})

test('a bogus ?l= is ignored, not attributed cross-tenant', async () => {
  // Another agent's lead id must never attach to this agent's property view.
  const other = await (await req('POST', '/api/auth/signup', { name: 'Other', phone: '+919800000092', password: 'secret123' })).json()
  const otherLead = await upsertLead(other.agent.id, '919777700092', 'Other Otto')
  await fetch(`${base}/p/${slug}?l=${otherLead.id}`)
  await fetch(`${base}/p/${slug}?l=abc`) // non-numeric

  const a = await (await req('GET', `/api/properties/${propertyId}/analytics`)).json()
  assert.equal(a.distinct_leads, 1, 'cross-tenant lead ref was dropped')
})

test('analytics returns a daily trend series and totals', async () => {
  const a = await (await req('GET', `/api/properties/${propertyId}/analytics`)).json()
  assert.ok(Array.isArray(a.daily))
  assert.ok(a.daily.length >= 1)
  assert.ok('last_24h' in a && 'last_7d' in a)
  assert.equal(a.title, 'Analytics Heights')
})

test('analytics 404s for another agent’s property', async () => {
  const other = await (await req('POST', '/api/auth/signup', { name: 'Nosy', phone: '+919800000093', password: 'secret123' })).json()
  assert.equal((await req('GET', `/api/properties/${propertyId}/analytics`, undefined, other.token)).status, 404)
})
