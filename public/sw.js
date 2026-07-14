// HomeNex service worker: offline-first caching for Indian network conditions.
// - Navigations (app shell): NETWORK-FIRST so a fresh deploy is picked up on the next
//   visit (no stale index.html pointing at deleted asset hashes), with a cached-shell
//   fallback only when the network is unavailable.
// - Hashed static assets (/assets/*): cache-first — hashed filenames make this safe.
// - API GETs (dashboard, leads, contacts, ...): network-first with cache fallback,
//   so the agent can still read their CRM at a construction site with no signal.
// Bump CACHE whenever the caching strategy changes; `activate` purges older caches.
const CACHE = 'homenex-v2'
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon.svg']

// API paths worth serving stale when offline (read-only CRM data).
const CACHEABLE_API = /^\/api\/(dashboard|leads|contacts|properties|followups|site-visits|stats|activity|pipeline-stages|templates)/

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== location.origin) return // never touch cross-origin (fonts, photos)
  if (url.pathname === '/webhook' || url.pathname.startsWith('/admin')) return

  // API: network-first, fall back to last-known data when offline.
  if (url.pathname.startsWith('/api/')) {
    if (!CACHEABLE_API.test(url.pathname)) return
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((cache) => cache.put(request, copy))
          }
          return res
        })
        .catch(() => caches.match(request).then((hit) => hit || Response.error())),
    )
    return
  }

  // Navigations (the SPA shell): network-first so a new deploy shows immediately.
  // Only fall back to the cached shell when the network is unavailable, so the app
  // still boots offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((cache) => cache.put(request, copy))
          }
          return res
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match('/'))),
    )
    return
  }

  // Hashed static assets: cache-first, refresh in the background.
  event.respondWith(
    caches.match(request).then((hit) => {
      const refresh = fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((cache) => cache.put(request, copy))
          }
          return res
        })
        .catch(() => hit)
      return hit || refresh
    }),
  )
})
