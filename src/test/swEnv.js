// A service-worker global scope, small enough to read in one sitting.
//
// public/sw.js is a classic worker script: it talks to `self`, `caches`, `location`
// and `fetch`, and it is never imported by the app, so no existing harness can reach
// it. This gives it those four globals, keeps the handlers it registers, and hands
// back the cache contents so a test can assert what was stored as well as what was
// served.
//
// Requests are plain objects rather than real Request instances: the worker only ever
// reads `.method`, `.url` and `.mode`, and uses the object itself as a cache key. A
// real Request would add a body stream to manage for no extra fidelity.

/** A Cache, backed by a Map keyed on the request URL. */
class FakeCache {
  constructor(name) {
    this.name = name
    this.entries = new Map()
  }
  async addAll(urls) {
    for (const url of urls) this.entries.set(url, { url, cached: true })
  }
  async put(request, response) {
    this.entries.set(keyOf(request), response)
  }
  async match(request) {
    return this.entries.get(keyOf(request))
  }
  get urls() {
    return [...this.entries.keys()]
  }
}

const keyOf = (request) => (typeof request === 'string' ? request : request.url)

/**
 * Install the worker globals. Returns a handle with the registered handlers, the
 * cache store, the fetch spy, and `restore()`. Pair with `t.after(env.restore)`.
 */
export function installServiceWorkerEnv({ origin = 'https://app.homenex.in' } = {}) {
  const saved = new Map()
  const define = (name, value) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }

  const handlers = new Map()
  let skipWaitingCalls = 0
  let claimCalls = 0
  const self = {
    addEventListener: (type, fn) => handlers.set(type, fn),
    skipWaiting: async () => void skipWaitingCalls++,
    clients: { claim: async () => void claimCalls++ },
  }

  const store = new Map()
  const caches = {
    open: async (name) => {
      if (!store.has(name)) store.set(name, new FakeCache(name))
      return store.get(name)
    },
    keys: async () => [...store.keys()],
    delete: async (name) => store.delete(name),
    // The global caches.match searches every cache, which is what the worker relies
    // on when it falls back to a hit it never opened a cache to find.
    match: async (request) => {
      for (const cache of store.values()) {
        const hit = await cache.match(request)
        if (hit) return hit
      }
      return undefined
    },
  }

  // What the network does. Default: every request succeeds with a fresh response.
  const fetches = []
  let responder = (request) => ok(`fresh ${keyOf(request)}`)
  const fetch = async (request) => {
    fetches.push(request)
    return responder(request)
  }

  define('self', self)
  define('caches', caches)
  define('location', { origin })
  define('fetch', fetch)

  return {
    origin,
    /** Fire a registered worker event; resolves once its waitUntil/respondWith has. */
    async dispatch(type, event = {}) {
      const handler = handlers.get(type)
      if (!handler) throw new Error(`sw.js never registered a '${type}' handler`)
      let pending
      handler({ ...event, waitUntil: (p) => (pending = p), respondWith: (p) => (pending = p) })
      return pending === undefined ? undefined : await pending
    },
    /** True when the worker declined to handle the event at all (no respondWith). */
    handles: (type) => handlers.has(type),
    cache: (name) => store.get(name),
    cacheNames: () => [...store.keys()],
    seed: async (name, url, response) => (await caches.open(name)).put({ url }, response),
    fetches,
    fetched: () => fetches.map(keyOf),
    /** Replace the network. `fn` receives the request and returns/throws a response. */
    network: (fn) => (responder = fn),
    offline: () =>
      (responder = () => {
        throw new TypeError('Failed to fetch')
      }),
    skipWaitingCalls: () => skipWaitingCalls,
    claimCalls: () => claimCalls,
    // Between tests, not between installs. sw.js registers its handlers at import and
    // ES modules are imported once, which is also how a real worker behaves — so the
    // env is installed once per file and the mutable state is cleared here instead.
    reset() {
      store.clear()
      fetches.length = 0
      responder = (request) => ok(`fresh ${keyOf(request)}`)
      skipWaitingCalls = 0
      claimCalls = 0
    },
    restore() {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else delete globalThis[name]
      }
    },
  }
}

/** A response the worker will treat as cacheable. */
export const ok = (body) => ({ ok: true, status: 200, body, clone: () => ok(body) })
/** One it will pass through without caching. */
export const notOk = (status = 500) => ({ ok: false, status, body: null, clone: () => notOk(status) })

/** A GET the worker would see for a page navigation. */
export const navigation = (url) => ({ method: 'GET', url, mode: 'navigate' })
/** A GET for a subresource (asset, API call). */
export const get = (url) => ({ method: 'GET', url, mode: 'cors' })
