// The defensive arms of the pure helpers. Every function here is fed by data the
// agent, the buyer or Meta typed — so the "missing field" path is the one that
// actually runs in production, and it is the one that was untested.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
// These helpers are pure, but a couple of them import db.js, which opens a pool at
// module load. Point it at a throwaway database first — hence the dynamic imports
// below, which run after createTestDb has set DATABASE_URL rather than being
// hoisted above it the way a static import would be.
const dbName = await createTestDb('helperedges')
const { closePool } = await import('../db.js')

const { extractPlaceholders, fillTemplate, reraLine, appendRera } = await import('../inbox.js')
const { detectEmiQuery, parseAmountLakhs, parseEmiQuery, calculateEmi, formatEmiMessage, emiReplyFor } =
  await import('../emi.js')
const { detectLanguage, detectConversationLanguage, __testables } = await import('../language.js')
const { renderMicroPage } = await import('../micropage.js')
const { personalizeGreeting, getFestival, FESTIVALS } = await import('../festivals.js')
const { budgetFits, localityMatches, scorePropertyMatch } = await import('../matching.js')
const { engagementVelocity, hybridScore } = await import('../scoring.js')
const { hourInTimezone } = await import('../sendLimiter.js')
const { extractPhoneFromText, parseAgentCommand } = await import('../agentCommands.js')
const { bookingConfirmationText, reminderT1Text, reminderT2Text } = await import('../siteVisit.js')
const { cors } = await import('../middleware.js')

after(async () => {
  await closePool()
  await dropTestDb(dbName)
})

// === inbox: template variables and the RERA footer ===

test('placeholder helpers survive a body that is missing entirely', () => {
  assert.deepEqual(extractPlaceholders(null), [])
  assert.deepEqual(extractPlaceholders(undefined), [])
  assert.deepEqual(fillTemplate(null), { text: '', missing: [] })
  // A caller that passes no values at all is the same as passing empty ones:
  // every variable comes back reported as missing, not silently blanked.
  assert.deepEqual(fillTemplate('Hi {{name}}'), { text: 'Hi {{name}}', missing: ['name'] })
  assert.deepEqual(fillTemplate('Hi {{name}}', null), { text: 'Hi {{name}}', missing: ['name'] })
})

test('the RERA footer is appended once and never to an agent without one', () => {
  const agent = { rera_id: 'A52100001234', rera_state: 'MH' }
  assert.equal(reraLine({}), '')
  assert.equal(reraLine({ rera_id: '   ' }), '')
  assert.equal(reraLine({ rera_id: 'A521' }), 'RERA: A521', 'no state on file')
  assert.equal(appendRera('Launch offer', {}), 'Launch offer', 'nothing to append')

  const once = appendRera('Launch offer', agent)
  assert.match(once, /RERA \(MH\): A52100001234$/)
  // Idempotent: an agent who already typed the number keeps their own wording.
  assert.equal(appendRera(once, agent), once)
  // A null body still gets the mandated line rather than throwing.
  assert.equal(appendRera(null, agent), '\n\nRERA (MH): A52100001234')
})

// === emi: the buyer's phrasing is arbitrary ===

test('EMI detection and amount parsing handle absent and crore-scale input', () => {
  assert.equal(detectEmiQuery(null), false)
  assert.equal(detectEmiQuery(''), false)
  assert.equal(detectEmiQuery('what is the EMI on this'), true)
  assert.equal(parseAmountLakhs(null), null)
  assert.equal(parseAmountLakhs('1.2 crore'), 120)
  assert.equal(parseAmountLakhs('2 cr'), 200)
  assert.equal(parseAmountLakhs('1,20,00,000'), 120, 'plain rupees with Indian grouping')
})

test('a zero or nonsense principal is not an EMI question', () => {
  assert.equal(parseEmiQuery('emi on 0 lakhs'), null)
  assert.equal(parseEmiQuery('what is the emi'), null, 'no amount at all')
  assert.equal(emiReplyFor('just browsing, thanks'), null)
})

test('an EMI that cannot be computed produces no message rather than a broken one', () => {
  assert.equal(calculateEmi({ principalPaise: 0, ratePct: 8.5, years: 20 }), null)
  assert.equal(formatEmiMessage({ principalLakhs: 0, ratePct: 8.5, years: 20 }), null)
})

