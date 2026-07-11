// Rules + LLM hybrid lead scoring. Pure functions over (lead, signals, now) — the
// hard qualification rule ("budget + near timeline + 2+ replies + visit -> Hot")
// combined with the LLM band and the engagement decay, with an explainable reason.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { hybridScore, ruleSignals, parseTimelineMonths } = await import('../scoring.js')

const HOUR = 3600_000

// --- parseTimelineMonths -----------------------------------------------------

test('parseTimelineMonths reads English and Hinglish timelines', () => {
  assert.equal(parseTimelineMonths('2 months'), 2)
  assert.equal(parseTimelineMonths('2 mahine me shift'), 2)
  assert.equal(parseTimelineMonths('next month'), 1)
  assert.equal(parseTimelineMonths('agle mahine'), 1)
  assert.equal(parseTimelineMonths('3-4 months'), 4) // upper bound of a range
  assert.equal(parseTimelineMonths('1 saal'), 12)
  assert.equal(parseTimelineMonths('2 weeks'), 0.5)
})

test('parseTimelineMonths treats urgency words as 0 months', () => {
  for (const t of ['ASAP', 'urgent', 'immediately', 'turant', 'abhi chahiye'])
    assert.equal(parseTimelineMonths(t), 0, t)
})

test('parseTimelineMonths returns null for the unknown / unparseable', () => {
  assert.equal(parseTimelineMonths(null), null)
  assert.equal(parseTimelineMonths(''), null)
  assert.equal(parseTimelineMonths('sometime'), null)
  assert.equal(parseTimelineMonths('80'), null) // a bare number is not a timeline
})

// --- ruleSignals -------------------------------------------------------------

test('ruleSignals fires Hot only when ALL four conditions hold', () => {
  const lead = { budget_max_l: 80, timeline: '2 months' }
  const full = ruleSignals(lead, { buyerReplies: 3, visitAgreed: true })
  assert.equal(full.hotRule, true)
  assert.equal(full.budgetStated, true)
  assert.equal(full.timelineSoon, true)
  assert.equal(full.engaged, true)
  assert.equal(full.visitAgreed, true)
})

test('ruleSignals does NOT fire without a visit', () => {
  const r = ruleSignals({ budget_max_l: 80, timeline: '2 months' }, { buyerReplies: 3, visitAgreed: false })
  assert.equal(r.hotRule, false)
})

test('ruleSignals does NOT fire when the timeline is too far out', () => {
  const r = ruleSignals({ budget_max_l: 80, timeline: '8 months' }, { buyerReplies: 3, visitAgreed: true })
  assert.equal(r.timelineSoon, false)
  assert.equal(r.hotRule, false)
})

test('ruleSignals does NOT fire with a single reply', () => {
  const r = ruleSignals({ budget_max_l: 80, timeline: '1 month' }, { buyerReplies: 1, visitAgreed: true })
  assert.equal(r.engaged, false)
  assert.equal(r.hotRule, false)
})

// --- hybridScore precedence --------------------------------------------------

test('the hard rule promotes a lead to Hot even when the LLM said Warm', () => {
  const lead = { budget_max_l: 80, timeline: '2 months', ai_score: 'warm' }
  const signals = { buyerReplies: 3, visitAgreed: true, lastBuyerAt: Date.now() - HOUR, siteVisits: [Date.now()] }
  const h = hybridScore(lead, signals, Date.now())
  assert.equal(h.temperature, 'Hot')
  assert.equal(h.source, 'rule')
  assert.match(h.reason, /Hot by rule/)
  assert.match(h.reason, /visit agreed/)
})

test('with no rule fired, the hotter of LLM band and engagement wins', () => {
  // LLM says Hot, but the lead has gone quiet (weak engagement). LLM should lift it.
  const lead = { ai_score: 'hot', budget_max_l: 90 }
  const cold = { buyerReplies: 1, visitAgreed: false, lastBuyerAt: Date.now() - 72 * HOUR }
  const h = hybridScore(lead, cold, Date.now())
  assert.equal(h.temperature, 'Hot')
  assert.equal(h.source, 'llm')
})

test('a genuinely cold, unqualified lead stays Cold with an explainable reason', () => {
  const lead = { intent: 'browse' }
  const h = hybridScore(lead, { buyerReplies: 1, visitAgreed: false }, Date.now())
  assert.equal(h.temperature, 'Cold')
  assert.match(h.reason, /Cold by/)
  assert.equal(typeof h.score, 'number')
})

test('hybridScore always returns the decay breakdown for auditability', () => {
  const h = hybridScore({ budget_max_l: 50 }, { buyerReplies: 2, lastBuyerAt: Date.now() }, Date.now())
  assert.ok(h.decay)
  assert.ok('effectiveScore' in h.decay)
  assert.ok('factors' in h.decay)
})
