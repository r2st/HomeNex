import { useEffect, useState } from 'react'
import { api } from '../api.js'

function Stat({ label, value, hint }) {
  return (
    <div className="card stat">
      <div className="value">{value ?? '—'}</div>
      <div className="label">{label}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  )
}

export default function Dashboard() {
  const [stats, setStats] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    api.dashboard().then(setStats).catch((e) => setError(e.message))
  }, [])

  if (error) return <div className="error-box">{error}</div>

  return (
    <>
      <h1 className="page-title">Dashboard</h1>
      <p className="page-sub">Platform overview across all agents</p>

      <div className="stat-grid">
        <Stat label="Total agents" value={stats?.totalAgents} />
        <Stat label="New signups (7 days)" value={stats?.newAgents7d} />
        <Stat label="New signups (30 days)" value={stats?.newAgents30d} />
        <Stat label="Active conversations" value={stats?.activeConversations} hint="Leads with a message in the last 24h" />
      </div>

      <div className="section-title">WABA status breakdown</div>
      <div className="stat-grid">
        <Stat label="No WABA" value={stats?.noneWaba} />
        <Stat label="Pending setup" value={stats?.pendingWaba} hint={stats?.pendingWaba ? <a href="#/waba">Go to WABA queue →</a> : null} />
        <Stat label="Registered" value={stats?.registeredWaba} />
        <Stat label="Active" value={stats?.activeWaba} />
      </div>

      <div className="section-title">Usage</div>
      <div className="stat-grid">
        <Stat label="Total leads" value={stats?.totalLeads} />
        <Stat label="Total client contacts" value={stats?.totalContacts} />
      </div>
    </>
  )
}
