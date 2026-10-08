import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const TOKEN_KEY = 'realty-token'
const LEGACY_TOKEN_KEY = 'homenex-token'
const QUEUE_KEY = 'realty-offline-queue'
const LEGACY_QUEUE_KEY = 'homenex-offline-queue'

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}

const listeners = new Map()
globalThis.window = {
  addEventListener: (e, fn) => listeners.set(e, [...(listeners.get(e) || []), fn]),
  removeEventListener: () => {},
  dispatchEvent: () => {},
}
globalThis.caches = undefined
globalThis.fetch = () => Promise.reject(new Error('no fetch in test'))

beforeEach(() => store.clear())

test('migrates homenex-token to realty-token on import', async () => {
  store.set(LEGACY_TOKEN_KEY, 'old-jwt')
  await import('./api.js?' + Date.now())
  assert.equal(store.get(TOKEN_KEY), 'old-jwt')
  assert.equal(store.has(LEGACY_TOKEN_KEY), false)
})

test('migrates homenex-offline-queue to realty-offline-queue', async () => {
  store.set(LEGACY_QUEUE_KEY, '[{"path":"/api/leads/1"}]')
  await import('./api.js?' + Date.now())
  assert.equal(store.get(QUEUE_KEY), '[{"path":"/api/leads/1"}]')
  assert.equal(store.has(LEGACY_QUEUE_KEY), false)
})

test('does not overwrite existing realty-token', async () => {
  store.set(TOKEN_KEY, 'already-migrated')
  store.set(LEGACY_TOKEN_KEY, 'stale-old')
  await import('./api.js?' + Date.now())
  assert.equal(store.get(TOKEN_KEY), 'already-migrated')
})

test('works when no legacy keys exist', async () => {
  await import('./api.js?' + Date.now())
  assert.equal(store.has(TOKEN_KEY), false)
  assert.equal(store.has(LEGACY_TOKEN_KEY), false)
})
