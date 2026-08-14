// Route arms that only a particular shape of request or a particular upstream
// failure reaches: an upload the server refuses, a second group blast that the
// limiter has to hold back, a review request for a template that isn't there, and
// a suggestions call whose provider dies rather than answers badly.
//
// WhatsApp is configured here with a mocked global.fetch, because the interesting
// arm of the bulk send is what the limiter does with the SECOND recipient after the
// first has actually gone out — which never happens with sending switched off.
import { test, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
process.env.WHATSAPP_ACCESS_TOKEN = 'test-token'
process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-pnid'
process.env.WHATSAPP_APP_SECRET = 'arms-app-secret' // else boot warns about unverified webhooks
process.env.OPENROUTER_API_KEY = 'test-key'
process.env.AI_MAX_RETRIES = '0'
const dbName = await createTestDb('routearms')

const { app } = await import('../index.js')
const {
  closePool, addContact, updateContact, createGroup, addGroupMembers,
  upsertLead, addMessage, createMessageTemplate,
} = await import('../db.js')

const realFetch = global.fetch
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

// The app's own routes are reached over real HTTP, so global.fetch has to keep
// working for localhost while standing in for the Graph API and OpenRouter.
function mockUpstream(handler) {
  global.fetch = async (url, options) => {
    const href = String(url)
    if (href.startsWith(base)) return realFetch(url, options)
    return handler(href, options)
  }
}

const graphOk = () =>
  mockUpstream(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ messages: [{ id: 'wamid.mock' }] }),
    text: async () => '{}',
    headers: { get: () => null },
  }))

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const out = await (
    await req('POST', '/api/auth/signup', { name: 'Arm Agent', phone: '+919800000771', password: 'secret123' }, null)
  ).json()
  token = out.token
  agentId = out.agent.id
})

afterEach(() => {
  global.fetch = realFetch
})

after(async () => {
  global.fetch = realFetch
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// === POST /api/media: uploads the server refuses ===============================
//
// saveUpload throws a coded error for a file that is too big or of a type we won't
// host. The media route's catch has to recognise both as the caller's fault: a
// rethrow here becomes a 500, and the media picker shows "something went wrong"
// instead of telling the agent their file is a .exe.

test('a media upload of a type we do not host is a 400 that names the type', async () => {
  const res = await req('POST', '/api/media', {
    title: 'Installer',
    data_base64: Buffer.from('MZ not really an exe').toString('base64'),
    filename: 'payload.exe',
  })
  assert.equal(res.status, 400, 'a rejected file type did not come back as a bad request')
  const body = await res.json()
  assert.match(body.error, /Unsupported file type: \.exe/)
})

test('a media upload with no usable extension at all is still a 400', async () => {
  // No filename extension and an unknown mime leaves nothing to check against the
  // allow-list, which is a rejection rather than a guess.
  const res = await req('POST', '/api/media', {
    title: 'Mystery',
    data_base64: Buffer.from('who knows').toString('base64'),
    filename: 'mystery',
    mime: 'application/x-mystery',
  })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /Unsupported file type/)
})

test('a media upload over the size ceiling is a 400 that names the ceiling', async () => {
  // 15MB decoded is the limit; 16MB of zeroes is comfortably past it and costs
  // nothing to build.
  const res = await req('POST', '/api/media', {
    title: 'Brochure',
    data_base64: Buffer.alloc(16 * 1024 * 1024).toString('base64'),
    filename: 'huge.pdf',
  })
  assert.equal(res.status, 400, 'an oversized upload did not come back as a bad request')
  assert.match((await res.json()).error, /File too large — max 15MB/)
})

test('a media upload of an allowed type still succeeds', async () => {
  const res = await req('POST', '/api/media', {
    title: 'Floor plan',
    data_base64: Buffer.from('%PDF-1.4 fake').toString('base64'),
    filename: 'plan.pdf',
  })
  assert.equal(res.status, 200)
  const asset = await res.json()
  assert.equal(asset.storage, 'local')
  assert.match(asset.url, /\/uploads\/[0-9a-f]+\.pdf$/)
})

// === POST /api/groups/:id/send: the limiter holding back a second blast =========
//
// The audience can't hold the same number twice — contacts.phone is UNIQUE across
// the whole table (001_initial_schema.sql) and every write path canonicalises
// through normalizePhone, so "+919800000772" and "919800000772" collide rather than
// becoming two rows. The reachable version of "don't message this number again" is
// therefore the SECOND blast: the per-contact history prefetched for the audience
// has to carry the first blast's sends forward and block on the 12h min gap.

let launchGroup

test('a group blast sends to every member and records it', async () => {
  graphOk()
  const a = await addContact(agentId, '+919800000772', 'Rahul Sharma')
  const b = await addContact(agentId, '+919800000774', 'Priya Nair')

  launchGroup = await createGroup(agentId, { name: 'Wakad Launch' })
  await addGroupMembers(launchGroup.id, agentId, [a.id, b.id])

  const res = await req('POST', `/api/groups/${launchGroup.id}/send`, { message: 'New launch in Wakad' })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { sent: 2, failed: 0, skipped: 0, skips: {}, recipients: 2 })
})

