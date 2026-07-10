// API client for the admin site. Uses its own token key so an admin session
// here doesn't collide with an agent session in the main dashboard.
const TOKEN_KEY = 'homenex-admin-token'
export const getToken = () => localStorage.getItem(TOKEN_KEY)
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY))

async function j(res) {
  if (res.status === 401) {
    setToken(null)
    window.dispatchEvent(new Event('admin-logout'))
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `HTTP ${res.status}`)
  }
  return res.json()
}

const authHeaders = () => {
  const t = getToken()
  return t ? { authorization: `Bearer ${t}` } : {}
}

const get = (url) => fetch(url, { headers: authHeaders() }).then(j)
const send = (method) => (url, body) =>
  fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  }).then(j)
const post = send('POST')
const put = send('PUT')

const qs = (params) => {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') q.set(k, v)
  }
  const s = q.toString()
  return s ? `?${s}` : ''
}

export const api = {
  login: (body) => post('/api/auth/login', body),
  me: () => get('/api/auth/me'),
  dashboard: () => get('/api/admin/dashboard'),
  agents: (params) => get(`/api/admin/agents${qs(params)}`),
  agent: (id) => get(`/api/admin/agents/${id}`),
  updateAgent: (id, body) => put(`/api/admin/agents/${id}`, body),
  updateWaba: (id, body) => put(`/api/admin/agents/${id}/waba`, body),
}

// SQLite stores UTC "YYYY-MM-DD HH:MM:SS"; render as local.
export function fmtDate(sqliteUtc) {
  if (!sqliteUtc) return '—'
  const d = new Date(sqliteUtc.replace(' ', 'T') + 'Z')
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function fmtDateTime(sqliteUtc) {
  if (!sqliteUtc) return '—'
  const d = new Date(sqliteUtc.replace(' ', 'T') + 'Z')
  return d.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function fmtAgo(sqliteUtc) {
  if (!sqliteUtc) return '—'
  const s = (Date.now() - new Date(sqliteUtc.replace(' ', 'T') + 'Z').getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export const WABA_STATUSES = ['none', 'pending', 'registered', 'active']
