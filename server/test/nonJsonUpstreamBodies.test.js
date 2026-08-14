// What happens when an upstream answers with something that is not JSON.
//
// Both HTTP clients on the server — the WhatsApp Graph client and the OpenRouter
// client — read the response body with `.json().catch(...)` (or `.text().catch(...)`)
// rather than a bare await. Those catch arms are not decoration: an HTML error page
// from a proxy, a truncated body from a dropped connection, or a 502 from a load
// balancer in front of the provider all produce a response whose body will not parse,
// and the parse rejection would otherwise escape as an unhandled error inside a
// webhook handler or a scheduler tick.
//
// The existing upstream suites (whatsappGraph, aiOpenRouter) mock a well-behaved
// provider that always returns parseable JSON, so every one of those catch arms had
// never run. This file mocks the badly-behaved one: a response whose .json()/.text()
// rejects. Each caller must still produce its normal degraded answer.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.NODE_ENV = 'test'
process.env.WHATSAPP_ACCESS_TOKEN = 'test-token'
process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-pnid'
process.env.OPENROUTER_API_KEY = 'test-key'
process.env.AI_MAX_RETRIES = '0' // no point retrying a mock through the wall clock

const { checkToken, fetchLeadgenData, sendText } = await import('../whatsapp.js')
const { generateReply } = await import('../ai.js')

const realFetch = global.fetch
const realConsoleError = console.error

// A response that looks fine at the status line and then fails to parse — exactly
// what an HTML error page or a truncated body looks like to fetch().
function mockUnparseable({ ok = true, status = 200 } = {}) {
  const calls = []
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options })
    return {
      ok,
      status,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0')
      },
      text: async () => {
        throw new TypeError('terminated')
      },
      headers: { get: () => null },
    }
  }
  return calls
}

afterEach(() => {
  global.fetch = realFetch
  console.error = realConsoleError
})

// --- WhatsApp Graph -----------------------------------------------------------

test('checkToken: an unparseable 200 is still reported healthy', async () => {
  // ok=true short-circuits before the body is used for anything, but the body is
  // still read. If that read threw, /api/health would 500 instead of answering.
  mockUnparseable({ ok: true, status: 200 })
  assert.deepEqual(await checkToken(), { ok: true })
})

test('checkToken: an unparseable failure degrades to "not expired", with the status', async () => {
  // No parseable body means no Meta error object, so the probe cannot claim the token
  // expired — that verdict drives a "reconnect WhatsApp" banner and must not be
  // guessed from a proxy's HTML. It falls back to the HTTP status instead.
  mockUnparseable({ ok: false, status: 502 })
  const out = await checkToken()
  assert.equal(out.ok, false)
  assert.equal(out.expired, false, 'a garbled body was read as an expired token')
  assert.equal(out.reason, 'HTTP 502')
})

test('sendText: an unparseable failure is reported with the status, not a parse error', async () => {
  // The webhook path calls this. A SyntaxError escaping here would be logged as a
  // JSON problem and send whoever is on call looking at the wrong system.
  mockUnparseable({ ok: false, status: 400 })
  await assert.rejects(
    () => sendText('919876500001', 'hello'),
    (err) => !/JSON|Unexpected token/.test(err.message),
  )
})

test('fetchLeadgenData: an unparseable failure returns null, and says so once', async () => {
  // The Meta Lead Ads webhook calls this. Returning null loses the form answers but
  // keeps the lead; throwing would lose the lead itself.
  const logged = []
  console.error = (...args) => logged.push(args.join(' '))
  mockUnparseable({ ok: false, status: 500 })

  assert.equal(await fetchLeadgenData('leadgen-1'), null)
  assert.equal(logged.length, 1, 'the failure was silent, or logged more than once')
  assert.match(logged[0], /leadgen fetch failed/)
})

// --- OpenRouter ---------------------------------------------------------------

test('generateReply: an unparseable 200 degrades to no reply', async () => {
  // The AI layer fails open: no parseable body means no content, which the caller
  // reads as "the model had nothing" and falls back to a human.
  mockUnparseable({ ok: true, status: 200 })
  assert.equal(await generateReply([{ role: 'buyer', text: 'hi' }], {}, 'Asha'), null)
})

test('generateReply: an unparseable non-retryable error still degrades to no reply', async () => {
  // 400 is not retryable, so the error body is read with .text() to put the provider's
  // explanation in the message. When even that fails the call must still fail open.
  mockUnparseable({ ok: false, status: 400 })
  assert.equal(await generateReply([{ role: 'buyer', text: 'hi' }], {}, 'Asha'), null)
})
