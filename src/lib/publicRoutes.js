// Public (login-free) route resolution. Lives outside PublicPages.jsx so the
// app shell can route without pulling the whole public-pages chunk into the
// main bundle — App.jsx lazy-loads the page components themselves.
export function resolvePublicRoute(pathname) {
  if (pathname === '/tools') return 'tools-index'
  if (pathname.startsWith('/tools/')) return 'tool-page'
  if (pathname === '/blog') return 'blog-index'
  if (pathname.startsWith('/blog/')) return 'blog-post'
  if (pathname === '/embed') return 'embed'
  return null
}
