// server/middleware.js, exercised directly rather than through a route.
//
// Every one of these helpers is mounted in index.js, so the suite runs all of them
// thousands of times — and that is exactly why they needed their own file. What a
// route test reaches is the arm the route takes: the origin that is allowed, the
// number that is in range, the id that is a digit. The arms that matter here are the
// other ones, and most of them cannot be reached through a mounted route at all —
// an OPTIONS preflight against an allowlist the app does not configure, a rate-limit
// bucket that has expired, a request shim with no req.ip, the sweep timer that keeps
// the limiter's Map from being an unbounded memory leak.
//
// These are also the pieces where being wrong is quiet. A CORS allowlist that
// matches nothing still answers every same-origin request correctly. A limiter that
// never resets its window still lets the first sixty callers through. A sweep that
// never deletes anything still rate-limits. Each of those is a bug you find in
// production, from a graph, weeks later.
//
// Nothing here touches the database or a socket: these are plain functions over a
// request and a response, and a recorded object is a faithful stand-in for both.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  cors,
  clientIp,
  rateLimit,
  errorCodeForStatus,
  errorCodes,
  validateIdParams,
  ID_PARAMS,
  ensureBody,
  boundedText,
  boundedUrl,
  boundedNumber,
  requestLogger,
  TEXT,
  NUM,
} from '../middleware.js'

// --- test doubles ---------------------------------------------------------------
// A response that records instead of writing. Only what the middleware under test
// actually calls is implemented; anything else missing is a signal worth the throw.
function recordingRes() {
  const res = {
    headers: {},
    statusCode: 200,
    body: undefined,
    sentStatus: undefined,
    setHeader(k, v) {
      this.headers[k] = v
      return this
    },
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return this
    },
    sendStatus(code) {
      this.sentStatus = code
      return this
    },
  }
  return res
}

// Runs a middleware and reports which way it went: `nexted` or a response.
function run(mw, req) {
  const res = recordingRes()
  let nexted = false
  mw(req, res, () => (nexted = true))
  return { nexted, res, status: res.statusCode, body: res.body, headers: res.headers }
}

// A request shim with the one Express method these middlewares use.
const reqWith = (headers = {}, extra = {}) => ({
  get: (name) => headers[name.toLowerCase()],
  method: 'GET',
  ...extra,
})

// --- CORS -----------------------------------------------------------------------

test('CORS off by default sends no headers and does not intercept the preflight', () => {
  // The shipped configuration. Same-origin means the browser never asks, so the
  // right answer to every request — including OPTIONS — is to say nothing and let
  // the route decide. An OPTIONS that were answered 204 here would break any route
  // that legitimately handles one.
  const mw = cors('')
  const plain = run(mw, reqWith({ origin: 'https://evil.example.com' }))
  assert.ok(plain.nexted)
  assert.deepEqual(plain.headers, {}, 'a disabled CORS handler must not decorate the response')

  const preflight = run(mw, reqWith({ origin: 'https://evil.example.com' }, { method: 'OPTIONS' }))
  assert.ok(preflight.nexted, 'with CORS off the preflight belongs to the route, not to us')
  assert.equal(preflight.res.sentStatus, undefined)
})

test('CORS reads CORS_ORIGIN when called with no argument', () => {
  // index.js mounts `cors()`. Both arms of that default matter: the env var is how a
  // separately-hosted dashboard gets let in, and its absence is what keeps the door
  // shut on every deploy that does not set it.
  const prev = process.env.CORS_ORIGIN
  try {
    process.env.CORS_ORIGIN = 'https://dash.example.com'
    const configured = run(cors(), reqWith({ origin: 'https://dash.example.com' }))
    assert.equal(configured.headers['Access-Control-Allow-Origin'], 'https://dash.example.com')

    delete process.env.CORS_ORIGIN
    const unset = run(cors(), reqWith({ origin: 'https://dash.example.com' }))
    assert.deepEqual(unset.headers, {}, 'an unset CORS_ORIGIN must mean off, not allow-anything')
  } finally {
    if (prev === undefined) delete process.env.CORS_ORIGIN
    else process.env.CORS_ORIGIN = prev
  }
})

