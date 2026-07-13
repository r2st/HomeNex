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
  auditLogs: (limit) => get(`/api/admin/audit-logs${qs({ limit })}`),
  // §7.1 Onboarding, KYC/RERA, WABA health, impersonation
  onboarding: () => get('/api/admin/onboarding'),
  setKyc: (id, body) => put(`/api/admin/agents/${id}/kyc`, body),
  verifyRera: (id, verified) => put(`/api/admin/agents/${id}/rera-verify`, { verified }),
  wabaHealth: () => get('/api/admin/waba-health'),
  impersonate: (id) => post(`/api/admin/agents/${id}/impersonate`, {}),
  // §7.2 Template approval workflow
  pendingTemplates: () => get('/api/admin/templates/pending'),
  reviewTemplate: (id, action, note) => put(`/api/admin/templates/${id}/review`, { action, note }),
  // §7.3 Billing & usage
  plans: () => get('/api/admin/plans'),
  createPlan: (body) => post('/api/admin/plans', body),
  updatePlan: (id, body) => put(`/api/admin/plans/${id}`, body),
  agentBilling: (id) => get(`/api/admin/agents/${id}/billing`),
  setSubscription: (id, planId, status) => put(`/api/admin/agents/${id}/subscription`, { plan_id: planId, status }),
  generateInvoice: (id, body) => post(`/api/admin/agents/${id}/invoices`, body),
  setInvoiceStatus: (id, status) => put(`/api/admin/invoices/${id}/status`, { status }),
  // §7.4 Support tickets
  tickets: (status) => get(`/api/admin/tickets${qs({ status })}`),
  ticket: (id) => get(`/api/admin/tickets/${id}`),
  replyTicket: (id, body) => post(`/api/admin/tickets/${id}/reply`, { body }),
  updateTicket: (id, body) => put(`/api/admin/tickets/${id}`, body),
  // §7.5 Platform analytics
  analytics: () => get('/api/admin/analytics'),
}

// Paise (BIGINT) → "₹1,234.00".
export function fmtPaise(paise) {
  if (paise == null) return '—'
  return `₹${(Number(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
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