test('blasting the same group again is skipped by the min-gap rule, not sent twice', async () => {
  // Prefetching each contact's send history in one query is only equivalent to
  // querying inside the loop if it actually sees what the last run wrote. If the
  // batch query missed those rows every member would look never-messaged and the
  // whole group would get the blast a second time within the hour.
  graphOk()
  assert.ok(launchGroup, 'the previous test should have left the group behind')

  const res = await req('POST', `/api/groups/${launchGroup.id}/send`, { message: 'Reminder: launch this weekend' })
  assert.equal(res.status, 200)
  const result = await res.json()

  assert.equal(result.sent, 0, 'the group was blasted twice inside the min-gap window')
  assert.equal(result.skipped, 2)
  assert.equal(result.skips.too_soon_since_last, 2, `expected min-gap skips, got ${JSON.stringify(result.skips)}`)
})

test('an opted-out member is skipped while the rest of the group still goes out', async () => {
  // opt_in_status is the first gate in evaluateSend, so it is the one skip reason
  // that coexists with a successful send in the same run — the counters have to keep
  // the two apart rather than reporting the blast as wholly sent or wholly skipped.
  graphOk()
  const out = await addContact(agentId, '+919800000775', 'Opted Out')
  const inn = await addContact(agentId, '+919800000776', 'Still Subscribed')
  await updateContact(out.id, agentId, { opt_in_status: 'opted_out' })

  const group = await createGroup(agentId, { name: 'Mixed Consent' })
  await addGroupMembers(group.id, agentId, [out.id, inn.id])

  const res = await req('POST', `/api/groups/${group.id}/send`, { message: 'Open house Sunday' })
  const result = await res.json()
  assert.equal(result.sent, 1)
  assert.equal(result.skipped, 1)
  assert.equal(result.skips.opted_out, 1, `expected an opt-out skip, got ${JSON.stringify(result.skips)}`)
})

// === POST /api/templates/:id/request-review ====================================

test('requesting review of a template that is not there is a 404', async () => {
  const res = await req('POST', '/api/templates/99999999/request-review')
  assert.equal(res.status, 404)
  assert.match((await res.json()).error, /not found|not in a requestable state/i)
})

test('requesting review of a template already in review is a 404, not a silent no-op', async () => {
  // Only draft/rejected templates are requestable. Asking twice must not quietly
  // report success the second time — the staff queue would then show one submission
  // while the agent believes they made two.
  const tpl = await createMessageTemplate(agentId, { name: 'diwali_offer', body: 'Happy Diwali {{1}}' })
  assert.equal((await (await req('POST', `/api/templates/${tpl.id}/request-review`)).json()).review_status, 'pending_review')

  const again = await req('POST', `/api/templates/${tpl.id}/request-review`)
  assert.equal(again.status, 404)
})

// === GET /api/leads/:id/suggestions: a provider that dies ======================

test('reply suggestions degrade to an empty list when the provider dies', async () => {
  // ai.test.js covers the provider being switched off, and aiOpenRouter covers it
  // answering badly. This is the third case: configured, reachable, and failing
  // every attempt — the queue exhausts its retries and rejects, and the route has to
  // absorb that. A throw here 500s the lead detail page for an optional panel.
  const lead = await upsertLead(agentId, '919800000773', 'Waiting Buyer')
  await addMessage(lead.id, 'buyer', 'Is the 2BHK still available?')

  mockUpstream(async () => {
    throw new Error('ECONNREFUSED')
  })

  const res = await req('GET', `/api/leads/${lead.id}/suggestions`)
  assert.equal(res.status, 200, 'a dead provider took the lead page down with it')
  assert.deepEqual(await res.json(), { suggestions: [] })
})
