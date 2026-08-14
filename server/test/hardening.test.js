// Production-hardening tests: env validation, the rate limiter / CORS / security-header
// middleware, and the app-level 400 (bad JSON) / 404 (unknown api) / /healthz behaviours.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { readFileSync } from 'node:fs'
import { createTestDb, dropTestDb } from './helpers.js'
import { validateEnv } from '../env.js'
import { securityHeaders, cors, rateLimit, clientIp } from '../middleware.js'

process.env.NODE_ENV = 'test'
const dbName = await createTestDb('hardening')
const { app } = await import('../index.js')

let server, base
const req = (method, url, body, headers = {}) =>
  fetch(base + url, {
    method,
    headers: { ...headers },
    ...(body !== undefined ? { body } : {}),
  })

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
})

after(async () => {
  const { closePool } = await import('../db.js')
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- validateEnv --------------------------------------------------------------
test('validateEnv: dev config is ok with only warnings', () => {
  const r = validateEnv({ NODE_ENV: 'development' })
  assert.equal(r.ok, true)
  assert.ok(r.warnings.length > 0) // missing WhatsApp/AI/app-secret warn, never fatal
})

test('validateEnv: production requires DATABASE_URL and SESSION_SECRET', () => {
  const r = validateEnv({ NODE_ENV: 'production' })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => /DATABASE_URL/.test(e)))
  assert.ok(r.errors.some((e) => /SESSION_SECRET/.test(e)))
})

test('validateEnv: production passes with the required secrets set', () => {
  const r = validateEnv({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://u:p@db.internal:5432/homenex',
    SESSION_SECRET: 'a'.repeat(32),
    PUBLIC_BASE_URL: 'https://homenex.example',
    WHATSAPP_ACCESS_TOKEN: 'x',
    WHATSAPP_PHONE_NUMBER_ID: 'y',
    OPENROUTER_API_KEY: 'z',
    WHATSAPP_APP_SECRET: 's',
    WHATSAPP_VERIFY_TOKEN: 'a-token-of-our-own',
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.warnings, [])
})

test('validateEnv: production is warned when the webhook handshake is open or dead', () => {
  const warn = (WHATSAPP_VERIFY_TOKEN) =>
    validateEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://u:p@db.internal:5432/homenex',
      SESSION_SECRET: 'a'.repeat(32),
      PUBLIC_BASE_URL: 'https://homenex.example',
      WHATSAPP_ACCESS_TOKEN: 'x',
      WHATSAPP_PHONE_NUMBER_ID: 'y',
      OPENROUTER_API_KEY: 'z',
      WHATSAPP_APP_SECRET: 's',
      WHATSAPP_VERIFY_TOKEN,
    }).warnings

  // Unset: the handshake fails closed, so inbound is dead until it is set. Silent is
  // the wrong way for that to happen.
  assert.ok(warn(undefined).some((w) => /REFUSED \(403\)/.test(w)))
  // Set, but to the value .env.example ships — which is worse than unset, because it
  // looks configured while letting anyone complete the handshake.
  assert.ok(warn('homenex-verify').some((w) => /published example value/.test(w)))
  assert.deepEqual(warn('a-token-of-our-own'), [])
})

test('validateEnv: rejects the local dev DB fallback and a too-short secret in prod', () => {
  const r = validateEnv({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://homenex:homenex@localhost:5432/homenex',
    SESSION_SECRET: 'short',
  })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => /dev fallback/.test(e)))
  assert.ok(r.errors.some((e) => /too short/.test(e)))
})

test('validateEnv: PG_POOL_SIZE must be a positive number', () => {
  assert.equal(validateEnv({ NODE_ENV: 'development', PG_POOL_SIZE: 'abc' }).ok, false)
  assert.equal(validateEnv({ NODE_ENV: 'development', PG_POOL_SIZE: '5' }).ok, true)
})

