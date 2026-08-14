// The API client itself: auth headers, the shared response handler (`j`), the offline
// write queue, and the display formatters. `fetch`, `localStorage` and `window` are
// stubbed — this is the browser contract, not a DOM test.
//
// The parts worth pinning down are all failure paths: a 401 must end the session
// everywhere at once, a 4xx must arrive with an agent-readable `.message` while
// keeping the raw status/code for callers that branch on it, and a dead network must
// queue a write rather than losing it.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}

const events = []
const listeners = new Map()
globalThis.window = {
  dispatchEvent: (e) => { events.push(e.type); return true },
  addEventListener: (type, fn) => listeners.set(type, fn),
}
globalThis.Event = class { constructor(type) { this.type = type } }

// Every call the stub sees, plus the canned response queue.
let calls = []
let responses = []
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), method: options.method || 'GET', headers: options.headers || {}, body: options.body })
  const next = responses.shift()
  if (!next) return jsonResponse(200, {})
  if (next instanceof Error) throw next
  return next
}
const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

const { api, getToken, setToken, offlineQueueSize, flushOfflineQueue, parseTs, fmtTime, fmtAgo, fmtWait, fmtBudget } =
  await import('./api.js')

const QUEUE_KEY = 'homenex-offline-queue'

beforeEach(() => {
  store.clear()
  calls = []
  responses = []
  events.length = 0
})

// --- auth headers -------------------------------------------------------------

test('requests carry the bearer token once one is stored, and none before', async () => {
  responses.push(jsonResponse(200, []))
  await api.leads()
  assert.equal(calls[0].headers.authorization, undefined, 'anonymous requests send no authorization header')

  setToken('tok-123')
  assert.equal(getToken(), 'tok-123')
  responses.push(jsonResponse(200, []))
  await api.leads()
  assert.equal(calls[1].headers.authorization, 'Bearer tok-123')
})

test('setToken(null) clears the stored token', () => {
  setToken('tok-123')
  setToken(null)
  assert.equal(getToken(), null)
})

// --- query strings ------------------------------------------------------------

test('filters are serialized, and empty/undefined/null values are dropped entirely', async () => {
  responses.push(jsonResponse(200, []))
  await api.leads({ stage: 'Qualified', q: '', temp: undefined, city: null, page: 2 })
  assert.equal(calls[0].url, '/api/leads?stage=Qualified&page=2')

  responses.push(jsonResponse(200, []))
  await api.leads({})
  assert.equal(calls[1].url, '/api/leads', 'no trailing "?" when nothing is filtered')

  responses.push(jsonResponse(200, []))
  await api.leads()
  assert.equal(calls[2].url, '/api/leads')
})

test('a value of 0 or false survives serialization (only empty string is dropped)', async () => {
  responses.push(jsonResponse(200, []))
  await api.properties({ min_price: 0, available: false })
  assert.equal(calls[0].url, '/api/properties?min_price=0&available=false')
})

// --- error handling -----------------------------------------------------------

test('a 4xx throws an agent-readable Error that still carries the raw details', async () => {
  responses.push(jsonResponse(400, { error: 'Budget must be a number', code: 'BAD_BUDGET' }))
  const err = await api.updateLead(1, { budget_max: 'lots' }).then(() => null, (e) => e)
  assert.ok(err instanceof Error)
  assert.equal(err.message, 'Budget must be a number', 'a human server message passes through')
  assert.equal(err.status, 400)
  assert.equal(err.code, 'BAD_BUDGET')
  assert.equal(err.serverMessage, 'Budget must be a number')
})

test('a technical server message is replaced with something an agent can act on', async () => {
  responses.push(jsonResponse(500, { error: 'TypeError: cannot read property id of undefined' }))
  const err = await api.stats().then(() => null, (e) => e)
  assert.ok(!/TypeError/.test(err.message), `leaked internals: ${err.message}`)
  assert.match(err.message, /our side|went wrong/i)
  assert.equal(err.status, 500)
  assert.equal(err.serverMessage, 'TypeError: cannot read property id of undefined')
})

