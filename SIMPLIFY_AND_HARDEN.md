# HomeNex — Simplification & Production Hardening

Follow-on to `UI_SIMPLIFICATION.md` (commit e99d9e6). Two tracks: (1) make the app
usable by a non-technical Indian real-estate agent with zero training, (2) harden the
Express+Postgres backend for production. Push to `main`, add tests, keep the existing
513-test suite green (2 pre-existing Docker-clock timing flakes in `window24h` /
`decisionLayer` excepted — environmental, not touched).

Constraints honoured: **no new npm dependencies** (matches the repo's minimal
`express` + `pg` server and `react` client). New logic goes in small pure modules with
co-located `*.test.js` so it runs under `node --test`.

---

## Track 1 — Simplify for layman users

**1.1 Human-friendly errors.** New `src/lib/friendlyError.js` maps raw API error
strings / HTTP codes → plain sentences ("Something went wrong — please try again",
"You're offline. We'll send this when you're back online."). Wired into `api.js` so
every thrown error already carries a human message; a raw `HTTP 500` never reaches the UI.

**1.2 Plain-language glossary + InfoTips.** New `src/lib/glossary.js` centralises the
jargon → one-line explanation map (RERA, WhatsApp Business/WABA, service window,
CTWA/click-to-WhatsApp, syndication, opt-in, leadgen). Components use it via the existing
`InfoTip`. User-facing raw codes ("MANUAL", "leadgen", portal slugs) get plain labels.

**1.3 Styled confirm dialog for destructive actions.** New `Confirm` primitive in
`ui.jsx` (mobile bottom-sheet style, matches theme) replaces jarring `window.confirm`
and guards every destructive action that lacked one: delete property, delete contact,
delete template, delete media, delete label, remove team member, delete group, disband
team, delete follow-up. Destructive button is clearly red; title states the exact object.

**1.4 Action-oriented labels.** Button/label pass: "Create Listing"→"Add Property",
"Create" verbs → "Add/Save/Send", etc. — obvious action words a WhatsApp user recognises.

**1.5 Loading skeletons + error boundary.** New `Skeleton` primitive + `LoadingRows`
for lists that currently flash empty; a root `ErrorBoundary` (in `ui.jsx`, mounted in
`App.jsx`) turns a component crash into a friendly "Something went wrong" card with a
Reload button instead of a white screen.

**1.6 Empty-state CTA sweep.** Confirm every list empty state has a reason + a next
action (most already done in e99d9e6; fill remaining gaps).

Tests: `friendlyError.test.js`, `glossary.test.js` (pure modules, `node --test`).

## Track 2 — Production hardening (backend)

**2.1 `server/middleware.js` (new, no deps):**
- `rateLimit({ windowMs, max, key })` — in-memory fixed-window limiter, keyed by IP.
  Applied strictly to auth (`/api/auth/login`, `/api/auth/signup`) and the public
  ingest/webhook endpoints; returns `429` + `Retry-After`.
- `requestLogger` — structured one-line access log (method, path, status, ms), skips
  static/`/uploads`, gated by `LOG_REQUESTS` (default on outside test).
- `securityHeaders` — `X-Content-Type-Options`, `X-Frame-Options: SAMEORIGIN`,
  `Referrer-Policy`, `X-DNS-Prefetch-Control`.
- `cors(origin)` — configurable via `CORS_ORIGIN` (comma list or `*`); off by default
  since the SPA is served same-origin. Handles preflight `OPTIONS`.

**2.2 `server/env.js` (new):** `validateEnv(env)` pure function returns
`{ ok, errors, warnings }`. In `NODE_ENV=production`, `DATABASE_URL` and `SESSION_SECRET`
are **required** (process exits non-zero if missing); missing WhatsApp/AI/app-secret are
warnings. Unit-tested.

**2.3 `index.js` wiring:**
- Body-parse errors → `400` ("Invalid request body"), payload-too-large → `413`
  (currently both fall to the generic 500 handler).
- JSON `404` for unknown `/api/*` routes (today they fall through to the SPA and 200
  index.html).
- Lightweight `GET /healthz` (no auth, no external Graph call): process up + a real DB
  `SELECT 1` ping → `200 {ok:true}` / `503` on DB failure. Existing `/api/health` stays.
- Security headers + request logger mounted first; rate limiters on the sensitive routes.

**2.4 Lifecycle:**
- Process-level `unhandledRejection` / `uncaughtException` handlers (log; don't hard-exit
  on unhandledRejection).
- The 60s background `setInterval` is captured in a handle and `.unref()`ed.
- Graceful shutdown on `SIGTERM`/`SIGINT`: stop accepting connections, clear the interval,
  `closePool()`, exit — with a force-exit timeout backstop.

**2.5 DB `SELECT 1` health helper** exported from `db.js` for `/healthz`.

Tests: `server/test/hardening.test.js` — rate-limit 429, bad-JSON 400, unknown-api 404
JSON, `/healthz` 200 + shape, security headers present, `validateEnv` cases.

---

Out of scope / deliberately not done: swapping the HMAC session token for JWT-with-expiry
(works today, would invalidate live sessions), adding index migrations without EXPLAIN
evidence of a hot query (would be speculative), and rewriting the 26 components wholesale.
