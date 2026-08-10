// Pure unit tests for the score-decay engine (no DB, no AI).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { signalRecencyWeight, engagementVelocity, fitScoreFor, decayLead, upcomingVisitWeight } from '../scoring.js'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

test('signalRecencyWeight is a decreasing step function', () => {
  assert.equal(signalRecencyWeight(0), 1.0)
  assert.equal(signalRecencyWeight(20 * MIN), 1.0)
  assert.equal(signalRecencyWeight(45 * MIN), 0.85)
  assert.equal(signalRecencyWeight(90 * MIN), 0.7)
  assert.equal(signalRecencyWeight(3 * HOUR), 0.5)
  assert.equal(signalRecencyWeight(6 * HOUR), 0.3)
  assert.equal(signalRecencyWeight(20 * HOUR), 0.15)
  assert.equal(signalRecencyWeight(36 * HOUR), 0.05)
  assert.equal(signalRecencyWeight(5 * 24 * HOUR), 0.02)
})

test('signalRecencyWeight returns 0 for missing / invalid ages', () => {
  assert.equal(signalRecencyWeight(null), 0)
  assert.equal(signalRecencyWeight(undefined), 0)
  assert.equal(signalRecencyWeight(NaN), 0)
  assert.equal(signalRecencyWeight(-100), 0)
})

test('a fresh signal is worth ~20x a two-day-old one (the whole point)', () => {
  assert.equal(signalRecencyWeight(10 * MIN) / signalRecencyWeight(47 * HOUR), 20)
})

test('engagementVelocity rewards clustering inside 24h only', () => {
  const now = Date.now()
  const ago = (h) => now - h * HOUR
  assert.equal(engagementVelocity([], now), 0)
  assert.equal(engagementVelocity([ago(1)], now), 0)
  assert.equal(engagementVelocity([ago(1), ago(2)], now), 0.1)
  assert.equal(engagementVelocity([ago(1), ago(2), ago(3)], now), 0.2)
  assert.equal(engagementVelocity([ago(1), ago(2), ago(3), ago(4)], now), 0.3)
  // Events older than 24h don't count toward velocity.
  assert.equal(engagementVelocity([ago(1), ago(30), ago(40)], now), 0)
})

test('fitScoreFor prefers the AI score when present', () => {
  assert.equal(fitScoreFor({ score: 82 }), 82)
  assert.equal(fitScoreFor({ score: 140 }), 100) // clamped
})

test('fitScoreFor derives from BLTC + intent + financing when unscored', () => {
  const cold = fitScoreFor({})
  assert.equal(cold, 0)
  const full = fitScoreFor({
    budget_max: 8_000_000_00, locality: 'Wakad', timeline: '3 months', bhk: '2',
    intent: 'buy', financing: 'loan',
  })
  // 4 BLTC * 15 = 60, + buy 20 + financing 10 = 90
  assert.equal(full, 90)
  // Category band is the last-resort fallback.
  assert.equal(fitScoreFor({ ai_score: 'hot' }), 70)
})

test('decayLead: an engaged-right-now lead stays Hot', () => {
  const now = Date.now()
  const r = decayLead({ score: 80 }, { lastBuyerAt: new Date(now - 5 * MIN).toISOString() }, now)
  assert.equal(r.fitScore, 80)
  assert.equal(r.temperature, 'Hot')
  assert.ok(r.effectiveScore >= 80)
})

test('decayLead: a strong lead gone silent cools down over time', () => {
  const now = Date.now()
  const lead = { score: 80 }
  const fresh = decayLead(lead, { lastBuyerAt: new Date(now - 10 * MIN).toISOString() }, now)
  const twoHours = decayLead(lead, { lastBuyerAt: new Date(now - 2 * HOUR).toISOString() }, now)
  const oneDay = decayLead(lead, { lastBuyerAt: new Date(now - 25 * HOUR).toISOString() }, now)
  const oneWeek = decayLead(lead, { lastBuyerAt: new Date(now - 7 * 24 * HOUR).toISOString() }, now)

  assert.equal(fresh.temperature, 'Hot')
  assert.ok(twoHours.effectiveScore < fresh.effectiveScore, 'cools within hours')
  assert.ok(oneDay.effectiveScore < twoHours.effectiveScore, 'keeps cooling')
  assert.ok(oneWeek.temperature === 'Cold', 'a week of silence is Cold')
  assert.ok(oneWeek.effectiveScore < oneDay.effectiveScore)
})

