// briefing.js — the pre-contact briefing ("Before you call" panel).
//
// Ported from Landline's services/call_briefing.py. The valuable, non-obvious part
// is talking_points: rule-based, not AI, therefore instant, free, and — crucially —
// it makes the AI's score auditable. The agent sees *why* a lead is Hot, in one line
// they'd actually say out loud, not a black-box label.
//
// Pure functions over data HomeNex already stores. No DB, no LLM.

const HOUR_MS = 3600_000
const DAY_MS = 24 * HOUR_MS

// Which BLTC pieces are still unknown — what the agent should ask for on the call.
export function missingBLTC(lead = {}) {
  const missing = []
  if (lead.budget_max == null && lead.budget_max_l == null) missing.push('Budget')
  if (!lead.locality && !(Array.isArray(lead.preferred_localities) && lead.preferred_localities.length))
    missing.push('Location')
  if (!lead.timeline) missing.push('Timeline')
  if (!lead.config && !lead.bhk) missing.push('Configuration')
  return missing
}

// The heart of it. Rule-based lines translated almost verbatim from Landline's
// talking-point ladder into Indian real-estate phrasing. `ctx` carries the derived
// signals; every branch is cheap and explainable. Ordered most to least urgent.
export function talkingPoints(lead = {}, ctx = {}) {
  const points = []
  const {
    serviceWindowClosingH = null, // hours left in the 24h window, if closing soon
    buyerReplied = false, // has the buyer ever sent a message
    pageViewCount = 0, // micro-page opens attributed to this lead
    repeatViewedProperty = false, // opened the same property 3+ times
    siteVisitCompleted = false,
    daysSinceLastContact = null,
    daysSinceSiteVisit = null,
    followupSinceVisit = false,
  } = ctx

  if (serviceWindowClosingH != null && serviceWindowClosingH <= 4) {
    points.push({
      tone: 'urgent',
      text: `The free-reply window closes in ~${Math.max(1, Math.round(serviceWindowClosingH))}h. Message or call now, or you're locked into an approved template.`,
    })
  }

  if (repeatViewedProperty) {
    points.push({
      tone: 'hot',
      text: 'They keep re-opening this flat. Ask what’s holding them back — price, floor, or possession date.',
    })
  } else if (pageViewCount >= 1 && !buyerReplied) {
    points.push({
      tone: 'warm',
      text: 'They looked at the page and went quiet. Don’t re-pitch — ask one question.',
    })
  }

  if (siteVisitCompleted && daysSinceSiteVisit != null && daysSinceSiteVisit >= 3 && !followupSinceVisit) {
    points.push({
      tone: 'urgent',
      text: 'They visited and you’ve gone quiet. That’s the deal dying. Call today.',
    })
  }

  const budgetKnown = lead.budget_max != null || lead.budget_max_l != null
  if (budgetKnown && !lead.timeline) {
    points.push({
      tone: 'warm',
      text: 'You know the budget. Get the timeline: “When do you want to be holding the keys?”',
    })
  }

  if (lead.financing === 'undecided' || lead.financing == null) {
    points.push({
      tone: 'warm',
      text: 'Loan is unresolved. Offer the EMI number before they ask.',
    })
  }

  if (buyerReplied && pageViewCount === 0) {
    points.push({
      tone: 'warm',
      text: 'They’ve messaged before — reference the last conversation, don’t start cold.',
    })
  }

  const missing = missingBLTC(lead)
  if (missing.length && missing.length < 4) {
    points.push({ tone: 'info', text: `Still missing: ${missing.join(', ')}. Fill the biggest gap first.` })
  } else if (missing.length === 4) {
    points.push({ tone: 'info', text: 'Cold — nothing qualified yet. Open with a question, not a pitch.' })
  }

  return points
}

// Assemble the whole briefing object the UI renders. `data` is already-fetched rows.
export function buildBriefing({ lead, messages = [], siteVisits = [], pageViews = [], serviceWindow = null, decay = null }, now = Date.now()) {
  const buyerMsgs = messages.filter((m) => m.role === 'buyer')
  const lastInbound = lead?.last_inbound_at ? new Date(lead.last_inbound_at).getTime() : (buyerMsgs.length ? new Date(buyerMsgs[buyerMsgs.length - 1].created_at).getTime() : null)
  const daysSinceLastContact = lastInbound == null ? null : Math.floor((now - lastInbound) / DAY_MS)

  // Repeat interest: 3+ views of any single property is Landline's "opened it 3× → hot".
  const viewsByProp = {}
  for (const v of pageViews) viewsByProp[v.property_id] = (viewsByProp[v.property_id] || 0) + 1
  const repeatViewedProperty = Object.values(viewsByProp).some((n) => n >= 3)

  const completedVisits = siteVisits.filter((v) => v.status === 'completed')
  const lastVisit = completedVisits.length
    ? Math.max(...completedVisits.map((v) => new Date(v.scheduled_at).getTime()))
    : null
  const daysSinceSiteVisit = lastVisit == null ? null : Math.floor((now - lastVisit) / DAY_MS)
  // A message from the agent after the visit means they haven't gone quiet.
  const followupSinceVisit = lastVisit != null && messages.some(
    (m) => (m.role === 'agent' || m.role === 'ai') && new Date(m.created_at).getTime() > lastVisit,
  )

  const serviceWindowClosingH =
    serviceWindow?.open && serviceWindow.expires_at
      ? Math.max(0, (new Date(serviceWindow.expires_at).getTime() - now) / HOUR_MS)
      : null

  const points = talkingPoints(lead, {
    serviceWindowClosingH,
    buyerReplied: buyerMsgs.length > 0,
    pageViewCount: pageViews.length,
    repeatViewedProperty,
    siteVisitCompleted: completedVisits.length > 0,
    daysSinceLastContact,
    daysSinceSiteVisit,
    followupSinceVisit,
  })

  return {
    lead_id: lead?.id ?? null,
    name: lead?.name ?? null,
    phone: lead?.phone || lead?.wa_id || null,
    score: decay?.effectiveScore ?? lead?.score ?? null,
    temperature: decay?.temperature ?? lead?.temp ?? null,
    score_reason: lead?.ai_score_reason ?? null,
    days_since_last_contact: daysSinceLastContact,
    service_window: serviceWindow,
    missing_bltc: missingBLTC(lead),
    page_view_count: pageViews.length,
    repeat_viewed_property: repeatViewedProperty,
    recent_messages: buyerMsgs.slice(-3).map((m) => ({ text: m.text, at: m.created_at })),
    site_visits: siteVisits.length,
    talking_points: points,
  }
}
