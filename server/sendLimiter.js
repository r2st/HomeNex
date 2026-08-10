// sendLimiter.js — WhatsApp quality-rating protection.
//
// Ported from Landline's services/send_limiter.py. Landline guards email-domain
// reputation; the identical machinery guards a WhatsApp Business number's Meta
// quality rating — same problem, different hat. A red-flagged number gets throttled
// then restricted, and there is no appeal worth relying on, so this is purely
// defensive and the downside it prevents is losing the agent's number = their book.
//
// The immediate risk surface is festive_schedules, which fans one message out to
// ALL of an agent's contacts at once — exactly the pattern Meta penalises. Every
// bulk/marketing send path must pass through evaluateSend() first.
//
// Pure functions: counts and timestamps come in as arguments (db.js gathers them),
// so the policy is deterministic and unit-testable without a database.

const HOUR_MS = 3600_000
const DAY_MS = 86_400_000

// Minimum gap between marketing/festive sends to the SAME contact.
export const PER_CONTACT_MIN_GAP_H = 12
// Per-contact monthly ceiling on marketing/festive sends.
export const PER_CONTACT_MONTHLY_CAP = 8

// Hour-of-day (0-23) in a timezone, or null if the timezone is unparseable.
export function hourInTimezone(now, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'Asia/Kolkata',
      hour: 'numeric',
      hour12: false,
    }).formatToParts(new Date(now))
    const h = Number(parts.find((p) => p.type === 'hour')?.value)
    return Number.isNaN(h) ? null : h % 24
  } catch {
    return null
  }
}

// Is `hour` inside a quiet range that may wrap past midnight (e.g. 21 → 8)?
export function inQuietRange(hour, start, end) {
  if (start == null || end == null || start === end) return false
  return start < end ? hour >= start && hour < end : hour >= start || hour < end
}

// May a bulk/marketing message go out right now? Respects the agent's configured
// quiet hours, enforces a hard night guard (never blast 00:00–06:00 local), and
// FAILS OPEN on an unparseable timezone — a bad config must not halt all sending.
export function withinSendWindow(now, tz, { quietStart = null, quietEnd = null } = {}) {
  const hour = hourInTimezone(now, tz)
  if (hour == null) return true
  if (hour >= 0 && hour < 6) return false // no 3 AM festive greetings, ever
  if (inQuietRange(hour, quietStart, quietEnd)) return false
  return true
}

// The warmup ramp: a new sending number starts small and scales over three weeks.
// bulkStartedAt === null means it hasn't started a bulk campaign yet → week-1 cap.
export function warmupDailyCap(bulkStartedAt, now = Date.now()) {
  if (bulkStartedAt == null) return 50
  const days = (now - new Date(bulkStartedAt).getTime()) / DAY_MS
  if (days < 7) return 50
  if (days < 14) return 150
  if (days < 21) return 500
  return 1000
}

// The single gate every bulk send path must call. Returns { canSend, reason }.
// Order matters: cheapest / most-decisive checks first.
export function evaluateSend({
  optInStatus = 'unknown',
  lastSentToContactAt = null,
  contactSendsThisMonth = 0,
  sendsToday = 0,
  dailyCap = 1000,
  now = Date.now(),
  tz = 'Asia/Kolkata',
  quietStart = null,
  quietEnd = null,
  // The clock window gates AUTOMATED bulk sends. An immediate, agent-initiated send
  // is a deliberate act, so those paths pass enforceWindow:false.
  enforceWindow = true,
} = {}) {
  if (optInStatus === 'opted_out') return { canSend: false, reason: 'opted_out' }
  if (enforceWindow && !withinSendWindow(now, tz, { quietStart, quietEnd }))
    return { canSend: false, reason: 'outside_send_window' }
  if (sendsToday >= dailyCap) return { canSend: false, reason: 'daily_cap_reached' }
  if (
    lastSentToContactAt != null &&
    now - new Date(lastSentToContactAt).getTime() < PER_CONTACT_MIN_GAP_H * HOUR_MS
  )
    return { canSend: false, reason: 'too_soon_since_last' }
  if (contactSendsThisMonth >= PER_CONTACT_MONTHLY_CAP)
    return { canSend: false, reason: 'contact_monthly_cap' }
  return { canSend: true, reason: 'ok' }
}