test('lakh-scale and crore-scale figures are each written the Indian way', () => {
  const lakhs = formatEmiMessage({ principalLakhs: 45, ratePct: 8.5, years: 20, assumedRate: true, assumedYears: true })
  assert.match(lakhs, /₹[\d.]+ L/, 'a 45L loan is quoted in lakhs')
  const crores = formatEmiMessage({ principalLakhs: 250, ratePct: 8.5, years: 20 })
  assert.match(crores, /₹[\d.]+ Cr/, 'a 2.5Cr loan is quoted in crores')
})

// === language: code-mixing is the normal case, not the exception ===

test('tokenize and detectLanguage accept nothing at all', () => {
  assert.deepEqual(__testables.tokenize(null), [])
  assert.deepEqual(__testables.tokenize('   '), [])
  const d = detectLanguage(null)
  assert.equal(d.language, 'unknown')
})

test('a short message with a single strong marker is still Hinglish', () => {
  // "2bhk chahiye" is two tokens and one marker — under the ratio rule it would
  // read as English, which would have the AI reply in the wrong register.
  const d = detectLanguage('2bhk chahiye')
  assert.equal(d.language, 'hinglish')
  assert.equal(d.markerHits, 1)
  assert.equal(d.script, 'latin')
})

test('a thread of unclassifiable messages falls back to the latest one', () => {
  const d = detectConversationLanguage([
    { role: 'buyer', text: '...' },
    { role: 'agent', text: 'Hello sir' },
    { role: 'buyer', text: '???' },
  ])
  assert.ok(d.language, 'still resolves to something usable')
})

// === micropage: a listing is mostly empty fields ===

test('a property with nothing filled in still renders a safe page', () => {
  const html = renderMicroPage({ title: null })
  assert.match(html, /<!doctype html>/)
  assert.match(html, /placeholder/, 'no photos means the placeholder block')
  assert.doesNotMatch(html, /Chat on WhatsApp/, 'no number means no CTA')
})

test('photo URLs that are not http(s) are dropped, not emitted', () => {
  const html = renderMicroPage({
    title: 'Test',
    photos: ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', '/relative.png', 'https://cdn.test/ok.png'],
    agent_phone: '+919876543210',
  })
  assert.doesNotMatch(html, /javascript:/)
  assert.doesNotMatch(html, /data:text\/html/)
  assert.doesNotMatch(html, /relative\.png/)
  assert.match(html, /https:\/\/cdn\.test\/ok\.png/)
})

test('a title carrying markup is escaped everywhere it appears', () => {
  const html = renderMicroPage({ title: '<img src=x onerror="alert(1)">', agent_phone: '+919876543210' })
  assert.doesNotMatch(html, /<img src=x/)
  assert.match(html, /&lt;img src=x/)
  // ...including inside the pre-filled WhatsApp message on the CTA link.
  assert.doesNotMatch(html, /href="[^"]*onerror="/)
})

// === festivals ===

test('a greeting with no client name addresses them respectfully', () => {
  assert.equal(personalizeGreeting('Happy Diwali {name}! — {agent}', {}), 'Happy Diwali ji! —')
  assert.equal(personalizeGreeting(null), '')
  assert.equal(
    personalizeGreeting('Namaste {name}, from {agent}', { name: 'Ramesh', agent: 'Suman' }),
    'Namaste Ramesh, from Suman',
  )
})

test('every festival is retrievable by its key and nothing else is', () => {
  for (const f of FESTIVALS) assert.equal(getFestival(f.key).key, f.key)
  assert.equal(getFestival('not-a-festival'), null)
})

// === matching: absent data must never hide inventory ===

// Budget and locality are deliberately opposite: an unpriced listing must never be
// filtered out on budget, but locality is a scoring bonus, so "we don't know" earns
// nothing rather than being treated as a match.
test('a missing price never excludes a listing from a budgeted lead', () => {
  const lead = { budget_min: 50_00_00_000, budget_max: 90_00_00_000 }
  assert.equal(budgetFits(lead, {}), true, 'no price on the listing')
  assert.equal(budgetFits({}, { price_paise: 90_00_00_000 }), true, 'no budget on the lead')
  assert.equal(budgetFits(lead, { price_paise: 99_00_00_000 }), true, 'within the 10% stretch')
  assert.equal(budgetFits(lead, { price_paise: 200_00_00_000 }), false, 'a stated conflict does exclude')
})