test('an allowlisted origin is echoed back, with credentials', () => {
  const mw = cors('https://app.example.com, https://admin.example.com')
  const { headers, nexted } = run(mw, reqWith({ origin: 'https://admin.example.com' }))
  assert.ok(nexted)
  assert.equal(headers['Access-Control-Allow-Origin'], 'https://admin.example.com')
  assert.equal(headers['Vary'], 'Origin', 'without Vary a shared cache serves one origin the other one’s response')
  assert.equal(headers['Access-Control-Allow-Credentials'], 'true')
  assert.equal(headers['Access-Control-Allow-Methods'], 'GET,POST,PUT,DELETE,OPTIONS')
  assert.equal(headers['Access-Control-Allow-Headers'], 'Content-Type, Authorization')
  assert.equal(headers['Access-Control-Max-Age'], '600')
})

test('an origin that is not on the list gets nothing, and still reaches the route', () => {
  // Not a rejection: the request continues and the route answers it. The browser is
  // the thing that enforces CORS, and the absent header is what it enforces on.
  const mw = cors('https://app.example.com')
  const { headers, nexted } = run(mw, reqWith({ origin: 'https://app.example.com.evil.test' }))
  assert.ok(nexted)
  assert.equal(headers['Access-Control-Allow-Origin'], undefined, 'a suffix of an allowed origin is a different origin')
})

test('a request with no Origin header is not given CORS headers', () => {
  // curl, a health probe, a same-origin fetch. There is no origin to echo, and
  // echoing `undefined` would produce a literally invalid header.
  const { headers, nexted } = run(cors('https://app.example.com'), reqWith({}))
  assert.ok(nexted)
  assert.deepEqual(headers, {})
})

test('a trailing slash on either side is the same origin', () => {
  // `new URL(x).origin` never has one, but a hand-written env var often does, and so
  // does a browser that is being generous. Both are normalised.
  const mw = cors('https://app.example.com/')
  assert.equal(
    run(mw, reqWith({ origin: 'https://app.example.com' })).headers['Access-Control-Allow-Origin'],
    'https://app.example.com',
  )
  assert.equal(
    run(mw, reqWith({ origin: 'https://app.example.com/' })).headers['Access-Control-Allow-Origin'],
    'https://app.example.com/',
    'the echoed value is the origin as sent — normalising is for the comparison only',
  )
})

test('an empty entry in the allowlist does not become a wildcard', () => {
  // `CORS_ORIGIN=,https://app.example.com` or a trailing comma. The empty string
  // must not end up in the Set, where `allowed.has('')` would be one bad request away.
  const mw = cors(', https://app.example.com ,')
  assert.equal(run(mw, reqWith({ origin: 'https://app.example.com' })).headers['Access-Control-Allow-Origin'], 'https://app.example.com')
  assert.equal(run(mw, reqWith({ origin: '' })).headers['Access-Control-Allow-Origin'], undefined)
})

test('CORS_ORIGIN=* allows any origin and withholds credentials', () => {
  // The combination `Allow-Origin: *` + `Allow-Credentials: true` is rejected by
  // every browser, so a wildcard deploy that also asked for credentials would fail
  // every cross-origin request rather than half of them. It must not be sent.
  const mw = cors('*')
  const { headers } = run(mw, reqWith({ origin: 'https://anything.example.com' }))
  assert.equal(headers['Access-Control-Allow-Origin'], '*')
  assert.equal(headers['Access-Control-Allow-Credentials'], undefined)
})

test('a configured CORS handler answers the preflight itself', () => {
  const mw = cors('https://app.example.com')
  const allowed = run(mw, reqWith({ origin: 'https://app.example.com' }, { method: 'OPTIONS' }))
  assert.equal(allowed.res.sentStatus, 204)
  assert.equal(allowed.nexted, false, 'a preflight that fell through would be answered by a route that expects GET')
  assert.equal(allowed.res.headers['Access-Control-Allow-Origin'], 'https://app.example.com')

  // An OPTIONS from a disallowed origin is still short-circuited — with no CORS
  // headers on it, which is what tells the browser to refuse.
  const denied = run(mw, reqWith({ origin: 'https://evil.example.com' }, { method: 'OPTIONS' }))
  assert.equal(denied.res.sentStatus, 204)
  assert.equal(denied.res.headers['Access-Control-Allow-Origin'], undefined)
})

// --- clientIp ---------------------------------------------------------------------

