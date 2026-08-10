// whatsapp.js reliability: every Graph API send now goes through a timeout + a
// retry-with-backoff queue (RequestQueue, shared with the OpenRouter path in
// aiQueue.js) instead of a bare fetch. These tests mock global.fetch so they run
// without a real WhatsApp account and stay fast/deterministic.
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.NODE_ENV = 'test'
process.env.WHATSAPP_ACCESS_TOKEN = 'test-token'
process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-pnid'
// Small so retry-exhaustion tests don't burn wall-clock time (real setTimeout backoff).
process.env.WA_MAX_RETRIES = '2'

const { sendText, sendTemplate, sendMedia } = await import('../whatsapp.js')

const realFetch = global.fetch

// Queues canned responses; each call to fetch() consumes the next one (repeating the
// last entry once exhausted, so an "always fails" mock only needs one entry).
function mockFetch(responses) {
  let calls = 0
  global.fetch = async () => {
    const r = responses[Math.min(calls, responses.length - 1)]
    calls++
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.body,
      headers: { get: (name) => (name === 'retry-after' ? (r.retryAfter ?? null) : null) },
    }
  }
  return () => calls
}

test.after(() => {
  global.fetch = realFetch
})

test('sendText returns the wa message id on success', async () => {
  mockFetch([{ ok: true, status: 200, body: { messages: [{ id: 'wamid.123' }] } }])
  const id = await sendText('919800000000', 'hi')
  assert.equal(id, 'wamid.123')
})

test('sendText retries a transient 500 then succeeds', async () => {
  const calls = mockFetch([
    { ok: false, status: 500, body: { error: { message: 'server hiccup' } } },
    { ok: true, status: 200, body: { messages: [{ id: 'wamid.456' }] } },
  ])
  const id = await sendText('919800000000', 'hi')
  assert.equal(id, 'wamid.456')
  assert.equal(calls(), 2)
})

test('sendText retries a 429 honouring Retry-After, then succeeds', async () => {
  const calls = mockFetch([
    { ok: false, status: 429, body: { error: { message: 'rate limited' } }, retryAfter: '0' },
    { ok: true, status: 200, body: { messages: [{ id: 'wamid.789' }] } },
  ])
  const id = await sendText('919800000000', 'hi')
  assert.equal(id, 'wamid.789')
  assert.equal(calls(), 2)
})

test('sendText fails fast on an expired token — no retries', async () => {
  const calls = mockFetch([
    { ok: false, status: 401, body: { error: { code: 190, type: 'OAuthException', message: 'Session expired' } } },
  ])
  await assert.rejects(
    () => sendText('919800000000', 'hi'),
    (err) => {
      assert.equal(err.code, 'WA_TOKEN_EXPIRED')
      return true
    },
  )
  assert.equal(calls(), 1, 'a token error must never be retried')
})

test('sendText gives up as WA_SEND_FAILED after exhausting retries on repeated 5xx', async () => {
  const calls = mockFetch([{ ok: false, status: 503, body: { error: { message: 'down' } } }])
  await assert.rejects(
    () => sendText('919800000000', 'hi'),
    (err) => {
      assert.equal(err.code, 'WA_SEND_FAILED')
      return true
    },
  )
  assert.equal(calls(), 3) // initial attempt + WA_MAX_RETRIES(2) retries
})

test('sendText does not retry a non-retryable 4xx', async () => {
  const calls = mockFetch([{ ok: false, status: 400, body: { error: { message: 'bad recipient' } } }])
  await assert.rejects(
    () => sendText('919800000000', 'hi'),
    (err) => {
      assert.equal(err.code, 'WA_SEND_FAILED')
      return true
    },
  )
  assert.equal(calls(), 1)
})

test('sendText surfaces a network failure/timeout as a retried, then failed, WA_SEND_FAILED', async () => {
  let calls = 0
  global.fetch = async () => {
    calls++
    throw new Error('fetch failed: network error')
  }
  await assert.rejects(
    () => sendText('919800000000', 'hi'),
    (err) => {
      assert.equal(err.code, 'WA_SEND_FAILED')
      return true
    },
  )
  assert.equal(calls, 3)
})

test('sendTemplate returns the wa message id on success', async () => {
  mockFetch([{ ok: true, status: 200, body: { messages: [{ id: 'wamid.tpl1' }] } }])
  const id = await sendTemplate('919800000000', { name: 'welcome_v1' })
  assert.equal(id, 'wamid.tpl1')
})

test('sendTemplate requires a template name', async () => {
  await assert.rejects(
    () => sendTemplate('919800000000', {}),
    (err) => {
      assert.equal(err.code, 'WA_TEMPLATE_MISSING')
      return true
    },
  )
})

test('sendMedia returns the wa message id on success', async () => {
  mockFetch([{ ok: true, status: 200, body: { messages: [{ id: 'wamid.media1' }] } }])
  const id = await sendMedia('919800000000', { type: 'image', link: 'https://example.com/a.jpg' })
  assert.equal(id, 'wamid.media1')
})

test('sendMedia requires a link', async () => {
  await assert.rejects(
    () => sendMedia('919800000000', { type: 'image' }),
    (err) => {
      assert.equal(err.code, 'WA_MEDIA_MISSING')
      return true
    },
  )
})

test('sendText throws WA_NOT_CONFIGURED when WhatsApp env vars are unset', async () => {
  const prevToken = process.env.WHATSAPP_ACCESS_TOKEN
  delete process.env.WHATSAPP_ACCESS_TOKEN
  await assert.rejects(
    () => sendText('919800000000', 'hi'),
    (err) => {
      assert.equal(err.code, 'WA_NOT_CONFIGURED')
      return true
    },
  )
  process.env.WHATSAPP_ACCESS_TOKEN = prevToken
})
