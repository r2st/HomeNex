// EMI calculator: parse loan queries the way Indian buyers phrase them on WhatsApp
// ("80L at 8.5% for 20 years", "1.2cr ka loan 15 saal", "emi for 50 lakh") and
// compute a standard reducing-balance EMI. Pure functions — no AI, no network.

const PAISE_PER_LAKH = 1e7

const DEFAULT_RATE_PCT = 8.5
const DEFAULT_TENURE_YEARS = 20

// Does this message look like an EMI/loan-installment question?
export function detectEmiQuery(text) {
  const t = String(text || '').toLowerCase()
  if (/\bemi\b/.test(t)) return true
  // "loan ... per month / monthly / installment / kist"
  if (/\bloan\b/.test(t) && /(month|monthly|installment|instalment|kist|hafta)/.test(t)) return true
  return false
}

// Parse an amount phrase into ₹ lakhs. Understands "80L", "80 lakh(s)", "1.2 cr",
// "1.2 crore", and plain rupee figures ("8000000"). Returns null when absent.
export function parseAmountLakhs(text) {
  const t = String(text || '').toLowerCase().replace(/,/g, '')
  let m = t.match(/(\d+(?:\.\d+)?)\s*(?:cr|crore)s?\b/)
  if (m) return parseFloat(m[1]) * 100
  m = t.match(/(\d+(?:\.\d+)?)\s*(?:l\b|lac|lakh|lakhs|lacs)/)
  if (m) return parseFloat(m[1])
  // Bare rupee amount: only trust figures of 6+ digits (≥ ₹1,00,000).
  m = t.match(/(?:₹|rs\.?\s*)?(\d{6,})(?:\.\d+)?\b/)
  if (m) return parseFloat(m[1]) / 100000
  return null
}

// Extract principal (lakhs), annual rate (%), and tenure (years) from free text.
// Rate and tenure fall back to sensible Indian home-loan defaults when unstated.
export function parseEmiQuery(text) {
  const t = String(text || '').toLowerCase().replace(/,/g, '')
  const principalLakhs = parseAmountLakhs(t)
  if (principalLakhs == null || principalLakhs <= 0) return null

  let ratePct = null
  let m = t.match(/(\d+(?:\.\d+)?)\s*%/)
  if (m) ratePct = parseFloat(m[1])
  else {
    m = t.match(/(?:@|at|rate(?:\s+of)?)\s*(\d+(?:\.\d+)?)\b/)
    // Guard against "at 80L": a rate above 20% is not a home-loan rate.
    if (m && parseFloat(m[1]) > 0 && parseFloat(m[1]) <= 20) ratePct = parseFloat(m[1])
  }

  let years = null
  m = t.match(/(\d+(?:\.\d+)?)\s*(?:years?|yrs?|saal|varsh)\b/)
  if (m) years = parseFloat(m[1])
  else {
    m = t.match(/(\d+)\s*months?\b/)
    if (m) years = parseInt(m[1], 10) / 12
  }

  return {
    principalLakhs,
    ratePct: ratePct ?? DEFAULT_RATE_PCT,
    years: years ?? DEFAULT_TENURE_YEARS,
    assumedRate: ratePct == null,
    assumedTenure: years == null,
  }
}

// Standard reducing-balance EMI. All money values in paise (integers).
// EMI = P·r·(1+r)^n / ((1+r)^n − 1), r = monthly rate, n = months.
export function calculateEmi({ principalPaise, ratePct, years }) {
  const P = Number(principalPaise)
  const n = Math.round(years * 12)
  if (!(P > 0) || !(n > 0) || !(ratePct >= 0)) return null
  const r = ratePct / 12 / 100
  const emiPaise = r === 0 ? P / n : (P * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1)
  const emi = Math.round(emiPaise)
  const total = emi * n
  return {
    emi_paise: emi,
    months: n,
    total_payment_paise: total,
    total_interest_paise: total - Math.round(P),
  }
}

const fmtRupees = (paise) => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`
const fmtBig = (paise) => {
  const r = paise / 100
  if (r >= 1e7) return `₹${String(Number((r / 1e7).toFixed(2)))} Cr`
  if (r >= 1e5) return `₹${String(Number((r / 1e5).toFixed(1)))} L`
  return fmtRupees(paise)
}

// WhatsApp-ready EMI breakdown message.
export function formatEmiMessage(parsed) {
  const principalPaise = Math.round(parsed.principalLakhs * PAISE_PER_LAKH)
  const calc = calculateEmi({ principalPaise, ratePct: parsed.ratePct, years: parsed.years })
  if (!calc) return null
  const assumptions = []
  if (parsed.assumedRate) assumptions.push(`${parsed.ratePct}% p.a.`)
  if (parsed.assumedTenure) assumptions.push(`${parsed.years} years`)
  return [
    `🏦 *EMI Calculation*`,
    ``,
    `Loan amount: ${fmtBig(principalPaise)}`,
    `Interest rate: ${parsed.ratePct}% p.a.`,
    `Tenure: ${String(Number(parsed.years.toFixed(1)))} years (${calc.months} months)`,
    ``,
    `📅 Monthly EMI: *${fmtRupees(calc.emi_paise)}*`,
    `💸 Total interest: ${fmtBig(calc.total_interest_paise)}`,
    `💰 Total payment: ${fmtBig(calc.total_payment_paise)}`,
    ``,
    assumptions.length
      ? `_Assumed ${assumptions.join(' and ')} — tell me your bank's rate or tenure and I'll recalculate._`
      : `_Indicative figure — final EMI depends on your bank's approved rate._`,
  ]
    .filter((line) => line !== null)
    .join('\n')
}

// One-shot helper for the inbound pipeline: returns the reply text for an EMI
// question, or null when the message isn't one (or has no parseable amount).
export function emiReplyFor(text) {
  if (!detectEmiQuery(text)) return null
  const parsed = parseEmiQuery(text)
  if (!parsed) return null
  return formatEmiMessage(parsed)
}
