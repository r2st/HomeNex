// Pure unit tests for the rule-based pre-contact briefing (no DB, no AI).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { missingBLTC, talkingPoints, buildBriefing } from '../briefing.js'

const texts = (points) => points.map((p) => p.text)

test('missingBLTC lists the unknown qualification pieces', () => {
  assert.deepEqual(missingBLTC({}), ['Budget', 'Location', 'Timeline', 'Configuration'])
  assert.deepEqual(
    missingBLTC({ budget_max: 1, locality: 'Wakad', timeline: '2 months', bhk: '2' }),
    [],
  )
  assert.deepEqual(missingBLTC({ budget_max_l: 80, preferred_localities: ['Baner'] }), ['Timeline', 'Configuration'])
})

test('talking points: repeat micro-page viewer gets the "keeps coming back" line', () => {
  const points = talkingPoints({ budget_max: 1, timeline: 'x' }, { repeatViewedProperty: true })
  assert.ok(texts(points).some((t) => /keep re-opening/i.test(t)))
})

test('talking points: viewed once then silent -> ask one question, do not re-pitch', () => {
  const points = talkingPoints({}, { pageViewCount: 1, buyerReplied: false })
  assert.ok(texts(points).some((t) => /went quiet/i.test(t) && /one question/i.test(t)))
})

test('talking points: budget known, timeline unknown -> get the timeline', () => {
  const points = talkingPoints({ budget_max: 8_000_000_00 }, {})
  assert.ok(texts(points).some((t) => /timeline/i.test(t)))
})

test('talking points: completed visit gone quiet 3+ days -> the deal is dying', () => {
  const points = talkingPoints({}, { siteVisitCompleted: true, daysSinceSiteVisit: 4, followupSinceVisit: false })
  assert.ok(texts(points).some((t) => /deal dying/i.test(t)))
})

test('talking points: undecided financing -> offer the EMI number', () => {
  const points = talkingPoints({ financing: 'undecided' }, {})
  assert.ok(texts(points).some((t) => /EMI/i.test(t)))
})

test('talking points: closing service window is the urgent line', () => {
  const points = talkingPoints({}, { serviceWindowClosingH: 2 })
  assert.equal(points[0].tone, 'urgent')
  assert.ok(/window closes/i.test(points[0].text))
})

test('buildBriefing assembles the full panel from stored data', () => {
  const now = Date.now()
  const lead = { id: 7, name: 'Ravi', wa_id: '9199', budget_max: 9_000_000_00, financing: 'undecided', ai_score_reason: 'clear budget' }
  const messages = [
    { role: 'buyer', text: 'Hi, 2BHK in Wakad?', created_at: new Date(now - 3 * 3600_000).toISOString() },
    { role: 'agent', text: 'Sure!', created_at: new Date(now - 2 * 3600_000).toISOString() },
    { role: 'buyer', text: 'Budget 90L', created_at: new Date(now - 3600_000).toISOString() },
  ]
  const pageViews = [
    { property_id: 5, viewed_at: new Date(now - 30 * 60_000).toISOString() },
    { property_id: 5, viewed_at: new Date(now - 20 * 60_000).toISOString() },
    { property_id: 5, viewed_at: new Date(now - 10 * 60_000).toISOString() },
  ]
  const briefing = buildBriefing({
    lead,
    messages,
    pageViews,
    siteVisits: [],
    serviceWindow: { open: true, expires_at: new Date(now + 3 * 3600_000).toISOString() },
    decay: { effectiveScore: 74, temperature: 'Hot' },
  }, now)

  assert.equal(briefing.lead_id, 7)
  assert.equal(briefing.score, 74)
  assert.equal(briefing.temperature, 'Hot')
  assert.equal(briefing.page_view_count, 3)
  assert.equal(briefing.repeat_viewed_property, true)
  assert.equal(briefing.recent_messages.length, 2) // only buyer messages, last 3
  assert.ok(briefing.talking_points.length > 0)
  assert.equal(briefing.score_reason, 'clear budget')
})

// --- buildBriefing edge branches ---------------------------------------------

