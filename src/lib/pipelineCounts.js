// Count leads per pipeline so the Leads tabs can show subtle volume badges.
// A lead with no pipeline_type defaults to buy_primary (matches the webhook +
// LeadsTab filtering). Pure — no React — so it can be unit-tested.

export const PIPELINE_IDS = ['buy_primary', 'buy_resale', 'rental']

export function pipelineCounts(leads = []) {
  const counts = { buy_primary: 0, buy_resale: 0, rental: 0 }
  for (const l of leads) {
    const type = (l && l.pipeline_type) || 'buy_primary'
    counts[type] = (counts[type] || 0) + 1
  }
  return counts
}
