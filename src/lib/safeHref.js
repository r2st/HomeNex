// Decide whether a stored link may be put in an href.
//
// The server now refuses to STORE anything but http(s) and our own /uploads paths
// (see boundedUrl in server/middleware.js), which closes the door going in. This is
// the other half, and it is not redundant: every listing saved before that check
// existed is still in the database exactly as it was written, and a validator added
// at the write path does not go back and clean the rows behind it. Until those rows
// are read at least once, the only thing standing between a `javascript:` brochure
// link and the agent who opens that listing is this function.
//
// React is no help here — it renders a `javascript:` href with a console warning and
// nothing else — and the token this would run next to lives in localStorage.
//
// Returns the link when it is safe to follow, and `undefined` when it is not, so
// `href={safeHref(x)}` drops the attribute entirely rather than emitting an <a> that
// silently does something else.
export function safeHref(url) {
  if (typeof url !== 'string') return undefined
  const s = url.trim()
  if (!s) return undefined
  // Protocol-relative: resolves to another origin despite the leading slash, so it
  // must not pass the relative-path test below.
  if (s.startsWith('//')) return undefined
  if (s.startsWith('/')) return url
  return /^https?:\/\//i.test(s) ? url : undefined
}

/** True when a link is safe to offer at all — for hiding the control, not just the href. */
export const isSafeHref = (url) => safeHref(url) !== undefined
