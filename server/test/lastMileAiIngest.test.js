// The extraction arm that only a value we don't control can reach.
//
// Structured extraction is best-effort work hung off a buyer's message: the model's
// answer is parsed, checked and written to the lead's jsonb column. Everything before
// the write is ours to validate; the write itself can still fail on content that is
// valid JSON and valid JavaScript but not storable — and the buyer's message, which
// was persisted several steps earlier, must not go down with it.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
process.env.OPENROUTER_API_KEY = 'last-mile-ai-key'
process.env.AI_MAX_RETRIES = '1' // nothing here is waiting on a retry ladder
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('lastmileai')

const { app } = await import('../index.js')
const { ready, closePool, query, getLead, getMessages } = await import('../db.js')
await ready

let server, base, token

const realFetch = global.fetch
// Set per test; anything not claimed falls through to the real fetch, so the suite's
// own HTTP calls to the app still go over the wire.
let openRouterHandler = null

global.fetch = async (url, options) => {
  if (openRouterHandler && String(url).includes('openrouter')) return openRouterHandler(url, options)
  return realFetch(url, options)
}

const aiReply = (content) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => ({ choices: [{ message: { content } }] }),
})

const req = (method, url, body, tok = token) =>
  realFetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
const json = async (...args) => (await req(...args)).json()

// Runs fn with console.error captured, so an expected failure doesn't spam the report.
const quietly = async (fn) => {
  const lines = []
  const real = console.error
  console.error = (...a) => lines.push(a.join(' '))
  try {
    return { result: await fn(), errors: lines }
  } finally {
    console.error = real
  }
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const out = await json('POST', '/api/auth/signup', {
    name: 'Ingest Ira', phone: '+919722000001', password: 'secret123',
  }, null)
  token = out.token
})

after(async () => {
  global.fetch = realFetch
  openRouterHandler = null
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

test('a buyer message survives an extraction the database refuses to store', async () => {
  const waId = '919722010001'
  const name = 'Nulled Nita'
  // The first message creates the lead. Turning the AI reply off afterwards leaves
  // the extraction as the only model call in the run under test.
  openRouterHandler = () => aiReply('Sure — which locality are you looking at?')
  const first = await json('POST', '/api/simulate', { from: waId, name, text: 'hi' })
  await query('UPDATE leads SET ai_enabled = 0 WHERE id = $1', [first.lead.id])

  // A model answer carrying a NUL byte. It parses as JSON and passes every check in
  // ai.js; PostgreSQL is what rejects it, because jsonb cannot hold one. That is the
  // shape the catch exists for — the extraction is derived from text nobody here
  // wrote, and it fails at the very last step, long after the buyer's message landed.
  const poisoned = JSON.stringify({
    name: 'Nita',
    intent: 'buy',
    summary: `wants a 2BHK in Wakad${String.fromCharCode(0)}under 80L`,
    score: 72,
    temp: 'Warm',
  })
  openRouterHandler = () => aiReply(poisoned)

  const { result, errors } = await quietly(() =>
    json('POST', '/api/simulate', { from: waId, name, text: '2bhk wakad, 80 tak' }),
  )

  assert.ok(result.lead, 'the request still answers with the lead')
  assert.ok(
    errors.some((e) => /extraction failed/.test(e)),
    `the failure must be logged for the operator, got:\n${errors.join('\n')}`,
  )

  // The three things that must have survived it.
  const texts = (await getMessages(result.lead.id)).map((m) => m.text)
  assert.ok(texts.includes('2bhk wakad, 80 tak'), 'the buyer’s message was lost to a failed extraction')
  const lead = await getLead(result.lead.id)
  assert.equal(lead.ai_extracted, null, 'nothing half-written was stored')
  assert.equal(lead.name, name, 'the lead card is untouched')
})
