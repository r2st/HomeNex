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
const del = (url) => fetch(url, { method: 'DELETE', headers: authHeaders() }).then(j)

export const api = {
  signup: (body) => post('/api/auth/signup', body),
  login: (body) => post('/api/auth/login', body),
  me: () => get('/api/auth/me'),
  health: () => get('/api/health'),
  leads: () => get('/api/leads'),
  lead: (id) => get(`/api/leads/${id}`),
  stats: () => get('/api/stats'),
  activity: () => get('/api/activity'),
  network: () => get('/api/network'),
  postNetwork: (body) => post('/api/network', body),
  reply: (id, text) => post(`/api/leads/${id}/reply`, { text }),
  setAi: (id, enabled) => post(`/api/leads/${id}/ai`, { enabled }),
  assignLead: (id) => post(`/api/leads/${id}/assign`, {}),
  contacts: () => get('/api/contacts'),
  addContact: (body) => post('/api/contacts', body),
  bulkContacts: (contacts) => post('/api/contacts/bulk', { contacts }),
  deleteContact: (id) => del(`/api/contacts/${id}`),
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

// SQLite stores UTC "YYYY-MM-DD HH:MM:SS"; render as local, compact.
export function fmtTime(sqliteUtc) {
  if (!sqliteUtc) return ''
  const d = new Date(sqliteUtc.replace(' ', 'T') + 'Z')
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

export function fmtAgo(sqliteUtc) {
  if (!sqliteUtc) return ''
  const s = (Date.now() - new Date(sqliteUtc.replace(' ', 'T') + 'Z').getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function fmtBudget(minL, maxL) {
  if (minL == null && maxL == null) return null
  const f = (l) => (l >= 100 ? `₹${(l / 100).toFixed(l % 100 === 0 ? 0 : 2)} Cr` : `₹${Math.round(l)} L`)
  if (minL != null && maxL != null && minL !== maxL) return `${f(minL)} – ${f(maxL)}`
  return f(maxL ?? minL)
}