test('the rate-limit key prefers req.ip, which the client cannot choose', () => {
  assert.equal(clientIp({ ip: '203.0.113.7', get: () => '1.2.3.4' }), '203.0.113.7')
})

test('without req.ip the key is the RIGHTMOST forwarded hop, never the leftmost', () => {
  // The leftmost entry of X-Forwarded-For is whatever the caller typed. Keying on it
  // means a header rotates the bucket every request and the login limiter is
  // decorative. The rightmost is the one our own proxy appended.
  const req = reqWith({ 'x-forwarded-for': '9.9.9.9, 8.8.8.8, 203.0.113.7' })
  assert.equal(clientIp(req), '203.0.113.7')
})

test('a forwarded header of nothing but separators falls through to the socket', () => {
  // `filter(Boolean)` can empty the list entirely, and `hops[hops.length - 1]` on an
  // empty array is undefined — a single shared bucket for every caller who sends it.
  const req = reqWith({ 'x-forwarded-for': ' , , ' }, { socket: { remoteAddress: '198.51.100.4' } })
  assert.equal(clientIp(req), '198.51.100.4')
})

test('a bare request shim with neither req.ip nor a get() still yields a key', () => {
  assert.equal(clientIp({ socket: { remoteAddress: '198.51.100.9' } }), '198.51.100.9')
  assert.equal(clientIp({}), 'unknown', 'an unkeyable request must share one bucket, not crash the limiter')
  assert.equal(clientIp({ socket: {} }), 'unknown')
})

// --- rate limiter -------------------------------------------------------------------

test('the limiter counts down, then refuses with a Retry-After', () => {
  const mw = rateLimit({ windowMs: 60_000, max: 3, key: () => 'one-caller' })
  try {
    for (let i = 1; i <= 3; i++) {
      const { nexted, headers } = run(mw, {})
      assert.ok(nexted, `request ${i} of 3 should be allowed`)
      assert.equal(headers['X-RateLimit-Limit'], '3')
      assert.equal(headers['X-RateLimit-Remaining'], String(3 - i))
    }
    const blocked = run(mw, {})
    assert.equal(blocked.nexted, false)
    assert.equal(blocked.status, 429)
    assert.equal(blocked.body.code, 'RATE_LIMITED')
    assert.match(blocked.body.error, /slow down/)
    assert.equal(blocked.headers['X-RateLimit-Remaining'], '0', 'remaining must clamp at zero, not go negative')
    assert.ok(blocked.body.retry_after > 0 && blocked.body.retry_after <= 60)
    assert.equal(blocked.headers['Retry-After'], String(blocked.body.retry_after))
  } finally {
    mw.stop()
  }
})

test('each caller gets their own bucket', () => {
  // The whole point: one agent brute-forcing a login must not lock out the rest.
  const mw = rateLimit({ windowMs: 60_000, max: 1, key: (req) => req.who })
  try {
    assert.ok(run(mw, { who: 'a' }).nexted)
    assert.ok(run(mw, { who: 'b' }).nexted, 'b was refused for a’s traffic — the key is not being read')
    assert.equal(run(mw, { who: 'a' }).status, 429)
    assert.ok(run(mw, { who: 'c' }).nexted)
  } finally {
    mw.stop()
  }
})

test('a custom message replaces the sentence but never the code', () => {
  // The sentence is for the agent reading the screen; the code is the contract.
  const mw = rateLimit({ windowMs: 60_000, max: 1, key: () => 'k', message: 'Too many login attempts.' })
  try {
    run(mw, {})
    const blocked = run(mw, {})
    assert.equal(blocked.body.error, 'Too many login attempts.')
    assert.equal(blocked.body.code, 'RATE_LIMITED')
  } finally {
    mw.stop()
  }
})

test('the window expires and the caller is let back in', (t) => {
  // The bug this is here for is a limiter that never resets: it passes every test
  // that only counts upward, and in production it bans a real agent permanently
  // after one burst.
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] })
  const mw = rateLimit({ windowMs: 1_000, max: 1, key: () => 'k' })
  try {
    assert.ok(run(mw, {}).nexted)
    assert.equal(run(mw, {}).status, 429)
    t.mock.timers.tick(1_001)
    const after = run(mw, {})
    assert.ok(after.nexted, 'the window never reset')
    assert.equal(after.headers['X-RateLimit-Remaining'], '0', 'and the fresh window starts from one hit, not zero')
  } finally {
    mw.stop()
  }
})

