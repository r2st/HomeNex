// What the AI layer tells the model about the buyer, and what it does when it is
// told nothing.
//
// Two prompt builders read the lead card field by field: knownFactsBlock, which
// stops the assistant re-asking for something the buyer already said, and the
// context line suggestReplies puts in front of the model. Every field in both is a
// separate `x && ...`, and a lead card is mostly empty for most of its life — so the
// half of each expression that runs on a blank card is the half that runs in
// production. These pin both halves of every field, and the two arms of
// categorizeInquiry's fail-open.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.NODE_ENV = 'test'
process.env.OPENROUTER_API_KEY = 'context-test-key'
process.env.AI_MAX_RETRIES = '1'

const { suggestReplies, categorizeInquiry, __testables } = await import('../ai.js')
const { knownFactsBlock, replyPrompt } = __testables

const realFetch = global.fetch
let lastBody = null

// Answers every OpenRouter call with `content`, and records what was asked.
function mockFetch(content) {
  global.fetch = async (_url, options) => {
    lastBody = JSON.parse(options.body)
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
      text: async () => content,
      headers: { get: () => null },
    }
  }
}

afterEach(() => {
  global.fetch = realFetch
  lastBody = null
})

const thread = [{ role: 'buyer', text: 'still looking, any updates?' }]

// --- knownFactsBlock: a full card, then an empty one -------------------------

test('a fully filled lead card is handed to the model field by field', () => {
  const block = knownFactsBlock({
    name: 'Rhea Kulkarni',
    intent: 'buy',
    config: '3 BHK',
    locality: 'Baner',
    budget_max_l: 95,
    financing: 'loan',
    timeline: '3 months',
  })
  for (const line of [
    'Name: Rhea Kulkarni',
    'Intent: buy',
    'Configuration: 3 BHK',
    'Location: Baner',
    'Budget: up to ₹95L',
    'Financing: loan',
    'Timeline: 3 months',
  ]) {
    assert.ok(block.includes(`- ${line}`), `missing "${line}"`)
  }
  assert.match(block, /do NOT ask for any of these again/)
})

test('bhk stands in for config when only the number is known', () => {
  const block = knownFactsBlock({ bhk: '2' })
  assert.ok(block.includes('- Configuration: 2 BHK'))
})

test('a lead card with nothing on it produces no facts block at all', () => {
  // Every field falsy: the block must be empty rather than a header followed by
  // an empty list, which would read to the model as "we know nothing, ask again".
  assert.equal(
    knownFactsBlock({
      name: null,
      intent: null,
      config: null,
      bhk: null,
      locality: null,
      budget_max_l: null,
      financing: null,
      timeline: null,
    }),
    '',
  )
  assert.equal(knownFactsBlock({}), '')
  assert.equal(knownFactsBlock(null), '', 'and no lead at all is not a crash')
})

test('the reply prompt names the broker, or says "the broker" when it has no name', () => {
  assert.match(replyPrompt('Anita Deshmukh', null), /assistant for Anita Deshmukh/)
  const anonymous = replyPrompt('', null)
  assert.match(anonymous, /assistant for the broker/)
  assert.ok(!/for  ,/.test(anonymous), 'no hole where the name should be')
})

// --- suggestReplies: the context line ----------------------------------------

test('every known field reaches the suggestion prompt as context', async () => {
  mockFetch(JSON.stringify({ suggestions: ['Sharing options now', 'Free for a visit Sunday?'] }))
  const out = await suggestReplies(thread, {
    intent: 'buy',
    config: '3 BHK',
    locality: 'Kothrud',
    budget_max_l: 120,
    timeline: 'this quarter',
    financing: 'self',
    temp: 'Hot',
  }, 'Anita')
  assert.deepEqual(out, ['Sharing options now', 'Free for a visit Sunday?'])

  const system = lastBody.messages[0].content
  for (const fragment of [
    'intent: buy',
    'config: 3 BHK',
    'locality: Kothrud',
    'budget: up to ₹120L',
    'timeline: this quarter',
    'financing: self',
    'lead temperature: Hot',
  ]) {
    assert.ok(system.includes(fragment), `context is missing "${fragment}"`)
  }
})

test('suggestions still come back for a lead we know nothing about', async () => {
  mockFetch(JSON.stringify({ suggestions: ['What budget are you working with?'] }))
  const out = await suggestReplies(thread, {}, 'Anita')
  assert.deepEqual(out, ['What budget are you working with?'])
  const system = lastBody.messages[0].content
  assert.ok(!/intent:|config:|locality:|budget:|timeline:|financing:|temperature:/.test(system),
    'an empty card contributes no context fragments at all')
})

test('suggestions survive a lead that is missing entirely', async () => {
  mockFetch(JSON.stringify({ suggestions: ['Happy to help — what are you looking for?'] }))
  const out = await suggestReplies(thread, null, 'Anita')
  assert.equal(out.length, 1)
})

// --- categorizeInquiry: both arms of the fail-open ---------------------------

test('a thread the model can read is projected onto the inquiry contract', async () => {
  mockFetch(JSON.stringify({
    intent: 'buy',
    bhk: '2',
    locality: 'Wakad',
    budget_max_l: 80,
    timeline: '3 months',
    financing: 'loan',
  }))
  const inquiry = await categorizeInquiry([{ role: 'buyer', text: '2bhk chahiye wakad me, 80 tak' }])
  assert.equal(inquiry.intent, 'buy')
  assert.equal(inquiry.bhk, 2)
  assert.deepEqual(inquiry.localities, ['Wakad'])
  assert.equal(inquiry.budget.max, 800000000, 'lakhs converted to paise')
  assert.equal(inquiry.budget.min, null)
  assert.equal(inquiry.financing, 'loan')
})

test('a thread the model returns nothing for categorizes as null, not as a throw', async () => {
  mockFetch('not json at all')
  assert.equal(await categorizeInquiry([{ role: 'buyer', text: 'hi' }]), null)
})
