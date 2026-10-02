// Small dependency-free Express middleware for production hardening: security
// headers, a configurable CORS handler, an in-memory rate limiter, and a compact
// request logger. Kept deliberately tiny — the repo ships only `express` + `pg` on
// the server and we don't want to grow that for four short helpers.

// --- Security headers ------------------------------------------------------
// Sensible defaults for an app served over HTTPS behind a reverse proxy. No CSP
// here (the SPA is inlined by Vite and would need per-build nonces); the cheap,
// always-safe headers are set on every response.
//
// HSTS is the one that cannot be unconditional. It is a promise with a memory: a
// browser that sees it refuses plain HTTP to this host for max-age seconds, and
// nothing the server later sends can shorten that — only waiting it out can. So it
// is sent only on a request that actually arrived over TLS. Express resolves
// req.secure from X-Forwarded-Proto once `trust proxy` is set (index.js sets it),
// which is how a request through the box's Caddy container is recognised; a plain
// HTTP request in dev is not, and gets nothing.
//
// Caddy does not add this itself (v2 dropped v1's automatic HSTS), so without this
// line homenex.doaide.com ships no HSTS at all.
//
// No `preload`. That flag is a submission to a list baked into browser binaries,
// it is effectively irreversible on a release timescale, and it would commit every
// sibling on doaide.com — a decision for the estate, not for this service.
const HSTS_MAX_AGE = Number(process.env.HSTS_MAX_AGE) >= 0 ? Number(process.env.HSTS_MAX_AGE) : 31_536_000

export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('X-DNS-Prefetch-Control', 'off')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
  if (HSTS_MAX_AGE > 0 && req?.secure) {
    res.setHeader('Strict-Transport-Security', `max-age=${HSTS_MAX_AGE}; includeSubDomains`)
  }
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

// --- Request body ----------------------------------------------------------
// One guarantee, made once: past this point req.body is a plain object.
//
// Ninety route handlers were each making that guarantee for themselves, as
// `req.body ?? {}` or `req.body?.field`, and none of them were ever exercised.
// body-parser 1.x assigns `req.body = req.body || {}` before it decides whether
// there is anything to parse, so under Express 4 a bodiless POST already arrives as
// `{}` — the fallbacks were reassurance, not defence, and reassurance repeated
// ninety times reads like a hazard that is actually there.
//
// It is worth keeping as a real middleware rather than deleting outright, because
// the guarantee is body-parser's and not ours. Express 5 ships body-parser 2, which
// drops that line and leaves req.body undefined; the version that made ninety
// fallbacks unnecessary is the version an upgrade would take away. Stating it here
// means the upgrade changes one line instead of reintroducing ninety.
//
// It also closes the case the fallbacks never covered. `express.json()` in strict
// mode accepts a top-level array, so `[1,2,3]` reaches a handler as an array, and
// `req.body ?? {}` passes it straight through — every field then reads as undefined
// and the route answers some incidental complaint. An array is not a body: it
// becomes an empty one, and the route's own required-field check says so plainly.
export function ensureBody(req, _res, next) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) req.body = {}
  next()
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
  // A password or passphrase, on the two public auth routes. Deliberately far looser
  // than anything a human types or a password manager generates (those top out around
  // 64), because the cost of being wrong here is a locked-out agent, not a slow one —
  // and the thing being defended against is measured in megabytes, not characters.
  //
  // What it defends: both routes hand this string straight to scryptSync, which is
  // synchronous by design and already ~100ms of deliberate work. A 25MB password took
  // 229ms of that instead — not the amplification the email field had, but it is the
  // event loop, on an unauthenticated route, and there is no reason to carry 25MB into
  // a KDF to find out the answer is no.
  PASSWORD: 1024,
  // One side of an email posted by an inbound-parse webhook (Mailgun / SendGrid /
  // Cloudflare Email Worker) — the text part or the HTML part, bounded separately.
  //
  // Unlike every other bound here this one is not about what gets stored, it is about
  // what gets *scanned*. parsePortalEmail runs ten chained regex passes over the body
  // and then builds a fresh RegExp per label; the cost is worse than linear, and it is
  // all on the event loop. Measured: 1MB of HTML blocks for 41ms, 25MB for 1.85s. The
  // route is public, so the 25MB express.json allowance — which exists for the media
  // library's base64 uploads on an authenticated route — was reachable by anyone who
  // knew an ingest token, at 240 requests a minute.
  //
  // Portal notification emails are a few KB of text and tens of KB of HTML. Half a
  // megabyte still admits an inlined logo and a long quoted thread, and holds the
  // worst case to about 15ms.
  EMAIL_PART: 512_000,
}

// --- Link fields -----------------------------------------------------------
// TEXT.URL bounds how LONG a link may be. Nothing bounded what SCHEME it used, and
// a stored link is not inert: `brochure_url` is rendered by the app as
//
//   <a href={property.brochure_url}>Brochure added — view</a>
//
// and React renders a `javascript:` href with a console warning and no more. So an
// agent could save a listing whose brochure link was a script, and it ran on our own
// origin for whoever opened the listing next — which, on a team account, is a
// manager or a teammate, and where the session token lives in localStorage. A
// listing is exactly the object a team shares, so the reach was the whole team.
//
// The rule was already written down elsewhere: micropage.js has `safeUrl`, which
// emits only http(s) into an attribute, because the public page was understood to be
// rendering strangers' data. The in-app screens render the same columns and never
// got the same treatment.
//
// Two shapes are legitimate here and nothing else is:
//   - an absolute http(s) URL — a brochure hosted elsewhere, a portal listing;
//   - a root-relative path — what saveUpload returns when PUBLIC_BASE_URL is unset.
//
// `//evil.com` is deliberately NOT relative: it is protocol-relative and resolves to
// another origin, so a `startsWith('/')` test alone would wave through exactly the
// off-site link this is here to keep out of the database.
//
// Not applied to `avatar_url`: that one is stored as a `data:` URI on purpose, and it
// only ever reaches an <img src>, where a data: URI cannot execute.
const isSafeUrl = (value) => {
  const s = String(value).trim()
  if (!s) return true // an empty string clears the field; the column allows it
  if (s.startsWith('//')) return false // protocol-relative → another origin
  if (s.startsWith('/')) return true // our own /uploads/… path
  return /^https?:\/\//i.test(s)
}