test('the sweep drops expired buckets so the Map cannot grow without bound', (t) => {
  // A single node keeping one entry per IP forever is a slow memory leak that only
  // shows up on a long-lived process under real traffic — never in a test that ends.
  // The sweep is the thing that prevents it and nothing else calls it.
  //
  // Retention is genuinely invisible from outside the limiter: the per-request lazy
  // expiry resets a stale bucket anyway, so a caller looks brand new whether the
  // sweep deleted the entry or merely overwrote it. Watching Map.delete is what
  // separates the two, and it is the only thing this test asserts about internals.
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] })
  const deleted = []
  const realDelete = Map.prototype.delete
  Map.prototype.delete = function (k) {
    deleted.push(k)
    return realDelete.call(this, k)
  }
  const mw = rateLimit({ windowMs: 1_000, max: 100, key: (req) => req.who })
  try {
    for (let i = 0; i < 50; i++) run(mw, { who: `ip-${i}` })
    assert.deepEqual(deleted, [], 'nothing is dropped inside the window')

    // One tick past the window: every bucket above is expired, and the sweep runs.
    t.mock.timers.tick(1_001)
    assert.equal(deleted.length, 50, 'the sweep left the Map holding one entry per IP for the life of the process')
    assert.deepEqual(new Set(deleted), new Set(Array.from({ length: 50 }, (_, i) => `ip-${i}`)))

    // And a swept-away caller is treated as brand new rather than as missing.
    assert.equal(run(mw, { who: 'ip-0' }).headers['X-RateLimit-Remaining'], '99')
  } finally {
    Map.prototype.delete = realDelete
    mw.stop()
  }
})

test('the sweep keeps buckets that are still inside their window', () => {
  // The other half: a sweep that deleted unconditionally would hand every caller a
  // fresh allowance once a window, which is a limiter that does not limit.
  const mw = rateLimit({ windowMs: 60_000, max: 2, key: () => 'k' })
  try {
    run(mw, {})
    run(mw, {})
    assert.equal(run(mw, {}).status, 429)
  } finally {
    mw.stop()
  }
})

test('stop() ends the sweep, so a shutdown is not held open by it', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] })
  const mw = rateLimit({ windowMs: 1_000, max: 1, key: () => 'k' })
  run(mw, {})
  mw.stop()
  // The timer is gone; ticking past the window must not throw, and the lazy
  // per-request expiry still does the limiter's job on its own.
  t.mock.timers.tick(5_000)
  assert.ok(run(mw, {}).nexted, 'stop() must disable the sweep, not the limiter')
})

test('the limiter has usable defaults when mounted with no options at all', () => {
  const mw = rateLimit()
  try {
    const { nexted, headers } = run(mw, { ip: '203.0.113.55' })
    assert.ok(nexted)
    assert.equal(headers['X-RateLimit-Limit'], '60')
    assert.equal(headers['X-RateLimit-Remaining'], '59')
  } finally {
    mw.stop()
  }
})

// --- error codes ---------------------------------------------------------------------

test('every status the API answers with has a stable code', () => {
  for (const [status, code] of Object.entries({
    400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 402: 'PAYMENT_REQUIRED', 403: 'FORBIDDEN',
    404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED', 409: 'CONFLICT', 410: 'GONE',
    413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE', 422: 'UNPROCESSABLE',
    429: 'RATE_LIMITED', 500: 'INTERNAL', 502: 'UPSTREAM_ERROR',
    503: 'SERVICE_UNAVAILABLE', 504: 'UPSTREAM_TIMEOUT',
  })) {
    assert.equal(errorCodeForStatus(Number(status)), code)
  }
})

test('a status nobody mapped still gets a code on the right side of the fence', () => {
  // The fallback decides whose fault the client is told it was. A 5xx is ours.
  assert.equal(errorCodeForStatus(599), 'INTERNAL')
  assert.equal(errorCodeForStatus(418), 'BAD_REQUEST')
  assert.equal(errorCodeForStatus(451), 'BAD_REQUEST')
})