test('decayLead: clustered micro-page views spike engagement', () => {
  const now = Date.now()
  const views = [1, 2, 3, 4].map((h) => new Date(now - h * HOUR).toISOString())
  const quiet = decayLead({ score: 30 }, {}, now)
  const clicking = decayLead({ score: 30 }, { pageViews: views }, now)
  assert.ok(clicking.effectiveScore > quiet.effectiveScore)
  assert.equal(clicking.factors.page_views, 4)
  assert.ok(clicking.factors.velocity > 0)
})

test('decayLead: no signal at all yields Cold with zero engagement', () => {
  const r = decayLead({ score: 90 }, {}, Date.now())
  assert.equal(r.engagementScore, 0)
  assert.equal(r.temperature, 'Cold')
  assert.equal(r.factors.last_signal_age_h, null)
})

test('decayLead output is explainable (factors breakdown)', () => {
  const now = Date.now()
  const r = decayLead({ score: 70 }, { lastBuyerAt: new Date(now - 90 * MIN).toISOString() }, now)
  assert.equal(r.factors.fit, 70)
  assert.equal(r.factors.recency, 0.7)
  assert.ok('engagement' in r.factors && 'velocity' in r.factors)
})

// --- Upcoming site visits ----------------------------------------------------
//
// Regression suite for the bug where booking a site visit COOLED the lead: the
// visit's scheduled_at sits in the future, so `now - scheduled_at` was negative,
// signalRecencyWeight returned 0, and a Hot lead's effective score collapsed to
// fit * 0.3. Booking a visit must only ever help.

test('upcomingVisitWeight is a decreasing step function of time-until-visit', () => {
  assert.equal(upcomingVisitWeight(1 * HOUR), 1.0)
  assert.equal(upcomingVisitWeight(24 * HOUR), 1.0)
  assert.equal(upcomingVisitWeight(48 * HOUR), 0.8)
  assert.equal(upcomingVisitWeight(72 * HOUR), 0.8)
  assert.equal(upcomingVisitWeight(5 * DAY), 0.6)
  assert.equal(upcomingVisitWeight(10 * DAY), 0.4)
  assert.equal(upcomingVisitWeight(30 * DAY), 0.25)
})

test('upcomingVisitWeight is 0 for a past, missing or invalid visit', () => {
  assert.equal(upcomingVisitWeight(0), 0) // happening right now = past activity, not a commitment
  assert.equal(upcomingVisitWeight(-HOUR), 0)
  assert.equal(upcomingVisitWeight(null), 0)
  assert.equal(upcomingVisitWeight(undefined), 0)
  assert.equal(upcomingVisitWeight(NaN), 0)
})

test('REGRESSION: booking a site visit does not flip a Hot lead to Cold', () => {
  const now = Date.now()
  const lead = { score: 90 }
  const signals = { lastBuyerAt: new Date(now - 10 * MIN).toISOString() }

  const beforeBooking = decayLead(lead, signals, now)
  const afterBooking = decayLead(lead, { ...signals, siteVisits: [new Date(now + 2 * DAY).toISOString()] }, now)

  assert.equal(beforeBooking.temperature, 'Hot')
  assert.equal(afterBooking.temperature, 'Hot', 'booking a visit must not cool the lead')
  assert.ok(
    afterBooking.effectiveScore >= beforeBooking.effectiveScore,
    `booking dropped the score ${beforeBooking.effectiveScore} -> ${afterBooking.effectiveScore}`,
  )
  // The old bug reported a negative "age" for the future visit.
  assert.ok(afterBooking.factors.last_signal_age_h >= 0)
  assert.equal(afterBooking.factors.next_visit_in_h, 48)
})

test('a future site visit never reduces recency, at any distance out', () => {
  const now = Date.now()
  const lead = { score: 75 }
  const signals = { lastBuyerAt: new Date(now - 45 * MIN).toISOString() }
  const base = decayLead(lead, signals, now)
  for (const days of [0.5, 1, 3, 7, 14, 60, 365]) {
    const withVisit = decayLead(lead, { ...signals, siteVisits: [new Date(now + days * DAY).toISOString()] }, now)
    assert.equal(withVisit.factors.recency, base.factors.recency, `recency changed for a visit ${days}d out`)
    assert.ok(withVisit.effectiveScore >= base.effectiveScore, `score dropped for a visit ${days}d out`)
  }
})