export function boundedUrl(fields) {
  const names = Array.isArray(fields) ? fields : Object.keys(fields)
  return function boundedUrlMiddleware(req, res, next) {
    const body = req.body
    if (!body || typeof body !== 'object' || Array.isArray(body)) return next()
    for (const field of names) {
      const value = body[field]
      if (value == null) continue
      // `photos` is a JSONB array of links, and one bad entry is enough — every one
      // of them ends up in an attribute.
      const values = Array.isArray(value) ? value : [value]
      for (const one of values) {
        if (typeof one !== 'string') continue // a non-string link is the route's complaint, not ours
        if (!isSafeUrl(one)) {
          return res.status(400).json({
            error: `${field} must be a web link starting with http:// or https://`,
            code: 'FIELD_NOT_A_URL',
            field,
          })
        }
      }
    }
    next()
  }
}

// --- Bounded numbers -------------------------------------------------------
// The numeric half of the same problem boundedText solves, and until this it had two
// distinct failure modes, both of them ours:
//
//   1. A filter that isn't a number 500ed. `?min_price=abc` became `Number('abc')` =
//      NaN, which is not null, so it was appended to the WHERE clause and travelled to
//      Postgres as the string 'NaN' against a bigint column — 22P02, uncaught, "500
//      Something went wrong on our side". It was the caller's input that was wrong,
//      and a stale bookmark or a cleared filter field was enough to trip it.
//   2. A number that is real but absurd was stored. A price of -5000 paise, a size of
//      -900 sqft and a deal worth minus one rupee were all accepted, because the
//      column type is the only thing that was checking. Nothing downstream expects
//      negative money: the matcher compares it against budgets, the invoice sums it,
//      and the dashboard renders it as "-₹50".
//
// So the bound is declared per route, next to what it protects, exactly like
// boundedText — and for the same reason: `lead_id` is a row id in one place and
// `floor` legitimately goes negative for a basement, and one inferred rule would be
// wrong somewhere. An absent field is not this guard's business (a route's own
// required-field check owns that), so null, undefined and '' pass through untouched.
export function boundedNumber(limits, { from = 'body' } = {}) {
  const entries = Object.entries(limits)
  return function boundedNumberMiddleware(req, res, next) {
    const source = from === 'query' ? req.query : req.body
    if (!source || typeof source !== 'object' || Array.isArray(source)) return next()
    for (const [field, spec] of entries) {
      const raw = source[field]
      // Absent, or a filter the UI cleared to the empty string.
      if (raw == null || (typeof raw === 'string' && raw.trim() === '')) continue
      const { min = -Infinity, max = Infinity, integer = false } = spec
      // Only a number or a numeric string is a number. `true` coerces to 1 and an
      // array of one coerces to its element, and neither is what the caller meant.
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
      if (!Number.isFinite(n)) {
        return res.status(400).json({ error: `${field} must be a number.`, code: 'FIELD_NOT_A_NUMBER', field })
      }
      if (integer && !Number.isInteger(n)) {
        return res.status(400).json({ error: `${field} must be a whole number.`, code: 'FIELD_NOT_A_NUMBER', field })
      }
      if (n < min || n > max) {
        return res.status(400).json({
          error: `${field} must be between ${min} and ${max}.`,
          code: 'FIELD_OUT_OF_RANGE',
          field,
          min,
          max,
        })
      }
    }
    next()
  }
}

// The ranges the schema actually holds, named after the kind of number rather than
// the column, so a route declares what it is bounding instead of repeating a bound
// whose meaning has to be guessed. Same intent as TEXT above.
export const NUM = {
  // Money, always paise in a BIGINT column. The ceiling is JS's safe-integer limit,
  // not the column's: anything past 2^53 arrives from JSON already rounded, so a
  // larger bound would only promise a precision we cannot keep. ₹90,07,19,92,54,740
  // is well past any deal an Indian broker will book.
  PAISE: { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true },
  // A percentage in a NUMERIC(5,2) column — commission, GST. Two decimals is the
  // column's business; the range is ours.
  PERCENT: { min: 0, max: 100 },
  // A row id used as a filter. Same shape as a path :id, for the same reason.
  ID: { min: 1, max: 2147483647, integer: true },
  // Carpet or built-up area. A DOUBLE, so fractions are fine, but not a negative one
  // and not a number that could only be a typo.
  AREA: { min: 0, max: 10_000_000 },
  // A floor number. Goes negative — basement parking is B1/B2 — and the tallest
  // building in the world has 163.
  FLOOR: { min: -10, max: 300, integer: true },
  // An hour on a 24h clock, for the quiet-hours window.
  HOUR: { min: 0, max: 23, integer: true },
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
