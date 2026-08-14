import { useEffect, useState } from 'react'
import { api } from '../api.js'

function Stat({ label, value }) {
  return (
    <div className="card stat">
      <div className="value">{value ?? '—'}</div>
      <div className="label">{label}</div>
    </div>
  )
}

// A tiny inline bar so cohort activation reads at a glance without a chart library.
function Bar({ value, max }) {
  const pct = max ? Math.round((value / max) * 100) : 0
  return (
    <div style={{ background: '#eee', borderRadius: 4, height: 8, width: 120 }}>
      <div style={{ background: '#2f6f52', height: 8, borderRadius: 4, width: `${pct}%` }} />
    </div>
  )
}

export default function Analytics() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    api.analytics().then(setData).catch((e) => setError(e.message))
  }, [])

  if (error) return <div className="error-box">{error}</div>
  // Rendering nothing at all made a slow query indistinguishable from a broken page.
  if (!data) return <p className="page-sub">Loading analytics…</p>
  const maxCity = Math.max(1, ...data.cities.map((c) => c.agents))

  return (
    <>
      <h1 className="page-title">Platform Analytics</h1>
      <p className="page-sub">Cohort activation, retention, feature adoption and geography</p>

      <div className="section-title">Retention (agents active in window)</div>
      <div className="stat-grid">
        <Stat label="Active today" value={data.retention.active_1d} />
        <Stat label="Active 7 days" value={data.retention.active_7d} />
        <Stat label="Active 30 days" value={data.retention.active_30d} />
      </div>

      <div className="section-title">Signup cohorts (activation = captured a lead)</div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Week</th><th>Signups</th><th>Activated</th><th>Rate</th></tr></thead>
          <tbody>
            {data.cohorts.map((c) => (
              <tr key={c.week}>
                <td>{c.week}</td>
                <td>{c.signups}</td>
                <td>{c.activated}</td>
                <td>{c.signups ? Math.round((c.activated / c.signups) * 100) : 0}%</td>
              </tr>
            ))}
            {data.cohorts.length === 0 && <tr><td colSpan={4} className="empty">No signups in the last 12 weeks.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="section-title">Feature adoption</div>
      <div className="stat-grid">
        <Stat label="Teams" value={data.feature_usage.teams} />
        <Stat label="Agents with properties" value={data.feature_usage.agents_with_properties} />
        <Stat label="Agents with site visits" value={data.feature_usage.agents_with_site_visits} />
        <Stat label="Agents with templates" value={data.feature_usage.agents_with_templates} />
        <Stat label="Agents with commissions" value={data.feature_usage.agents_with_commissions} />
        <Stat label="Agents with groups" value={data.feature_usage.agents_with_groups} />
      </div>

      <div className="section-title">Agents by city</div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>City</th><th>Agents</th><th></th></tr></thead>
          <tbody>
            {data.cities.map((c) => (
              <tr key={c.city}>
                <td>{c.city}</td>
                <td>{c.agents}</td>
                <td><Bar value={c.agents} max={maxCity} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
