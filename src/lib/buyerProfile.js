// Detect an all-empty buyer profile so the Lead Detail card can show a friendly
// "will be captured from conversations" state instead of a wall of "not set".
// Pure — no React — so it can be unit-tested.

const BUYER_PROFILE_FIELDS = [
  'budget_min',
  'budget_max',
  'bhk',
  'property_type',
  'preferred_localities',
  'timeline',
  'financing',
]

const hasValue = (v) =>
  v != null && v !== '' && !(Array.isArray(v) && v.length === 0)

export function buyerProfileIsEmpty(lead = {}) {
  return !BUYER_PROFILE_FIELDS.some((f) => hasValue(lead[f]))
}