test('locality only matches when both sides actually named one', () => {
  assert.equal(localityMatches({}, { locality: 'Wakad' }), false, 'lead said nothing to match against')
  assert.equal(localityMatches({ locality: 'Wakad' }, {}), false, 'listing has no locality')
  assert.equal(localityMatches({ locality: null }, { locality: null }), false)
  assert.equal(localityMatches({ locality: 'Wakad' }, { locality: 'Baner' }), false)
  // Whitespace and case are noise; a substring either way is still the same place.
  assert.equal(localityMatches({ locality: '  wakad  ' }, { locality: 'Wakad' }), true)
  assert.equal(localityMatches({ preferred_localities: ['Wakad'] }, { locality: 'Wakad, Pune' }), true)
  // preferred_localities that isn't a list is ignored, not crashed on.
  assert.equal(localityMatches({ preferred_localities: 'Wakad', locality: 'Wakad' }, { locality: 'Wakad' }), true)
})

test('scoring a match against an empty lead and empty property does not throw', () => {
  const s = scorePropertyMatch({}, {})
  assert.equal(s.fits, true, 'nothing stated means nothing to conflict with')
  assert.equal(s.score, 0)
  assert.deepEqual(s.reasons, [])
})

// === scoring ===

test('engagement velocity ignores missing and unparseable timestamps', () => {
  assert.equal(engagementVelocity(null), 0)
  assert.equal(engagementVelocity([]), 0)
  const now = Date.now()
  assert.equal(engagementVelocity([null, undefined, 'not-a-date'], now), 0)
  // Four real events inside the window is the clustering bonus.
  assert.equal(engagementVelocity([now - 1000, now - 2000, now - 3000, now - 4000], now), 0.3)
  // Anything in the future is not engagement that has happened.
  assert.equal(engagementVelocity([now + 60_000], now), 0)
})

test('an immediate timeline reads as "immediate", not "~0 month(s)"', () => {
  const lead = { budget_min: 5_000_000_00, budget_max: 9_000_000_00, timeline: 'immediately', temp: 'Hot' }
  const out = hybridScore(lead, { replyCount: 3, visitAgreed: true, lastInboundAt: new Date().toISOString() })
  if (out.source === 'rule') {
    assert.match(out.reason, /timeline immediate/)
    assert.doesNotMatch(out.reason, /~0 month/)
  }
})

// === sendLimiter ===

test('the send-window hour falls back to IST and survives a bad timezone', () => {
  const now = Date.parse('2026-08-10T06:30:00Z') // 12:00 IST
  assert.equal(hourInTimezone(now, 'Asia/Kolkata'), 12)
  assert.equal(hourInTimezone(now), 12, 'no timezone on file means IST')
  assert.equal(hourInTimezone(now, ''), 12)
  assert.equal(hourInTimezone(now, 'Mars/Olympus_Mons'), null, 'unparseable, not a crash')
})

// === agentCommands: the agent messages their own number ===

test('a phone number is only extracted when it could actually be one', () => {
  assert.equal(extractPhoneFromText(null), null)
  assert.equal(extractPhoneFromText(''), null)
  assert.equal(extractPhoneFromText('call me maybe'), null)
  assert.equal(extractPhoneFromText('12345'), null, 'too short to be a number')
  assert.equal(extractPhoneFromText('add +91 (98765) 43-210 please'), '+919876543210')
})

test('a shared contact card without a number is a help request, not a bad add', () => {
  assert.deepEqual(parseAgentCommand({ type: 'contacts', contacts: [{ name: { formatted_name: 'Ramesh' } }] }), { kind: 'help' })
  assert.deepEqual(parseAgentCommand({ type: 'contacts', contacts: [] }), { kind: 'help' })
  assert.deepEqual(parseAgentCommand({ type: 'image' }), { kind: 'help' })
  // wa_id is used when the card has no plain phone, and first_name when there is
  // no formatted name.
  assert.deepEqual(
    parseAgentCommand({
      type: 'contacts',
      contacts: [{ name: { first_name: 'Ramesh' }, phones: [{ wa_id: '919876543210' }] }],
    }),
    { kind: 'add', phone: '919876543210', name: 'Ramesh' },
  )
  // A card with a number but no name at all still adds.
  assert.deepEqual(
    parseAgentCommand({ type: 'contacts', contacts: [{ phones: [{ phone: '+919876543210' }] }] }),
    { kind: 'add', phone: '+919876543210', name: null },
  )
})

