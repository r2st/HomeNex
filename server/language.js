// language.js — deterministic language + register detection for buyer messages.
//
// Pune buyers write in three registers on WhatsApp:
//   * English    — "Looking for a 2 BHK in Wakad under 80 lakhs."
//   * Hindi       — Devanagari script: "मुझे वाकड में 2 BHK चाहिए, बजट 80 लाख।"
//   * Hinglish    — Roman-script Hindi/Marathi code-mix: "2bhk chahiye wakad me, 80 tak"
//
// We detect this WITHOUT an LLM call: it is instant, free, and works when AI is
// off — exactly what a fail-open reply/suggestion path needs. The detection then
// drives an explicit "reply in this language & register" instruction so the model
// mirrors the buyer instead of guessing.

// Devanagari block (Hindi/Marathi). Its presence is the strongest signal.
const DEVANAGARI = /[ऀ-ॿ]/
const LATIN_LETTER = /[A-Za-z]/

// High-signal romanized Hindi/Marathi tokens. Curated so common English words that
// happen to look similar don't misfire. A message with several of these is Hinglish
// even though every character is ASCII.
const HINGLISH_MARKERS = new Set([
  'hai', 'hain', 'nahi', 'nahin', 'haan', 'han', 'ji', 'kya', 'kyaa', 'kyun', 'kaise',
  'kaisa', 'kitna', 'kitne', 'kitni', 'chahiye', 'chaiye', 'mujhe', 'mereko', 'muze',
  'aap', 'aapka', 'aapko', 'tumhara', 'apna', 'mera', 'meri', 'hamara', 'bhai', 'bhaiya',
  'yaar', 'arre', 'arey', 'achha', 'accha', 'acha', 'theek', 'thik', 'thoda', 'bahut',
  'bohot', 'bohut', 'zyada', 'jyada', 'kam', 'karo', 'karna', 'karke', 'kar', 'karenge',
  'karunga', 'lena', 'lelo', 'dena', 'dedo', 'dikhao', 'dikha', 'batao', 'bata', 'bta',
  'chalega', 'chal', 'milega', 'milegi', 'lagta', 'lagega', 'sakta', 'sakte', 'sakti',
  'matlab', 'lekin', 'magar', 'agar', 'phir', 'abhi', 'jaldi', 'baad', 'pehle', 'wala',
  'wali', 'wale', 'me', 'mein', ' me', 'ke', 'ka', 'ki', 'ko', 'se', 'tak', 'pe', 'par',
  'hoga', 'hogi', 'hona', 'raha', 'rahe', 'rahi', 'gaya', 'diya', 'liya', 'kiya',
  'chahta', 'chahte', 'dekhna', 'dekh', 'dekhte', 'shift', 'mahine', 'mahina', 'saal',
  'lakh', 'lakhs', 'peti', 'khokha', 'budget', 'ready', 'possession',
])

// Marathi-leaning markers (Pune is in Maharashtra). Treated as Hinglish too — we
// reply in the same romanized register rather than switching languages.
const MARATHI_MARKERS = new Set([
  'kaay', 'kai', 'kase', 'kasa', 'mala', 'tula', 'tumhi', 'aahe', 'ahe', 'nahi',
  'pahije', 'havay', 'have', 'ghar', 'kiti', 'aani', 'pan', 'mag', 'zala', 'zali',
])

// Formal-register cues (either language). WhatsApp skews informal, so we only flip
// to formal on explicit politeness/business markers.
const FORMAL_MARKERS = /\b(kindly|regards|sir|madam|please note|dear|respected|thank you|would you|could you)\b/i
const FORMAL_HINDI = /(कृपया|धन्यवाद|महोदय|आपसे निवेदन|सादर)/
const INFORMAL_MARKERS = /\b(bhai|yaar|arre|arey|bro|dude|plz|pls|u|ur|lol|hii+|heyy+)\b/i

