// Festive greeting templates: catalogue, scheduling, cancellation, and delivery.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'
import { FESTIVALS, getFestival, personalizeGreeting } from '../festivals.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('festive')

const { app, deliverDueFestiveSchedules } = await import('../index.js')
const { closePool, addContact, createFestiveSchedule } = await import('../db.js')

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

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const out = await (
    await req('POST', '/api/auth/signup', { name: 'Festive Agent', phone: '+919800000051', password: 'secret123' })
  ).json()
  token = out.token
  agentId = out.agent.id
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

test('all ten festivals ship with default greetings', () => {
  const keys = FESTIVALS.map((f) => f.key)
  for (const expected of [
    'diwali', 'holi', 'eid', 'christmas', 'new_year',
    'makar_sankranti', 'pongal', 'onam', 'navratri', 'ganesh_chaturthi',
  ]) {
    assert.ok(keys.includes(expected), `missing festival: ${expected}`)
  }
  for (const f of FESTIVALS) {
    assert.ok(f.default_message.includes('{name}'), `${f.key} greeting should personalise with {name}`)
    assert.ok(f.suggested_date, `${f.key} needs a suggested date`)
  }
})

test('personalizeGreeting fills placeholders', () => {
  assert.equal(personalizeGreeting('Happy Diwali, {name}! — {agent}', { name: 'Rohan', agent: 'Priya' }),
    'Happy Diwali, Rohan! — Priya')
  assert.equal(personalizeGreeting('Hi {name}', {}), 'Hi ji') // graceful fallback
  assert.equal(getFestival('nope'), null)
})

test('GET /api/templates/festive lists festivals and the agent schedule', async () => {
  const res = await req('GET', '/api/templates/festive')
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.festivals.length, 10)
  assert.deepEqual(data.scheduled, [])
})

test('POST /api/templates/festive/send schedules a future greeting', async () => {
  const sendAt = new Date(Date.now() + 48 * 3600_000).toISOString()
  const res = await req('POST', '/api/templates/festive/send', {
    festival: 'diwali',
    message: 'Custom Diwali wishes, {name}! 🪔',
    send_at: sendAt,
  })
  assert.equal(res.status, 200)
  const out = await res.json()
  assert.equal(out.scheduled, true)
  assert.equal(out.schedule.festival_key, 'diwali')
  assert.equal(out.schedule.message, 'Custom Diwali wishes, {name}! 🪔')
  assert.equal(out.schedule.status, 'scheduled')

  const { scheduled } = await (await req('GET', '/api/templates/festive')).json()
  assert.equal(scheduled.length, 1)
})

test('scheduling uses the default greeting when no custom message is given', async () => {
  const sendAt = new Date(Date.now() + 72 * 3600_000).toISOString()
  const out = await (await req('POST', '/api/templates/festive/send', { festival: 'holi', send_at: sendAt })).json()
  assert.equal(out.schedule.message, getFestival('holi').default_message)
})

test('send validation: unknown festival, bad/past send_at', async () => {
  assert.equal((await req('POST', '/api/templates/festive/send', { festival: 'halloween' })).status, 400)
  assert.equal(
    (await req('POST', '/api/templates/festive/send', { festival: 'diwali', send_at: 'yesterday' })).status,
    400,
  )
  assert.equal(
    (await req('POST', '/api/templates/festive/send', {
      festival: 'diwali',
      send_at: new Date(Date.now() - 3600_000).toISOString(),
    })).status,
    400,
  )
})

test('DELETE cancels a scheduled greeting (but not twice)', async () => {
  const { scheduled } = await (await req('GET', '/api/templates/festive')).json()
  const target = scheduled.find((s) => s.festival_key === 'holi')
  const res = await req('DELETE', `/api/templates/festive/${target.id}`)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).status, 'cancelled')
  assert.equal((await req('DELETE', `/api/templates/festive/${target.id}`)).status, 404)
})

test('immediate send with contacts fails 503 when WhatsApp is not configured', async () => {
  await addContact(agentId, '+919777700051', 'Client One')
  const res = await req('POST', '/api/templates/festive/send', { festival: 'eid' })
  assert.equal(res.status, 503)
})

test('immediate send with zero recipients succeeds with sent=0', async () => {
  const other = await (
    await req('POST', '/api/auth/signup', { name: 'Lonely', phone: '+919800000052', password: 'secret123' })
  ).json()
  const res = await req('POST', '/api/templates/festive/send', { festival: 'eid' }, other.token)
  assert.equal(res.status, 200)
  const out = await res.json()
  assert.equal(out.sent, 0)
  assert.equal(out.recipients, 0)
})

test('deliverDueFestiveSchedules claims due rows exactly once', async () => {
  // Insert a due schedule directly (the API refuses past send_at by design).
  const other = await (
    await req('POST', '/api/auth/signup', { name: 'Due Agent', phone: '+919800000053', password: 'secret123' })
  ).json()
  await createFestiveSchedule(other.agent.id, {
    festival_key: 'onam',
    message: 'Happy Onam, {name}!',
    send_at: new Date(Date.now() - 60_000).toISOString(),
  })
  const delivered = await deliverDueFestiveSchedules()
  assert.equal(delivered, 1)
  // Second run: nothing left to claim.
  assert.equal(await deliverDueFestiveSchedules(), 0)

  const { scheduled } = await (await req('GET', '/api/templates/festive', undefined, other.token)).json()
  assert.equal(scheduled[0].status, 'sent') // zero contacts -> sent with 0 recipients
  assert.equal(scheduled[0].sent_count, 0)
})