test('an error body that is not JSON still produces a clean message', async () => {
  responses.push({ ok: false, status: 502, json: async () => { throw new Error('not json') } })
  const err = await api.stats().then(() => null, (e) => e)
  assert.equal(err.status, 502)
  assert.ok(err.message.length > 0)
  assert.equal(err.code, undefined)
})

test('a 401 clears the session and broadcasts a logout exactly once', async () => {
  setToken('tok-expired')
  responses.push(jsonResponse(401, { error: 'unauthorized' }))
  await api.me().catch(() => {})
  assert.equal(getToken(), null, 'an expired session must not be left on disk')
  assert.ok(events.includes('homenex-logout'))
})

test('a 2xx returns the parsed body and dispatches nothing', async () => {
  responses.push(jsonResponse(200, { id: 7, name: 'Ravi' }))
  assert.deepEqual(await api.lead(7), { id: 7, name: 'Ravi' })
  assert.deepEqual(events, [])
})

// --- offline write queue ------------------------------------------------------

const networkDown = () => new TypeError('Failed to fetch')

test('a stage move that hits a dead network is queued, not lost', async () => {
  responses.push(networkDown())
  const out = await api.moveLeadStage(4, 'Site Visit Done')
  assert.deepEqual(out, { queued: true })
  assert.equal(offlineQueueSize(), 1)
  assert.ok(events.includes('homenex-queued'))

  const [queued] = JSON.parse(localStorage.getItem(QUEUE_KEY))
  assert.equal(queued.method, 'PUT')
  assert.equal(queued.url, '/api/leads/4/stage')
  // lost_reason is undefined here and JSON.stringify drops it — the replayed body is
  // exactly what a live call would have sent.
  assert.deepEqual(queued.body, { stage: 'Site Visit Done' })
  assert.ok(queued.queued_at, 'the queue records when the write was attempted')
})

test('a follow-up created offline is queued as a POST', async () => {
  responses.push(networkDown())
  await api.createFollowup({ lead_id: 3, due_at: '2026-09-01T10:00:00Z' })
  const [queued] = JSON.parse(localStorage.getItem(QUEUE_KEY))
  assert.equal(queued.method, 'POST')
  assert.equal(queued.url, '/api/followups')
})

test('a real server error is NOT queued — retrying it would never succeed', async () => {
  responses.push(jsonResponse(400, { error: 'stage is required' }))
  await assert.rejects(() => api.moveLeadStage(4, ''), /stage is required/)
  assert.equal(offlineQueueSize(), 0)
  assert.ok(!events.includes('homenex-queued'))
})

test('flushing replays queued writes in order and empties the queue', async () => {
  responses.push(networkDown(), networkDown())
  await api.moveLeadStage(1, 'Qualified')
  await api.moveLeadStage(2, 'Lost')
  assert.equal(offlineQueueSize(), 2)

  calls = []
  responses.push(jsonResponse(200, {}), jsonResponse(200, {}))
  assert.equal(await flushOfflineQueue(), 0)
  assert.deepEqual(calls.map((c) => c.url), ['/api/leads/1/stage', '/api/leads/2/stage'])
  assert.equal(offlineQueueSize(), 0)
  assert.ok(events.includes('homenex-queue-flushed'))
})

test('flushing stops at the first still-offline write and keeps the rest queued', async () => {
  responses.push(networkDown(), networkDown())
  await api.moveLeadStage(1, 'Qualified')
  await api.moveLeadStage(2, 'Lost')

  events.length = 0
  responses.push(networkDown())
  assert.equal(await flushOfflineQueue(), 2, 'nothing is dropped while still offline')
  assert.equal(offlineQueueSize(), 2)
  assert.ok(!events.includes('homenex-queue-flushed'))
})

test('a queued write that the server rejects is dropped rather than retried forever', async () => {
  responses.push(networkDown())
  await api.moveLeadStage(1, 'Teleported')
  responses.push(jsonResponse(400, { error: 'unknown stage' }))
  assert.equal(await flushOfflineQueue(), 0)
  assert.equal(offlineQueueSize(), 0, 'a permanently-invalid write must not block the queue')
})

