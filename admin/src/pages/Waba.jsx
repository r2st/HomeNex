import { useEffect, useState } from 'react'
import { api, fmtDate, fmtDateTime } from '../api.js'
import { StatusBadge } from '../components.jsx'

// Inline registration form for one pending agent: enter Meta IDs -> registered.
function RegisterRow({ agent, onDone }) {
  const [open, setOpen] = useState(false)
  const [metaWabaId, setMetaWabaId] = useState('')
  const [phoneNumberId, setPhoneNumberId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const register = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.updateWaba(agent.id, {
        status: 'registered',
        meta_waba_id: metaWabaId,
        wa_phone_number_id: phoneNumberId,
      })
      onDone()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <>
      <tr>
        <td>
          <a href={`#/agents/${agent.id}`}>{agent.name}</a>
          <div className="sub">{agent.email || agent.phone}</div>
        </td>
        <td className="mono">{agent.wa_phone_number || '—'}</td>
        <td>{fmtDate(agent.created_at)}</td>
        <td>
          <button className="btn sm" onClick={() => setOpen(!open)}>
            {open ? 'Cancel' : 'Mark registered'}
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={4} style={{ background: '#fafbfd' }}>
            <form onSubmit={register} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <label className="field" style={{ marginBottom: 0, minWidth: 220 }}>
                <span>Meta WABA ID</span>
                <input className="mono" value={metaWabaId} onChange={(e) => setMetaWabaId(e.target.value)} required />
              </label>
              <label className="field" style={{ marginBottom: 0, minWidth: 220 }}>
                <span>Meta phone_number_id</span>
                <input className="mono" value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} required />
              </label>
              <button className="btn sm" disabled={busy}>{busy ? 'Saving…' : 'Register'}</button>
              {error && <span className="error-box" style={{ margin: 0 }}>{error}</span>}
            </form>
          </td>
        </tr>
      )}
    </>
  )
}

// Registered/active numbers with a health indicator (placeholder until we
// poll Meta's quality/health API).
function NumberRow({ agent, onChanged }) {
  const [busy, setBusy] = useState(false)
  const isActive = agent.waba_status === 'active'

  const setStatus = async (status) => {
    setBusy(true)
    try {
      await api.updateWaba(agent.id, { status })
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <tr>
      <td>
        <a href={`#/agents/${agent.id}`}>{agent.name}</a>
        <div className="sub">{agent.email || agent.phone}</div>
      </td>
      <td className="mono">{agent.wa_phone_number || '—'}</td>
      <td className="mono">{agent.wa_phone_number_id || '—'}</td>
      <td><StatusBadge status={agent.waba_status} /></td>
      <td>
        <span className={`health-dot ${isActive ? 'ok' : 'off'}`} />
        {isActive ? 'Healthy' : 'Not live'} <span className="sub">(placeholder)</span>
      </td>
      <td>{fmtDateTime(agent.waba_registered_at)}</td>
      <td>
        {isActive ? (
          <button className="btn secondary sm" disabled={busy} onClick={() => setStatus('registered')}>
            Deactivate
          </button>
        ) : (
          <button className="btn sm" disabled={busy} onClick={() => setStatus('active')}>
            Activate
          </button>
        )}
      </td>
    </tr>
  )
}

export default function Waba() {
  const [pending, setPending] = useState(null)
  const [registered, setRegistered] = useState(null)
  const [error, setError] = useState(null)

  const load = () => {
    Promise.all([
      api.agents({ status: 'pending', pageSize: 100 }),
      api.agents({ status: 'registered', pageSize: 100 }),
      api.agents({ status: 'active', pageSize: 100 }),
    ])
      .then(([p, r, a]) => {
        setPending(p.agents)
        setRegistered([...r.agents, ...a.agents])
        setError(null)
      })
      .catch((e) => setError(e.message))
  }
  useEffect(load, [])

  return (
    <>
      <h1 className="page-title">WABA Management</h1>
      <p className="page-sub">Register and activate agents' WhatsApp Business numbers</p>

      {error && <div className="error-box">{error}</div>}

      <div className="section-title">Setup queue — pending registration {pending && `(${pending.length})`}</div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Requested business number</th>
              <th>Signed up</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {pending?.map((a) => <RegisterRow key={a.id} agent={a} onDone={load} />)}
            {pending && pending.length === 0 && (
              <tr><td colSpan={4} className="empty">Queue is empty — no agents waiting for WABA setup.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="section-title">Registered numbers {registered && `(${registered.length})`}</div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Business number</th>
              <th>phone_number_id</th>
              <th>Status</th>
              <th>Health</th>
              <th>Registered</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {registered?.map((a) => <NumberRow key={a.id} agent={a} onChanged={load} />)}
            {registered && registered.length === 0 && (
              <tr><td colSpan={7} className="empty">No registered numbers yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
