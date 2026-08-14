// Small dependency-free Express middleware for production hardening: security
// headers, a configurable CORS handler, an in-memory rate limiter, and a compact
// request logger. Kept deliberately tiny — the repo ships only `express` + `pg` on
// the server and we don't want to grow that for four short helpers.

// --- Security headers ------------------------------------------------------
// Sensible defaults for an app served over HTTPS behind a reverse proxy. No CSP
// here (the SPA is inlined by Vite and would need per-build nonces); the cheap,
// always-safe headers are set on every response.
export function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('X-DNS-Prefetch-Control', 'off')
  next()
}

// --- CORS ------------------------------------------------------------------
// Off by default: the SPA is served same-origin so no CORS headers are needed and
// the browser same-origin policy stays maximally strict. Set CORS_ORIGIN to a
// comma-separated allowlist (or `*`) only when the frontend is hosted elsewhere.
export function cors(originConfig = process.env.CORS_ORIGIN || '') {
  const config = String(originConfig).trim()
  const allowAll = config === '*'
  const allowed = new Set(
    config
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean),
  )
  return function corsMiddleware(req, res, next) {
    if (!config) return next() // CORS disabled — same-origin only
    const origin = req.get('origin')
    if (origin && (allowAll || allowed.has(origin.replace(/\/$/, '')))) {
      res.setHeader('Access-Control-Allow-Origin', allowAll ? '*' : origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      res.setHeader('Access-Control-Max-Age', '600')
      if (!allowAll) res.setHeader('Access-Control-Allow-Credentials', 'true')
    }
    // Answer the preflight without falling through to route handlers.
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  }
}

// --- Rate limiter ----------------------------------------------------------
// Fixed-window counter in a Map, keyed by client IP. Good enough to blunt
// brute-force login attempts and webhook floods on a single node; swap for Redis
// if HomeNex ever scales horizontally. Buckets are swept lazily on access and by a
// low-frequency interval so the Map can't grow without bound.

// The rate-limit key must be an address the *client* cannot choose, or the limiter
// is decorative: a caller who picks their own key just rotates it every request.
//
// X-Forwarded-For is client-supplied and only appended to by our proxy, so its
// LEFTMOST entry is whatever the attacker sent — reading that hop let anyone defeat
// the login limiter with a header. Express's req.ip already resolves this correctly
// from `trust proxy` (with one trusted hop it returns the address our own proxy
// appended, i.e. the real peer), so prefer it. The XFF fallback exists only for
// bare request shims with no req.ip, and takes the RIGHTMOST hop for the same
// reason — that is the one closest to us and the hardest to forge.
export function clientIp(req) {
  if (req.ip) return req.ip
  const fwd = req.get?.('x-forwarded-for')
  if (fwd) {
    const hops = String(fwd).split(',').map((h) => h.trim()).filter(Boolean)
    if (hops.length) return hops[hops.length - 1]
  }
  return req.socket?.remoteAddress || 'unknown'
}

export function rateLimit({ windowMs = 60_000, max = 60, key = clientIp, message } = {}) {
  const hits = new Map() // ip -> { count, resetAt }
  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k)
  }, windowMs)
  sweep.unref?.() // never keep the process alive just for the sweep

  const middleware = function rateLimitMiddleware(req, res, next) {
    const now = Date.now()
    const k = key(req)
    let entry = hits.get(k)
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs }
      hits.set(k, entry)
    }
    entry.count += 1
    const remaining = Math.max(0, max - entry.count)
    res.setHeader('X-RateLimit-Limit', String(max))
    res.setHeader('X-RateLimit-Remaining', String(remaining))
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000)
      res.setHeader('Retry-After', String(retryAfter))
      return res.status(429).json({
        error: message || 'Too many requests — please slow down and try again shortly.',
        code: 'RATE_LIMITED',
        retry_after: retryAfter,
      })
    }
    next()
  }
  // Exposed so tests (and a graceful shutdown) can stop the sweep timer.
  middleware.stop = () => clearInterval(sweep)
  return middleware
}

// --- Error-response codes --------------------------------------------------
// Every API failure answers with `{ error: <human sentence>, code: <STABLE_TOKEN> }`.
// The sentence is for the agent reading the screen and is free to be reworded; the
// code is the contract a client branches on. Most routes only supply the sentence
// (that's the interesting half, and threading a code through ~130 call sites would
// bury it), so this fills in the status-derived default and leaves any explicit,
// more specific code (TEMPLATE_LOCKED, WINDOW_EXPIRED, …) untouched.
const STATUS_CODES = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  402: 'PAYMENT_REQUIRED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  410: 'GONE',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
  500: 'INTERNAL',
  502: 'UPSTREAM_ERROR',
  503: 'SERVICE_UNAVAILABLE',
  504: 'UPSTREAM_TIMEOUT',
}