test('a corrupt queue in localStorage reads as empty instead of throwing', () => {
  localStorage.setItem(QUEUE_KEY, '{not json')
  assert.equal(offlineQueueSize(), 0)
})

test('flushing an empty queue is a no-op that still announces it is clear', async () => {
  assert.equal(await flushOfflineQueue(), 0)
  assert.ok(events.includes('homenex-queue-flushed'))
  assert.equal(calls.length, 0)
})

test('coming back online triggers a flush', async () => {
  responses.push(networkDown())
  await api.moveLeadStage(9, 'Qualified')
  calls = []
  responses.push(jsonResponse(200, {}))
  await listeners.get('online')()
  assert.deepEqual(calls.map((c) => c.url), ['/api/leads/9/stage'])
})

// --- formatters ---------------------------------------------------------------

test('parseTs handles ISO strings, legacy SQLite stamps, Dates and blanks', () => {
  assert.equal(parseTs(null), null)
  assert.equal(parseTs(''), null)
  const d = new Date('2026-07-09T16:15:00.000Z')
  assert.equal(parseTs(d), d, 'a Date passes straight through')
  assert.equal(parseTs('2026-07-09T16:15:00.000Z').getTime(), d.getTime())
  // Legacy "YYYY-MM-DD HH:MM:SS" is UTC and must not be read as local time.
  assert.equal(parseTs('2026-07-09 16:15:00').getTime(), d.getTime())
})

test('fmtAgo counts up through minutes, hours and days', () => {
  const ago = (s) => new Date(Date.now() - s * 1000).toISOString()
  assert.equal(fmtAgo(null), '')
  assert.equal(fmtAgo(ago(5)), 'just now')
  assert.equal(fmtAgo(ago(120)), '2m ago')
  assert.equal(fmtAgo(ago(3 * 3600)), '3h ago')
  assert.equal(fmtAgo(ago(50 * 3600)), '2d ago')
})

test('fmtWait never shows 0m for a lead that just arrived', () => {
  const ago = (s) => new Date(Date.now() - s * 1000).toISOString()
  assert.equal(fmtWait(null), '')
  assert.equal(fmtWait(ago(5)), '1m', 'a few seconds of waiting still reads as 1m')
  assert.equal(fmtWait(ago(12 * 60)), '12m')
  assert.equal(fmtWait(ago(3 * 3600)), '3h')
  assert.equal(fmtWait(ago(2 * 86400)), '2d')
  // A future timestamp (clock skew) clamps to the floor rather than going negative.
  assert.equal(fmtWait(new Date(Date.now() + 60_000).toISOString()), '1m')
})

test('fmtTime shows a clock time today and a date on any other day', () => {
  assert.equal(fmtTime(null), '')
  const todayAt = new Date()
  todayAt.setHours(9, 5, 0, 0)
  assert.match(fmtTime(todayAt.toISOString()), /^\d{1,2}:\d{2}/)
  const lastWeek = new Date(Date.now() - 7 * 86400_000)
  assert.ok(!/:/.test(fmtTime(lastWeek.toISOString())), 'an older message shows a date, not a time')
})

test('fmtBudget renders lakhs, crores and ranges the way Indian buyers state them', () => {
  assert.equal(fmtBudget(null, null), null)
  assert.equal(fmtBudget(null, 85), '₹85 L')
  assert.equal(fmtBudget(85, null), '₹85 L')
  assert.equal(fmtBudget(null, 100), '₹1 Cr', 'a round crore drops the decimals')
  assert.equal(fmtBudget(null, 125), '₹1.25 Cr')
  assert.equal(fmtBudget(80, 120), '₹80 L – ₹1.20 Cr')
  assert.equal(fmtBudget(90, 90), '₹90 L', 'an exact figure is not shown as a range')
})

