import { useEffect, useState } from 'react'

const TOKEN_KEY = 'homenex-token'
export const getToken = () => localStorage.getItem(TOKEN_KEY)
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY))

async function j(res) {
  if (res.status === 401) {
    setToken(null)
    window.dispatchEvent(new Event('homenex-logout'))
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
const post = (url, body) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  }).then(j)
const put = (url, body) =>
  fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  }).then(j)
const del = (url) => fetch(url, { method: 'DELETE', headers: authHeaders() }).then(j)

const qs = (params) => {
  const s = new URLSearchParams(
    Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ).toString()
  return s ? `?${s}` : ''
}

export const api = {
  signup: (body) => post('/api/auth/signup', body),
  login: (body) => post('/api/auth/login', body),
  me: () => get('/api/auth/me'),
  health: () => get('/api/health'),
  leads: (filters) => get(`/api/leads${qs(filters)}`),
  lead: (id) => get(`/api/leads/${id}`),
  updateLead: (id, body) => put(`/api/leads/${id}`, body),
  moveLeadStage: (id, stage, lost_reason) => put(`/api/leads/${id}/stage`, { stage, lost_reason }),
  pipelineStages: (type) => get(`/api/pipeline-stages${qs({ type })}`),
  stats: () => get('/api/stats'),
  activity: () => get('/api/activity'),
  dashboard: () => get('/api/dashboard'),
  network: () => get('/api/network'),
  postNetwork: (body) => post('/api/network', body),
  reply: (id, text) => post(`/api/leads/${id}/reply`, { text }),
  setAi: (id, enabled) => post(`/api/leads/${id}/ai`, { enabled }),
  assignLead: (id) => post(`/api/leads/${id}/assign`, {}),
  contacts: (search) => get(`/api/contacts${qs({ q: search })}`),
  contact: (id) => get(`/api/contacts/${id}`),
  updateContact: (id, body) => put(`/api/contacts/${id}`, body),
  deleteContact: (id) => del(`/api/contacts/${id}`),
  properties: (filters) => get(`/api/properties${qs(filters)}`),
  property: (id) => get(`/api/properties/${id}`),
  createProperty: (body) => post('/api/properties', body),
  updateProperty: (id, body) => put(`/api/properties/${id}`, body),
  deleteProperty: (id) => del(`/api/properties/${id}`),
  sendPropertyToChat: (id, leadId) => post(`/api/properties/${id}/send-to-chat`, { lead_id: leadId }),
  followups: (filters) => get(`/api/followups${qs(filters)}`),
  createFollowup: (body) => post('/api/followups', body),
  updateFollowup: (id, body) => put(`/api/followups/${id}`, body),
  siteVisits: (filters) => get(`/api/site-visits${qs(filters)}`),
  createSiteVisit: (body) => post('/api/site-visits', body),
  updateSiteVisit: (id, body) => put(`/api/site-visits/${id}`, body),
  phoneConfig: () => get('/api/agent/phone-config'),
  updatePhoneConfig: (body) =>
    fetch('/api/agent/phone-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    }).then(j),
  updateWaPhone: (body) =>
    fetch('/api/agent/wa-phone', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    }).then(j),
  // Admin APIs (list endpoint returns { agents, total, page, ... } — unwrap for the panel)
  adminAgents: () => get('/api/admin/agents').then((r) => (Array.isArray(r) ? r : r.agents)),
  adminDashboard: () => get('/api/admin/dashboard'),
  adminUpdateWaba: (agentId, body) =>
    fetch(`/api/admin/agents/${agentId}/waba`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    }).then(j),
}

// Poll an endpoint so the dashboard stays live as real messages arrive.
export function usePoll(fn, intervalMs = 5000, deps = []) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    let alive = true
    const tick = () =>
      fn()
        .then((d) => alive && (setData(d), setError(null)))
        .catch((e) => alive && setError(e))
    tick()
    const t = setInterval(tick, intervalMs)
    return () => {
      alive = false
      clearInterval(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return { data, error }
}

// Timestamps arrive as ISO strings from PostgreSQL ("2026-07-09T16:15:00.000Z");
// legacy SQLite-style "YYYY-MM-DD HH:MM:SS" (UTC) is still handled for safety.
export function parseTs(ts) {
  if (!ts) return null
  if (ts instanceof Date) return ts
  const s = String(ts)
  return new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z')
}

export function fmtTime(ts) {
  const d = parseTs(ts)
  if (!d) return ''
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

export function fmtAgo(ts) {
  const d = parseTs(ts)
  if (!d) return ''
  const s = (Date.now() - d.getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// Compact waiting-time label for the unanswered queue: "12m", "3h", "2d".
export function fmtWait(ts) {
  const d = parseTs(ts)
  if (!d) return ''
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000)
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export function fmtBudget(minL, maxL) {
  if (minL == null && maxL == null) return null
  const f = (l) => (l >= 100 ? `₹${(l / 100).toFixed(l % 100 === 0 ? 0 : 2)} Cr` : `₹${Math.round(l)} L`)
  if (minL != null && maxL != null && minL !== maxL) return `${f(minL)} – ${f(maxL)}`
  return f(maxL ?? minL)
}
