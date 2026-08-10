// Session-scoped client state must not survive a change of agent. HomeNex is used on
// shared office desktops, and two stores would otherwise carry one agent's data into
// the next agent's session: the service worker's cache of authenticated API GETs
// (keyed by URL, with no agent in the key) and the offline write queue (replayed with
// whatever token is current at replay time).
//
// localStorage and Cache Storage are stubbed here — this is the browser contract, not
// a DOM test.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

// Minimal localStorage stand-in, installed before api.js is imported (the module
// reads localStorage at call time, but nothing should touch it at import time).
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}

// Cache Storage stand-in: one named cache holding Request-ish entries.
function makeCaches(initial = {}) {
  const caches = new Map(
    Object.entries(initial).map(([name, urls]) => [name, urls.map((url) => ({ url }))]),
  )
  return {
    _caches: caches,
    urls: (name) => (caches.get(name) || []).map((r) => r.url),
    keys: async () => [...caches.keys()],
    open: async (name) => ({
      keys: async () => caches.get(name) || [],
      delete: async (req) => {
        const list = caches.get(name) || []
        const i = list.indexOf(req)
        if (i >= 0) list.splice(i, 1)
        return i >= 0
      },
    }),
  }
}

const { clearSessionCaches, setToken, getToken } = await import('./api.js')

const QUEUE_KEY = 'homenex-offline-queue'
const TOKEN_KEY = 'homenex-token'
// clearSessionCaches deliberately doesn't await its Cache Storage work (signing in
// must not block on it), so give the microtasks a turn before asserting.
const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  store.clear()
  delete globalThis.caches
})

afterEach(() => {
  delete globalThis.caches
})

test('cached API responses are dropped when the session changes', async () => {
  globalThis.caches = makeCaches({
    'homenex-v2': [
      'https://app.homenex.test/api/leads',
      'https://app.homenex.test/api/contacts?q=priya',
      'https://app.homenex.test/api/dashboard',
    ],
  })
  clearSessionCaches()
  await settle()
  assert.deepEqual(globalThis.caches.urls('homenex-v2'), [])
})

test('the app shell and hashed assets survive — only agent data is purged', async () => {
  globalThis.caches = makeCaches({
    'homenex-v2': [
      'https://app.homenex.test/',
      'https://app.homenex.test/assets/index-abc123.js',
      'https://app.homenex.test/manifest.webmanifest',
      'https://app.homenex.test/api/leads',
    ],
  })
  clearSessionCaches()
  await settle()
  assert.deepEqual(globalThis.caches.urls('homenex-v2'), [
    'https://app.homenex.test/',
    'https://app.homenex.test/assets/index-abc123.js',
    'https://app.homenex.test/manifest.webmanifest',
  ])
})

test('every cache version is swept, not just the current one', async () => {
  globalThis.caches = makeCaches({
    'homenex-v1': ['https://app.homenex.test/api/leads'],
    'homenex-v2': ['https://app.homenex.test/api/contacts'],
  })
  clearSessionCaches()
  await settle()
  assert.deepEqual(globalThis.caches.urls('homenex-v1'), [])
  assert.deepEqual(globalThis.caches.urls('homenex-v2'), [])
})

test('a malformed cache entry is skipped rather than aborting the sweep', async () => {
  globalThis.caches = makeCaches({
    'homenex-v2': ['not a url at all', 'https://app.homenex.test/api/leads'],
  })
  clearSessionCaches()
  await settle()
  assert.deepEqual(globalThis.caches.urls('homenex-v2'), ['not a url at all'])
})

test('the offline write queue is dropped so it cannot replay under a new token', async () => {
  store.set(QUEUE_KEY, JSON.stringify([{ method: 'PUT', url: '/api/leads/7/stage', body: { stage: 'Lost' } }]))
  clearSessionCaches()
  assert.equal(store.get(QUEUE_KEY), undefined)
})

test('logging in clears the previous agent’s cached data before storing the new token', async () => {
  globalThis.caches = makeCaches({ 'homenex-v2': ['https://app.homenex.test/api/leads'] })
  store.set(QUEUE_KEY, JSON.stringify([{ method: 'POST', url: '/api/followups', body: {} }]))

  setToken('42.newagenttoken')
  await settle()

  assert.equal(getToken(), '42.newagenttoken')
  assert.equal(store.get(QUEUE_KEY), undefined)
  assert.deepEqual(globalThis.caches.urls('homenex-v2'), [])
})

test('logging out clears the token and the cached data together', async () => {
  globalThis.caches = makeCaches({ 'homenex-v2': ['https://app.homenex.test/api/contacts'] })
  store.set(TOKEN_KEY, '7.oldtoken')
  store.set(QUEUE_KEY, '[]')

  setToken(null)
  await settle()

  assert.equal(getToken(), null)
  assert.equal(store.get(QUEUE_KEY), undefined)
  assert.deepEqual(globalThis.caches.urls('homenex-v2'), [])
})

test('a browser with no Cache Storage signs in and out normally', async () => {
  delete globalThis.caches
  setToken('9.token')
  assert.equal(getToken(), '9.token')
  setToken(null)
  assert.equal(getToken(), null)
})

test('a Cache Storage that rejects does not break signing out', async () => {
  globalThis.caches = { keys: async () => { throw new Error('quota') } }
  setToken(null)
  await settle()
  assert.equal(getToken(), null)
})