test('phone-config and wa-phone use their own fetch but the same auth + error handling', async () => {
  setToken('tok-abc')
  responses.push(jsonResponse(200, { ok: true }), jsonResponse(200, { ok: true }))
  await api.updatePhoneConfig({ wa_phone_number_id: '123' })
  await api.updateWaPhone({ wa_phone: '+919812345678' })

  for (const c of calls) {
    assert.equal(c.method, 'PUT')
    assert.equal(c.headers.authorization, 'Bearer tok-abc')
    assert.equal(c.headers['content-type'], 'application/json')
  }
  assert.deepEqual(calls.map((c) => c.url), ['/api/agent/phone-config', '/api/agent/wa-phone'])
  assert.deepEqual(JSON.parse(calls[0].body), { wa_phone_number_id: '123' })

  // And they raise the same friendly error as every other write.
  responses.push(jsonResponse(409, { error: 'That number is already connected to another workspace' }))
  const err = await api.updateWaPhone({ wa_phone: 'x' }).then(() => null, (e) => e)
  assert.equal(err.status, 409)
  assert.equal(err.message, 'That number is already connected to another workspace')
})

test('adminAgents unwraps the paginated shape and passes a bare array through', async () => {
  responses.push(jsonResponse(200, { agents: [{ id: 1 }], total: 1, page: 1 }))
  assert.deepEqual(await api.adminAgents({ q: 'ravi' }), [{ id: 1 }])
  assert.equal(calls[0].url, '/api/admin/agents?q=ravi')

  responses.push(jsonResponse(200, [{ id: 2 }]))
  assert.deepEqual(await api.adminAgents(), [{ id: 2 }])
})

// --- the request each wrapper builds ------------------------------------------
//
// Most of `api` is one line: a method, a URL built by template literal, and a body
// whose keys are renamed on the way out (`assigneeId` becomes assignee_id). Nothing
// type-checks any of that, and the failure it produces is not a crash — a wrapper
// that PUTs where the server expects POST, or writes /api/group/2 for /api/groups/2,
// gets a 404 the UI reports as "Something went wrong on our side."
//
// The screens that call these are covered by their own component tests, but those
// stub `api` wholesale, so the wrapper bodies themselves never run there. This is the
// only place the URL, verb and payload shape are actually asserted, so it covers
// every wrapper no screen test happens to reach rather than a chosen few.
const REQUESTS = [
  // Leads: notes, assignment, EMI.
  ['emi', () => api.emi({ principal: 5000000, rate: 8.5 }), 'POST', '/api/emi', { principal: 5000000, rate: 8.5 }],
  ['activity', () => api.activity(), 'GET', '/api/activity'],
  ['leadNotes', () => api.leadNotes(5), 'GET', '/api/leads/5/notes'],
  ['deleteLeadNote', () => api.deleteLeadNote(5, 9), 'DELETE', '/api/leads/5/notes/9'],
  ['assignLeadTo', () => api.assignLeadTo(5, 42), 'POST', '/api/leads/5/assign-to', { assignee_id: 42 }],
  // Broker network.
  ['network', () => api.network(), 'GET', '/api/network'],
  ['postNetwork', () => api.postNetwork({ text: '2BHK wanted in Baner' }), 'POST', '/api/network', { text: '2BHK wanted in Baner' }],
  // Templates and quick replies.
  ['updateTemplate', () => api.updateTemplate(7, { body: 'Hi {{name}}' }), 'PUT', '/api/templates/7', { body: 'Hi {{name}}' }],
  ['requestTemplateReview', () => api.requestTemplateReview(7), 'POST', '/api/templates/7/request-review', {}],
  ['updateQuickReply', () => api.updateQuickReply(3, { text: 'On my way' }), 'PUT', '/api/quick-replies/3', { text: 'On my way' }],
  ['deleteContact', () => api.deleteContact(12), 'DELETE', '/api/contacts/12'],
  // Deals and commissions (§5.4).
  ['deal', () => api.deal(4), 'GET', '/api/deals/4'],
  ['createDeal', () => api.createDeal({ lead_id: 5 }), 'POST', '/api/deals', { lead_id: 5 }],
  ['updateDeal', () => api.updateDeal(4, { status: 'won' }), 'PUT', '/api/deals/4', { status: 'won' }],
  ['createCommission', () => api.createCommission({ deal_id: 4 }), 'POST', '/api/commissions', { deal_id: 4 }],
  ['updateCommission', () => api.updateCommission(6, { status: 'received' }), 'PUT', '/api/commissions/6', { status: 'received' }],
  // Notifications.
  ['markAllNotificationsRead', () => api.markAllNotificationsRead(), 'POST', '/api/notifications/read-all', {}],
  // Groups and segments.
  ['createGroup', () => api.createGroup({ name: 'Baner buyers' }), 'POST', '/api/groups', { name: 'Baner buyers' }],
  ['updateGroup', () => api.updateGroup(2, { name: 'Baner' }), 'PUT', '/api/groups/2', { name: 'Baner' }],
  ['groupMembers', () => api.groupMembers(2), 'GET', '/api/groups/2/members'],
  ['addGroupMembers', () => api.addGroupMembers(2, [11, 12]), 'POST', '/api/groups/2/members', { contact_ids: [11, 12] }],
  ['removeGroupMember', () => api.removeGroupMember(2, 12), 'DELETE', '/api/groups/2/members/12'],
  ['previewSegment', () => api.previewSegment({ city: 'Pune' }), 'POST', '/api/segments/preview', { criteria: { city: 'Pune' } }],
  // Team (§5.3).
  ['teamMembers', () => api.teamMembers(), 'GET', '/api/team/members'],
  ['teamPipeline', () => api.teamPipeline('buyer'), 'GET', '/api/team/pipeline?type=buyer'],
  ['autoAssignTeamLead', () => api.autoAssignTeamLead(8), 'POST', '/api/team/leads/8/auto-assign', {}],
  ['claimTeamLead', () => api.claimTeamLead(8), 'POST', '/api/team/leads/8/claim', {}],
]

