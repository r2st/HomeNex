// {{placeholder}} handling for quick replies and approved templates.
//
// Two jobs, deliberately kept apart: listing the variables a template needs (so
// the composer can ask the agent to fill them in), and pre-filling the ones we
// already know from the lead. Anything we can't fill is left as literal
// {{placeholder}} text so the agent can see what still needs a value — never
// blanked, which would silently send a half-written message.
//
// Extracted from InboxTab so it can be tested directly.

const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

// The variable names in a body, in first-appearance order, deduped.
// "Hi {{name}} about {{property}}" -> ['name', 'property']
export function varsOf(body) {
  const out = []
  for (const m of String(body || '').matchAll(VAR_RE)) if (!out.includes(m[1])) out.push(m[1])
  return out
}

// Substitute the placeholders we can resolve from the lead, leaving the rest
// intact for the agent to complete in the draft box.
export function fillKnown(body, lead) {
  return String(body || '').replace(VAR_RE, (full, key) =>
    key === 'name' && lead?.name ? lead.name : full,
  )
}

// Which placeholders are still unresolved after fillKnown — what the composer
// must prompt for before the message is safe to send.
export function missingVars(body, lead) {
  return varsOf(fillKnown(body, lead))
}

// Which of a template's variables the agent has not filled in yet.
//
// Out-of-window replies go out as paid, approved WhatsApp templates, and the
// server refuses one with a blank variable. Checking the same thing here lets
// the composer disable Send and name the empty field instead of spending a round
// trip to come back with "Fill in: property".
export function unfilledVars(body, vars = {}) {
  return varsOf(body).filter((name) => !String(vars?.[name] ?? '').trim())
}