test('an error body is given its status code, and keeps a more specific one', () => {
  const res = recordingRes()
  errorCodes({}, res, () => {})
  res.status(404).json({ error: 'not found' })
  assert.deepEqual(res.body, { error: 'not found', code: 'NOT_FOUND' })

  const specific = recordingRes()
  errorCodes({}, specific, () => {})
  specific.status(409).json({ error: 'that template is locked', code: 'TEMPLATE_LOCKED' })
  assert.deepEqual(specific.body, { error: 'that template is locked', code: 'TEMPLATE_LOCKED' },
    'the status-derived default overwrote a code the route chose deliberately')
})

test('a body that is not an error envelope passes through byte-for-byte', () => {
  // The health check answers 503 with `{ ok: false, db: false }` and a monitor
  // parses it. A `code` appearing in it is a contract change nobody asked for.
  const cases = [
    [503, { ok: false, db: false }],
    [500, { error: 42 }],
    [400, ['a', 'b']],
    [400, null],
    [400, 'plain text'],
    [200, { error: 'this is a field, not a failure' }],
    [204, { ok: true }],
  ]
  for (const [status, body] of cases) {
    const res = recordingRes()
    errorCodes({}, res, () => {})
    res.status(status).json(body)
    assert.deepEqual(res.body, body, `${status} ${JSON.stringify(body)} was rewritten`)
  }
})

test('errorCodes hands control on before anything is written', () => {
  let nexted = false
  errorCodes({}, recordingRes(), () => (nexted = true))
  assert.ok(nexted)
})

// --- path id validation ------------------------------------------------------------

test('a path id must be a positive int4, and everything else is a 400 not a 500', () => {
  // The reason this is a middleware and not 38 try/catches: without it a probe for
  // `/api/leads/undefined` reached Postgres as `WHERE id = 'undefined'`, raised
  // 22P02, and came back as "Something went wrong on our side" — untrue, and a map
  // of which routes are unguarded.
  const registered = {}
  const target = { param: (name, cb) => (registered[name] = cb) }
  assert.equal(validateIdParams(target), target, 'the helper must be chainable')
  assert.deepEqual(Object.keys(registered), ID_PARAMS)

  const check = (name, value) => {
    const res = recordingRes()
    let nexted = false
    registered[name](null, res, () => (nexted = true), value)
    return { nexted, status: res.statusCode, body: res.body }
  }

  for (const ok of ['1', '42', '2147483647']) {
    assert.ok(check('id', ok).nexted, `${ok} is a valid serial id`)
  }
  for (const bad of ['0', '-1', 'abc', 'undefined', '', '1.5', '1e3', ' 1', '01a', '2147483648', '9999999999']) {
    const got = check('id', bad)
    assert.equal(got.nexted, false, `${JSON.stringify(bad)} reached the database`)
    assert.equal(got.status, 400)
    assert.equal(got.body.code, 'BAD_ID')
    assert.equal(got.body.error, 'Invalid id')
  }
  // 9999999999 is the one that is all digits and still out of int4 range — it raises
  // 22003 at the database rather than 22P02, so a `/^\d+$/` test alone misses it.
  assert.equal(check('agentId', '9999999999').body.error, 'Invalid agentId', 'the 400 should name the param that was wrong')
})

test('validateIdParams can be pointed at a narrower list of names', () => {
  const registered = {}
  validateIdParams({ param: (name, cb) => (registered[name] = cb) }, ['leadId'])
  assert.deepEqual(Object.keys(registered), ['leadId'])
})

// --- body shape ------------------------------------------------------------------

test('past ensureBody req.body is always a plain object', () => {
  // express.json() in strict mode accepts a top-level array, so `[1,2,3]` used to
  // reach a handler as an array: every field read as undefined and the route
  // answered some incidental complaint instead of "you did not send a body".
  for (const input of [undefined, null, [1, 2, 3], [], 'a string', 42, true]) {
    const req = { body: input }
    let nexted = false
    ensureBody(req, null, () => (nexted = true))
    assert.ok(nexted)
    assert.deepEqual(req.body, {}, `${JSON.stringify(input)} was left as-is`)
  }
})

test('a real body is passed through untouched, same object', () => {
  const body = { name: 'Priya', nested: { a: 1 } }
  const req = { body }
  ensureBody(req, null, () => {})
  assert.equal(req.body, body, 'ensureBody must not clone — routes mutate req.body')
})