test('a quiet lead with a visit booked tomorrow stays live instead of decaying to Cold', () => {
  const now = Date.now()
  const lead = { score: 80 }
  const silentFor3Days = { lastBuyerAt: new Date(now - 3 * DAY).toISOString() }

  const noVisit = decayLead(lead, silentFor3Days, now)
  const visitTomorrow = decayLead(lead, { ...silentFor3Days, siteVisits: [new Date(now + 20 * HOUR).toISOString()] }, now)

  assert.equal(noVisit.temperature, 'Cold')
  assert.equal(visitTomorrow.temperature, 'Hot')
  assert.equal(visitTomorrow.factors.commitment, 1)
  assert.equal(visitTomorrow.factors.recency, 0.02, 'the stale message is still stale')
})

test('the nearest upcoming visit drives commitment when several are booked', () => {
  const now = Date.now()
  const visits = [now + 10 * DAY, now + 2 * DAY, now + 30 * DAY].map((t) => new Date(t).toISOString())
  const r = decayLead({ score: 60 }, { siteVisits: visits }, now)
  assert.equal(r.factors.commitment, 0.8) // 2 days out, not 10 or 30
  assert.equal(r.factors.next_visit_in_h, 48)
})

test('a visit that has already happened decays like any other activity', () => {
  const now = Date.now()
  const past = decayLead({ score: 80 }, { siteVisits: [new Date(now - 20 * MIN).toISOString()] }, now)
  assert.equal(past.factors.commitment, 0, 'a completed visit is not a forward commitment')
  assert.equal(past.factors.recency, 1)
  assert.equal(past.factors.next_visit_in_h, null)
  assert.equal(past.factors.last_signal_age_h, 0.3)
  assert.equal(past.temperature, 'Hot')

  const longAgo = decayLead({ score: 80 }, { siteVisits: [new Date(now - 5 * DAY).toISOString()] }, now)
  assert.equal(longAgo.factors.recency, 0.02)
  assert.equal(longAgo.temperature, 'Cold')
})

test('a booked visit alone (no messages, no views) makes a lead live', () => {
  const now = Date.now()
  const r = decayLead({ score: 70 }, { siteVisits: [new Date(now + 6 * HOUR).toISOString()] }, now)
  assert.equal(r.factors.last_signal_age_h, null, 'no past activity to age')
  assert.equal(r.factors.recency, 0)
  assert.equal(r.factors.commitment, 1)
  assert.equal(r.effectiveScore, 70)
  assert.equal(r.temperature, 'Hot')
})

test('an upcoming visit does not count toward the 24h clustering velocity', () => {
  const now = Date.now()
  const twoRecentViews = [1, 2].map((h) => new Date(now - h * HOUR).toISOString())
  const withVisit = decayLead(
    { score: 50 },
    { pageViews: twoRecentViews, siteVisits: [new Date(now + 3 * HOUR).toISOString()] },
    now,
  )
  // Velocity counts activity that HAPPENED: the two views, not the pending visit.
  assert.equal(withVisit.factors.velocity, 0.1)
})

test('a slightly future-dated message is treated as clock skew, not as bad data', () => {
  const now = Date.now()
  const skewed = decayLead({ score: 80 }, { lastBuyerAt: new Date(now + 30_000).toISOString() }, now)
  assert.equal(skewed.factors.recency, 1)
  assert.equal(skewed.factors.last_signal_age_h, 0)
  assert.equal(skewed.temperature, 'Hot')
})

test('an implausibly future-dated message is ignored rather than zeroing recency', () => {
  const now = Date.now()
  const realActivity = new Date(now - 20 * MIN).toISOString()
  const r = decayLead(
    { score: 80 },
    { lastBuyerAt: new Date(now + 365 * DAY).toISOString(), pageViews: [realActivity] },
    now,
  )
  assert.equal(r.factors.recency, 1, 'the real page view still counts')
  assert.equal(r.temperature, 'Hot')
})

test('decayLead ignores unparseable timestamps in every signal', () => {
  const now = Date.now()
  const r = decayLead(
    { score: 90 },
    { lastBuyerAt: 'not-a-date', pageViews: ['nope', null], siteVisits: ['garbage', undefined] },
    now,
  )
  assert.equal(r.factors.recency, 0)
  assert.equal(r.factors.commitment, 0)
  assert.equal(r.factors.last_signal_age_h, null)
  assert.equal(r.factors.next_visit_in_h, null)
  assert.equal(r.temperature, 'Cold')
})

test('decayLead falls back to lead.last_inbound_at when no explicit signal is given', () => {
  const now = Date.now()
  const r = decayLead({ score: 80, last_inbound_at: new Date(now - 15 * MIN).toISOString() }, {}, now)
  assert.equal(r.factors.recency, 1)
  assert.equal(r.temperature, 'Hot')
})
