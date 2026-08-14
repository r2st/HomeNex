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
const { closePool, addContact, createFestiveSchedule, pool } = await import('../db.js')

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

test('the tick reads every agent with a greeting due in one query, not one each', async () => {
  // A festival is the one moment every agent on the box has a schedule land in the same
  // minute — precisely when an extra round trip per agent is least affordable. The
  // agent rows are fetched once for the whole claim; the sends stay per schedule.
  const made = []
  for (let i = 0; i < 5; i++) {
    const who = await (
      await req('POST', '/api/auth/signup', {
        name: `Batch Agent ${i}`,
        phone: `+91980000006${i}`,
        password: 'secret123',
      })
    ).json()
    await createFestiveSchedule(who.agent.id, {
      festival_key: 'holi',
      message: 'Happy Holi, {name}!',
      send_at: new Date(Date.now() - 60_000).toISOString(),
    })
    made.push(who)
  }

  const agentReads = []
  const original = pool.query.bind(pool)
  pool.query = (...args) => {
    const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text || ''
    if (/FROM agents WHERE id/.test(sql)) agentReads.push(sql)
    return original(...args)
  }
  let delivered
  try {
    delivered = await deliverDueFestiveSchedules()
  } finally {
    pool.query = original
  }

  assert.equal(delivered, 5)
  assert.equal(agentReads.length, 1, 'the agent row was fetched once per schedule instead of once per claim')
  assert.match(agentReads[0], /id = ANY/)
})

test('a claim with nothing due does not go looking for agents at all', async () => {
  assert.equal(await deliverDueFestiveSchedules(), 0)
  const reads = []
  const original = pool.query.bind(pool)
  pool.query = (...args) => {
    reads.push(typeof args[0] === 'string' ? args[0] : args[0]?.text || '')
    return original(...args)
  }
  try {
    assert.equal(await deliverDueFestiveSchedules(), 0)
  } finally {
    pool.query = original
  }
  assert.equal(reads.length, 1, 'an empty claim should be the claim and nothing else')
})

// A scheduled delivery runs unattended on the once-a-minute tick, so the only thing
// standing between a failing send and a schedule stuck on 'sending' for ever is the
// loop's own catch. The immediate-send route has a caller to hand a 503 to; this one
// has nobody, and has to mark itself failed and move on to the next schedule.

// Pick a timezone in which "now" is the middle of the working day, whenever the
// suite happens to run. Automated deliveries enforce the send window, so a fixed
// timezone would make this test pass or fail depending on the clock.
function middayTimezone(now = new Date()) {
  const offset = (12 - now.getUTCHours() + 24) % 24
  return offset <= 14 ? `Etc/GMT-${offset}` : `Etc/GMT+${24 - offset}`
}

test('a scheduled delivery that fails is marked failed, and the next one still runs', async () => {
  const one = await (
    await req('POST', '/api/auth/signup', { name: 'Failing Agent', phone: '+919800000054', password: 'secret123' })
  ).json()
  const two = await (
    await req('POST', '/api/auth/signup', { name: 'Second Agent', phone: '+919800000055', password: 'secret123' })
  ).json()

  const tz = middayTimezone()
  for (const who of [one, two]) {
    await req('PUT', '/api/agent/preferences', { timezone: tz }, who.token)
  }
  // Only the first has a contact, so only the first actually attempts a send — and
  // with WhatsApp unconfigured that attempt throws WA_NOT_CONFIGURED.
  await addContact(one.agent.id, '+919777700054', 'Doomed Recipient')

  for (const who of [one, two]) {
    await createFestiveSchedule(who.agent.id, {
      festival_key: 'diwali',
      message: 'Happy Diwali, {name}!',
      send_at: new Date(Date.now() - 60_000).toISOString(),
    })
  }

  // Both are claimed — a failure must not leave the second one unclaimed on the queue.
  assert.equal(await deliverDueFestiveSchedules(), 2)

  const first = (await (await req('GET', '/api/templates/festive', undefined, one.token)).json()).scheduled[0]
  assert.equal(first.status, 'failed', 'a delivery that threw was not recorded as failed')
  assert.equal(first.sent_count, 0)

  // The whole point of catching per-schedule rather than per-run: one agent's broken
  // WhatsApp config must not stop every other agent's greetings going out.
  const second = (await (await req('GET', '/api/templates/festive', undefined, two.token)).json()).scheduled[0]
  assert.equal(second.status, 'sent', 'the second schedule was taken down by the first one failing')

  // And nothing is left claimable, so the tick a minute later does not retry for ever.
  assert.equal(await deliverDueFestiveSchedules(), 0)
})

test('a delivery that fails, and then fails to record that it failed, still lets the tick finish', async () => {
  // The last unguarded step in the loop is the bookkeeping itself. If the send throws
  // and the UPDATE that marks the row 'failed' throws too — a dropped connection mid
  // sweep, say — an unswallowed rejection would escape the catch and abandon every
  // schedule after this one. The `.catch(() => {})` on the mark-failed is what keeps
  // the tick going; without it this test rejects instead of returning a count.
  const who = await (
    await req('POST', '/api/auth/signup', { name: 'Bookkeeping Agent', phone: '+919800000056', password: 'secret123' })
  ).json()
  await req('PUT', '/api/agent/preferences', { timezone: middayTimezone() }, who.token)
  // A contact means a real send is attempted, and with WhatsApp unconfigured it throws.
  await addContact(who.agent.id, '+919777700056', 'Doomed Again')
  await createFestiveSchedule(who.agent.id, {
    festival_key: 'onam',
    message: 'Happy Onam, {name}!',
    send_at: new Date(Date.now() - 60_000).toISOString(),
  })

  let markFailedAttempts = 0
  const original = pool.query.bind(pool)
  pool.query = (...args) => {
    const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text || ''
    if (/UPDATE festive_schedules SET sent_count/.test(sql)) {
      markFailedAttempts++
      return Promise.reject(new Error('connection terminated unexpectedly'))
    }
    return original(...args)
  }
  let delivered
  try {
    delivered = await deliverDueFestiveSchedules()
  } finally {
    pool.query = original
  }

  assert.equal(markFailedAttempts, 1, 'the loop never tried to record the failure')
  assert.equal(delivered, 1, 'a failed mark-failed took the whole tick down with it')

  // The claim already flipped the row to 'sent' up front, so a swallowed mark-failed
  // leaves it exactly there — wrong, but claimed, which is the deliberate trade: the
  // row is not retried for ever and the remaining schedules still got their turn.
  const row = (await (await req('GET', '/api/templates/festive', undefined, who.token)).json()).scheduled[0]
  assert.equal(row.status, 'sent')
  assert.equal(row.sent_count, 0)

  // And the pool is fine afterwards — nothing was left half-written by the stub.
  assert.equal(await deliverDueFestiveSchedules(), 0)
})