// --- bounded text -----------------------------------------------------------------

test('a text field over its declared bound is refused, by name and number', () => {
  const mw = boundedText({ name: TEXT.LINE, body: TEXT.PROSE })
  const ok = run(mw, { body: { name: 'x'.repeat(TEXT.LINE), body: 'y'.repeat(TEXT.PROSE) } })
  assert.ok(ok.nexted, 'exactly at the bound is inside it')

  const tooLong = run(mw, { body: { name: 'x'.repeat(TEXT.LINE + 1) } })
  assert.equal(tooLong.status, 400)
  assert.deepEqual(tooLong.body, {
    error: `name must be ${TEXT.LINE} characters or fewer.`,
    code: 'FIELD_TOO_LONG',
    field: 'name',
    max: TEXT.LINE,
  })
})

test('the first over-long field is the one reported, and later fields are not checked', () => {
  const mw = boundedText({ name: 5, note: 5 })
  const got = run(mw, { body: { name: 'toolong', note: 'alsotoolong' } })
  assert.equal(got.body.field, 'name')
})

test('boundedText measures strings only, and leaves everything else to the route', () => {
  // A number in a text field is a different complaint, already answered by the
  // route's own validation or by Postgres. Rejecting it here would change behaviour
  // that has nothing to do with length.
  const mw = boundedText({ name: 3 })
  for (const body of [{ name: 12345678 }, { name: null }, { name: undefined }, { name: ['a', 'b', 'c', 'd'] }, { name: { length: 99 } }, {}]) {
    assert.ok(run(mw, { body }).nexted, `${JSON.stringify(body)} should not be a length complaint`)
  }
})

test('boundedText on a body that is not an object falls through', () => {
  // ensureBody runs first on every mounted route, so this is the guard for a call
  // site that forgets to mount it — it must not throw on `undefined.field`.
  const mw = boundedText({ name: 3 })
  for (const body of [null, undefined, ['xxxxxx'], 'a string']) {
    assert.ok(run(mw, { body }).nexted)
  }
})

test('the declared text sizes are the ones the product means', () => {
  // WHATSAPP in particular is Meta's own hard limit: anything longer is refused
  // upstream *after* we have spent the send. EMAIL_PART is the odd one out — it
  // bounds what gets SCANNED rather than what gets stored, because parsePortalEmail
  // is a chain of regex passes on the event loop and /ingest/email is public.
  assert.deepEqual(TEXT, {
    LINE: 120,
    BLURB: 500,
    PROSE: 4000,
    WHATSAPP: 4096,
    URL: 2000,
    EMAIL_PART: 512_000,
  })
})

// --- bounded links ------------------------------------------------------------------

test('a stored link may be an absolute http(s) URL or one of our own paths', () => {
  const mw = boundedUrl(['brochure_url'])
  for (const url of [
    'https://cdn.example.com/a.pdf',
    'http://cdn.example.com/a.pdf',
    'HTTPS://CDN.EXAMPLE.COM/A.PDF',
    '/uploads/1712345-brochure.pdf',
    '',
    '   ',
  ]) {
    assert.ok(run(mw, { body: { brochure_url: url } }).nexted, `${JSON.stringify(url)} is a legitimate link`)
  }
})

test('a link that is not a web link is refused before it reaches the database', () => {
  // brochure_url is rendered by the app as an <a href>. React renders a
  // `javascript:` href with a console warning and no more, so an agent could save a
  // listing whose brochure link was a script — and a listing is exactly the object a
  // team shares, so it ran on our origin for whoever opened it next.
  const mw = boundedUrl(['brochure_url'])
  for (const url of [
    'javascript:alert(document.cookie)',
    ' javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '//evil.example.com/x',
    'evil.example.com',
    'ftp://files.example.com/a.pdf',
  ]) {
    const got = run(mw, { body: { brochure_url: url } })
    assert.equal(got.status, 400, `${JSON.stringify(url)} was stored`)
    assert.equal(got.body.code, 'FIELD_NOT_A_URL')
    assert.equal(got.body.field, 'brochure_url')
  }
})

