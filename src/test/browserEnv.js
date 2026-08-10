// Minimal browser globals for component tests.
//
// The components reach for window/localStorage/navigator (offline banner, WhatsApp
// deep links, clipboard share, token storage). Node has none of those, so each test
// installs just enough of them to run the real code paths — and gets spies back so
// it can assert what the component tried to do.
import { setToken } from '../api.js'

/**
 * Install fake browser globals. Returns a handle with spies plus `restore()`.
 * Pair with `t.after(env.restore)` so tests stay isolated.
 */
export function installBrowser({ online = true, now } = {}) {
  const saved = new Map()
  const define = (name, value) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }

  const store = new Map()
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() {
      return store.size
    },
  }

  const opened = []
  const alerts = []
  const prompts = []
  const confirms = []
  const copied = []
  const shared = []
  let reloads = 0
  let promptReply = null
  let confirmReply = true

  const target = new EventTarget()
  const window = {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    open: (url, name, features) => {
      opened.push({ url, name, features })
      return { closed: false, focus() {} }
    },
    alert: (msg) => alerts.push(msg),
    prompt: (msg) => {
      prompts.push(msg)
      return promptReply
    },
    confirm: (msg) => {
      confirms.push(msg)
      return confirmReply
    },
    location: {
      href: 'http://localhost/',
      origin: 'http://localhost',
      pathname: '/',
      reload: () => {
        reloads++
      },
    },
    localStorage,
    scrollTo: () => {},
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  }

  const navigator = {
    onLine: online,
    userAgent: 'node-test',
    language: 'en-IN',
    clipboard: { writeText: async (text) => void copied.push(text) },
    share: async (data) => void shared.push(data),
  }

  // Elements the app creates imperatively (the CSV/vCard download trick).
  const created = []
  const document = {
    createElement: (tag) => {
      const el = { tagName: tag.toUpperCase(), style: {}, clicked: 0, click() { el.clicked++ }, setAttribute(k, v) { el[k] = v }, remove() {} }
      created.push(el)
      return el
    },
    body: { appendChild: () => {}, removeChild: () => {} },
    getElementById: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
  }

  // Deterministic intervals: usePoll and the WhatsApp health check would otherwise
  // leave real timers running past the end of the test.
  const intervals = new Map()
  let intervalId = 0
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval

  define('window', window)
  define('localStorage', localStorage)
  define('navigator', navigator)
  define('document', document)
  define('setInterval', (fn, ms) => {
    const id = ++intervalId
    intervals.set(id, { fn, ms, elapsed: 0 })
    return id
  })
  define('clearInterval', (id) => intervals.delete(id))
  if (now !== undefined) {
    const realNow = Date.now
    saved.set('__dateNow', { value: realNow })
    Date.now = () => now
  }

  return {
    window,
    navigator,
    localStorage,
    document,
    opened,
    alerts,
    prompts,
    confirms,
    copied,
    shared,
    created,
    get reloads() {
      return reloads
    },
    /** Number of live intervals — a leak check for polling components. */
    get liveIntervals() {
      return intervals.size
    },
    setPromptReply: (v) => {
      promptReply = v
    },
    setConfirmReply: (v) => {
      confirmReply = v
    },
    setOnline: (v) => {
      navigator.onLine = v
    },
    /** Fire every interval whose period has elapsed. */
    advance(ms) {
      for (const timer of [...intervals.values()]) {
        timer.elapsed += ms
        while (timer.elapsed >= timer.ms) {
          timer.elapsed -= timer.ms
          timer.fn()
        }
      }
    },
    restore() {
      // The token lives in module state as well as storage; clear both so the next
      // test doesn't inherit a logged-in session.
      try {
        setToken(null)
      } catch {
        /* storage already torn down */
      }
      intervals.clear()
      globalThis.setInterval = realSetInterval
      globalThis.clearInterval = realClearInterval
      if (saved.has('__dateNow')) Date.now = saved.get('__dateNow').value
      for (const [name, descriptor] of saved) {
        if (name === '__dateNow') continue
        // Node exposes some of these (navigator, localStorage) as lazy accessors that
        // warn when touched. Restoring the accessor just re-arms that warning, so drop
        // the global instead — nothing outside a test should be reading it anyway.
        if (descriptor && !descriptor.get) Object.defineProperty(globalThis, name, descriptor)
        else delete globalThis[name]
      }
    },
  }
}

/**
 * Stub `fetch` with a route table so tests exercise the real api.js layer —
 * including its error mapping and 401 handling — instead of bypassing it.
 *
 *   const net = mockFetch({ 'GET /api/leads': [{ id: 1 }] })
 *   net.calls  // every request made, in order
 *
 * A route value may be a plain body, or `{ status, body }`, or a function
 * `({ method, path, body, query }) => body | { status, body }`.
 */
export function mockFetch(routes = {}) {
  const calls = []
  const table = { ...routes }
  const real = globalThis.fetch

  globalThis.fetch = async (url, options = {}) => {
    const method = (options.method || 'GET').toUpperCase()
    const parsed = new URL(url, 'http://localhost')
    const path = parsed.pathname
    const body = options.body ? JSON.parse(options.body) : undefined
    const call = { method, path, url: String(url), query: Object.fromEntries(parsed.searchParams), body, headers: options.headers || {} }
    calls.push(call)

    const route = table[`${method} ${path}`] ?? table[path]
    if (route === undefined) {
      return response(404, { error: `no mock route for ${method} ${path}` })
    }
    const resolved = typeof route === 'function' ? await route(call) : route
    if (resolved && typeof resolved === 'object' && 'status' in resolved && !Array.isArray(resolved)) {
      return response(resolved.status, resolved.body ?? {})
    }
    return response(200, resolved)
  }

  return {
    calls,
    /** Requests to a given path, optionally filtered by method. */
    to: (path, method) => calls.filter((c) => c.path === path && (!method || c.method === method.toUpperCase())),
    set: (key, value) => {
      table[key] = value
    },
    restore: () => {
      globalThis.fetch = real
    },
  }
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}
