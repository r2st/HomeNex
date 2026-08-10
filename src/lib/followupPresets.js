// One-tap follow-up presets.
//
// Date-based presets land at 10am local time because that is when agents make
// their calls; "Custom" opens the datetime picker instead. Seconds and
// milliseconds are zeroed so two presets chosen a moment apart produce the same
// timestamp and sort predictably.
//
// Extracted from LeadDetail so it can be tested directly.

export const FOLLOWUP_PRESETS = [
  { kind: 'tomorrow', label: 'Tomorrow 10am', days: 1 },
  { kind: '3days', label: 'In 3 days', days: 3 },
  { kind: 'nextweek', label: 'Next week', days: 7 },
]

const BY_KIND = new Map(FOLLOWUP_PRESETS.map((p) => [p.kind, p]))

// `from` is injectable so tests don't depend on the wall clock.
export function presetDate(kind, from = new Date()) {
  const d = new Date(from.getTime())
  d.setSeconds(0, 0)
  const preset = BY_KIND.get(kind)
  // Unknown kinds (including 'custom') mean "start from now" — the picker takes
  // over from there, so we must not invent a 10am time for it.
  if (!preset) return d
  d.setDate(d.getDate() + preset.days)
  d.setHours(10, 0)
  return d
}
