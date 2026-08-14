// The two catch-alls that serve the built single-page apps.
//
// One process hosts everything in production: the API, the dashboard bundle at `/`
// and the admin console at `/admin`. Both bundles do their own client-side routing,
// so a hard navigation to any of their URLs — an agent refreshing on a lead, a
// bookmarked deep link, a shared /admin/agents/12 — arrives at Express as a path no
// route knows. The catch-alls answer those with index.html and let the bundle route
// itself.
//
// The interesting part is what they must NOT swallow: /api, /webhook and the public
// pages all sit under the same prefixes-shaped space, and a catch-all that is one
// character too greedy turns a client's typo into a 200 HTML page or, worse, hands
// Meta's webhook the dashboard.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('spashell')

const { app } = await import('../index.js')
const { ready, closePool } = await import('../db.js')

await ready

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BUNDLES = [
  { name: 'dashboard', dir: path.join(root, 'dist'), marker: '<!-- test dashboard shell -->' },
  { name: 'admin', dir: path.join(root, 'admin', 'dist'), marker: '<!-- test admin shell -->' },
]

let server, base, token
const created = []

// `dist/` is a build output and is gitignored, so it may or may not be on disk. Put
// a placeholder shell wherever one is missing and take only that back out again — a
// developer's real build must survive the suite untouched.
function ensureShell({ dir, marker }) {
  const file = path.join(dir, 'index.html')
  if (fs.existsSync(file)) return
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><title>HomeNex</title>${marker}`)
  created.push(file)
}

before(async () => {
  for (const bundle of BUNDLES) ensureShell(bundle)
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  token = (
    await (
      await fetch(`${base}/api/auth/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Shell Shalini', phone: '+919847000001', password: 'secret123' }),
      })
    ).json()
  ).token
})

after(async () => {
  for (const file of created) fs.rmSync(file, { force: true })
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

const get = (url, tok = null) =>
  fetch(base + url, { redirect: 'manual', headers: tok ? { authorization: `Bearer ${tok}` } : {} })

async function assertShell(url) {
  const res = await get(url)
  assert.equal(res.status, 200, `${url} did not serve the app shell`)
  assert.match(res.headers.get('content-type') || '', /text\/html/, `${url} served the wrong type`)
  const html = await res.text()
  assert.match(html, /<\/?(?:!doctype|html|meta|title)/i, `${url} served something that is not a document`)
  return html
}

// --- The dashboard shell ---------------------------------------------------------

test('the dashboard is served at the root', async () => {
  await assertShell('/')
})

test('a hard refresh deep inside the dashboard still lands on the shell', async () => {
  // These are client-side routes only. Before the catch-all they 404'd, which is what
  // "refreshing the page logs me out" actually looked like.
  for (const url of ['/leads', '/leads/1042', '/settings/team', '/inbox?filter=hot']) {
    await assertShell(url)
  }
})

// --- The admin shell -------------------------------------------------------------

test('the admin console and its deep links are served from the admin bundle', async () => {
  for (const url of ['/admin/', '/admin/agents', '/admin/agents/12']) {
    await assertShell(url)
  }
  // The bare /admin is express.static's directory redirect, not the catch-all.
  assert.equal((await get('/admin')).status, 301)
})

// --- What the catch-alls must not swallow ----------------------------------------

test('an unknown API path stays JSON, it never becomes the shell', async () => {
  const res = await get('/api/leeds', token)
  assert.equal(res.status, 404)
  assert.match(res.headers.get('content-type') || '', /application\/json/)
  assert.deepEqual(await res.json(), { error: 'Not found', code: 'NOT_FOUND' })
})

test('an unknown API path does not tell an anonymous caller whether it exists', async () => {
  // The auth gate is mounted on /api ahead of the 404, so a signed-out probe gets the
  // same 401 for a real route and an invented one — and never an HTML page it would
  // then fail to JSON.parse.
  for (const url of ['/api/leads', '/api/leeds']) {
    const res = await get(url)
    assert.equal(res.status, 401, url)
    assert.match(res.headers.get('content-type') || '', /application\/json/, url)
  }
})

test('the webhook path is never answered with the dashboard', async () => {
  // Meta polls and posts here. Handing it an HTML page instead of the verification
  // challenge — or a 200 for a path we do not serve — is silent breakage.
  const res = await get('/webhook?hub.mode=subscribe&hub.verify_token=wrong')
  assert.equal(res.status, 403, 'a bad verify token is refused, not routed to the SPA')

  const unknown = await get('/webhook/anything')
  assert.notEqual(unknown.status, 200, 'nothing under /webhook falls through to index.html')
})

test('the public pages win over the catch-all', async () => {
  // /privacy, /terms and /p/:slug are registered ahead of it and are real pages Meta
  // app review and buyers open directly.
  for (const [url, expected] of [['/privacy', /Privacy/i], ['/terms', /Terms/i]]) {
    assert.match(await assertShell(url), expected, `${url} was swallowed by the SPA catch-all`)
  }
  const missing = await get('/p/no-such-property')
  assert.equal(missing.status, 404, 'an unknown micro-page 404s rather than serving the dashboard')
})
