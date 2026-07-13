// Money helpers. All monetary values are stored in paise (BIGINT) — never floats.
// 1 Lakh = ₹1,00,000 = 1e7 paise. 1 Crore = ₹1,00,00,000 = 1e9 paise.

const PAISE_PER_RUPEE = 100
const PAISE_PER_LAKH = 1e7
const PAISE_PER_CRORE = 1e9

// Trim a fixed(1)/fixed(2) number to its shortest form: 1.20 -> "1.2", 45.0 -> "45".
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

// GST on Indian SaaS/brokerage invoices is 18% by default. Compute the split in
// paise so an invoice's subtotal + gst = total is exact and never re-derived from
// a float. Returns integer paise for every field.
export const GST_RATE = 18

export function gstBreakdown(subtotalPaise, rate = GST_RATE) {
  const subtotal = Math.round(Number(subtotalPaise) || 0)
  const r = Number(rate)
  const gst = Math.round((subtotal * r) / 100)
  return { subtotal_paise: subtotal, gst_rate: r, gst_paise: gst, total_paise: subtotal + gst }
}

// "₹1,234.00" — plain rupee amount with paise, for invoice line items and totals.
export function paiseToRupees(paise) {
  if (paise == null || Number.isNaN(Number(paise))) return null
  return `₹${(Number(paise) / PAISE_PER_RUPEE).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}
