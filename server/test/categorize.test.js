// Inquiry auto-categorization: the compact spec contract (intent / bhk / localities
// / budget-in-paise / timeline / financing) plus the auto-fill suggestion builder.
// No network — normalizeInquiry / buildAutofillSuggestions are pure, and the
// model-calling wrappers fail open to null/[] without an API key.
import { test } from 'node:test'
import assert from 'node:assert/strict'

delete process.env.OPENROUTER_API_KEY

const { normalizeInquiry, categorizeInquiry, buildAutofillSuggestions, __testables } = await import('../ai.js')
const { EXTRACT_PROMPT, SUGGEST_PROMPT, FEWSHOT_EXTRACTION, VALID_INTENT } = __testables

// The full extraction payload ai.js produces for the canonical Hinglish inquiry.
const HINGLISH = {
  intent: 'buy',
  bhk: '2',
  config: '2 BHK',
  locality: 'Wakad',
  preferred_localities: ['Wakad'],
  budget_min_l: null,
  budget_max_l: 80,
  timeline: null,
  financing: null,
}

// --- normalizeInquiry: the spec's worked example -----------------------------

test('"2bhk chahiye wakad me, 80 tak" normalizes to the spec contract', () => {
  const c = normalizeInquiry(HINGLISH)
  assert.equal(c.intent, 'buy')
  assert.equal(c.bhk, 2) // numeric, not the "2" string
  assert.deepEqual(c.localities, ['Wakad'])
  // Budget in paise (HomeNex's canonical unit): 80 Lakh = 800000000 paise; min unknown.
  assert.equal(c.budget.max, 800000000)
  assert.equal(c.budget.min, null)
})

test('a two-sided Hinglish budget "50-60 lakh" becomes a paise range', () => {
  const c = normalizeInquiry({ ...HINGLISH, budget_min_l: 50, budget_max_l: 60 })
  assert.equal(c.budget.min, 500000000)
  assert.equal(c.budget.max, 600000000)
})

test('localities fall back to the single locality when no array is present', () => {
  const c = normalizeInquiry({ intent: 'rent', bhk: '1', locality: 'Hinjewadi', preferred_localities: null })
  assert.deepEqual(c.localities, ['Hinjewadi'])
})

test('a crore budget and 5+ config normalize correctly', () => {
  const c = normalizeInquiry({ intent: 'buy', bhk: '5+', budget_max_l: 250 })
  assert.equal(c.bhk, 5)
  assert.equal(c.budget.max, 2500000000) // 2.5 Cr
})

test('broker intent survives normalization; garbage intent is dropped', () => {
  assert.equal(normalizeInquiry({ intent: 'broker' }).intent, 'broker')
  assert.equal(normalizeInquiry({ intent: 'nonsense' }).intent, null)
})

test('normalizeInquiry tolerates null/garbage input', () => {
  assert.equal(normalizeInquiry(null), null)
  assert.equal(normalizeInquiry('x'), null)
  const empty = normalizeInquiry({})
  assert.deepEqual(empty.localities, [])
  assert.equal(empty.budget.max, null)
})

// --- categorizeInquiry: fail-open -------------------------------------------

test('categorizeInquiry returns null when AI is not configured', async () => {
  assert.equal(await categorizeInquiry([{ role: 'buyer', text: '2bhk chahiye' }]), null)
})

// --- broker intent + few-shot grounding in the prompts ----------------------

test('broker is now a recognised intent', () => {
  assert.ok(VALID_INTENT.includes('broker'))
  assert.ok(VALID_INTENT.includes('buy'))
})

test('the extraction prompt carries Hinglish few-shot examples and the broker case', () => {
  assert.match(FEWSHOT_EXTRACTION, /80 tak/)
  assert.match(FEWSHOT_EXTRACTION, /2 mahine me shift/)
  assert.match(FEWSHOT_EXTRACTION, /property dealer/) // the broker example
  assert.match(EXTRACT_PROMPT, /broker/)
  assert.match(EXTRACT_PROMPT, /<customer_message>/) // untrusted-input framing
})

test('the suggest prompt is language-aware and keeps the untrusted-input framing', () => {
  const p = SUGGEST_PROMPT('Subhendu', 'intent: buy', 'Reply in Hinglish.')
  assert.match(p, /Reply in Hinglish\./)
  assert.match(p, /<customer_message>/)
  assert.match(p, /Subhendu/)
})

// --- buildAutofillSuggestions -----------------------------------------------

test('auto-fill proposes only fields that differ from the current lead', () => {
  const lead = { bhk: '2', name: null, budget_max: null, preferred_localities: [] }
  const suggestions = buildAutofillSuggestions(lead, HINGLISH)
  const fields = suggestions.map((s) => s.field)
  assert.ok(!fields.includes('bhk'), 'bhk already matches, should be skipped')
  assert.ok(fields.includes('budget_max'))
  assert.ok(fields.includes('preferred_localities'))
  const budget = suggestions.find((s) => s.field === 'budget_max')
  assert.equal(budget.suggested, 800000000) // paise
  assert.match(budget.suggested_display, /₹80L/)
})

