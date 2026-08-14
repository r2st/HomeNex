// Friendly names for the handful of timezones a HomeNex agent (mostly India, some
// NRI-facing) actually needs. IANA identifiers like "Asia/Kolkata" are technical;
// show "India (IST)" instead. Pure — no React.

const TIMEZONE_LABELS = {
  'Asia/Kolkata': 'India (IST)',
  'Asia/Dubai': 'Dubai (GST)',
  'Asia/Singapore': 'Singapore (SGT)',
  'Asia/Kathmandu': 'Nepal (NPT)',
  'Asia/Colombo': 'Sri Lanka (IST)',
  'Europe/London': 'London (UK)',
  'America/New_York': 'New York (US East)',
  'America/Los_Angeles': 'Los Angeles (US West)',
  'Australia/Sydney': 'Sydney (Australia)',
  UTC: 'UTC',
}

// The zones we offer by default, in the order agents most often need them.
export const COMMON_TIMEZONES = Object.keys(TIMEZONE_LABELS)

export const DEFAULT_TIMEZONE = 'Asia/Kolkata'

// Friendly label for any zone; an unknown IANA id degrades to "Asia / Kolkata".
export function timezoneLabel(tz) {
  if (!tz) return TIMEZONE_LABELS[DEFAULT_TIMEZONE]
  return TIMEZONE_LABELS[tz] || String(tz).replace(/_/g, ' ').replace(/\//g, ' / ')
}

// The list to render in the dropdown — the common set, with the agent's stored zone
// prepended if it's something exotic we don't already list.
export function timezoneOptions(currentTz) {
  const zones = COMMON_TIMEZONES.includes(currentTz) || !currentTz
    ? COMMON_TIMEZONES
    : [currentTz, ...COMMON_TIMEZONES]
  return zones.map((tz) => ({ value: tz, label: timezoneLabel(tz) }))
}
