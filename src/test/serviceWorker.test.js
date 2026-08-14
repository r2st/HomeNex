// public/sw.js — the only code in this repo that can serve an agent something other
// than what the server just sent.
//
// It had no tests at all, and it could not have had: it is never imported by the app,
// so it never appeared in a coverage report either — the report listed the files the
// suite loaded, and a file nothing loads is not red, it is absent. That is the worst
// shape for a bug to hide in, and this file has already produced one: the v1 worker
// served navigations cache-first, so agents kept opening a deploy-old shell and
// reported it as "the new features aren't there". The fix was a strategy change and a
// cache-name bump, neither of which anything would have caught going back.
//
// So the assertions here are mostly about what the worker must NOT keep: a shell it
// was told is stale, a cache from the previous strategy, a login response, the admin
// app, anything cross-origin, anything that isn't a GET.
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { get, installServiceWorkerEnv, navigation, notOk, ok } from './swEnv.js'

const env = installServiceWorkerEnv()
const ORIGIN = env.origin
// Imported once, with the globals already in place: sw.js registers its handlers at
// load, exactly as it does in a browser.
await import('../../public/sw.js')

const CACHE = 'homenex-v2'

before(() => assert.ok(env.handles('fetch'), 'sw.js registered no fetch handler'))
beforeEach(() => env.reset())
after(() => env.restore())

// --- Lifecycle -------------------------------------------------------------------

test('install pre-caches the app shell and takes over immediately', async () => {
  await env.dispatch('install')

  assert.deepEqual(env.cache(CACHE).urls, ['/', '/manifest.webmanifest', '/icons/icon.svg'])
  // Without skipWaiting the new worker sits idle behind the old one until every tab
  // is closed, which on a phone the agent never closes is approximately never.
  assert.equal(env.skipWaitingCalls(), 1, 'the new worker waited instead of taking over')
})

test('activate deletes every cache but the current one', async () => {
  // The literal regression: a v1 worker's cache-first shell outliving the v2 worker
  // that replaced it. Bumping CACHE is only half the fix — the purge is the other.
  await env.seed('homenex-v1', `${ORIGIN}/`, ok('the old app shell'))
  await env.seed(CACHE, `${ORIGIN}/`, ok('the new app shell'))

  await env.dispatch('activate')

  assert.deepEqual(env.cacheNames(), [CACHE], 'a cache from an older strategy survived')
  assert.equal(env.claimCalls(), 1, 'open tabs were left on the previous worker')
})

// --- Navigations -----------------------------------------------------------------

test('a navigation goes to the network first, so a fresh deploy is what loads', async () => {
  await env.seed(CACHE, `${ORIGIN}/`, ok('yesterday’s shell'))
  env.network(() => ok('today’s shell'))

  const res = await env.dispatch('fetch', { request: navigation(`${ORIGIN}/`) })

  assert.equal(res.body, 'today’s shell', 'the agent was served a stale shell')
  assert.equal(env.fetched().length, 1)
})

test('a navigation that reached the network replaces the cached shell', async () => {
  await env.seed(CACHE, `${ORIGIN}/`, ok('yesterday’s shell'))
  env.network(() => ok('today’s shell'))

  await env.dispatch('fetch', { request: navigation(`${ORIGIN}/`) })

  // Not just served — stored. Otherwise the next offline boot is still yesterday's.
  assert.equal((await env.cache(CACHE).match({ url: `${ORIGIN}/` })).body, 'today’s shell')
})

test('a navigation with no signal falls back to the cached shell', async () => {
  await env.seed(CACHE, `${ORIGIN}/`, ok('the cached shell'))
  env.offline()

  const res = await env.dispatch('fetch', { request: navigation(`${ORIGIN}/`) })
  assert.equal(res.body, 'the cached shell', 'the app did not boot offline')
})

test('an offline navigation to a deep link falls back to the shell, not to nothing', async () => {
  // The SPA serves every route from one shell, so /leads/42 offline has no cache
  // entry of its own and must land on '/' — otherwise a shared link opens a blank app.
  await env.seed(CACHE, '/', ok('the cached shell'))
  env.offline()

  const res = await env.dispatch('fetch', { request: navigation(`${ORIGIN}/leads/42`) })
  assert.equal(res.body, 'the cached shell')
})

test('a navigation the server rejected is passed through, not cached', async () => {
  env.network(() => notOk(503))

  const res = await env.dispatch('fetch', { request: navigation(`${ORIGIN}/`) })

  assert.equal(res.status, 503, 'an error page was swallowed')
  assert.equal(env.cache(CACHE), undefined, 'a 503 was written into the shell cache')
})

