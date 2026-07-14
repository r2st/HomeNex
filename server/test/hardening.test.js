// Production-hardening tests: env validation, the rate limiter / CORS / security-header
// middleware, and the app-level 400 (bad JSON) / 404 (unknown api) / /healthz behaviours.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
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
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.warnings, [])
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

test('clientIp: honours the first X-Forwarded-For hop', () => {
  assert.equal(clientIp({ get: (h) => (h === 'x-forwarded-for' ? '9.9.9.9, 10.0.0.1' : null) }), '9.9.9.9')
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