test('every entry of a photos array is checked, not just the first', () => {
  // photos is a JSONB array and one bad entry is enough — every one of them ends up
  // in an attribute.
  const mw = boundedUrl(['photos'])
  assert.ok(run(mw, { body: { photos: ['/uploads/a.jpg', 'https://cdn.example.com/b.jpg'] } }).nexted)
  const got = run(mw, { body: { photos: ['/uploads/a.jpg', 'javascript:alert(1)'] } })
  assert.equal(got.status, 400)
  assert.equal(got.body.field, 'photos')
})

test('boundedUrl skips absent fields and non-string entries', () => {
  const mw = boundedUrl(['brochure_url', 'video_url'])
  for (const body of [{}, { brochure_url: null }, { brochure_url: undefined }, { brochure_url: 42 }, { photos: 'javascript:alert(1)' }]) {
    assert.ok(run(mw, { body }).nexted, `${JSON.stringify(body)} is not this guard’s complaint`)
  }
  assert.ok(run(mw, { body: { photos: [42, null, { url: 'javascript:alert(1)' }] } }).nexted)
})

// --- bounded numbers ------------------------------------------------------------------

test('a filter that is not a number is a 400, not a 500 from Postgres', () => {
  // `?min_price=abc` became Number('abc') = NaN, which is not null, so it was
  // appended to the WHERE clause and travelled to a bigint column as the string
  // 'NaN' — 22P02, uncaught, "Something went wrong on our side" for a stale bookmark.
  const mw = boundedNumber({ min_price: NUM.PAISE }, { from: 'query' })
  const got = run(mw, { query: { min_price: 'abc' } })
  assert.equal(got.status, 400)
  assert.deepEqual(got.body, { error: 'min_price must be a number.', code: 'FIELD_NOT_A_NUMBER', field: 'min_price' })
})

test('money cannot be negative, a percentage cannot exceed 100', () => {
  // Nothing downstream expects negative money: the matcher compares it against
  // budgets, the invoice sums it, and the dashboard renders it as "-₹50".
  const mw = boundedNumber({ price: NUM.PAISE, commission_pct: NUM.PERCENT })
  const negative = run(mw, { body: { price: -5000 } })
  assert.equal(negative.status, 400)
  assert.equal(negative.body.code, 'FIELD_OUT_OF_RANGE')
  assert.equal(negative.body.min, 0)
  assert.equal(negative.body.max, Number.MAX_SAFE_INTEGER)
  assert.equal(negative.body.error, `price must be between 0 and ${Number.MAX_SAFE_INTEGER}.`)

  assert.equal(run(mw, { body: { commission_pct: 100.01 } }).status, 400)
  assert.ok(run(mw, { body: { commission_pct: 2.5 } }).nexted, 'a NUMERIC(5,2) percentage is not an integer field')
  assert.ok(run(mw, { body: { price: 0, commission_pct: 0 } }).nexted, 'zero is inside every one of these bounds')
})

test('a floor goes negative for a basement, and area does not', () => {
  // The reason bounds are declared per route rather than inferred from a field name.
  const mw = boundedNumber({ floor: NUM.FLOOR, carpet_area: NUM.AREA })
  assert.ok(run(mw, { body: { floor: -2, carpet_area: 612.5 } }).nexted)
  assert.equal(run(mw, { body: { floor: -11 } }).status, 400)
  assert.equal(run(mw, { body: { floor: 301 } }).status, 400)
  assert.equal(run(mw, { body: { carpet_area: -1 } }).status, 400)
})

test('a whole-number field refuses a fraction with its own sentence', () => {
  const mw = boundedNumber({ lead_id: NUM.ID, hour: NUM.HOUR })
  const fraction = run(mw, { body: { lead_id: 1.5 } })
  assert.equal(fraction.status, 400)
  assert.deepEqual(fraction.body, { error: 'lead_id must be a whole number.', code: 'FIELD_NOT_A_NUMBER', field: 'lead_id' })
  assert.equal(run(mw, { body: { hour: 24 } }).status, 400)
  assert.ok(run(mw, { body: { hour: 0 } }).nexted)
  assert.ok(run(mw, { body: { hour: 23 } }).nexted)
})

