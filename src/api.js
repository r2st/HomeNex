import { useEffect, useState } from 'react'

async function j(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `HTTP ${res.status}`)
  }
  return res.json()
}

const post = (url, body) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(j)

export const api = {
  health: () => fetch('/api/health').then(j),
  leads: () => fetch('/api/leads').then(j),
  lead: (id) => fetch(`/api/leads/${id}`).then(j),
  stats: () => fetch('/api/stats').then(j),
  activity: () => fetch('/api/activity').then(j),
  network: () => fetch('/api/network').then(j),
  postNetwork: (body) => post('/api/network', body),
  reply: (id, text) => post(`/api/leads/${id}/reply`, { text }),
  setAi: (id, enabled) => post(`/api/leads/${id}/ai`, { enabled }),
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
