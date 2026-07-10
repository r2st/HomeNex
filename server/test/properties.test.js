// API tests for property inventory CRUD, filtering, and send-to-chat.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN // WhatsApp inert: send-to-chat should 503
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('properties')

const { app, formatPropertyMessage } = await import('../index.js')
const { closePool, upsertLead } = await import('../db.js')
const { paiseToDisplay, lakhsToPaise } = await import('../money.js')

let server
let base
let token
let agentId

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
    },
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
    await req('POST', '/api/auth/signup', { name: 'Inventory Agent', phone: '+919800000003', password: 'secret123' })
  ).json()
  token = out.token
  agentId = out.agent.id
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

test('money helpers format paise as ₹ L / ₹ Cr', () => {
  assert.equal(paiseToDisplay(45_0000000), '₹ 45L')
  assert.equal(paiseToDisplay(1_20_0000000), '₹ 1.2Cr')
  assert.equal(paiseToDisplay(85_5000000), '₹ 85.5L')
  assert.equal(paiseToDisplay(8000000), '₹ 80,000')
  assert.equal(paiseToDisplay(null), null)
  assert.equal(lakhsToPaise(45), 45_0000000)
  assert.equal(lakhsToPaise(null), null)
})

test('POST /api/properties creates a property (price stored in paise)', async () => {
  const res = await req('POST', '/api/properties', {
    title: 'Kolte Patil 24K Sereno — 2BHK',
    property_type: 'apartment',
    bhk: '2',
    size_sqft: 985,
    price_paise: lakhsToPaise(88),
    locality: 'Baner',
    city: 'Pune',
    rera_project_number: 'P52100012345',
    builder_name: 'Kolte Patil',
    amenities: ['gym', 'pool'],
    photos: [],
  })
  assert.equal(res.status, 200)
  const p = await res.json()
  assert.equal(p.price_paise, 88_0000000)
  assert.equal(p.status, 'available')
  assert.deepEqual(p.amenities, ['gym', 'pool'])
})

test('POST /api/properties requires a title and validates enums', async () => {
  assert.equal((await req('POST', '/api/properties', { locality: 'Baner' })).status, 400)
  assert.equal((await req('POST', '/api/properties', { title: 'X', property_type: 'igloo' })).status, 400)
})

test('GET /api/properties filters by type, BHK, locality, price range, and status', async () => {
  await req('POST', '/api/properties', {
    title: 'Wakad Villa', property_type: 'villa', bhk: '4', price_paise: lakhsToPaise(250), locality: 'Wakad', city: 'Pune',
  })
  await req('POST', '/api/properties', {
    title: 'Baner Plot', property_type: 'plot', price_paise: lakhsToPaise(60), locality: 'Baner', city: 'Pune', status: 'token',
  })

  const all = await (await req('GET', '/api/properties')).json()
  assert.equal(all.length, 3)

  assert.equal((await (await req('GET', '/api/properties?type=villa')).json()).length, 1)
  assert.equal((await (await req('GET', '/api/properties?bhk=2')).json()).length, 1)
  assert.equal((await (await req('GET', '/api/properties?locality=baner')).json()).length, 2)
  assert.equal((await (await req('GET', '/api/properties?status=token')).json()).length, 1)

  const under1cr = await (await req('GET', `/api/properties?max_price=${lakhsToPaise(100)}`)).json()
  assert.deepEqual(under1cr.map((p) => p.title).sort(), ['Baner Plot', 'Kolte Patil 24K Sereno — 2BHK'])
  const over1cr = await (await req('GET', `/api/properties?min_price=${lakhsToPaise(100)}`)).json()
  assert.deepEqual(over1cr.map((p) => p.title), ['Wakad Villa'])

  const search = await (await req('GET', '/api/properties?q=kolte')).json()
  assert.equal(search.length, 1)
})

test('PUT /api/properties/:id updates fields; DELETE removes', async () => {
  const [plot] = await (await req('GET', '/api/properties?type=plot')).json()
  const upd = await req('PUT', `/api/properties/${plot.id}`, { status: 'sold', price_paise: lakhsToPaise(62) })
  assert.equal(upd.status, 200)
  const updated = await upd.json()
  assert.equal(updated.status, 'sold')
  assert.equal(updated.price_paise, 62_0000000)

  assert.equal((await req('DELETE', `/api/properties/${plot.id}`)).status, 200)
  assert.equal((await req('DELETE', `/api/properties/${plot.id}`)).status, 404)
})

test('properties are scoped per agent', async () => {
  const other = await (
    await req('POST', '/api/auth/signup', { name: 'Rival', phone: '+919800000004', password: 'secret123' })
  ).json()
  const theirs = await (await req('GET', '/api/properties', undefined, other.token)).json()
  assert.equal(theirs.length, 0)
  const [mine] = await (await req('GET', '/api/properties?type=villa')).json()
  assert.equal((await req('PUT', `/api/properties/${mine.id}`, { status: 'sold' }, other.token)).status, 404)
})

test('formatPropertyMessage renders a WhatsApp-ready card', () => {
  const msg = formatPropertyMessage({
    title: 'Test Home',
    bhk: '2',
    property_type: 'apartment',
    size_sqft: 985,
    locality: 'Baner',
    city: 'Pune',
    price_paise: 88_0000000,
    builder_name: 'Kolte Patil',
    rera_project_number: 'P521000',
  })
  assert.match(msg, /🏠 \*Test Home\*/)
  assert.match(msg, /2 BHK · apartment · 985 sqft/)
  assert.match(msg, /📍 Baner, Pune/)
  assert.match(msg, /💰 ₹ 88L/)
  assert.match(msg, /RERA: P521000/)
})

test('send-to-chat validates ownership and reports WhatsApp config errors', async () => {
  const [property] = await (await req('GET', '/api/properties?type=villa')).json()
  const lead = await upsertLead(agentId, '919888800001', 'Site Visit Sam')

  // No lead_id → 400; unknown lead → 404; WhatsApp unconfigured → 503.
  assert.equal((await req('POST', `/api/properties/${property.id}/send-to-chat`, {})).status, 400)
  assert.equal((await req('POST', `/api/properties/${property.id}/send-to-chat`, { lead_id: 999999 })).status, 404)
  assert.equal((await req('POST', `/api/properties/${property.id}/send-to-chat`, { lead_id: lead.id })).status, 503)
})
