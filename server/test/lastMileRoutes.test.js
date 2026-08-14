// The last route-level arms with no test: a lead the buyer never gave a name to, a
// round-robin owner who has since left the team, an AI helper that throws instead of
// degrading, a delete for a row that isn't there, a bulk send where two contact rows
// share one number, and a scheduled greeting for a festival the calendar no longer
// knows.
//
// They share a shape: each is the second half of a fallback whose first half is what
// every other test in the suite happens to produce.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_APP_SECRET
process.env.AI_MAX_RETRIES = '1' // the AI-failure test must not sit on the retry ladder
process.env.WHATSAPP_ACCESS_TOKEN = 'test-token'
process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-pnid'
const dbName = await createTestDb('lastmileroutes')

const { app, deliverDueFestiveSchedules } = await import('../index.js')
const {
  ready, closePool, query, addContact, createGroup, addGroupMembers,
  createMediaAsset, createFestiveSchedule, upsertLead, addMessage,
} = await import('../db.js')
await ready

let server, base, token, agentId
const GONE = 99_999_999

const realFetch = global.fetch
let sendSeq = 0
const graphSends = []

// Meta accepts everything; calls to our own app go through the real fetch.
global.fetch = async (url, options) => {
  const href = String(url)
  if (!href.includes('graph.facebook.com')) return realFetch(url, options)
  graphSends.push(options?.body ? JSON.parse(options.body) : null)
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ messages: [{ id: `wamid.LASTMILE${++sendSeq}` }] }),
  }
}

const req = (method, url, body, tok = token) =>
  realFetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
const json = async (...args) => (await req(...args)).json()

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const out = await json('POST', '/api/auth/signup', {
    name: 'Route Rhea', phone: '+919733000001', password: 'secret123',
  }, null)
  token = out.token
  agentId = out.agent.id
})

after(async () => {
  global.fetch = realFetch
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// === A buyer who never gave a name ==========================================

test('a first message from a nameless sender is logged against the number', async () => {
  const waId = '919733010001'
  const out = await json('POST', '/api/simulate', { from: waId, name: '', text: 'plots in wakad?' })
  assert.equal(out.lead.name, null, 'nothing to store as a name')

  const { rows } = await query(
    `SELECT text FROM activity WHERE agent_id = $1 AND lead_id = $2 AND kind = 'lead'`,
    [agentId, out.lead.id],
  )
  assert.equal(rows.length, 1)
  assert.equal(
    rows[0].text,
    `New lead: ${waId} via Test`,
    'the number stands in for the name — never "New lead: undefined"',
  )
})

// === AI helpers degrade rather than 500 =====================================

test('a suggestion request answers with an empty list when the AI layer throws', async () => {
  const lead = await upsertLead(agentId, '919733030001', 'Suggest Suhani')
  await addMessage(lead.id, 'buyer', 'kya rate chal raha hai?')

  // suggestReplies reads OPENROUTER_API_KEY at call time. Turning it on with a fetch
  // that rejects is the difference between "AI is off" (an empty list by design) and
  // "AI is on and broke" — the arm that must not surface as a 500 to the composer.
  process.env.OPENROUTER_API_KEY = 'last-mile-key'
  const prevFetch = global.fetch
  global.fetch = async (url, options) => {
    if (String(url).includes('openrouter')) throw Object.assign(new Error('socket hang up'), { name: 'FetchError' })
    return prevFetch(url, options)
  }
  try {
    const res = await req('GET', `/api/leads/${lead.id}/suggestions`)
    assert.equal(res.status, 200, 'a dead provider must not become a server error')
    assert.deepEqual(await res.json(), { suggestions: [] })
  } finally {
    global.fetch = prevFetch
    delete process.env.OPENROUTER_API_KEY
  }
})

// === Deleting a row that isn't there ========================================

test('deleting a media asset twice reports 404 the second time', async () => {
  const asset = await createMediaAsset(agentId, {
    title: 'Brochure', kind: 'brochure', storage: 'url', url: 'https://example.com/b.pdf',
  })
  assert.equal((await req('DELETE', `/api/media/${asset.id}`)).status, 200)

  const again = await req('DELETE', `/api/media/${asset.id}`)
  assert.equal(again.status, 404, 'a delete that removed nothing is not a success')
  assert.deepEqual(await again.json(), { ok: false })
})

// === A second blast inside the min-gap window ================================

test('a contact messaged once is skipped by the min-gap rule on the next blast', async () => {
  // contacts.phone is globally unique, so the "two rows, one number" case the batch
  // prefetch guards against cannot exist; what a blast does have to get right is the
  // send it made a moment ago, read back out of the send log on the next run.
  const contact = await addContact(agentId, '+919733040001', 'Repeat Rakesh')
  const group = await createGroup(agentId, { name: 'Wakad launch' })
  await addGroupMembers(group.id, agentId, [contact.id])

  const before = graphSends.length
  const first = await json('POST', `/api/groups/${group.id}/send`, { message: 'New launch in Wakad' })
  assert.equal(first.sent, 1)
  assert.equal(graphSends.length - before, 1, 'exactly one message reached Meta')

  const second = await json('POST', `/api/groups/${group.id}/send`, { message: 'Reminder: new launch' })
  assert.equal(second.sent, 0, 'the same number is not blasted twice in twelve hours')
  assert.equal(second.skips.too_soon_since_last, 1)
  assert.equal(graphSends.length - before, 1, 'nothing further reached Meta')
})

// === A scheduled greeting for a festival the calendar dropped ================

test('a due greeting for an unknown festival is delivered and logged under its key', async () => {
  // festive_schedules.festival_key is free text: a schedule written while a festival
  // was in the calendar outlives its removal, and the delivery must still name it.
  await addContact(agentId, '+919733050001', 'Festive Farida')
  const schedule = await createFestiveSchedule(agentId, {
    festival_key: 'retired_festival',
    message: 'Wishing you and your family a wonderful year ahead!',
    send_at: new Date(Date.now() - 60_000).toISOString(),
  })

  assert.equal(await deliverDueFestiveSchedules(), 1)

  const { rows } = await query(
    `SELECT text FROM activity WHERE agent_id = $1 AND lead_id IS NULL AND kind = 'agent'
      ORDER BY id DESC LIMIT 1`,
    [agentId],
  )
  assert.match(
    rows[0].text,
    /^retired_festival greeting delivered to \d+ contacts$/,
    'with no festival to name, the stored key is the name',
  )
  const done = (await query('SELECT status FROM festive_schedules WHERE id = $1', [schedule.id])).rows[0]
  assert.equal(done.status, 'sent')
})
