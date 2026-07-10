// HomeNex service worker: offline-first caching for Indian network conditions.
// - App shell + static assets: cache-first (hashed filenames make this safe)
// - API GETs (dashboard, leads, contacts, ...): network-first with cache fallback,
//   so the agent can still read their CRM at a construction site with no signal.
const CACHE = 'homenex-v1'
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

  if (url.pathname.startsWith('/api/')) {
    if (!CACHEABLE_API.test(url.pathname)) return
    // Network-first: fresh data when online, last-known data when offline.
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

  // Static assets and navigations: cache-first, refresh in the background.
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
      // Navigations fall back to the cached shell so the SPA boots offline.
      if (hit) return hit
      if (request.mode === 'navigate') {
        return refresh.then((res) => res || caches.match('/')).catch(() => caches.match('/'))
      }
      return refresh
    }),
  )
})
