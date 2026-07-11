// scoring.js — recency decay + engagement velocity.
//
// Ported from Landline's services/scoring.py and re-pointed at HomeNex's WhatsApp
// signals. Pure functions: no DB, no AI, no clock except the `now` you pass in —
// so they are fast, deterministic, and unit-testable in isolation.
//
// The problem this solves: HomeNex's leads.score / ai_score are set by the LLM at
// extraction time and then never change. A lead scored Hot at 11pm Tuesday is still
// Hot on Friday having said nothing since. That silently poisons any queue or
// briefing built on the score. Here scoring is split in two:
//
//   * FIT (slow): BLTC completeness, intent, financing clarity. What the AI judged.
//   * ENGAGEMENT (fast, decaying): how recent and how clustered the buyer's activity
//     is right now — last message, micro-page views, site visits.
//
// The EFFECTIVE score is fit decayed by engagement recency, plus a velocity bonus.
// A buyer deciding right now stays Hot; one who has gone quiet cools to Cold over
// roughly a day, which is what makes every downstream ranking honest.

const MINUTE = 60_000
const DAY_MS = 24 * 3600_000

const clamp100 = (n) => Math.max(0, Math.min(100, Math.round(n)))
const round2 = (n) => Math.round(n * 100) / 100
const round1 = (n) => Math.round(n * 10) / 10

// How much a single signal counts, given how long ago it happened. A step function:
// "a micro-page opened 30 minutes ago is worth 20× one from two days ago." Returns
// 0 for a missing/unknown age (no signal at all).
export function signalRecencyWeight(ageMs) {
  if (ageMs == null || Number.isNaN(ageMs) || ageMs < 0) return 0
  const min = ageMs / MINUTE
  if (min <= 30) return 1.0
  if (min <= 60) return 0.85
  if (min <= 120) return 0.7
  if (min <= 240) return 0.5
  if (min <= 480) return 0.3
  if (min <= 1440) return 0.15 // ≤ 24h
  if (min <= 2880) return 0.05 // ≤ 48h
  return 0.02
}

// Clustered activity in the last 24h means the buyer is in the middle of deciding.
// Counts distinct engagement events in the window and awards a clustering bonus.
export function engagementVelocity(eventTimes, now = Date.now()) {
  const n = (eventTimes || []).filter((t) => {
    if (t == null) return false
    const ms = new Date(t).getTime()
    return !Number.isNaN(ms) && now - ms <= DAY_MS && now - ms >= 0
  }).length
  if (n >= 4) return 0.3
  if (n === 3) return 0.2
  if (n === 2) return 0.1
  return 0
}

// The slow-moving fit component. Prefer the AI's 0-100 score when it set one;
// otherwise derive a fit from BLTC completeness + intent + financing clarity, so a
// lead the AI hasn't scored yet still ranks sensibly.
export function fitScoreFor(lead = {}) {
  if (lead.score != null && Number(lead.score) > 0) return clamp100(Number(lead.score))

  let s = 0
  const hasBudget = lead.budget_max != null || lead.budget_max_l != null
  const hasLocality =
    Boolean(lead.locality) ||
    (Array.isArray(lead.preferred_localities) && lead.preferred_localities.length > 0)
  const hasTimeline = Boolean(lead.timeline)
  const hasConfig = Boolean(lead.config) || Boolean(lead.bhk)
  for (const known of [hasBudget, hasLocality, hasTimeline, hasConfig]) if (known) s += 15 // BLTC

  const intentBonus = { buy: 20, invest: 15, sell: 12, rent: 10, browse: 3 }
  if (lead.intent) s += intentBonus[lead.intent] ?? 0
  if (lead.financing === 'cash' || lead.financing === 'loan') s += 10 // clarity, either way

  // Fall back to the categorical band if literally nothing else is known.
  if (s === 0 && lead.ai_score) s = { hot: 70, warm: 45, cold: 20 }[lead.ai_score] ?? 0
  return clamp100(s)
}

// Compute the decayed scoring for a lead from its raw engagement signals.
//
//   signals.lastBuyerAt  — timestamp of the lead's most recent inbound message
//   signals.pageViews    — array of micro-page view timestamps attributed to the lead
//   signals.siteVisits   — array of site-visit timestamps (scheduled/completed)
//
// Returns { fitScore, engagementScore, effectiveScore, temperature, factors }.
export function decayLead(lead = {}, signals = {}, now = Date.now()) {
  const events = []
  const push = (t) => {
    if (t == null) return
    const ms = new Date(t).getTime()
    if (!Number.isNaN(ms)) events.push(ms)
  }
  push(signals.lastBuyerAt ?? lead.last_inbound_at)
  for (const t of signals.pageViews || []) push(t)
  for (const t of signals.siteVisits || []) push(t)

  const mostRecent = events.length ? Math.max(...events) : null
  const recency = mostRecent == null ? 0 : signalRecencyWeight(now - mostRecent)
  const velocity = engagementVelocity(events, now)
  const fitScore = fitScoreFor(lead)

  // Engagement is purely "how live is this lead right now" — recency + clustering.
  const engagementScore = clamp100(100 * recency + 100 * velocity)

  // Effective = fit decayed by recency (floor 0.3 so a strong lead never fully
  // vanishes) plus the velocity bonus for a buyer actively clicking around.
  const effectiveScore = clamp100(fitScore * (0.3 + 0.7 * recency) + 100 * velocity)

  const temperature = effectiveScore >= 65 ? 'Hot' : effectiveScore >= 35 ? 'Warm' : 'Cold'

  const factors = {
    fit: fitScore,
    recency: round2(recency),
    velocity: round2(velocity),
    engagement: engagementScore,
    page_views: (signals.pageViews || []).length,
    last_signal_age_h: mostRecent == null ? null : round1((now - mostRecent) / 3600_000),
  }
  return { fitScore, engagementScore, effectiveScore, temperature, factors }
}

