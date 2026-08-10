// Turn an API failure into a sentence a non-technical agent can act on. The server
// already returns human strings for most 4xx cases ("Wrong WhatsApp number or
// password"), so those pass through untouched. What we rewrite is the scary stuff:
// bare "HTTP 500", raw network TypeErrors, and technical noise that should never
// reach the screen.

const STATUS_MESSAGE = {
  0: "You're offline. Check your internet and try again.",
  400: 'Some details look incorrect. Please check and try again.',
  401: 'Your session has expired. Please log in again.',
  403: "You don't have permission to do that.",
  404: "We couldn't find that. It may have been removed.",
  409: 'That didn\'t go through — it may already exist or have changed. Please refresh and try again.',
  413: 'That file is too large. Please choose a smaller one.',
  429: 'Too many attempts. Please wait a minute and try again.',
  500: 'Something went wrong on our side. Please try again in a moment.',
  502: 'Our server is briefly unavailable. Please try again in a moment.',
  503: 'The service is temporarily unavailable. Please try again shortly.',
  504: 'The request took too long. Please try again.',
}

const GENERIC = 'Something went wrong. Please try again.'

// Heuristic: does this string read like an internal/technical error rather than a
// message written for the agent? If so we hide it behind the generic line.
function looksTechnical(msg) {
  if (!msg) return true
  return (
    /^HTTP\s+\d+/i.test(msg) ||
    /\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/.test(msg) ||
    /fetch failed|NetworkError|Failed to fetch|Load failed/i.test(msg) ||
    /\binternal error\b/i.test(msg) ||
    /undefined|null|\bNaN\b|stack|TypeError|\[object /i.test(msg)
  )
}

// A fetch that rejects with a TypeError never reached the server → treat as offline.
export function isNetworkError(err) {
  return err instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(err?.message || '')
}

// Main entry. Accepts the Error thrown by api.js (which may carry `.status` and
// `.serverMessage`), or a plain string, or a { status, serverMessage } object.
export function friendlyMessage(input) {
  if (input == null) return GENERIC
  if (typeof input === 'string') return looksTechnical(input) ? GENERIC : input

  const isNet = input instanceof Error ? isNetworkError(input) : Boolean(input.isNetwork)
  if (isNet) return STATUS_MESSAGE[0]

  const status = input.status
  const serverMessage = input.serverMessage ?? (input instanceof Error ? input.message : input.message)

  // Prefer a real, human server message (but not the bare "HTTP 500" fallback).
  if (serverMessage && !looksTechnical(serverMessage)) return serverMessage

  // Not `status && ...`: status 0 is the table's own "no response at all" entry, and
  // a truthiness check would skip straight past it to the generic line.
  if (STATUS_MESSAGE[status]) return STATUS_MESSAGE[status]
  if (status >= 500) return STATUS_MESSAGE[500]
  if (status >= 400) return STATUS_MESSAGE[400]
  return GENERIC
}