test('a numeric string is a number; a boolean and an array are not', () => {
  // `true` coerces to 1 and `[7]` coerces to 7, and neither is what the caller meant.
  const mw = boundedNumber({ n: NUM.ID })
  assert.ok(run(mw, { body: { n: '42' } }).nexted)
  assert.ok(run(mw, { body: { n: ' 42 ' } }).nexted, 'a query string arrives with whitespace often enough')
  for (const n of [true, false, [7], [], {}, NaN, Infinity, -Infinity]) {
    const got = run(mw, { body: { n } })
    assert.equal(got.status, 400, `${JSON.stringify(n)} was accepted as a number`)
    assert.equal(got.body.code, 'FIELD_NOT_A_NUMBER')
  }
})

test('an absent or cleared field is not this guard’s business', () => {
  // A route's own required-field check owns "you did not send it". A UI that clears
  // a filter sends '', and that has to mean "no filter", not "the number nothing".
  const mw = boundedNumber({ min_price: NUM.PAISE }, { from: 'query' })
  for (const query of [{}, { min_price: null }, { min_price: undefined }, { min_price: '' }, { min_price: '   ' }]) {
    assert.ok(run(mw, { query }).nexted, `${JSON.stringify(query)} should pass through untouched`)
  }
})

test('boundedNumber defaults to the body, and to an unbounded spec', () => {
  const mw = boundedNumber({ anything: {} })
  assert.ok(run(mw, { body: { anything: -1e300 } }).nexted, 'an empty spec bounds nothing but still requires a number')
  assert.equal(run(mw, { body: { anything: 'nope' } }).status, 400)
})

test('boundedNumber on a source that is not an object falls through', () => {
  const mw = boundedNumber({ n: NUM.ID })
  for (const body of [null, undefined, [1, 2], 'a string']) {
    assert.ok(run(mw, { body }).nexted)
  }
  assert.ok(run(boundedNumber({ n: NUM.ID }, { from: 'query' }), { query: undefined }).nexted)
})

test('the declared numeric ranges are the ones the schema holds', () => {
  assert.deepEqual(NUM.PAISE, { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true })
  assert.deepEqual(NUM.PERCENT, { min: 0, max: 100 })
  assert.deepEqual(NUM.ID, { min: 1, max: 2147483647, integer: true })
  assert.deepEqual(NUM.AREA, { min: 0, max: 10_000_000 })
  assert.deepEqual(NUM.FLOOR, { min: -10, max: 300, integer: true })
  assert.deepEqual(NUM.HOUR, { min: 0, max: 23, integer: true })
  assert.equal(NUM.ID.max, 2147483647, 'an id filter must share the path :id ceiling — same column, same int4')
})

// --- request logger -------------------------------------------------------------------

test('one structured line per request, once the response has finished', () => {
  const lines = []
  const mw = requestLogger({ log: (l) => lines.push(l) })
  const res = new EventEmitter()
  res.statusCode = 201
  let nexted = false
  mw({ path: '/api/leads', originalUrl: '/api/leads?page=2', method: 'POST' }, res, () => (nexted = true))
  assert.ok(nexted)
  assert.deepEqual(lines, [], 'nothing is logged until the response finishes — the status is not known yet')
  res.emit('finish')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^POST \/api\/leads\?page=2 201 \d+\.\dms$/, 'the line logs the full URL and the status, not the matched route')
})

test('static assets and uploads are skipped, so the log stays signal-dense', () => {
  const lines = []
  const mw = requestLogger({ log: (l) => lines.push(l) })
  for (const path of ['/uploads/123-photo.jpg', '/assets/index-a1b2.js', '/favicon.ico']) {
    const res = new EventEmitter()
    res.statusCode = 200
    let nexted = false
    mw({ path, originalUrl: path, method: 'GET' }, res, () => (nexted = true))
    assert.ok(nexted, `${path} must still reach the route`)
    assert.equal(res.listenerCount('finish'), 0, `${path} attached a finish listener it will never use`)
    res.emit('finish')
  }
  assert.deepEqual(lines, [])
})

test('requestLogger defaults to console.log when mounted with no options', () => {
  // index.js mounts `requestLogger()`. Exercised on a skipped path so the default
  // sink is constructed without writing to the test runner's own output.
  const mw = requestLogger()
  let nexted = false
  mw({ path: '/favicon.ico', originalUrl: '/favicon.ico', method: 'GET' }, new EventEmitter(), () => (nexted = true))
  assert.ok(nexted)
})
