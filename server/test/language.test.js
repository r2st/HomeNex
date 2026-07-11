// Language + register detection. Pure functions, no DB, no network. These lock in
// the Hindi / Hinglish / English classification that drives "reply in the buyer's
// language" and the explicit prompt instruction the reply/suggest models receive.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { detectLanguage, detectConversationLanguage, replyLanguageInstruction } = await import('../language.js')

// --- English ----------------------------------------------------------------

test('plain English is detected as english', () => {
  const d = detectLanguage('Hi, I am looking for a 2 BHK apartment in Baner under 90 lakhs.')
  assert.equal(d.language, 'english')
  assert.equal(d.script, 'latin')
})

test('a formal English message is tagged formal register', () => {
  const d = detectLanguage('Dear sir, kindly share the available options. Thank you.')
  assert.equal(d.language, 'english')
  assert.equal(d.register, 'formal')
})

// --- Hinglish (romanized Hindi/Marathi) -------------------------------------

test('the canonical Hinglish inquiry is detected as hinglish', () => {
  const d = detectLanguage('2bhk chahiye wakad me, 80 tak')
  assert.equal(d.language, 'hinglish')
  assert.equal(d.script, 'latin')
  assert.ok(d.markerHits >= 1)
})

test('longer Hinglish with several markers is hinglish, not english', () => {
  const d = detectLanguage('haan bhai budget theek hai, loan lena hai, 2 mahine me shift karna hai')
  assert.equal(d.language, 'hinglish')
})

test('bhai/yaar flips the register to informal', () => {
  const d = detectLanguage('arre bhai jaldi options bhejo na')
  assert.equal(d.language, 'hinglish')
  assert.equal(d.register, 'informal')
})

test('Marathi-leaning code-mix is treated as hinglish (same romanized register)', () => {
  const d = detectLanguage('mala Kharadi madhe 2bhk pahije, kiti budget lagel')
  assert.equal(d.language, 'hinglish')
})

// --- Hindi (Devanagari) ------------------------------------------------------

test('Devanagari text is detected as hindi', () => {
  const d = detectLanguage('मुझे वाकड में 2 BHK चाहिए, बजट 80 लाख तक')
  assert.equal(d.language, 'hindi')
})

test('mostly-Latin with a stray Devanagari word is hinglish (mixed script)', () => {
  const d = detectLanguage('budget 80L hai ready possession चाहिए')
  assert.equal(d.language, 'hinglish')
  assert.equal(d.script, 'mixed')
})

// --- edge cases --------------------------------------------------------------

test('empty / numeric-only input is unknown, never throws', () => {
  assert.equal(detectLanguage('').language, 'unknown')
  assert.equal(detectLanguage(null).language, 'unknown')
  assert.equal(detectLanguage('80 90 100').language, 'unknown')
})

test('a bare "ok" is not misfired as Hinglish', () => {
  assert.equal(detectLanguage('ok').language, 'english')
})

// --- conversation-level detection -------------------------------------------

test('conversation language follows the buyer, ignoring assistant turns', () => {
  const msgs = [
    { role: 'ai', text: 'Hello! How can I help you find a home?' },
    { role: 'buyer', text: '2bhk chahiye wakad me' },
    { role: 'ai', text: 'Sure, what is your budget?' },
    { role: 'buyer', text: 'budget 80 tak hai bhai, jaldi chahiye' },
  ]
  assert.equal(detectConversationLanguage(msgs).language, 'hinglish')
})

test('conversation with no buyer messages is unknown', () => {
  assert.equal(detectConversationLanguage([{ role: 'ai', text: 'hi' }]).language, 'unknown')
})

test('buyer switching to Hindi mid-thread is picked up from the latest turn', () => {
  const msgs = [
    { role: 'buyer', text: 'hi looking for a flat' },
    { role: 'buyer', text: 'मुझे बाणेर में 3 BHK चाहिए' },
  ]
  const d = detectConversationLanguage(msgs)
  assert.equal(d.language, 'hindi')
})

// --- prompt instruction ------------------------------------------------------

test('replyLanguageInstruction gives a distinct, explicit rule per language', () => {
  assert.match(replyLanguageInstruction({ language: 'hinglish', register: 'informal' }), /Hinglish/)
  assert.match(replyLanguageInstruction({ language: 'hinglish', register: 'informal' }), /Roman letters only/)
  assert.match(replyLanguageInstruction({ language: 'hindi', register: 'informal' }), /Devanagari/)
  assert.match(replyLanguageInstruction({ language: 'english', register: 'formal' }), /English/)
  assert.match(replyLanguageInstruction({ language: 'unknown', register: 'informal' }), /Mirror/)
})