const tokenize = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[^a-zऀ-ॿ\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

function scriptRatios(text) {
  const chars = String(text || '')
  let deva = 0
  let latin = 0
  for (const ch of chars) {
    if (DEVANAGARI.test(ch)) deva++
    else if (LATIN_LETTER.test(ch)) latin++
  }
  const total = deva + latin
  return { deva, latin, total, devaRatio: total ? deva / total : 0 }
}

// Detect the language + register of a single message.
//
// Returns:
//   language   — 'english' | 'hindi' | 'hinglish' | 'unknown'
//   script     — 'latin' | 'devanagari' | 'mixed'
//   register   — 'formal' | 'informal'
//   confidence — 0..1
//   markerHits — how many romanized-Hindi markers matched (debug/tests)
export function detectLanguage(text) {
  const raw = String(text || '').trim()
  const { deva, latin, total, devaRatio } = scriptRatios(raw)

  const register =
    FORMAL_MARKERS.test(raw) || FORMAL_HINDI.test(raw)
      ? 'formal'
      : INFORMAL_MARKERS.test(raw)
        ? 'informal'
        : 'informal' // WhatsApp default

  if (!total) {
    return { language: 'unknown', script: 'latin', register, confidence: 0, markerHits: 0 }
  }

  // Devanagari present → Hindi (or mixed Hinglish if there's substantial Latin too).
  if (deva > 0) {
    if (devaRatio >= 0.4) {
      const script = latin > 0 ? 'mixed' : 'devanagari'
      return { language: 'hindi', script, register, confidence: Math.min(1, 0.6 + devaRatio / 2), markerHits: 0 }
    }
    // Mostly Latin with a few Devanagari words — treat as Hinglish, script mixed.
    return { language: 'hinglish', script: 'mixed', register, confidence: 0.7, markerHits: 0 }
  }

  // All-Latin: count romanized Hindi/Marathi markers.
  const tokens = tokenize(raw)
  let hits = 0
  for (const t of tokens) if (HINGLISH_MARKERS.has(t) || MARATHI_MARKERS.has(t)) hits++
  const ratio = tokens.length ? hits / tokens.length : 0

  // A couple of markers, or a meaningful fraction, means the buyer is code-mixing.
  if (hits >= 2 || ratio >= 0.2) {
    return { language: 'hinglish', script: 'latin', register, confidence: Math.min(1, 0.5 + ratio), markerHits: hits }
  }
  if (hits === 1 && tokens.length <= 5) {
    // Short message with one strong marker ("2bhk chahiye") — still Hinglish.
    return { language: 'hinglish', script: 'latin', register, confidence: 0.55, markerHits: hits }
  }
  return { language: 'english', script: 'latin', register, confidence: Math.min(1, 0.6 + (1 - ratio) / 3), markerHits: hits }
}

// Detect the conversation's working language from the buyer's messages, weighting
// recent messages more heavily (people warm up and switch registers mid-thread).
export function detectConversationLanguage(messages = []) {
  const buyerTexts = messages.filter((m) => m.role === 'buyer').map((m) => m.text)
  if (!buyerTexts.length) return { language: 'unknown', script: 'latin', register: 'informal', confidence: 0, markerHits: 0 }

  // Weight: most recent buyer message counts most; tally weighted votes per language.
  const recent = buyerTexts.slice(-6)
  const votes = { english: 0, hindi: 0, hinglish: 0, unknown: 0 }
  let last = null
  recent.forEach((t, i) => {
    const d = detectLanguage(t)
    const weight = (i + 1) * d.confidence
    votes[d.language] += weight
    last = d
  })
  // Prefer the buyer's latest clear signal; break ties toward the most recent message.
  const winner = Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0]
  const chosen = winner === 'unknown' ? last.language : winner
  return { ...detectLanguage(recent[recent.length - 1]), language: chosen }
}

// Human-readable label + the explicit instruction we inject into buyer-facing
// prompts so the model mirrors the buyer's language and register precisely.
export function replyLanguageInstruction(detection) {
  const reg = detection.register === 'formal' ? 'polite/formal' : 'warm/informal'
  switch (detection.language) {
    case 'hindi':
      return `The buyer is writing in Hindi (Devanagari). Reply in Hindi using Devanagari script, ${reg} register. Do not switch to English unless the buyer does.`
    case 'hinglish':
      return `The buyer is writing in Hinglish (Hindi/Marathi in Roman letters, e.g. "haan theek hai", "kitna budget"). Reply in the SAME natural Hinglish, ${reg} register — Roman letters only, do NOT switch to pure English or to Devanagari.`
    case 'english':
      return `The buyer is writing in English. Reply in clear, friendly English, ${reg} register.`
    default:
      return `Mirror whatever language and register the buyer uses (English, Hindi, or Hinglish).`
  }
}

export const __testables = { HINGLISH_MARKERS, MARATHI_MARKERS, scriptRatios, tokenize }
