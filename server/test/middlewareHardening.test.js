// The production-hardening middleware, on the arms hardening.test.js does not reach.
//
// Two things live here.
//
// HSTS, because it is the one security header that cannot be asserted the way the
// others are. The rest are constants — set them, read them back, done. HSTS is a
// promise with a memory: a browser that sees it refuses plain HTTP to this host for
// max-age seconds and nothing the server later sends can shorten that. So it has to
// be conditional on the request actually having arrived over TLS, and "conditional"
// is a thing that can silently become "never" — a lost `trust proxy`, a header
// renamed, a middleware reordered — while every existing test still passes because
// they all assert headers that are unconditional.
//
// And boundedUrl's two argument-shape arms, which are the paths a future call site
// takes rather than the ones today's do: it is mounted with arrays everywhere in
// index.js, and every request that reaches it has already been through ensureBody.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { childEnv, createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('mwhardening')

const { app } = await import('../index.js')
const { closePool } = await import('../db.js')
const { securityHeaders, boundedUrl } = await import('../middleware.js')

let server, base

before(async () => {
  await new Promise((r) => (server = app.listen(0, () => r((base = `http://127.0.0.1:${server.address().port}`)))))
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// A fresh process is how a config value read at module load has to be tested — see
// fixtures/hstsProbe.mjs for why it is not an `import('…?query')`.
const PROBE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hstsProbe.mjs')
const execFileAsync = promisify(execFile)
const headersWith = async (env) => {
  const { stdout } = await execFileAsync(process.execPath, [PROBE], { env: childEnv(env) })
  return JSON.parse(stdout)
}

// The middleware only ever calls setHeader, so a plain recorder is a faithful res.
const runHeaders = (req) => {
  const set = {}
  let nexted = false
  securityHeaders(req, { setHeader: (k, v) => (set[k] = v) }, () => (nexted = true))
  assert.ok(nexted, 'securityHeaders must always call next()')
  return set
}

// --- HSTS ---------------------------------------------------------------------

test('a request that arrived over TLS is promised HTTPS for a year', () => {
  const sts = runHeaders({ secure: true })['Strict-Transport-Security']
  assert.ok(sts, 'no HSTS on a secure request — homenex.doaide.com ships none, Caddy does not add it either')
  assert.match(sts, /max-age=31536000/, 'a year is the shortest max-age that is worth anything')
  assert.match(sts, /includeSubDomains/)
})

test('and is never promised anything the deployment has not actually got', () => {
  // Sending HSTS over plain HTTP is how a dev machine, or a service that has not
  // finished its TLS rollout, locks itself out of its own http:// origin for a year.
  assert.equal(runHeaders({ secure: false })['Strict-Transport-Security'], undefined)
  assert.equal(runHeaders({})['Strict-Transport-Security'], undefined, 'a bare req shim must not be treated as TLS')
})

test('the always-safe headers are set either way, TLS or not', () => {
  for (const req of [{ secure: true }, { secure: false }]) {
    const set = runHeaders(req)
    assert.equal(set['X-Content-Type-Options'], 'nosniff')
    assert.equal(set['X-Frame-Options'], 'SAMEORIGIN')
    assert.equal(set['Referrer-Policy'], 'strict-origin-when-cross-origin')
    assert.equal(set['X-DNS-Prefetch-Control'], 'off')
  }
})

test('HSTS_MAX_AGE=0 turns it off, for a host that is not ready to commit', async () => {
  const set = await headersWith({ HSTS_MAX_AGE: '0' })
  assert.equal(set['Strict-Transport-Security'], undefined, 'the opt-out did not opt out')
  assert.equal(set['X-Content-Type-Options'], 'nosniff', 'and it took the other headers down with it')
})

test('a shorter max-age can be staged before committing to a year', async () => {
  const set = await headersWith({ HSTS_MAX_AGE: '600' })
  assert.equal(set['Strict-Transport-Security'], 'max-age=600; includeSubDomains')
})

test('a max-age that is not a number falls back to the year, it does not disable HSTS', async () => {
  // `Number('nope') >= 0` is false, so the guard takes its other arm and the default
  // stands. That is the right way round: a typo in a deploy's env should not silently
  // withdraw a security header, and turning HSTS off has to be something someone
  // typed on purpose (`HSTS_MAX_AGE=0`, asserted above).
  assert.equal((await headersWith({ HSTS_MAX_AGE: 'nope' }))['Strict-Transport-Security'], 'max-age=31536000; includeSubDomains')
  assert.equal((await headersWith({ HSTS_MAX_AGE: '-1' }))['Strict-Transport-Security'], 'max-age=31536000; includeSubDomains')
})

// --- HSTS, through the app as mounted ------------------------------------------

test('the real app sends HSTS for a request Caddy forwarded over HTTPS', async () => {
  // This is the half a unit test cannot cover: that securityHeaders is still mounted,
  // still ahead of the routes, and that `trust proxy` is still set — without it
  // req.secure is false for every request behind the proxy and the header silently
  // never ships, which is exactly the regression that looks like nothing at all.
  const res = await fetch(`${base}/healthz`, { headers: { 'x-forwarded-proto': 'https' } })
  assert.equal(res.status, 200)
  assert.match(
    res.headers.get('strict-transport-security') || '',
    /max-age=31536000; includeSubDomains/,
    'either securityHeaders came unmounted or trust proxy stopped resolving X-Forwarded-Proto',
  )
})

test('the same app over plain HTTP sends none of it', async () => {
  const res = await fetch(`${base}/healthz`)
  assert.equal(res.headers.get('strict-transport-security'), null)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff', 'the unconditional headers still ship')
})

test('a forwarded scheme that is not https is not treated as https', async () => {
  const res = await fetch(`${base}/healthz`, { headers: { 'x-forwarded-proto': 'http' } })
  assert.equal(res.headers.get('strict-transport-security'), null)
})

// --- boundedUrl argument shapes -------------------------------------------------

test('boundedUrl accepts a field map, not only a field list', () => {
  // Every call site in index.js passes an array today. The object form is the shape
  // the neighbouring bounded* middlewares take, so it is the shape the next call site
  // will reach for — and it silently checked nothing until this ran.
  const mw = boundedUrl({ brochure_url: true, video_url: true })
  const reject = (body) => {
    let status, payload
    const res = { status: (s) => ((status = s), res), json: (p) => ((payload = p), res) }
    mw({ body }, res, () => (status = 'next'))
    return { status, payload }
  }
  assert.equal(reject({ brochure_url: 'https://cdn.example.com/a.pdf' }).status, 'next')
  const bad = reject({ video_url: '//evil.example.com/x' })
  assert.equal(bad.status, 400, 'the object form named no fields, so nothing was checked')
  assert.equal(bad.payload.code, 'FIELD_NOT_A_URL')
  assert.equal(bad.payload.field, 'video_url')
})

test('boundedUrl passes a JSON array body straight through', () => {
  // ensureBody guarantees an object on every mounted route, so this arm exists for the
  // request that arrives as a bare JSON array: there are no named fields to read off
  // it, and indexing it by field name would read array methods, not user data.
  const mw = boundedUrl(['photos'])
  for (const body of [['//evil.example.com/x'], null, undefined, 'a string']) {
    let nexted = false
    mw({ body }, { status: () => assert.fail(`a ${JSON.stringify(body)} body must not be rejected here`) }, () => (nexted = true))
    assert.ok(nexted, `a ${JSON.stringify(body)} body should fall through to the route`)
  }
})
