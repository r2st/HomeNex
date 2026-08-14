import { useEffect, useState } from 'react'
import { api, fmtAgo } from '../api.js'
import { StatusBadge } from '../components.jsx'

const Tick = ({ ok }) => <span style={{ color: ok ? '#16794c' : '#b23b3b' }}>{ok ? '✓' : '○'}</span>

// Open the main dashboard as this agent (impersonation). The main app reads the
// 'homenex-token' key, distinct from the admin token, so this doesn't disturb the
// admin session.
async function impersonate(id) {
  const { token } = await api.impersonate(id)
  localStorage.setItem('homenex-token', token)
  window.open('/', '_blank')
}

export default function Onboarding() {
  const [queue, setQueue] = useState(null)
  const [health, setHealth] = useState(null)
  const [healthError, setHealthError] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)

  const load = () => {
    api.onboarding().then(setQueue).catch((e) => setError(e.message))
    // Kept off the page-level error on purpose: the health board is a second, lower
    // section, and failing it should not replace the onboarding queue with an error
    // screen. But it must not be swallowed either — an empty board with no
    // explanation reads as "every number is fine".
    api
      .wabaHealth()
      .then((h) => {
        setHealth(h)
        setHealthError(null)
      })
      .catch((e) => setHealthError(e.message))
  }
  useEffect(load, [])

  const act = async (fn) => {
    setBusy(true)
    try {
      await fn()
      load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  if (error) return <div className="error-box">{error}</div>

  return (
    <>
      <h1 className="page-title">Onboarding</h1>
      <p className="page-sub">Agents still setting up — verify KYC/RERA and get their WhatsApp line live</p>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Profile</th>
              <th>RERA</th>
              <th>WABA</th>
              <th>KYC</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {(queue || []).map((a) => (
              <tr key={a.id}>
                <td>
                  <div><strong>{a.name}</strong></div>
                  <div className="sub mono">{a.phone}</div>
                  {a.rera_id && <div className="sub">RERA: {a.rera_id}{a.rera_state ? ` · ${a.rera_state}` : ''}</div>}
                </td>
                <td><Tick ok={a.steps.profile} /></td>
                <td><Tick ok={a.steps.rera} /></td>
                <td><StatusBadge status={a.waba_status} /></td>
                <td>{a.kyc_status}</td>
                <td>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {a.kyc_status !== 'verified' && (
                      <button className="btn sm" disabled={busy} onClick={() => act(() => api.setKyc(a.id, { status: 'verified' }))}>
                        Verify KYC
                      </button>
                    )}
                    {!a.rera_verified && a.rera_id && (
                      <button className="btn secondary sm" disabled={busy} onClick={() => act(() => api.verifyRera(a.id, true))}>
                        Verify RERA
                      </button>
                    )}
                    <button className="btn secondary sm" onClick={() => impersonate(a.id).catch((e) => setError(e.message))}>
                      Impersonate
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {queue && queue.length === 0 && (
              <tr><td colSpan={6} className="empty">Everyone is fully onboarded 🎉</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="section-title">WABA health board</div>
      {healthError && <div className="error-box">{healthError}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Number</th>
              <th>Status</th>
              <th>Sends (7d)</th>
              <th>Last active</th>
            </tr>
          </thead>
          <tbody>
            {(health || []).map((h) => (
              <tr key={h.id}>
                <td>{h.name}</td>
                <td className="mono">{h.wa_phone_number || '—'}</td>
                <td><StatusBadge status={h.waba_status} /></td>
                <td>{h.sends_7d}</td>
                <td className="sub">{h.last_active ? fmtAgo(h.last_active) : '—'}</td>
              </tr>
            ))}
            {health && health.length === 0 && (
              <tr><td colSpan={5} className="empty">No WhatsApp numbers are registered yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
