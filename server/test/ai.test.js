// Output hygiene + prompt construction for the WhatsApp AI layer. These run
// without a live OpenRouter call: no OPENROUTER_API_KEY, no DB. They lock in the
// fix for foreign-script leakage (the "또는" Korean-token bug) and the language/
// tone contract that keeps buyer-facing replies clean.
import { test } from 'node:test'
import assert from 'node:assert/strict'

delete process.env.OPENROUTER_API_KEY
delete process.env.OPENROUTER_MODEL

const { sanitizeReply, generateReply, suggestReplies, __testables } = await import('../ai.js')
const { replyPrompt, LANGUAGE_RULES, knownFactsBlock } = __testables

// --- sanitizeReply: foreign-script removal ---------------------------------

test('strips the exact reported Korean leak (또는) and repairs spacing', () => {
  const dirty =
    "Hello! I'm HomeNex AI. Could you share 또는 let me know your budget range in ₹ lakhs?"
  const clean = sanitizeReply(dirty)
  assert.ok(!/또는/.test(clean), 'Korean word must be gone')
  assert.ok(!/\s{2,}/.test(clean), 'no double spaces left where the word was')
  assert.match(clean, /Could you share let me know your budget range/)
  assert.match(clean, /₹ lakhs/, 'rupee symbol survives')
})

test('removes CJK, Japanese, Thai, Arabic, Cyrillic, Greek but keeps Latin', () => {
  const clean = sanitizeReply('Budget 你好 confirm कृपया ก confirm مرحبا Привет γεια done')
  assert.ok(!/[一-鿿]/.test(clean), 'no Chinese')
  assert.ok(!/[฀-๿]/.test(clean), 'no Thai')
  assert.ok(!/[؀-ۿ]/.test(clean), 'no Arabic')
  assert.ok(!/[Ѐ-ӿ]/.test(clean), 'no Cyrillic')
  assert.ok(!/[Ͱ-Ͽ]/.test(clean), 'no Greek')
  assert.match(clean, /Budget/)
  assert.match(clean, /confirm/)
  assert.match(clean, /done/)
})

test('keeps Devanagari (Hindi) when the buyer wrote in Hindi', () => {
  const clean = sanitizeReply('नमस्ते! आपका बजट क्या है?')
  assert.equal(clean, 'नमस्ते! आपका बजट क्या है?')
})

test('keeps Hinglish (Roman Hindi) untouched', () => {
  const clean = sanitizeReply('Haan ji, aapka budget kitna hai? Wakad me 2 BHK dekh lete hain.')
  assert.equal(clean, 'Haan ji, aapka budget kitna hai? Wakad me 2 BHK dekh lete hain.')
})

// --- sanitizeReply: emoji + markdown hygiene -------------------------------

test('caps emoji at one (kills emoji overuse)', () => {
  const clean = sanitizeReply('Hi 👋😊🏠✨ ready to help 🎉')
  const emojiCount = [...clean.matchAll(/\p{Extended_Pictographic}/gu)].length
  assert.equal(emojiCount, 1, 'at most one emoji survives')
  assert.match(clean, /ready to help/)
})

test('strips markdown fences and emphasis a model might add', () => {
  assert.equal(sanitizeReply('```\nBudget theek hai\n```'), 'Budget theek hai')
  assert.equal(sanitizeReply('Your **budget** is _noted_'), 'Your budget is noted')
})

test('a reply that is entirely foreign script collapses to empty', () => {
  assert.equal(sanitizeReply('안녕하세요 여러분'), '')
})

test('handles null/undefined without throwing', () => {
  assert.equal(sanitizeReply(null), '')
  assert.equal(sanitizeReply(undefined), '')
})

// --- generateReply / suggestReplies fall back safely without a key ----------

test('generateReply returns null when AI is not configured', async () => {
  assert.equal(await generateReply([{ role: 'buyer', text: 'hi' }], 'Subhendu'), null)
})

test('suggestReplies returns [] when AI is not configured', async () => {
  assert.deepEqual(await suggestReplies([{ role: 'buyer', text: 'hi' }], null, 'Subhendu'), [])
})

// --- prompt construction ----------------------------------------------------

test('every buyer-facing prompt carries the strict language rules', () => {
  assert.match(LANGUAGE_RULES, /Korean/)
  assert.match(LANGUAGE_RULES, /또는/, 'names the exact failure so the model avoids it')
  assert.match(LANGUAGE_RULES, /at most ONE emoji/i)
  assert.match(replyPrompt('Subhendu', null), /Language & formatting rules/)
})

test('replyPrompt personalises with the broker name', () => {
  const p = replyPrompt('Subhendu Das', null)
  assert.match(p, /Subhendu Das/)
  assert.ok(!/\$\{/.test(p), 'no unresolved template placeholders')
})

test('knownFactsBlock lists known details so the model does not re-ask', () => {
  const block = knownFactsBlock({
    name: 'Rohan',
    locality: 'Wakad',
    budget_max_l: 80,
    bhk: '2',
    financing: 'loan',
  })
  assert.match(block, /do NOT ask for any of these again/)
  assert.match(block, /Rohan/)
  assert.match(block, /Wakad/)
  assert.match(block, /₹80L/)
  assert.match(block, /2 BHK/)
})

test('knownFactsBlock is empty for a brand-new lead', () => {
  assert.equal(knownFactsBlock(null), '')
  assert.equal(knownFactsBlock({}), '')
})