export function errorCodeForStatus(status) {
  return STATUS_CODES[status] || (status >= 500 ? 'INTERNAL' : 'BAD_REQUEST')
}

// Wraps res.json for the life of the request. Only an error status carrying an
// `error` string is touched — a 503 health payload (`{ ok: false, db: false }`) or
// any successful body passes through byte-for-byte.
export function errorCodes(_req, res, next) {
  const json = res.json.bind(res)
  res.json = function jsonWithErrorCode(body) {
    if (
      res.statusCode >= 400 &&
      body &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      typeof body.error === 'string' &&
      body.code == null
    ) {
      return json({ ...body, code: errorCodeForStatus(res.statusCode) })
    }
    return json(body)
  }
  next()
}

// --- Numeric path ids ------------------------------------------------------
// Every :id in this app is a SERIAL primary key, so a path id is only ever a
// positive int4. Anything else — `/api/leads/undefined` from a frontend bug, or a
// deliberate probe — used to travel all the way to Postgres as `WHERE id = 'x'`,
// where it raised 22P02 (invalid text representation) and surfaced as a 500.
//
// Routes that already wrap their query in the pgBadRequest catch turned that into a
// 400; the ~38 that don't returned "Something went wrong on our side", which is
// both untrue (it was the caller's input) and a useful map for anyone probing the
// API for which routes are unguarded. Rejecting the id up front fixes every one of
// them in the same place, and keeps the guarantee from depending on each new route
// remembering to catch.
//
// The int4 ceiling matters as much as the digits: 9999999999 is all digits and
// still raises 22003 (out of range) at the database.
const MAX_INT4 = 2147483647
export const ID_PARAMS = ['id', 'noteId', 'labelId', 'contactId', 'agentId']

export function validateIdParams(target, names = ID_PARAMS) {
  for (const name of names) {
    target.param(name, (req, res, next, value) => {
      if (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= MAX_INT4) return next()
      res.status(400).json({ error: `Invalid ${name}`, code: 'BAD_ID' })
    })
  }
  return target
}

// --- Bounded text fields ---------------------------------------------------
// Nearly every text column in the schema is an unbounded Postgres TEXT, which is
// the right choice for storage and no answer at all for input. Until this, the only
// ceiling on a lead note, a template body or a contact's name was express.json()'s
// 25MB body cap — a limit that exists so the media library can post a base64 photo,
// and one that let a signed-in agent (or anything holding their token) put roughly
// eighteen megabytes into a field the dashboard renders on a single line.
//
// The bound is declared per route rather than inferred from the field name: `body`
// is a two-line quick reply in one place and a support ticket in another, and a
// guard that quietly picked one number for both would be wrong somewhere. Declaring
// it at the route also keeps the limit visible next to what it protects, and lets
// the 400 name the field and the number instead of just saying "too long".
//
// Only strings are measured. A non-string in a text field is a different complaint,
// already answered by the route's own validation or by Postgres, and rejecting it
// here would change behaviour that has nothing to do with length.
export function boundedText(limits) {
  const entries = Object.entries(limits)
  return function boundedTextMiddleware(req, res, next) {
    const body = req.body
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      for (const [field, max] of entries) {
        const value = body[field]
        if (typeof value === 'string' && value.length > max) {
          return res.status(400).json({
            error: `${field} must be ${max} characters or fewer.`,
            code: 'FIELD_TOO_LONG',
            field,
            max,
          })
        }
      }
    }
    next()
  }
}

// The sizes the product actually uses, named so a route says what kind of field it
// is bounding instead of repeating a number whose meaning has to be guessed.
export const TEXT = {
  // A name, a locality, a builder — one line, rendered inside a fixed-width cell.
  LINE: 120,
  // A subject, a caption, a short description: a paragraph at most.
  BLURB: 500,
  // Free-form prose an agent types: notes, a ticket body, a template.
  PROSE: 4000,
  // WhatsApp's own hard limit on a text message body. Anything longer is refused by
  // Meta *after* we have spent the send, so refuse it here instead.
  WHATSAPP: 4096,
  // A link. Well past any real URL, well short of a payload.
  URL: 2000,
}

// --- Request logger --------------------------------------------------------
// One structured line per request once the response finishes. Static assets and
// uploads are skipped to keep the log signal-dense. Disabled under NODE_ENV=test
// and when LOG_REQUESTS=0.
export function requestLogger({ log = console.log } = {}) {
  return function requestLoggerMiddleware(req, res, next) {
    const p = req.path
    if (p.startsWith('/uploads') || p.startsWith('/assets') || p === '/favicon.ico') return next()
    const start = process.hrtime.bigint()
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6
      log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`)
    })
    next()
  }
}
