// The Graph API calls that aren't message sends: the token health probe behind
// /api/health, the Meta Lead Ads answer fetch, and read receipts. All three are
// "must never throw at the caller" paths — a dead token or a Meta outage has to
// degrade into a status object or a null, because the callers are a health endpoint
// and the inbound webhook loop, neither of which can afford to blow up.
// global.fetch is mocked so these run with no WhatsApp account.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.NODE_ENV = 'test'
process.env.WHATSAPP_ACCESS_TOKEN = 'test-token'
process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-pnid'

const { checkToken, fetchLeadgenData, markRead, sendTemplate, sendMedia } = await import('../whatsapp.js')

const realFetch = global.fetch
let lastCall = null

function mockFetch({ ok = true, status = 200, body = {} } = {}) {
  const calls = []
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options })
    lastCall = { url: String(url), options }
    return { ok, status, json: async () => body, headers: { get: () => null } }
  }
  return calls
}

function failFetch(message) {
  const calls = []
  global.fetch = async (url) => {
    calls.push(String(url))
    throw new Error(message)
  }
  return calls
}

afterEach(() => {
  global.fetch = realFetch
  lastCall = null
})

// --- checkToken ---------------------------------------------------------------

test('checkToken: a healthy token reports ok', async () => {
  mockFetch({ ok: true, body: { id: 'test-pnid' } })
  assert.deepEqual(await checkToken(), { ok: true })
})

test('checkToken: probes the agent-specific number when one is given', async () => {
  mockFetch({ ok: true, body: { id: 'agent-pnid' } })
  await checkToken('agent-pnid')
  assert.match(lastCall.url, /\/agent-pnid\?fields=id/)
})

test('checkToken: an expired token is reported as expired, with Meta’s reason', async () => {
  mockFetch({
    ok: false,
    status: 401,
    body: { error: { code: 190, type: 'OAuthException', message: 'Session has expired' } },
  })
  const result = await checkToken()
  assert.equal(result.ok, false)
  assert.equal(result.expired, true)
  assert.equal(result.reason, 'Session has expired')
})

test('checkToken: an ordinary API error is not mistaken for an expired token', async () => {
  mockFetch({ ok: false, status: 500, body: { error: { code: 2, message: 'Service temporarily unavailable' } } })
  const result = await checkToken()
  assert.equal(result.ok, false)
  assert.equal(result.expired, false)
  assert.equal(result.reason, 'Service temporarily unavailable')
})

test('checkToken: an error body with no message still yields a usable reason', async () => {
  mockFetch({ ok: false, status: 503, body: {} })
  assert.equal((await checkToken()).reason, 'HTTP 503')
})

test('checkToken: a network failure resolves, it never throws at /api/health', async () => {
  failFetch('fetch failed: ECONNREFUSED')
  const result = await checkToken()
  assert.equal(result.ok, false)
  assert.match(result.reason, /ECONNREFUSED/)
})

test('checkToken: reports not_configured without making a call', async () => {
  const prev = process.env.WHATSAPP_ACCESS_TOKEN
  delete process.env.WHATSAPP_ACCESS_TOKEN
  const calls = mockFetch()
  assert.deepEqual(await checkToken(), { ok: false, reason: 'not_configured' })
  assert.equal(calls.length, 0)
  process.env.WHATSAPP_ACCESS_TOKEN = prev
})

// --- fetchLeadgenData ---------------------------------------------------------

test('fetchLeadgenData: returns the form answers on success', async () => {
  const body = { field_data: [{ name: 'phone_number', values: ['+919800000000'] }], ad_id: 'ad-1' }
  mockFetch({ ok: true, body })
  assert.deepEqual(await fetchLeadgenData('leadgen-1'), body)
  assert.match(lastCall.url, /\/leadgen-1\?fields=field_data/)
})

test('fetchLeadgenData: prefers the Page access token when one is configured', async () => {
  process.env.META_PAGE_ACCESS_TOKEN = 'page-token'
  mockFetch({ ok: true, body: {} })
  await fetchLeadgenData('leadgen-2')
  assert.match(lastCall.url, /access_token=page-token/)
  delete process.env.META_PAGE_ACCESS_TOKEN
})

test('fetchLeadgenData: a Graph error is null, so the webhook loop moves on', async () => {
  mockFetch({ ok: false, status: 400, body: { error: { message: 'Unsupported get request' } } })
  assert.equal(await fetchLeadgenData('leadgen-3'), null)
})

