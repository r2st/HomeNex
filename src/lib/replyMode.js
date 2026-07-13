// The badge shown on an inbox conversation row (and usable elsewhere) describing
// who answers this chat. Replaces the opaque "MANUAL" tag with plain language.
// Pure — no React — so it can be unit-tested.

// tone maps to a colour family the component already knows how to render.
export function replyModeBadge(lead = {}) {
  if (lead && lead.ai_enabled) {
    return { key: 'ai', label: 'Auto-reply', icon: '🤖', tone: 'brand' }
  }
  return { key: 'manual', label: 'You reply', icon: '✋', tone: 'amber' }
}

// One-line explanation of the two states, for the Inbox header helper text.
export const REPLY_MODE_HELP =
  '🤖 Auto-reply = HomeNex AI answers · ✋ You reply = you’ve taken over'
