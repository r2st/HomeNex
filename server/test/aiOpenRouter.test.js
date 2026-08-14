// The live OpenRouter path: how HomeNex behaves when the model actually answers,
// answers badly, or doesn't answer at all. ai.test.js covers output hygiene with the
// key unset; this covers the HTTP call itself with global.fetch mocked, so it runs
// offline and costs nothing.
//
// The contract that matters operationally: the AI layer FAILS OPEN. A dead provider,
// a bad key, a rate limit or a garbage response must degrade to "no reply / no
// extraction / no suggestions" — never to a thrown error, because the caller is the
// inbound WhatsApp webhook and a throw there loses the buyer's message.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.NODE_ENV = 'test'
process.env.OPENROUTER_API_KEY = 'test-key'
process.env.AI_MAX_RETRIES = '2' // keep retry-exhaustion tests off the wall clock
delete process.env.OPENROUTER_MODEL

const { generateReply, extractLead, suggestReplies, aiConfigured } = await import('../ai.js')

const realFetch = global.fetch
let lastRequest = null

// Each entry is consumed in order; the last one repeats once exhausted.
function mockFetch(responses) {
  let calls = 0
  global.fetch = async (url, options) => {
    const r = responses[Math.min(calls, responses.length - 1)]
    calls++
    lastRequest = { url: String(url), body: JSON.parse(options.body), headers: options.headers }
    return {
      ok: r.ok !== false,
      status: r.status ?? 200,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body ?? ''),
      headers: { get: (h) => (h === 'retry-after' ? (r.retryAfter ?? null) : null) },
    }
  }
  return () => calls
}

const reply = (content) => ({ ok: true, body: { choices: [{ message: { content } }] } })
const thread = [{ role: 'buyer', text: '2bhk chahiye wakad me, 80 tak' }]

afterEach(() => {
  global.fetch = realFetch
  lastRequest = null
})

test('aiConfigured tracks the key, live', () => {
  assert.equal(aiConfigured(), true)
  const prev = process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_API_KEY
  assert.equal(aiConfigured(), false)
  process.env.OPENROUTER_API_KEY = prev
})

// --- generateReply ------------------------------------------------------------

test('generateReply returns the model’s answer and calls the configured model', async () => {
  mockFetch([reply('Sure — what is your budget range in lakhs?')])
  const out = await generateReply(thread, 'Priya')
  assert.equal(out, 'Sure — what is your budget range in lakhs?')
  assert.equal(lastRequest.body.model, 'meta-llama/llama-3.3-70b-instruct:free')
  assert.match(lastRequest.headers.Authorization, /^Bearer test-key$/)
  // The broker's name reaches the system prompt so the buyer isn't talking to "an AI".
  assert.match(lastRequest.body.messages[0].content, /Priya/)
})

test('generateReply honours an OPENROUTER_MODEL override', async () => {
  process.env.OPENROUTER_MODEL = 'some/other-model'
  mockFetch([reply('ok')])
  await generateReply(thread, 'Priya')
  assert.equal(lastRequest.body.model, 'some/other-model')
  delete process.env.OPENROUTER_MODEL
})

test('generateReply sanitizes model output before it can reach WhatsApp', async () => {
  mockFetch([reply('Sure 또는 tell me your budget **now** 😀😀😀')])
  const out = await generateReply(thread, 'Priya')
  assert.ok(!/또는/.test(out), 'foreign-script leak reached the buyer')
  assert.ok(!out.includes('**'), 'markdown reached the buyer')
  assert.equal((out.match(/😀/g) || []).length, 1, 'emoji not capped')
})

test('generateReply treats a blank or all-foreign answer as no reply', async () => {
  mockFetch([reply('   ')])
  assert.equal(await generateReply(thread, 'Priya'), null)
  mockFetch([reply('안녕하세요 또는')])
  assert.equal(await generateReply(thread, 'Priya'), null)
})

test('generateReply sends only the recent history, oldest trimmed', async () => {
  const long = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'ai' : 'buyer', text: `msg ${i}` }))
  mockFetch([reply('ok')])
  await generateReply(long, 'Priya')
  const sent = lastRequest.body.messages
  assert.equal(sent.length, 25) // 1 system + the last 24 turns
  assert.equal(sent[1].content, 'msg 16')
  assert.equal(sent[1].role, 'user') // buyer maps to user, ai/agent to assistant
  assert.equal(sent[2].role, 'assistant')
})

// --- Failing open -------------------------------------------------------------

