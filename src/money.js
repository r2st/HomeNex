// Money helpers (client twin of server/money.js). All monetary values travel as
// paise integers; the UI shows ₹ Lakhs/Crores and edits in Lakhs.

const PAISE_PER_RUPEE = 100
const PAISE_PER_LAKH = 1e7
const PAISE_PER_CRORE = 1e9

const trim = (n, dp) => String(Number(n.toFixed(dp)))

// "₹ 45L", "₹ 1.2Cr", or "₹ 80,000" below a lakh. Returns null for null/undefined.
export function paiseToDisplay(paise) {
  if (paise == null || Number.isNaN(Number(paise))) return null
  const p = Number(paise)
  const sign = p < 0 ? '-' : ''
  const abs = Math.abs(p)
  if (abs >= PAISE_PER_CRORE) return `${sign}₹ ${trim(abs / PAISE_PER_CRORE, 2)}Cr`
  if (abs >= PAISE_PER_LAKH) return `${sign}₹ ${trim(abs / PAISE_PER_LAKH, 1)}L`
  return `${sign}₹ ${Math.round(abs / PAISE_PER_RUPEE).toLocaleString('en-IN')}`
}

// "₹ 45L – ₹ 60L" for a budget range; single value when only one bound is known.
export function paiseRangeToDisplay(minPaise, maxPaise) {
  const lo = paiseToDisplay(minPaise)
  const hi = paiseToDisplay(maxPaise)
  if (lo && hi && lo !== hi) return `${lo} – ${hi}`
  return hi || lo
}

export function lakhsToPaise(lakhs) {
  if (lakhs == null || lakhs === '' || Number.isNaN(Number(lakhs))) return null
  return Math.round(Number(lakhs) * PAISE_PER_LAKH)
}

export function paiseToLakhs(paise) {
  if (paise == null) return null
  return Number(paise) / PAISE_PER_LAKH
}