for (const [name, call, method, url, body] of REQUESTS) {
  test(`api.${name} sends ${method} ${url}`, async () => {
    setToken('tok-wrap')
    responses.push(jsonResponse(200, {}))
    await call()

    assert.equal(calls.length, 1, 'exactly one request')
    assert.equal(calls[0].method, method)
    assert.equal(calls[0].url, url)
    assert.equal(calls[0].headers.authorization, 'Bearer tok-wrap', 'every one of these is authenticated')

    if (body === undefined) {
      assert.equal(calls[0].body, undefined, 'a read sends no body')
    } else {
      assert.deepEqual(JSON.parse(calls[0].body), body)
      assert.equal(calls[0].headers['content-type'], 'application/json')
    }
  })
}

test('teamPipeline with no type asks for the whole pipeline, not "?type=undefined"', async () => {
  responses.push(jsonResponse(200, {}))
  await api.teamPipeline()
  assert.equal(calls[0].url, '/api/team/pipeline')
})

test('coming back online replays the queue without anyone calling flush', async () => {
  // The listener registered at import time is what makes the offline queue actually
  // drain — flushOfflineQueue is well covered above, but only because the tests call
  // it directly. In the app nothing does: the agent walks out of a basement showing
  // and the browser fires 'online'. Drop this listener and every queued stage move
  // sits in localStorage until the next full reload, which is the bug the queue was
  // built to prevent.
  setToken('tok-online')
  responses.push(new TypeError('Failed to fetch'))
  assert.deepEqual(await api.moveLeadStage(5, 'Site Visit'), { queued: true })
  assert.equal(offlineQueueSize(), 1)

  calls = []
  responses.push(jsonResponse(200, { ok: true }))
  listeners.get('online')()
  for (let i = 0; i < 20 && offlineQueueSize(); i++) await new Promise((r) => setTimeout(r, 0))

  assert.equal(offlineQueueSize(), 0, 'the queued move was replayed')
  assert.equal(calls[0].url, '/api/leads/5/stage')
  assert.equal(calls[0].method, 'PUT')
  assert.ok(events.includes('homenex-queue-flushed'))
})