test('a rate limit is retried, then succeeds', async () => {
  const calls = mockFetch([
    { ok: false, status: 429, body: { error: 'slow down' }, retryAfter: '0' },
    reply('Sure, what is your budget?'),
  ])
  assert.equal(await generateReply(thread, 'Priya'), 'Sure, what is your budget?')
  assert.equal(calls(), 2)
})

test('a persistent 5xx gives up and fails open — no throw, no reply', async () => {
  const calls = mockFetch([{ ok: false, status: 503, body: { error: 'upstream down' } }])
  assert.equal(await generateReply(thread, 'Priya'), null)
  assert.equal(calls(), 3) // initial attempt + AI_MAX_RETRIES(2)
})

test('a bad API key fails immediately — retrying a 401 cannot help', async () => {
  const calls = mockFetch([{ ok: false, status: 401, body: { error: 'invalid key' } }])
  assert.equal(await generateReply(thread, 'Priya'), null)
  assert.equal(calls(), 1)
})

test('a network failure or timeout fails open', async () => {
  let calls = 0
  global.fetch = async () => {
    calls++
    throw new Error('fetch failed: ETIMEDOUT')
  }
  assert.equal(await generateReply(thread, 'Priya'), null)
  assert.equal(calls, 3)
})

test('with no key configured nothing is sent at all', async () => {
  const prev = process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_API_KEY
  const calls = mockFetch([reply('should never be used')])
  assert.equal(await generateReply(thread, 'Priya'), null)
  assert.equal(await extractLead(thread), null)
  assert.deepEqual(await suggestReplies(thread, {}, 'Priya'), [])
  assert.equal(calls(), 0)
  process.env.OPENROUTER_API_KEY = prev
})

// --- extractLead --------------------------------------------------------------

test('extractLead asks for JSON and returns the parsed record', async () => {
  mockFetch([reply(JSON.stringify({ intent: 'buy', bhk: '2', locality: 'Wakad', budget_max_l: 80, score: 72, temp: 'Warm' }))])
  const x = await extractLead(thread)
  assert.equal(lastRequest.body.response_format.type, 'json_object')
  assert.equal(x.intent, 'buy')
  assert.equal(x.bhk, '2')
  assert.equal(x.score, 72)
})

test('extractLead unwraps a fenced ```json block', async () => {
  mockFetch([reply('```json\n{"intent":"rent","bhk":1}\n```')])
  const x = await extractLead(thread)
  assert.equal(x.intent, 'rent')
  assert.equal(x.bhk, '1') // coerced to the string form the column accepts
})

test('extractLead clamps and rejects values the columns would refuse', async () => {
  mockFetch([reply(JSON.stringify({
    score: 250, temp: 'Boiling', intent: 'timeshare', financing: 'crypto', bhk: 9,
    preferred_localities: ['Wakad', '', 42, null, 'Baner'],
  }))])
  const x = await extractLead(thread)
  assert.equal(x.score, 100) // clamped into 0-100
  assert.equal(x.temp, null)
  assert.equal(x.intent, null)
  assert.equal(x.financing, null)
  assert.equal(x.bhk, null) // "9" is not one of 1/2/3/4/5+
  assert.deepEqual(x.preferred_localities, ['Wakad', 'Baner'])
})

test('extractLead drops a budget too large for the column instead of losing the whole extraction', async () => {
  // The budgets are the only extracted numbers that land in a column unscaled — and
  // they land in two, because budget_max_l is also multiplied by 1e7 into paise. A
  // model that renders "80 lakhs" as 80000000000 therefore writes past BIGINT, and
  // applyExtraction is a single UPDATE: the name, the temperature, the locality and
  // the score are all discarded along with the bad number, leaving the agent a blank
  // lead card and no clue why.
  mockFetch([reply(JSON.stringify({
    name: 'Bhavesh', temp: 'Hot', locality: 'Wakad', score: 88, budget_max_l: 1e12,
  }))])
  const x = await extractLead(thread)
  assert.equal(x.budget_max_l, null, 'an impossible budget must be dropped, not passed through')
  // Everything the model got RIGHT still survives — that is the point.
  assert.equal(x.name, 'Bhavesh')
  assert.equal(x.temp, 'Hot')
  assert.equal(x.locality, 'Wakad')
  assert.equal(x.score, 88)
})