test('buildBriefing derives last contact from the messages when the lead has no stamp', () => {
  const now = Date.now()
  const messages = [
    { role: 'agent', text: 'ping', created_at: new Date(now - 5 * 24 * 3600_000).toISOString() },
    { role: 'buyer', text: 'still looking', created_at: new Date(now - 2 * 24 * 3600_000).toISOString() },
  ]
  const b = buildBriefing({ lead: { id: 1 }, messages }, now)
  assert.equal(b.days_since_last_contact, 2)
})

test('buildBriefing reports a null last contact when the buyer has never written', () => {
  const b = buildBriefing({ lead: { id: 1 }, messages: [{ role: 'agent', text: 'hi', created_at: new Date().toISOString() }] })
  assert.equal(b.days_since_last_contact, null)
  assert.deepEqual(b.recent_messages, [])
})

test('buildBriefing tolerates a missing lead entirely', () => {
  const b = buildBriefing({})
  assert.equal(b.lead_id, null)
  assert.equal(b.name, null)
  assert.equal(b.phone, null)
  assert.equal(b.score, null)
  assert.equal(b.temperature, null)
  assert.equal(b.site_visits, 0)
  assert.deepEqual(b.missing_bltc, ['Budget', 'Location', 'Timeline', 'Configuration'])
})

test('buildBriefing falls back to the stored score/temp when no decay is supplied', () => {
  const b = buildBriefing({ lead: { id: 2, score: 55, temp: 'Warm', wa_id: '9199' } })
  assert.equal(b.score, 55)
  assert.equal(b.temperature, 'Warm')
  assert.equal(b.phone, '9199', 'falls back to the wa_id when there is no phone')
})

test('buildBriefing prefers lead.phone over the wa_id', () => {
  const b = buildBriefing({ lead: { id: 2, phone: '+919812345678', wa_id: '919812345678' } })
  assert.equal(b.phone, '+919812345678')
})

test('buildBriefing counts only COMPLETED visits toward the gone-quiet warning', () => {
  const now = Date.now()
  const lead = { id: 3, budget_max: 1, timeline: '2 months', locality: 'Baner', bhk: '2', financing: 'loan' }
  // A visit booked for next week is not a visit that happened.
  const scheduledOnly = buildBriefing({
    lead,
    siteVisits: [{ status: 'scheduled', scheduled_at: new Date(now + 7 * 24 * 3600_000).toISOString() }],
  }, now)
  assert.equal(scheduledOnly.site_visits, 1)
  assert.ok(!texts(scheduledOnly.talking_points).some((t) => /deal dying/i.test(t)))

  const completedAndIgnored = buildBriefing({
    lead,
    siteVisits: [{ status: 'completed', scheduled_at: new Date(now - 5 * 24 * 3600_000).toISOString() }],
  }, now)
  assert.ok(texts(completedAndIgnored.talking_points).some((t) => /gone quiet/i.test(t)))
})

test('an agent message after the visit clears the gone-quiet warning', () => {
  const now = Date.now()
  const visitAt = new Date(now - 5 * 24 * 3600_000).toISOString()
  const lead = { id: 4, budget_max: 1, timeline: '2 months', locality: 'Baner', bhk: '2', financing: 'loan' }
  const siteVisits = [{ status: 'completed', scheduled_at: visitAt }]

  const followedUp = buildBriefing({
    lead, siteVisits,
    messages: [{ role: 'agent', text: 'How was it?', created_at: new Date(now - 4 * 24 * 3600_000).toISOString() }],
  }, now)
  assert.ok(!texts(followedUp.talking_points).some((t) => /gone quiet/i.test(t)))

  // An AI reply counts as follow-up too; a BUYER message does not.
  const aiFollowedUp = buildBriefing({
    lead, siteVisits,
    messages: [{ role: 'ai', text: 'How was it?', created_at: new Date(now - 4 * 24 * 3600_000).toISOString() }],
  }, now)
  assert.ok(!texts(aiFollowedUp.talking_points).some((t) => /gone quiet/i.test(t)))

  const buyerOnly = buildBriefing({
    lead, siteVisits,
    messages: [{ role: 'buyer', text: 'nice place', created_at: new Date(now - 4 * 24 * 3600_000).toISOString() }],
  }, now)
  assert.ok(texts(buyerOnly.talking_points).some((t) => /gone quiet/i.test(t)))
})

