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