// --- API reads -------------------------------------------------------------------

test('an API read is network-first and keeps the answer for the next dead spot', async () => {
  env.network(() => ok('{"leads":[]}'))

  const res = await env.dispatch('fetch', { request: get(`${ORIGIN}/api/leads?page=1`) })

  assert.equal(res.body, '{"leads":[]}')
  assert.equal((await env.cache(CACHE).match({ url: `${ORIGIN}/api/leads?page=1` })).body, '{"leads":[]}')
})

test('an API read with no signal serves the last answer rather than failing', async () => {
  // The reason any of this exists: an agent standing on a construction site with no
  // bars can still read the lead they came to discuss.
  await env.seed(CACHE, `${ORIGIN}/api/dashboard`, ok('{"hot":3}'))
  env.offline()

  const res = await env.dispatch('fetch', { request: get(`${ORIGIN}/api/dashboard`) })
  assert.equal(res.body, '{"hot":3}')
})

test('an API read with no signal and nothing cached fails rather than hanging', async () => {
  env.offline()

  const res = await env.dispatch('fetch', { request: get(`${ORIGIN}/api/dashboard`) })
  assert.equal(res.type, 'error', 'an uncached offline read resolved to something usable')
})

test('an API error is not cached over good data', async () => {
  await env.seed(CACHE, `${ORIGIN}/api/leads`, ok('{"leads":[1]}'))
  env.network(() => notOk(500))

  const res = await env.dispatch('fetch', { request: get(`${ORIGIN}/api/leads`) })

  assert.equal(res.status, 500)
  assert.equal(
    (await env.cache(CACHE).match({ url: `${ORIGIN}/api/leads` })).body,
    '{"leads":[1]}',
    'a 500 overwrote the last good copy of the leads list',
  )
})

test('an API path outside the read-only list is never touched', async () => {
  // /api/auth/* above all: a cached login response is a session served to whoever
  // picks up the phone next. The worker must not respondWith at all here.
  for (const path of ['/api/auth/login', '/api/messages/send', '/api/notifications']) {
    assert.equal(
      await env.dispatch('fetch', { request: get(ORIGIN + path) }),
      undefined,
      `${path} was intercepted by the service worker`,
    )
  }
  assert.equal(env.fetched().length, 0, 'the worker fetched a request it had declined')
})

// --- Static assets ---------------------------------------------------------------

test('a hashed asset is served from cache without waiting for the network', async () => {
  await env.seed(CACHE, `${ORIGIN}/assets/app-a1b2c3.js`, ok('cached bundle'))
  env.network(() => ok('network bundle'))

  const res = await env.dispatch('fetch', { request: get(`${ORIGIN}/assets/app-a1b2c3.js`) })

  // Safe precisely because the filename carries the hash: a changed bundle is a
  // different URL, so a cache hit can never be the wrong version.
  assert.equal(res.body, 'cached bundle')
})

test('an asset that is not cached yet comes off the network and is kept', async () => {
  env.network(() => ok('network bundle'))

  const res = await env.dispatch('fetch', { request: get(`${ORIGIN}/assets/app-a1b2c3.js`) })

  assert.equal(res.body, 'network bundle')
  assert.equal((await env.cache(CACHE).match({ url: `${ORIGIN}/assets/app-a1b2c3.js` })).body, 'network bundle')
})

// --- What the worker must keep its hands off -------------------------------------

test('anything that is not a GET is left alone', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await env.dispatch('fetch', { request: { ...get(`${ORIGIN}/api/leads`), method } })
    assert.equal(res, undefined, `a ${method} was intercepted — replaying one from cache writes data twice`)
  }
})

test('cross-origin requests are left alone', async () => {
  for (const url of ['https://graph.facebook.com/v20.0/media', 'https://fonts.gstatic.com/s/x.woff2']) {
    assert.equal(await env.dispatch('fetch', { request: get(url) }), undefined, `${url} was intercepted`)
  }
})

test('the webhook and the admin app are left alone', async () => {
  // /webhook is Meta talking to the server, and /admin is a different SPA with its own
  // shell — caching either under this app's worker serves the wrong thing entirely.
  for (const path of ['/webhook', '/admin', '/admin/agents']) {
    const req = path === '/webhook' ? get(ORIGIN + path) : navigation(ORIGIN + path)
    assert.equal(await env.dispatch('fetch', { request: req }), undefined, `${path} was intercepted`)
  }
})