test('auto-fill returns [] when there is no extraction to draw from', () => {
  assert.deepEqual(buildAutofillSuggestions({ bhk: '2' }, null), [])
  assert.deepEqual(buildAutofillSuggestions(null, null), [])
})

test('auto-fill reads the stored ai_extracted when no explicit extraction is passed', () => {
  const lead = { ai_extracted: HINGLISH, bhk: null }
  const suggestions = buildAutofillSuggestions(lead)
  assert.ok(suggestions.some((s) => s.field === 'bhk' && s.suggested === '2'))
})

// A model that invents an intent, a BHK or a financing value outside the contract
// must produce no suggestion for that field rather than offering the agent a value
// the column will not accept.
test('auto-fill drops field values the model invented outside the contract', () => {
  const suggestions = buildAutofillSuggestions(
    {},
    { intent: 'timeshare', bhk: '9', financing: 'crypto', timeline: '3 months' },
  )
  const fields = suggestions.map((s) => s.field)
  assert.deepEqual(fields, ['timeline'], 'only the free-text field survives')
})

// preferred_localities is the primary source; a bare `locality` is the fallback.
test('auto-fill falls back to a single locality when the list is absent', () => {
  const [only] = buildAutofillSuggestions({}, { locality: 'Baner' })
  assert.equal(only.field, 'preferred_localities')
  assert.deepEqual(only.suggested, ['Baner'])
  assert.equal(only.suggested_display, 'Baner')

  // An empty list is not a value — with no `locality` to fall back on there is nothing.
  assert.deepEqual(buildAutofillSuggestions({}, { preferred_localities: [] }), [])
})

// With no lead at all every suggestion is a change, and `current` reads null rather
// than throwing on the absent row.
test('auto-fill against no lead at all suggests everything with a null current', () => {
  const suggestions = buildAutofillSuggestions(null, { name: 'Nikhil', timeline: 'immediately' })
  assert.deepEqual(suggestions.map((s) => s.field), ['name', 'timeline'])
  assert.ok(suggestions.every((s) => s.current === null))
})

// The DB hands bigint columns back as numeric strings, so the comparison has to be
// numeric or every budget would look changed on each pass.
test('auto-fill treats a numeric string and its number as the same value', () => {
  const same = buildAutofillSuggestions({ budget_max: '800000000' }, { budget_max_l: 80 })
  assert.deepEqual(same, [], 'the stored string equals the suggested number')

  const changed = buildAutofillSuggestions({ budget_max: '700000000' }, { budget_max_l: 80 })
  assert.deepEqual(changed.map((s) => s.field), ['budget_max'])
})

// Non-numeric values fall through to the string compare, and a field that is null on
// both sides is unchanged rather than a suggestion of null.
test('auto-fill compares non-numeric values as strings and skips null-to-null', () => {
  assert.deepEqual(buildAutofillSuggestions({ timeline: '3 months' }, { timeline: '3 months' }), [])
  assert.deepEqual(buildAutofillSuggestions({ timeline: null }, { timeline: null }), [])
  const moved = buildAutofillSuggestions({ timeline: '3 months' }, { timeline: 'immediately' })
  assert.deepEqual(moved.map((s) => s.field), ['timeline'])
})

// An unchanged locality list must compare structurally, not by reference.
test('auto-fill compares locality lists structurally', () => {
  assert.deepEqual(
    buildAutofillSuggestions({ preferred_localities: ['Wakad', 'Baner'] }, { preferred_localities: ['Wakad', 'Baner'] }),
    [],
  )
  const reordered = buildAutofillSuggestions(
    { preferred_localities: ['Baner', 'Wakad'] },
    { preferred_localities: ['Wakad', 'Baner'] },
  )
  assert.equal(reordered.length, 1, 'a different order is a different list')
})

// normalizeInquiry's financing arm mirrors the auto-fill contract.
test('normalizeInquiry keeps only contract financing values', () => {
  assert.equal(normalizeInquiry({ intent: 'buy', financing: 'loan' }).financing, 'loan')
  assert.equal(normalizeInquiry({ intent: 'buy', financing: 'barter' }).financing, null)
})

// The suggest prompt has to stand up without a broker name or a language hint —
// that is what an unnamed workspace on an English thread passes.
test('the suggest prompt degrades gracefully with no broker name or language hint', () => {
  const p = SUGGEST_PROMPT('', 'intent: buy', '')
  assert.match(p, /a real estate broker/, 'falls back to a generic broker')
  assert.ok(!/undefined|null/.test(p), 'no placeholder leaks into the prompt')
  assert.ok(!/\n\n\n/.test(p.slice(0, 400)), 'the empty language hint leaves no gap')
})
