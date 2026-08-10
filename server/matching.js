// matching.js — pure, explainable "Quick Match" scoring: which of an agent's
// available inventory fits a given buyer lead. Ported out of db.js's inline SQL
// (propertyMatchesForLead) so the ranking is unit-testable and the UI can show
// *why* each property matched, not just an opaque score — and so locality
// comparison no longer relies on a hand-built ILIKE wildcard (a locality
// containing a literal % or _ used to silently broaden the match).
//
// Budget/BHK/property-type are near-hard filters — a lead who said "3 BHK" does
// not want to see a shortlist of 1BHKs. A property with the field unset (agent
// hasn't filled it in yet) is never excluded on that field: absence of data
// should not hide inventory, only a stated conflict should.

const BUDGET_STRETCH = 1.1 // a listing up to 10% over budget_max still surfaces
const BUDGET_SLACK = 0.9 // a listing down to 10% under budget_min still surfaces

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')

// True when the property's price is inside the lead's stated budget band (with a
// small stretch either way). Either side missing price data always passes — we
// only exclude on an explicit stated conflict.
export function budgetFits(lead = {}, property = {}) {
  if (property.price_paise == null) return true
  if (lead.budget_max != null && property.price_paise > Math.round(lead.budget_max * BUDGET_STRETCH)) return false
  if (lead.budget_min != null && property.price_paise < Math.round(lead.budget_min * BUDGET_SLACK)) return false
  return true
}

// True when the property's locality is one the lead prefers — plain substring
// match on normalized strings, no SQL wildcards involved.
export function localityMatches(lead = {}, property = {}) {
  if (!property.locality) return false
  const wanted = new Set(
    [...(Array.isArray(lead.preferred_localities) ? lead.preferred_localities : []), lead.locality]
      .filter(Boolean)
      .map(norm),
  )
  if (!wanted.size) return false
  const have = norm(property.locality)
  for (const w of wanted) if (w && (have.includes(w) || w.includes(have))) return true
  return false
}

// Score one property against one lead. `fits` is false when the property fails a
// hard filter (budget, or a stated BHK/type conflict) and should be excluded
// entirely, not merely ranked low.
export function scorePropertyMatch(lead = {}, property = {}) {
  if (!budgetFits(lead, property)) return { score: 0, reasons: [], fits: false }
  if (lead.bhk && property.bhk && String(lead.bhk) !== String(property.bhk)) {
    return { score: 0, reasons: [], fits: false }
  }
  if (lead.property_type && property.property_type && lead.property_type !== property.property_type) {
    return { score: 0, reasons: [], fits: false }
  }

  let score = 0
  const reasons = []

  if (localityMatches(lead, property)) {
    score += 2
    reasons.push(`in ${property.locality}, a preferred locality`)
  }
  if (lead.bhk && property.bhk && String(lead.bhk) === String(property.bhk)) {
    score += 1
    reasons.push(`${property.bhk} as requested`)
  }
  if (property.price_paise != null) {
    score += 1
    reasons.push('price confirmed')
  }

  return { score, reasons, fits: true }
}

// Rank a candidate set of properties for one lead: fits only, highest score
// first, freshest as the tiebreak. Returns each property spread with
// `match_score` and `match_reasons`.
export function rankPropertyMatches(lead, properties = [], { limit = 20 } = {}) {
  return properties
    .map((p) => ({ property: p, ...scorePropertyMatch(lead, p) }))
    .filter((m) => m.fits)
    .sort((a, b) => b.score - a.score || new Date(b.property.updated_at || 0) - new Date(a.property.updated_at || 0))
    .slice(0, limit)
    .map((m) => ({ ...m.property, match_score: m.score, match_reasons: m.reasons }))
}
