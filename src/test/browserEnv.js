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
  // Document-level listeners are a real behaviour now (Escape closes the overlays in
  // ui.jsx), so the shim records them and `press()` below fires them — a no-op
  // addEventListener would make an unclosable sheet look tested.
  const listeners = new Map()
  const document = {
    createElement: (tag) => {
      const el = { tagName: tag.toUpperCase(), style: {}, clicked: 0, click() { el.clicked++ }, setAttribute(k, v) { el[k] = v }, remove() {} }
      // downscalePhoto draws a picked photo into a canvas and reads a JPEG back out.
      // The shim records the size it was asked for and the quality it encoded at, so a
      // test can assert the downscale maths rather than just that it didn't throw.
      if (el.tagName === 'CANVAS') {
        el.width = 0
        el.height = 0
        el.drawn = []
        el.getContext = () => ({ drawImage: (img, x, y, w, h) => el.drawn.push({ x, y, w, h }) })
        el.toDataURL = (type = 'image/png', quality) => {
          el.encoded = { type, quality }
          return `data:${type};base64,scaled-${el.width}x${el.height}`
        }
      }
      created.push(el)
      return el
    },
    body: { appendChild: () => {}, removeChild: () => {} },
    getElementById: () => null,
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
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
    /** Fire a document-level key event (Escape-to-close on the overlays). */
    press: (key) => {
      for (const fn of listeners.get('keydown') ?? []) fn({ key })
    },
    /** Live document-level listener count — a leak check for overlay unmounts. */
    get liveKeyListeners() {
      return listeners.get('keydown')?.size ?? 0
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
 * The file-picking half of the browser: URL.createObjectURL, Image and FileReader.
 *
 * Opt-in rather than part of installBrowser, because only the two upload pickers need
 * it and every other test is better off without globals it does not use. Pair with
 * installBrowser — this one only adds what the picking path touches.
 *
 *   const files = installFileApis()
 *   t.after(files.restore)
 *   files.image('front.jpg', { width: 4000, height: 3000 })  // a phone-camera photo
 *   files.image('broken.jpg', { broken: true })              // not decodable
 *   files.doc('plan.pdf', 'application/pdf')                 // read by FileReader
 *
 * `leakedObjectUrls` is the check that matters beyond "it uploaded": downscalePhoto
 * creates an object URL per photo and must revoke it on both the load and the error
 * path, or picking a gallery-full of photos pins every one of them in memory.
 */
export function installFileApis() {
  const saved = new Map()
  const define = (name, value) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }

  const blobs = new Map()
  let seq = 0

  const make = (name, type, extra) => ({ name, type, size: 1024, ...extra })
  const handle = {
    image: (name, { width = 1600, height = 1200, broken = false } = {}) =>
      make(name, 'image/jpeg', { width, height, broken }),
    doc: (name, type = 'application/pdf', { unreadable = false } = {}) => make(name, type, { unreadable }),
  }

  // Node has a real URL constructor and api.js builds URLs with it, so add the two
  // statics to it rather than replacing the global with a stub.
  const RealURL = globalThis.URL
  const savedCreate = Object.getOwnPropertyDescriptor(RealURL, 'createObjectURL')
  const savedRevoke = Object.getOwnPropertyDescriptor(RealURL, 'revokeObjectURL')
  RealURL.createObjectURL = (file) => {
    const url = `blob:mock/${++seq}`
    blobs.set(url, file)
    return url
  }
  RealURL.revokeObjectURL = (url) => blobs.delete(url)

  class FakeImage {
    constructor() {
      this.onload = null
      this.onerror = null
      this.width = 0
      this.height = 0
    }

    set src(url) {
      const file = blobs.get(url)
      // Decoding is async in a browser, and the code under test revokes the object URL
      // inside the handler — firing synchronously from the setter would hide an ordering
      // bug that a real browser would expose.
      queueMicrotask(() => {
        if (!file || file.broken) return this.onerror?.(new Error('decode failed'))
        this.width = file.width
        this.height = file.height
        this.onload?.()
      })
    }
  }

  class FakeFileReader {
    readAsDataURL(file) {
      queueMicrotask(() => {
        if (file?.unreadable) return this.onerror?.(new Error('unreadable'))
        this.result = `data:${file.type};base64,${Buffer.from(file.name).toString('base64')}`
        this.onload?.()
      })
    }
  }

  define('Image', FakeImage)
  define('FileReader', FakeFileReader)

  return {
    ...handle,
    /** Object URLs created but never revoked — each one is a pinned image in a browser. */
    get leakedObjectUrls() {
      return [...blobs.keys()]
    },
    restore() {
      blobs.clear()
      if (savedCreate) Object.defineProperty(RealURL, 'createObjectURL', savedCreate)
      else delete RealURL.createObjectURL
      if (savedRevoke) Object.defineProperty(RealURL, 'revokeObjectURL', savedRevoke)
      else delete RealURL.revokeObjectURL
      for (const [name, descriptor] of saved) {
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
    if (isResponseSpec(resolved)) return response(resolved.status, resolved.body ?? {})
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

// Is this route value a `{ status, body }` RESPONSE, or is it the response body?
//
// The test used to be `'status' in resolved`, and `status` is a column. A property
// has one ('available'), so does a site visit, a deal, an invoice and a subscription
// — so `'GET /api/properties/11': property` was read as "respond 'available' with an
// empty body", the component saw a failed request, and the test went on to assert
// against an error screen it never meant to be looking at. Nothing failed; the
// assertions were simply about a different render. Two screens in the a11y sweep
// (the property panel and the billing tab) had been checked in that state.
//
// So a spec now has to be unambiguous: a NUMERIC status, and nothing on it beyond
// the three keys a response is made of. `{ status: 500, body: {} }` still means what
// it always did; a row that happens to carry a status stays a row.
const RESPONSE_KEYS = new Set(['status', 'body', 'headers'])
function isResponseSpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (typeof value.status !== 'number') return false
  return Object.keys(value).every((k) => RESPONSE_KEYS.has(k))
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}
