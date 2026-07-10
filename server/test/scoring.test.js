// Pure unit tests for the score-decay engine (no DB, no AI).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { signalRecencyWeight, engagementVelocity, fitScoreFor, decayLead } from '../scoring.js'

const MIN = 60_000
const HOUR = 60 * MIN

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
