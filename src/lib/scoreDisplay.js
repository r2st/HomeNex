// Whether to show the detailed score breakdown. A brand-new lead scores ~10/100
// with every factor at zero, which reads as broken/discouraging — so below a
// threshold we hide the breakdown and show an encouraging "not enough data" note.
// Pure — no React — so it can be unit-tested.

export const SCORE_BREAKDOWN_MIN = 20

export function shouldShowScoreBreakdown(score, breakdown = []) {
  if (!Array.isArray(breakdown) || breakdown.length === 0) return false
  return Number(score || 0) >= SCORE_BREAKDOWN_MIN
}
