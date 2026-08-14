// Pure helpers for the Unified WhatsApp Inbox + Template Messages features.
// No I/O here so these can be unit-tested in isolation: variable filling for
// quick replies and templates, RERA auto-append for marketing, and the label
// auto-rule vocabulary.

// The lifecycle labels HomeNex applies automatically. Manual labels an agent
// creates have auto_key = null; these six are seeded is_system with an auto_key.
export const AUTO_LABEL_KEYS = Object.freeze([
  'new',
  'hot',
  'site_visit_scheduled',
  'token_paid',
  'lost',
  'broker',
])

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

// The variable names in a body, in first-seen order, de-duplicated.
// "Hi {{name}}, about {{property}}" -> ["name", "property"]
export function extractPlaceholders(body) {
  const seen = new Set()
  const out = []
  for (const m of String(body || '').matchAll(PLACEHOLDER_RE)) {
    const key = m[1]
    if (!seen.has(key)) {
      seen.add(key)
      out.push(key)
    }
  }
  return out
}

// Fill {{placeholders}} from a values object. Returns the filled text plus the
// list of placeholders that had no value supplied (so a caller can reject a send
// with unfilled variables). A value is "supplied" only if it is a non-empty string
// after trimming — an empty box counts as missing, not as an intentional blank.
export function fillTemplate(body, vars = {}) {
  const values = vars || {}
  const missing = []
  const seenMissing = new Set()
  const text = String(body || '').replace(PLACEHOLDER_RE, (_full, key) => {
    const v = values[key]
    if (v == null || String(v).trim() === '') {
      if (!seenMissing.has(key)) {
        seenMissing.add(key)
        missing.push(key)
      }
      return `{{${key}}}` // leave the placeholder visible so nothing silently blanks
    }
    return String(v)
  })
  return { text, missing }
}

// The RERA line appended to marketing messages. Indian real-estate advertising
// must carry the agent's RERA registration number; state is included when known.
// Returns "" when the agent has no RERA number on file (nothing to append).
export function reraLine(agent) {
  const id = (agent?.rera_id || '').trim()
  if (!id) return ''
  const state = (agent?.rera_state || '').trim()
  return `RERA${state ? ` (${state})` : ''}: ${id}`
}

// Append the RERA line to a message body, once. Idempotent: if the body already
// contains the exact RERA number, it is not appended again.
export function appendRera(text, agent) {
  const line = reraLine(agent)
  if (!line) return text
  const body = String(text ?? '')
  // reraLine() returned a line, which it only does for a non-empty trimmed
  // rera_id on a non-null agent — so neither guard here can fire. They are kept so
  // the expression stays correct if it is ever read without the line check above.
  /* node:coverage ignore next */
  const id = (agent?.rera_id || '').trim()
  if (id && body.includes(id)) return body
  return `${body}\n\n${line}`
}

// Render a template for sending: fill variables, then append RERA for marketing
// templates that opted in. `template` is a message_templates row; `vars` the
// agent-supplied values; `agent` supplies the RERA number.
// Returns { text, missing } — `missing` lists unfilled variables (caller rejects).
export function renderTemplate(template, vars, agent) {
  const { text, missing } = fillTemplate(template?.body, vars)
  const isMarketing = template?.category === 'marketing' && template?.rera_auto_append
  return { text: isMarketing ? appendRera(text, agent) : text, missing }
}

// Map a WhatsApp media asset kind to the Cloud API message type. Brochures,
// floor plans and generic files go as documents; photos as images; videos as video.
export function waMediaType(kind) {
  if (kind === 'photo') return 'image'
  if (kind === 'video') return 'video'
  return 'document' // brochure, floor_plan, document
}