test('fetchLeadgenData: a network failure is null, never a thrown webhook', async () => {
  failFetch('socket hang up')
  assert.equal(await fetchLeadgenData('leadgen-4'), null)
})

test('fetchLeadgenData: no id or no token short-circuits without a call', async () => {
  const calls = mockFetch({ ok: true, body: {} })
  assert.equal(await fetchLeadgenData(null), null)
  assert.equal(await fetchLeadgenData(''), null)
  const prev = process.env.WHATSAPP_ACCESS_TOKEN
  delete process.env.WHATSAPP_ACCESS_TOKEN
  assert.equal(await fetchLeadgenData('leadgen-5'), null)
  process.env.WHATSAPP_ACCESS_TOKEN = prev
  assert.equal(calls.length, 0)
})

// --- markRead -----------------------------------------------------------------

test('markRead: posts a read receipt for the message', async () => {
  mockFetch({ ok: true, body: {} })
  await markRead('wamid.abc')
  assert.match(lastCall.url, /\/test-pnid\/messages$/)
  assert.deepEqual(JSON.parse(lastCall.options.body), {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: 'wamid.abc',
  })
})

test('markRead: a failing receipt is swallowed — it must not break inbound handling', async () => {
  failFetch('network down')
  await markRead('wamid.def') // resolves rather than rejecting
})

test('markRead: skips the call with no message id or no credentials', async () => {
  const calls = mockFetch({ ok: true, body: {} })
  await markRead(null)
  await markRead('')
  const prev = process.env.WHATSAPP_ACCESS_TOKEN
  delete process.env.WHATSAPP_ACCESS_TOKEN
  await markRead('wamid.ghi')
  process.env.WHATSAPP_ACCESS_TOKEN = prev
  assert.equal(calls.length, 0)
})

// --- the not-configured guards ------------------------------------------------

test('sendTemplate and sendMedia refuse to run unconfigured', async () => {
  const prev = process.env.WHATSAPP_ACCESS_TOKEN
  delete process.env.WHATSAPP_ACCESS_TOKEN
  for (const call of [
    () => sendTemplate('919800000000', { name: 'welcome_v1' }),
    () => sendMedia('919800000000', { link: 'https://example.com/a.pdf' }),
  ]) {
    await assert.rejects(call, (err) => {
      assert.equal(err.code, 'WA_NOT_CONFIGURED')
      return true
    })
  }
  process.env.WHATSAPP_ACCESS_TOKEN = prev
})

test('sendMedia sends a document filename but drops it for images', async () => {
  mockFetch({ ok: true, body: { messages: [{ id: 'wamid.doc' }] } })
  await sendMedia('919800000000', { type: 'document', link: 'https://x/a.pdf', filename: 'a.pdf', caption: 'Brochure' })
  const doc = JSON.parse(lastCall.options.body)
  assert.equal(doc.document.filename, 'a.pdf')
  assert.equal(doc.document.caption, 'Brochure')

  mockFetch({ ok: true, body: { messages: [{ id: 'wamid.img' }] } })
  await sendMedia('919800000000', { type: 'image', link: 'https://x/a.jpg', filename: 'a.jpg' })
  const img = JSON.parse(lastCall.options.body)
  assert.equal(img.image.filename, undefined) // only documents carry a filename
  assert.equal(img.image.caption, undefined)
})

test('sendTemplate omits an empty components array and sets the language code', async () => {
  mockFetch({ ok: true, body: { messages: [{ id: 'wamid.t' }] } })
  await sendTemplate('919800000000', { name: 'welcome_v1', language: 'en_US', components: [] })
  const sent = JSON.parse(lastCall.options.body)
  assert.deepEqual(sent.template, { name: 'welcome_v1', language: { code: 'en_US' } })

  mockFetch({ ok: true, body: { messages: [{ id: 'wamid.t2' }] } })
  const components = [{ type: 'body', parameters: [{ type: 'text', text: 'Priya' }] }]
  await sendTemplate('919800000000', { name: 'welcome_v1', components })
  assert.deepEqual(JSON.parse(lastCall.options.body).template.components, components)
})

test('a send that returns no message id resolves to null rather than undefined-crashing', async () => {
  mockFetch({ ok: true, body: {} })
  assert.equal(await sendTemplate('919800000000', { name: 'welcome_v1' }), null)
  mockFetch({ ok: true, body: { messages: [] } })
  assert.equal(await sendMedia('919800000000', { link: 'https://x/a.pdf' }), null)
})
