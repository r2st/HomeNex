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