test('every setting that is fatal in production is written down in .env.example', () => {
  // The failure this prevents is a first deploy, not a regression: SESSION_SECRET was
  // fatal in production for as long as validateEnv has existed and appeared in no
  // example file, so the documented way to configure this server — copy .env.example
  // and fill it in — produced a server that refused to boot, with the reason visible
  // only in the crash. Any future fatal setting has the same trap waiting for it.
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
  const documented = new Set(
    example
      .split('\n')
      .map((l) => /^#?\s*([A-Z_0-9]+)\s*=/.exec(l.trim())?.[1])
      .filter(Boolean),
  )

  // Drive validateEnv with an otherwise-empty production environment and read the
  // required names back out of its own complaints, rather than restating a list here
  // that would drift from the one that actually stops the process.
  const { errors } = validateEnv({ NODE_ENV: 'production' })
  const fatal = [...new Set(errors.flatMap((e) => [...e.matchAll(/\b([A-Z][A-Z_0-9]{3,})\b/g)].map((m) => m[1])))]

  assert.ok(fatal.length, 'validateEnv named nothing fatal — this test would pass vacuously')
  for (const name of fatal) {
    assert.ok(documented.has(name), `${name} stops production from starting but is not in server/.env.example`)
  }
})

// --- rate limiter (unit, on a throwaway app since it's disabled in the real app under test) ---
test('rateLimit: allows up to max then returns 429 with Retry-After', async () => {
  const mini = express()
  const limiter = rateLimit({ windowMs: 10_000, max: 3 })
  mini.use(limiter)
  mini.get('/', (_q, s) => s.json({ ok: true }))
  const srv = await new Promise((r) => {
    const s = mini.listen(0, () => r(s))
  })
  const b = `http://127.0.0.1:${srv.address().port}`
  try {
    for (let i = 0; i < 3; i++) assert.equal((await fetch(b + '/')).status, 200)
    const blocked = await fetch(b + '/')
    assert.equal(blocked.status, 429)
    assert.ok(blocked.headers.get('retry-after'))
    assert.equal((await blocked.json()).code, 'RATE_LIMITED')
    assert.equal(blocked.headers.get('x-ratelimit-limit'), '3')
  } finally {
    limiter.stop()
    srv.close()
  }
})

test('rateLimit: separate client IPs get separate buckets', async () => {
  const limiter = rateLimit({ windowMs: 10_000, max: 1, key: (r) => r.headers['x-test-ip'] })
  const call = (ip) =>
    new Promise((res) =>
      limiter({ headers: { 'x-test-ip': ip } }, { setHeader() {}, status() { return { json() { res(429) } } } }, () => res(200)),
    )
  assert.equal(await call('1.1.1.1'), 200)
  assert.equal(await call('2.2.2.2'), 200) // different IP, still allowed
  assert.equal(await call('1.1.1.1'), 429) // first IP now over its limit
  limiter.stop()
})

// The limiter key must not be client-choosable. Express resolves req.ip from
// `trust proxy`, so it wins; a bare shim with only XFF falls back to the LAST hop
// (the one our proxy appended) — never the attacker-supplied first hop.
test('clientIp: prefers req.ip, which trust-proxy already resolved', () => {
  assert.equal(
    clientIp({ ip: '10.0.0.1', get: (h) => (h === 'x-forwarded-for' ? '9.9.9.9, 10.0.0.1' : null) }),
    '10.0.0.1',
  )
})

test('clientIp: a spoofed X-Forwarded-For prefix cannot become the key', () => {
  const spoofed = clientIp({ get: (h) => (h === 'x-forwarded-for' ? '9.9.9.9, 10.0.0.1' : null) })
  assert.notEqual(spoofed, '9.9.9.9') // the attacker-controlled hop
  assert.equal(spoofed, '10.0.0.1') // the hop our own proxy appended
})

// --- security headers + CORS (unit) ------------------------------------------
test('securityHeaders sets the safe defaults', () => {
  const set = {}
  securityHeaders({}, { setHeader: (k, v) => (set[k] = v) }, () => {})
  assert.equal(set['X-Content-Type-Options'], 'nosniff')
  assert.equal(set['X-Frame-Options'], 'SAMEORIGIN')
  assert.ok(set['Referrer-Policy'])
})

test('cors: disabled by default (no origin header echoed)', () => {
  const set = {}
  let nexted = false
  cors('')({ get: () => 'https://evil.example', method: 'GET' }, { setHeader: (k, v) => (set[k] = v) }, () => (nexted = true))
  assert.equal(set['Access-Control-Allow-Origin'], undefined)
  assert.equal(nexted, true)
})

test('cors: echoes an allowlisted origin and answers preflight with 204', () => {
  const mw = cors('https://app.homenex.example')
  const set = {}
  mw({ get: () => 'https://app.homenex.example', method: 'GET' }, { setHeader: (k, v) => (set[k] = v) }, () => {})
  assert.equal(set['Access-Control-Allow-Origin'], 'https://app.homenex.example')

  let status
  mw(
    { get: () => 'https://app.homenex.example', method: 'OPTIONS' },
    { setHeader() {}, sendStatus: (c) => (status = c) },
    () => {},
  )
  assert.equal(status, 204)
})

// --- app-level behaviours -----------------------------------------------------
test('GET /healthz returns 200 with a db-ok body', async () => {
  const res = await req('GET', '/healthz')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.db, true)
})

test('malformed JSON body returns 400, not 500', async () => {
  const res = await req('POST', '/api/auth/login', '{ not json', { 'content-type': 'application/json' })
  assert.equal(res.status, 400)
  assert.equal((await res.json()).code, 'BAD_JSON')
})

