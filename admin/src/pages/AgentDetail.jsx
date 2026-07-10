import { useEffect, useState } from 'react'
import { api, fmtDateTime, fmtAgo, WABA_STATUSES } from '../api.js'
import { StatusBadge } from '../components.jsx'

function ProfileEditor({ agent, onSaved }) {
  const [name, setName] = useState(agent.name || '')
  const [email, setEmail] = useState(agent.email || '')
  const [phone, setPhone] = useState(agent.phone || '')
  const [isAdmin, setIsAdmin] = useState(agent.is_admin === 1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)

  const save = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const updated = await api.updateAgent(agent.id, {
        name,
        email,
        phone,
        is_admin: isAdmin,
      })
      onSaved(updated)
      setSaved(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card" onSubmit={save}>
      <div className="section-title" style={{ marginTop: 0 }}>Profile</div>
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label className="field">
        <span>Email</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="optional" />
      </label>
      <label className="field">
        <span>Personal WhatsApp number</span>
        <input value={phone} onChange={(e) => setPhone(e.target.value)} required />
      </label>
      <label className="field" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={isAdmin}
          onChange={(e) => setIsAdmin(e.target.checked)}
        />
        <span style={{ marginBottom: 0 }}>Platform admin</span>
      </label>
      {error && <div className="error-box">{error}</div>}
      {saved && <div className="ok-box">Profile saved.</div>}
      <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</button>
    </form>
  )
}

export function WabaEditor({ agent, onSaved }) {
  const [status, setStatus] = useState(agent.waba_status || 'none')
  const [waPhone, setWaPhone] = useState(agent.wa_phone_number || '')
  const [phoneNumberId, setPhoneNumberId] = useState(agent.wa_phone_number_id || '')
  const [metaWabaId, setMetaWabaId] = useState(agent.meta_waba_id || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)

  const save = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const updated = await api.updateWaba(agent.id, {
        status,
        wa_phone_number: waPhone || null,
        wa_phone_number_id: phoneNumberId || null,
        meta_waba_id: metaWabaId || null,
      })
      onSaved(updated)
      setSaved(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card" onSubmit={save}>
      <div className="section-title" style={{ marginTop: 0 }}>
        WABA configuration <StatusBadge status={agent.waba_status} />
      </div>
      <label className="field">
        <span>Status</span>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {WABA_STATUSES.map((s) => (
            <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>WhatsApp Business number</span>
        <input value={waPhone} onChange={(e) => setWaPhone(e.target.value)} placeholder="+919876543210" />
      </label>
      <label className="field">
        <span>Meta phone_number_id</span>
        <input className="mono" value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} placeholder="123456789012345" />
      </label>
      <label className="field">
        <span>Meta WABA ID</span>
        <input className="mono" value={metaWabaId} onChange={(e) => setMetaWabaId(e.target.value)} placeholder="987654321098765" />
      </label>
      {agent.waba_registered_at && (
        <p className="sub" style={{ color: 'var(--ink-faint)', fontSize: 12 }}>
          Registered: {fmtDateTime(agent.waba_registered_at)}
        </p>
      )}
      {error && <div className="error-box">{error}</div>}
      {saved && <div className="ok-box">WABA config saved.</div>}
      <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save WABA config'}</button>
    </form>
  )
}

export default function AgentDetail({ id }) {
  const [agent, setAgent] = useState(null)
  const [error, setError] = useState(null)

  const load = () => api.agent(id).then(setAgent).catch((e) => setError(e.message))
  useEffect(() => {
    setAgent(null)
    setError(null)
    load()
  }, [id])

  // Editors return the bare agent row; re-fetch so counts/activity stay correct.
  const onSaved = () => load()

  if (error) return (
    <>
      <p><a href="#/agents">← All agents</a></p>
      <div className="error-box">{error}</div>
    </>
  )
  if (!agent) return <p className="page-sub">Loading…</p>

  return (
    <>
      <p><a href="#/agents">← All agents</a></p>
      <h1 className="page-title">
        {agent.name} {agent.is_admin === 1 && <span className="badge admin">admin</span>}
      </h1>
      <p className="page-sub">Agent #{agent.id} · joined {fmtDateTime(agent.created_at)}</p>

      <div className="stat-grid">
        <div className="card stat"><div className="value">{agent.lead_count}</div><div className="label">Leads</div></div>
        <div className="card stat"><div className="value">{agent.contact_count}</div><div className="label">Clients</div></div>
        <div className="card stat"><div className="value">{agent.message_count}</div><div className="label">Messages</div></div>
        <div className="card stat"><div className="value">{fmtAgo(agent.last_active)}</div><div className="label">Last active</div></div>
      </div>

      <div className="grid-2">
        <ProfileEditor key={`p${agent.id}-${agent.name}-${agent.email}-${agent.phone}-${agent.is_admin}`} agent={agent} onSaved={onSaved} />
        <WabaEditor key={`w${agent.id}-${agent.waba_status}-${agent.wa_phone_number_id}`} agent={agent} onSaved={onSaved} />
      </div>

      <div className="section-title">Recent activity</div>
      <div className="card">
        {agent.recent_activity?.length ? (
          <ul className="activity">
            {agent.recent_activity.map((a) => (
              <li key={a.id}>
                {a.text} <span className="when">· {fmtAgo(a.created_at)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty">No activity yet.</div>
        )}
      </div>
    </>
  )
}