test('extractLead keeps budgets a broker could actually book, and rejects nonsense', async () => {
  mockFetch([reply(JSON.stringify({ budget_min_l: 60, budget_max_l: 80 }))])
  const ok = await extractLead(thread)
  assert.equal(ok.budget_min_l, 60)
  assert.equal(ok.budget_max_l, 80)

  // ₹1 lakh crore is the cap: past any real deal, and inside what the paise column
  // can hold once multiplied out. The boundary itself is accepted.
  mockFetch([reply(JSON.stringify({ budget_max_l: 1e6 }))])
  assert.equal((await extractLead(thread)).budget_max_l, 1e6)
  mockFetch([reply(JSON.stringify({ budget_max_l: 1e6 + 1 }))])
  assert.equal((await extractLead(thread)).budget_max_l, null)

  // A negative budget, a string, and a non-number all read as "the model didn't know".
  mockFetch([reply(JSON.stringify({ budget_min_l: -5 }))])
  assert.equal((await extractLead(thread)).budget_min_l, null)
  mockFetch([reply(JSON.stringify({ budget_max_l: 'eighty lakhs' }))])
  assert.equal((await extractLead(thread)).budget_max_l, null)

  // A numeric string is still a number the model meant — keep it.
  mockFetch([reply(JSON.stringify({ budget_max_l: '80' }))])
  assert.equal((await extractLead(thread)).budget_max_l, 80)
})

test('extractLead floors a negative score rather than storing it', async () => {
  mockFetch([reply(JSON.stringify({ score: -20 }))])
  assert.equal((await extractLead(thread)).score, 0)
  mockFetch([reply(JSON.stringify({ score: 61.7 }))])
  assert.equal((await extractLead(thread)).score, 62)
})

test('extractLead drops a localities list that had nothing usable in it', async () => {
  mockFetch([reply(JSON.stringify({ preferred_localities: [42, null, '  '] }))])
  assert.equal((await extractLead(thread)).preferred_localities, null)
  mockFetch([reply(JSON.stringify({ preferred_localities: 'Wakad' }))])
  assert.equal((await extractLead(thread)).preferred_localities, null)
})

test('extractLead caps a runaway localities list', async () => {
  const many = Array.from({ length: 30 }, (_, i) => `Locality ${i}`)
  mockFetch([reply(JSON.stringify({ preferred_localities: many }))])
  assert.equal((await extractLead(thread)).preferred_localities.length, 10)
})

test('extractLead returns null on unparseable output instead of throwing', async () => {
  mockFetch([reply('I think the buyer wants a 2BHK.')])
  assert.equal(await extractLead(thread), null)
  mockFetch([reply('')])
  assert.equal(await extractLead(thread), null)
})

// --- suggestReplies -----------------------------------------------------------

test('suggestReplies returns the model’s chips, sanitized', async () => {
  mockFetch([reply(JSON.stringify({ suggestions: ['Sure, **when** can you visit?', 'Budget kitna hai?'] }))])
  const chips = await suggestReplies(thread, { intent: 'buy', temp: 'Warm' }, 'Priya')
  assert.equal(chips.length, 2)
  assert.ok(!chips[0].includes('**'))
  assert.equal(chips[1], 'Budget kitna hai?')
})

test('suggestReplies caps the chip list at three', async () => {
  mockFetch([reply(JSON.stringify({ suggestions: ['a', 'b', 'c', 'd', 'e'] }))])
  assert.equal((await suggestReplies(thread, {}, 'Priya')).length, 3)
})

test('suggestReplies drops non-string and empty entries', async () => {
  mockFetch([reply(JSON.stringify({ suggestions: ['Good one', '', null, 42, '   ', '또는'] }))])
  assert.deepEqual(await suggestReplies(thread, {}, 'Priya'), ['Good one'])
})

test('suggestReplies returns [] for a malformed or empty response', async () => {
  mockFetch([reply(JSON.stringify({ suggestions: 'not a list' }))])
  assert.deepEqual(await suggestReplies(thread, {}, 'Priya'), [])
  mockFetch([reply('nonsense')])
  assert.deepEqual(await suggestReplies(thread, {}, 'Priya'), [])
})

test('suggestReplies never calls out for an empty thread', async () => {
  const calls = mockFetch([reply(JSON.stringify({ suggestions: ['x'] }))])
  assert.deepEqual(await suggestReplies([], {}, 'Priya'), [])
  assert.equal(calls(), 0)
})

test('lead context is folded into the suggestion prompt so chips stay on-topic', async () => {
  mockFetch([reply(JSON.stringify({ suggestions: ['ok'] }))])
  await suggestReplies(thread, { intent: 'buy', locality: 'Wakad', budget_max_l: 80, temp: 'Hot' }, 'Priya')
  const system = lastRequest.body.messages[0].content
  assert.match(system, /Wakad/)
  assert.match(system, /80/)
  assert.match(system, /Hot/)
})