test('unknown /api route returns JSON 404 (not the SPA) for an authed client', async () => {
  // The requireAuth guard 401s an anonymous caller before the 404 handler, so sign in
  // first: the point of the handler is that a logged-in client's typo'd route returns
  // JSON 404 instead of falling through to the SPA's index.html with a 200.
  const signup = await (
    await req('POST', '/api/auth/signup', JSON.stringify({ name: 'H Tester', phone: '+919800000099', password: 'secret123' }), {
      'content-type': 'application/json',
    })
  ).json()
  const res = await req('GET', '/api/does-not-exist', undefined, { authorization: `Bearer ${signup.token}` })
  assert.equal(res.status, 404)
  const body = await res.json()
  assert.equal(body.code, 'NOT_FOUND')
})

test('security headers are present on a real response', async () => {
  const res = await req('GET', '/healthz')
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN')
  assert.equal(res.headers.get('x-powered-by'), null) // disabled
})

// --- clientIp fallbacks -------------------------------------------------------

test('clientIp falls back to the socket address, then to a constant', () => {
  assert.equal(clientIp({ socket: { remoteAddress: '203.0.113.7' } }), '203.0.113.7')
  assert.equal(clientIp({ get: () => null, socket: { remoteAddress: '203.0.113.8' } }), '203.0.113.8')
  // An XFF header of only separators yields no usable hop.
  assert.equal(clientIp({ get: () => ' , ,', socket: { remoteAddress: '203.0.113.9' } }), '203.0.113.9')
  assert.equal(clientIp({}), 'unknown')
})

test('clientIp uses the single hop when the proxy chain has just one', () => {
  assert.equal(clientIp({ get: (h) => (h === 'x-forwarded-for' ? '198.51.100.4' : null) }), '198.51.100.4')
})

// --- rate limiter window rollover --------------------------------------------

test('rateLimit: the bucket resets once the window has elapsed', async () => {
  const limiter = rateLimit({ windowMs: 20, max: 1, key: () => 'k' })
  const call = () =>
    new Promise((res) =>
      limiter({}, { setHeader() {}, status() { return { json() { res(429) } } } }, () => res(200)),
    )
  assert.equal(await call(), 200)
  assert.equal(await call(), 429)
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(await call(), 200, 'a new window starts fresh')
  limiter.stop()
})

test('rateLimit: the sweep drops expired buckets so the map cannot grow forever', async () => {
  const limiter = rateLimit({ windowMs: 15, max: 1, key: (r) => r.k })
  const call = (k) =>
    new Promise((res) =>
      limiter({ k }, { setHeader() {}, status() { return { json() { res(429) } } } }, () => res(200)),
    )
  for (let i = 0; i < 5; i++) assert.equal(await call(`ip-${i}`), 200)
  // After the window and one sweep tick, every key is forgotten and allowed again.
  await new Promise((r) => setTimeout(r, 50))
  for (let i = 0; i < 5; i++) assert.equal(await call(`ip-${i}`), 200)
  limiter.stop()
})

test('rateLimit: a custom message is returned instead of the default', async () => {
  const limiter = rateLimit({ windowMs: 1000, max: 0, key: () => 'k', message: 'Too many login attempts.' })
  const body = await new Promise((res) =>
    limiter({}, { setHeader() {}, status() { return { json: res } } }, () => res(null)),
  )
  assert.equal(body.error, 'Too many login attempts.')
  assert.equal(body.code, 'RATE_LIMITED')
  limiter.stop()
})

// --- request logger -----------------------------------------------------------

test('requestLogger logs one line per finished request', async () => {
  const { requestLogger } = await import('../middleware.js')
  const lines = []
  const mw = requestLogger({ log: (l) => lines.push(l) })
  const mini = express()
  mini.use(mw)
  mini.get('/thing', (_q, s) => s.status(201).json({ ok: true }))
  const srv = await new Promise((r) => {
    const s = mini.listen(0, () => r(s))
  })
  try {
    await fetch(`http://127.0.0.1:${srv.address().port}/thing?q=1`)
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(lines.length, 1)
    assert.match(lines[0], /^GET \/thing\?q=1 201 [\d.]+ms$/)
  } finally {
    srv.close()
  }
})

test('requestLogger skips static assets, uploads and the favicon', async () => {
  const { requestLogger } = await import('../middleware.js')
  const lines = []
  const mw = requestLogger({ log: (l) => lines.push(l) })
  const next = () => {}
  for (const path of ['/uploads/a.jpg', '/assets/app.js', '/favicon.ico']) {
    mw({ path, method: 'GET', originalUrl: path, on() {} }, { on() {} }, next)
  }
  assert.equal(lines.length, 0)
})