// --- Rules + LLM hybrid temperature -----------------------------------------
//
// The decay model above is engagement-driven. The product also wants a hard,
// explainable RULE that promotes a lead to Hot on classic qualification signals,
// independent of how recently they clicked:
//
//   Budget stated + timeline < 3 months + replied >= 2x + visit agreed -> Hot
//
// Rules and the LLM/decay signal are combined so neither alone can hide a Hot lead:
// a lead the rule fires on is Hot even if the AI scored it Warm, and vice-versa.

// Parse a free-text timeline ("2 months", "2 mahine", "next month", "ASAP",
// "3-4 months", "6 mahine me") into an approximate number of months, or null.
export function parseTimelineMonths(timeline) {
  if (timeline == null) return null
  const t = String(timeline).toLowerCase().trim()
  if (!t) return null
  if (/(asap|urgent|immediate|immediately|turant|abhi|right away|this month|is mahine)/.test(t)) return 0
  if (/(next month|agle mahine|agle mahina)/.test(t)) return 1
  // "week(s)" -> fraction of a month.
  const week = t.match(/(\d+(?:\.\d+)?)\s*(weeks?|hafte|haftaa?|hafta)/)
  if (week) return Math.round((Number(week[1]) / 4.345) * 10) / 10
  // "N months / mahine" — take the upper bound of a range like "3-4 months".
  const nums = [...t.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])).filter((n) => Number.isFinite(n))
  if (/(month|mahine|mahina|maah|mah)/.test(t) && nums.length) return Math.max(...nums)
  if (/(year|saal|varsh|varsha)/.test(t) && nums.length) return Math.max(...nums) * 12
  // Bare number with no unit but a "month-ish" context is ambiguous — don't guess.
  return null
}

// Was a budget stated on this lead, in any of the columns we might have filled?
const hasBudget = (lead = {}) =>
  lead.budget_max != null || lead.budget_min != null || lead.budget_max_l != null || lead.budget_min_l != null

// Evaluate the hard qualification rule. Returns the individual signals plus whether
// the Hot rule fired, so callers can show the buyer exactly why they're Hot.
export function ruleSignals(lead = {}, signals = {}) {
  const timelineMonths = parseTimelineMonths(lead.timeline)
  const budgetStated = hasBudget(lead)
  const timelineSoon = timelineMonths != null && timelineMonths < 3
  const engaged = (signals.buyerReplies ?? 0) >= 2
  const visitAgreed = Boolean(signals.visitAgreed)
  const hotRule = budgetStated && timelineSoon && engaged && visitAgreed
  return { budgetStated, timelineMonths, timelineSoon, engaged, visitAgreed, hotRule }
}

// Combine the hard rule, the LLM fit, and the engagement decay into one verdict.
// Returns { temperature, score, reason, source, rules, decay }.
export function hybridScore(lead = {}, signals = {}, now = Date.now()) {
  const decay = decayLead(lead, signals, now)
  const rules = ruleSignals(lead, signals)

  // Order of precedence: a fired hard rule wins (Hot); otherwise take the hotter of
  // the LLM band and the decayed engagement temperature so a strong lead that has
  // gone briefly quiet isn't prematurely written off.
  const rank = { Hot: 3, Warm: 2, Cold: 1 }
  const llmTemp = { hot: 'Hot', warm: 'Warm', cold: 'Cold' }[lead.ai_score] || null

  let temperature = decay.temperature
  let source = 'engagement'
  if (llmTemp && rank[llmTemp] > rank[temperature]) {
    temperature = llmTemp
    source = 'llm'
  }
  if (rules.hotRule) {
    temperature = 'Hot'
    source = 'rule'
  }

  const reason = buildReason(temperature, source, rules, lead, decay)
  return { temperature, score: decay.effectiveScore, reason, source, rules, decay }
}

function buildReason(temperature, source, rules, lead, decay) {
  if (source === 'rule') {
    const t = rules.timelineMonths
    return `Hot by rule: budget stated, timeline ${t === 0 ? 'immediate' : `~${t} month(s)`} (<3), replied 2+ times, and site visit agreed.`
  }
  const bits = []
  if (rules.budgetStated) bits.push('budget stated')
  if (rules.timelineSoon) bits.push('near-term timeline')
  if (rules.engaged) bits.push('actively replying')
  if (rules.visitAgreed) bits.push('visit agreed')
  const engagementNote =
    decay.factors.last_signal_age_h == null
      ? 'no recent activity'
      : `last active ${decay.factors.last_signal_age_h}h ago`
  const lead_in = source === 'llm' ? 'AI assessment' : 'engagement'
  return `${temperature} by ${lead_in}: ${bits.length ? bits.join(', ') + '; ' : ''}${engagementNote} (effective score ${decay.effectiveScore}).`
}
