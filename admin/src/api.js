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

// The API sends timestamps in two shapes, and the old code — written against SQLite's
// zoneless "YYYY-MM-DD HH:MM:SS" — appended a 'Z' to both.
//
//   TIMESTAMPTZ  pg parses to a JS Date, so JSON.stringify emits ISO-8601 with a zone
//                already on it: "2026-08-10T14:23:45.123Z". Appending another 'Z' gave
//                "…ZZ", which is Invalid Date. Every timestamp in the portal — joined,
//                registered, last active, ticket replies — rendered as "Invalid Date",
//                and fmtAgo rendered "NaNd ago".
//   DATE         Deliberately left as a plain "2026-07-01" string by the type parser in
//                server/db.js, so a payout date cannot slide a day across zones. "…Z"
//                made those Invalid Date too.
//
// So: parse what actually arrives, and render a date-only value as written rather than
// putting it through a timezone at all — converting it is the very off-by-one the
// server's type parser exists to avoid.
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const LEGACY_SQLITE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/

function toDate(value) {
  if (value == null || value === '') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  const s = String(value)
  const only = s.match(DATE_ONLY)
  // Local midnight, not UTC midnight: new Date('2026-07-01') is the latter, and renders
  // as 30 June anywhere west of Greenwich.
  if (only) return new Date(Number(only[1]), Number(only[2]) - 1, Number(only[3]))
  // A row imported from the old SQLite database still has no zone marker, and meant UTC.
  const d = new Date(LEGACY_SQLITE.test(s) ? `${s.replace(' ', 'T')}Z` : s)
  return Number.isNaN(d.getTime()) ? null : d
}

export function fmtDate(value) {
  const d = toDate(value)
  // '—' rather than "Invalid Date": an unparseable value is missing information, and
  // saying so is more use to whoever is reading the portal than the words themselves.
  return d ? d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
}

export function fmtDateTime(value) {
  const d = toDate(value)
  return d
    ? d.toLocaleString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '—'
}

export function fmtAgo(value) {
  const d = toDate(value)
  if (!d) return '—'
  const s = (Date.now() - d.getTime()) / 1000
  // A clock skew between the server and this browser can put a "just created" row a few
  // seconds into the future; "just now" is the honest reading of that, not "-1m ago".
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export const WABA_STATUSES = ['none', 'pending', 'registered', 'active']
