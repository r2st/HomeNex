// WhatsApp's 24-hour customer service window.
//
// Meta only allows free-form replies for 24 hours after the buyer's last inbound
// message; outside that window an agent must use an approved template. The inbox
// shows the agent which side of that line they are on, so getting this wrong
// either scares them off a reply they were allowed to send or lets them draft one
// that Meta will reject.
//
// Extracted from InboxTab so it can be tested directly.
import { parseTs } from '../api.js'

export const WINDOW_MS = 24 * 3600_000

// State of the service window for a lead, derived from its last inbound message.
// Leads with no anchor (imported, or from before we tracked it) are treated as
// open: we don't know of a closed window, and blocking a reply on a guess is the
// worse failure.
export function windowState(lead, now) {
  if (!lead?.last_inbound_at) return { known: false, open: true, msLeft: null }
  const anchor = parseTs(lead.last_inbound_at)
  // An unparseable timestamp is no better than a missing one — don't render
  // "NaNh left" or silently claim the window is shut.
  if (!anchor || Number.isNaN(anchor.getTime())) return { known: false, open: true, msLeft: null }
  const expires = anchor.getTime() + WINDOW_MS
  return { known: true, open: expires > now, msLeft: expires - now }
}

// Coarse countdown for the badge: hours+minutes while there is an hour left,
// minutes below that. Never shows "0m" — the last sixty seconds still round up to
// "1m" so the window never looks expired while it is still open.
export function fmtCountdown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0m'
  const h = Math.floor(ms / 3600_000)
  const m = Math.floor((ms % 3600_000) / 60_000)
  return h > 0 ? `${h}h ${m}m` : `${Math.max(1, m)}m`
}