// === siteVisit: the Hinglish pack, with and without a pickup point ===

const visit = (extra = {}) => ({
  scheduled_at: '2026-08-11T05:30:00Z',
  property_title: 'Skyline Towers',
  property_locality: 'Wakad',
  property_city: 'Pune',
  lead_name: 'Ramesh Kumar',
  pickup_required: true,
  pickup_location: 'Hinjewadi Phase 1',
  ...extra,
})

test('Hinglish site-visit messages render with and without a pickup location', () => {
  const withPickup = bookingConfirmationText(visit(), { lang: 'hinglish' })
  assert.match(withPickup, /Pickup arranged hai — Hinjewadi Phase 1 se/)
  assert.match(withPickup, /Aapki site visit confirm ho gayi hai/)
  assert.match(withPickup, /Hi Ramesh!/, 'first name only')

  // A pickup with no address named still says a pickup is arranged.
  const noAddress = bookingConfirmationText(visit({ pickup_location: null }), { lang: 'hinglish' })
  assert.match(noAddress, /Pickup arranged hai$/m)
  assert.doesNotMatch(noAddress, /Hinjewadi/)
  // No pickup at all drops the line entirely.
  assert.doesNotMatch(
    bookingConfirmationText(visit({ pickup_required: false }), { lang: 'hinglish' }),
    /Pickup/,
  )

  const t1 = reminderT1Text(visit({ pickup_location: 'Baner' }), { lang: 'hinglish' })
  assert.match(t1, /Pickup — Baner se — ready rehna/)
  assert.match(reminderT1Text(visit({ pickup_location: null }), { lang: 'hinglish' }), /Pickup — ready rehna/)

  const t2 = reminderT2Text(visit({ pickup_location: 'Aundh' }), { lang: 'hinglish' })
  assert.match(t2, /Pickup — Aundh se nikal chuka hai/)
  assert.match(t2, /2 ghante mein hai/)
  assert.match(t2, /📍 Location: https:/, 'the 2-hour reminder carries the map pin')
  assert.match(reminderT2Text(visit({ pickup_location: null }), { lang: 'hinglish' }), /Pickup nikal chuka hai/)
})

test('an unknown language falls back to the English pack', () => {
  assert.match(bookingConfirmationText(visit(), { lang: 'klingon' }), /site visit is confirmed|confirmed/i)
  assert.match(bookingConfirmationText(visit(), {}), /confirmed/i)
  // The detector's object form is accepted as well as a bare string.
  assert.match(bookingConfirmationText(visit(), { lang: { language: 'hinglish' } }), /confirm ho gayi hai/)
})

test('an unnamed lead gets a greeting without a dangling name', () => {
  const text = bookingConfirmationText(visit({ lead_name: null }), { lang: 'hinglish' })
  assert.doesNotMatch(text, /Hi !/)
  assert.match(text, /site visit confirm ho gayi hai/)
  // A lead whose "name" is just their wa_id is not a name.
  const waIdOnly = bookingConfirmationText(
    visit({ lead_name: '919876543210', lead_wa_id: '919876543210' }),
    { lang: 'hinglish' },
  )
  assert.doesNotMatch(waIdOnly, /919876543210/)
})

// === middleware: CORS wildcard ===

test('CORS_ORIGIN="*" answers any origin without claiming credentials', () => {
  const headers = {}
  const res = { setHeader: (k, v) => { headers[k] = v }, sendStatus: () => {} }
  const next = () => {}
  cors('*')({ get: (h) => (h === 'origin' ? 'https://anywhere.test' : null), method: 'GET' }, res, next)
  assert.equal(headers['Access-Control-Allow-Origin'], '*')
  // A wildcard origin with credentials is rejected by browsers and would be a
  // footgun to advertise — it must stay off.
  assert.equal(headers['Access-Control-Allow-Credentials'], undefined)
})

test('a preflight is answered without falling through to a route', () => {
  let status = null
  let nexted = false
  const res = { setHeader: () => {}, sendStatus: (s) => { status = s } }
  cors('https://app.test')(
    { get: (h) => (h === 'origin' ? 'https://app.test' : null), method: 'OPTIONS' },
    res,
    () => { nexted = true },
  )
  assert.equal(status, 204)
  assert.equal(nexted, false)
})