test('the most recent completed visit is the one that counts', () => {
  const now = Date.now()
  const lead = { id: 5, budget_max: 1, timeline: '2 months', locality: 'Baner', bhk: '2', financing: 'loan' }
  const b = buildBriefing({
    lead,
    siteVisits: [
      { status: 'completed', scheduled_at: new Date(now - 30 * 24 * 3600_000).toISOString() },
      { status: 'completed', scheduled_at: new Date(now - 3600_000).toISOString() }, // an hour ago
    ],
  }, now)
  // Latest visit was an hour ago — nobody has "gone quiet" yet.
  assert.ok(!texts(b.talking_points).some((t) => /gone quiet/i.test(t)))
})

test('a closed or expiry-less service window produces no urgent window line', () => {
  const now = Date.now()
  const lead = { id: 6, budget_max: 1, timeline: '2 months', locality: 'Baner', bhk: '2', financing: 'loan' }
  for (const serviceWindow of [null, { open: false, expires_at: new Date(now + 3600_000).toISOString() }, { open: true, expires_at: null }]) {
    const b = buildBriefing({ lead, serviceWindow }, now)
    assert.ok(!texts(b.talking_points).some((t) => /window closes/i.test(t)), JSON.stringify(serviceWindow))
  }
})

test('an already-expired window clamps to 1h rather than going negative', () => {
  const now = Date.now()
  const b = buildBriefing({
    lead: { id: 7 },
    serviceWindow: { open: true, expires_at: new Date(now - 3600_000).toISOString() },
  }, now)
  assert.match(texts(b.talking_points).find((t) => /window closes/i.test(t)), /~1h/)
})

test('talking points: a buyer who has written but never opened a page', () => {
  const points = talkingPoints(
    { budget_max: 1, timeline: '2 months', locality: 'Baner', bhk: '2', financing: 'loan' },
    { buyerReplied: true, pageViewCount: 0 },
  )
  assert.ok(texts(points).some((t) => /reference the last conversation/i.test(t)))
})

test('talking points: a totally unqualified lead gets the cold opener line', () => {
  const points = talkingPoints({ financing: 'loan' }, {})
  assert.ok(texts(points).some((t) => /Cold — nothing qualified yet/.test(t)))
  assert.ok(!texts(points).some((t) => /Still missing/.test(t)), 'the two lines are mutually exclusive')
})

test('talking points: a fully qualified lead gets neither missing-BLTC line', () => {
  const points = talkingPoints(
    { budget_max: 1, timeline: '2 months', locality: 'Baner', bhk: '2', financing: 'loan' },
    { buyerReplied: true, pageViewCount: 2 },
  )
  assert.ok(!texts(points).some((t) => /Still missing|nothing qualified/.test(t)))
})

test('talking points: an undecided-financing lead is flagged either way it is stored', () => {
  for (const financing of [undefined, null, 'undecided']) {
    const points = talkingPoints({ budget_max: 1, timeline: 'x', locality: 'y', bhk: '2', financing }, {})
    assert.ok(texts(points).some((t) => /Loan is unresolved/.test(t)), String(financing))
  }
  const decided = talkingPoints({ budget_max: 1, timeline: 'x', locality: 'y', bhk: '2', financing: 'cash' }, {})
  assert.ok(!texts(decided).some((t) => /Loan is unresolved/.test(t)))
})

test('repeat viewing and view-then-silence are mutually exclusive lines', () => {
  const lead = { budget_max: 1, timeline: 'x', locality: 'y', bhk: '2', financing: 'loan' }
  const repeat = texts(talkingPoints(lead, { repeatViewedProperty: true, pageViewCount: 5, buyerReplied: false }))
  assert.ok(repeat.some((t) => /keep re-opening/i.test(t)))
  assert.ok(!repeat.some((t) => /went quiet/i.test(t)))
})
