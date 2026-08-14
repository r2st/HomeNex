// Every text field an agent can post is bounded now.
//
// Nearly all of them land in an unbounded Postgres TEXT column, so until this the
// only ceiling was express.json()'s 25MB body cap — a limit that exists so the media
// library can post a base64 photo. That made "how long can a contact's name be?"
// answerable with eighteen megabytes, on a field the list renders in one line, and
// on a table (leads, contacts, properties) that a polled dashboard re-reads every
// few seconds.
//
// Two halves here: the middleware's own rules, and a sweep over the real routes
// asserting the bound is actually mounted on each one. The sweep matters more than
// it looks — a limit table is easy to write and easy to forget to wire up, and a
// forgotten one fails open, silently.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'
import { boundedText, TEXT } from '../middleware.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('textlimits')

const { app } = await import('../index.js')
const { ready, closePool } = await import('../db.js')

await ready

let server, base, token

const req = (method, url, body) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  token = (
    await (
      await fetch(`${base}/api/auth/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Limit Latika', phone: '+919848000001', password: 'secret123' }),
      })
    ).json()
  ).token
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- The middleware's own rules ---------------------------------------------------

// Driven directly rather than through a route: these are the decisions the guard
// makes before any handler sees the body, and each one is a deliberate choice about
// what "too long" does and does not mean.
function run(limits, body) {
  const req = { body }
  let rejected = null
  let passed = false
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      rejected = { status: this.statusCode, ...payload }
      return this
    },
  }
  boundedText(limits)(req, res, () => {
    passed = true
  })
  return { rejected, passed }
}

test('a field at exactly its limit is allowed; one character more is not', () => {
  assert.equal(run({ note: 10 }, { note: 'x'.repeat(10) }).passed, true)

  const { rejected, passed } = run({ note: 10 }, { note: 'x'.repeat(11) })
  assert.equal(passed, false, 'the handler must never see an over-long field')
  assert.equal(rejected.status, 400)
  assert.equal(rejected.code, 'FIELD_TOO_LONG')
  assert.equal(rejected.field, 'note', 'the caller is told which field, not just that one was wrong')
  assert.equal(rejected.max, 10, 'and what the limit is, so a client can trim rather than guess')
  assert.match(rejected.error, /note must be 10 characters or fewer/)
})

test('only strings are measured', () => {
  // A number, an object or an array in a text field is a different complaint —
  // Postgres or the route's own validation answers it. Length is not the issue, and
  // pretending it is would turn a clear type error into a confusing one.
  for (const value of [12345, { a: 1 }, ['x', 'y'], true]) {
    assert.equal(run({ note: 2 }, { note: value }).passed, true, JSON.stringify(value))
  }
})

test('an absent, null or empty field is not a violation', () => {
  for (const body of [{}, { note: null }, { note: undefined }, { note: '' }, { other: 'x'.repeat(99) }]) {
    assert.equal(run({ note: 5 }, body).passed, true, JSON.stringify(body))
  }
})

test('a body that is not a plain object is left to the route', () => {
  // body-parser leaves req.body undefined when there is no JSON content-type, and a
  // JSON array body is a shape no route accepts. Neither is this guard's argument.
  for (const body of [undefined, null, 'a string', ['x'.repeat(99)]]) {
    assert.equal(run({ note: 5 }, body).passed, true, String(body))
  }
})

test('the first over-long field wins, and stops there', () => {
  const { rejected } = run({ a: 1, b: 1 }, { a: 'xx', b: 'yy' })
  assert.equal(rejected.field, 'a', 'reported in the order the limits are declared')
})

test('the named sizes are the ones the product actually uses', () => {
  // WHATSAPP is not a round number by accident: it is Meta's own cap on a text
  // message body. A longer send is refused by the Graph API after we have paid for
  // the round trip, so the number has to stay in step with theirs.
  assert.equal(TEXT.WHATSAPP, 4096)
  assert.ok(TEXT.LINE < TEXT.BLURB && TEXT.BLURB < TEXT.PROSE)
})

// --- The sweep: every bound is really mounted -------------------------------------

// (method, url, field, max). Ids are deliberately bogus — the guard runs ahead of
// the handler, so a route that rejects the length never gets as far as the lookup,
// and one that doesn't reject it gives itself away with a 404.
const BOUNDED = [
  ['PUT', '/api/agent/preferences', 'timezone', TEXT.LINE],
  // The agent's own account routes. Every one of these reaches something that charges
  // by the character — scryptSync for the two password routes, normalizePhone and a
  // stored TEXT column for the rest — and none of them was bounded.
  ['PUT', '/api/agent/phone', 'phone', TEXT.LINE],
  ['PUT', '/api/agent/phone', 'password', TEXT.PASSWORD],
  ['PUT', '/api/agent/password', 'current_password', TEXT.PASSWORD],
  ['PUT', '/api/agent/password', 'new_password', TEXT.PASSWORD],
  ['PUT', '/api/agent/phone-config', 'wa_phone_number', TEXT.LINE],
  ['PUT', '/api/agent/phone-config', 'wa_phone_number_id', TEXT.LINE],
  ['PUT', '/api/agent/wa-phone', 'wa_phone_number', TEXT.LINE],
  ['PUT', '/api/leads/999999', 'name', TEXT.LINE],
  ['PUT', '/api/leads/999999', 'notes', TEXT.PROSE],
  ['PUT', '/api/leads/999999', 'preferred_localities', TEXT.BLURB],
  ['PUT', '/api/leads/999999/stage', 'lost_reason', TEXT.BLURB],
  ['POST', '/api/leads/999999/notes', 'body', TEXT.PROSE],
  ['POST', '/api/leads/999999/reply', 'text', TEXT.WHATSAPP],
  ['POST', '/api/emi', 'text', TEXT.BLURB],
  ['PUT', '/api/contacts/999999', 'name', TEXT.LINE],
  ['PUT', '/api/contacts/999999', 'notes', TEXT.PROSE],
  ['POST', '/api/properties', 'title', TEXT.LINE],
  ['POST', '/api/properties', 'locality', TEXT.LINE],
  ['POST', '/api/properties', 'notes', TEXT.PROSE],
  ['POST', '/api/properties', 'brochure_url', TEXT.URL],
  ['PUT', '/api/properties/999999', 'title', TEXT.LINE],
  ['POST', '/api/followups', 'note', TEXT.PROSE],
  ['PUT', '/api/followups/999999', 'note', TEXT.PROSE],
  ['POST', '/api/site-visits', 'pickup_location', TEXT.BLURB],
  ['PUT', '/api/site-visits/999999', 'outcome_notes', TEXT.PROSE],
  ['POST', '/api/deals', 'builder_name', TEXT.LINE],
  ['POST', '/api/deals', 'notes', TEXT.PROSE],
  ['PUT', '/api/deals/999999', 'notes', TEXT.PROSE],
  ['POST', '/api/commissions', 'builder_name', TEXT.LINE],
  ['PUT', '/api/commissions/999999', 'notes', TEXT.PROSE],
  ['POST', '/api/commissions/999999/invoice', 'invoice_number', TEXT.LINE],
  ['PUT', '/api/commission-invoices/999999', 'notes', TEXT.PROSE],
  ['POST', '/api/templates', 'name', TEXT.LINE],
  ['POST', '/api/templates', 'body', TEXT.WHATSAPP],
  ['PUT', '/api/templates/999999', 'body', TEXT.WHATSAPP],
  ['POST', '/api/quick-replies', 'title', TEXT.LINE],
  ['POST', '/api/quick-replies', 'body', TEXT.PROSE],
  ['PUT', '/api/quick-replies/999999', 'body', TEXT.PROSE],
  ['POST', '/api/labels', 'name', TEXT.LINE],
  ['POST', '/api/labels', 'color', TEXT.LINE],
  ['POST', '/api/media', 'title', TEXT.LINE],
  ['POST', '/api/media', 'caption', TEXT.BLURB],
  ['POST', '/api/media', 'url', TEXT.URL],
  ['POST', '/api/uploads', 'filename', TEXT.LINE],
  ['POST', '/api/media/999999/send', 'caption', TEXT.BLURB],
  ['POST', '/api/templates/festive/send', 'message', TEXT.WHATSAPP],
  ['POST', '/api/groups', 'name', TEXT.LINE],
  ['PUT', '/api/groups/999999', 'name', TEXT.LINE],
  ['POST', '/api/groups/999999/send', 'message', TEXT.WHATSAPP],
  ['POST', '/api/leads/quick-add', 'name', TEXT.LINE],
  ['POST', '/api/leads/quick-add', 'open_message', TEXT.WHATSAPP],
  ['POST', '/api/support/tickets', 'subject', TEXT.LINE],
  ['POST', '/api/support/tickets', 'body', TEXT.PROSE],
  ['POST', '/api/support/tickets/999999/reply', 'body', TEXT.PROSE],
  ['PUT', '/api/portal-integrations/99acres', 'api_key', TEXT.LINE],
  ['POST', '/api/simulate', 'text', TEXT.WHATSAPP],
]

test('every bounded field really is bounded on its route', async () => {
  const unguarded = []
  for (const [method, url, field, max] of BOUNDED) {
    const res = await req(method, url, { [field]: 'x'.repeat(max + 1) })
    const body = await res.json().catch(() => ({}))
    if (res.status !== 400 || body.code !== 'FIELD_TOO_LONG' || body.field !== field) {
      unguarded.push(`${method} ${url} [${field}] -> ${res.status} ${body.code || '?'} ${body.field || ''}`)
    }
  }
  assert.deepEqual(unguarded, [], 'fields that accepted one character over their limit')
})

test('a field at exactly its limit is never rejected for length', async () => {
  // The other half of the same claim: the bound has to be off-by-none. These calls
  // are expected to fail for their own reasons (a bogus id, a missing sibling
  // field) — they just must not fail because of the length.
  const overTight = []
  for (const [method, url, field, max] of BOUNDED) {
    const res = await req(method, url, { [field]: 'x'.repeat(max) })
    const body = await res.json().catch(() => ({}))
    if (body.code === 'FIELD_TOO_LONG') overTight.push(`${method} ${url} [${field}] rejected at exactly ${max}`)
  }
  assert.deepEqual(overTight, [], 'fields rejected at their own stated limit')
})

// --- What must NOT be bounded -----------------------------------------------------

test('the fields that legitimately carry a payload are left alone', async () => {
  // The profile photo is a data: URI and the media library posts base64 file
  // contents. Both are far longer than any text limit and are capped elsewhere — by
  // normalizeAvatar and by saveUpload's decoded byte ceiling. A text bound on either
  // would break the feature rather than protect it.
  const avatar = `data:image/png;base64,${'A'.repeat(5000)}`
  const res = await req('PUT', '/api/agent/profile', { avatar_url: avatar })
  assert.notEqual((await res.json().catch(() => ({}))).code, 'FIELD_TOO_LONG')

  const upload = await req('POST', '/api/uploads', { data_base64: 'A'.repeat(9000), filename: 'big.png' })
  assert.notEqual((await upload.json()).code, 'FIELD_TOO_LONG', 'an upload is bounded by bytes, not characters')
})

test('the profile keeps its own, better-worded caps', async () => {
  // updateAgentProfileSelf caps these per field (name 80, bio 500, RERA id 64) and
  // names them the way the form labels them. A blanket guard in front of it would
  // have replaced "Name is too long (max 80 characters)" with something vaguer and
  // a limit 40 characters looser.
  const res = await req('PUT', '/api/agent/profile', { name: 'x'.repeat(81) })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /Name is too long \(max 80 characters\)/)
})
