import { useEffect, useState } from 'react'
import { api, fmtAgo } from '../api.js'

// §7.2 Template approval workflow: agents submit drafts for review; staff approve,
// reject (with a note), or submit the approved template to Meta.
export default function Templates() {
  const [pending, setPending] = useState(null)
  const [error, setError] = useState(null)
  const [note, setNote] = useState({})

  const load = () => api.pendingTemplates().then(setPending).catch((e) => setError(e.message))
  useEffect(load, [])

  const review = async (id, action) => {
    try {
      await api.reviewTemplate(id, action, note[id] || undefined)
      setNote((n) => ({ ...n, [id]: '' }))
      load()
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <>
      <h1 className="page-title">Template Approvals</h1>
      <p className="page-sub">Agent-requested WhatsApp templates awaiting review, then submission to Meta</p>
      {error && <div className="error-box">{error}</div>}

      {pending && pending.length === 0 && <div className="empty card">No templates are waiting for review.</div>}

      {(pending || []).map((t) => (
        <div key={t.id} className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <div className="mono"><strong>{t.name}</strong> · {t.category} · {t.language}</div>
              <div className="sub">
                {t.agent_name} ({t.agent_phone}) · requested {fmtAgo(t.updated_at)}
              </div>
            </div>
            <span className="badge pending">pending review</span>
          </div>
          <p style={{ whiteSpace: 'pre-wrap', margin: '10px 0', padding: 10, background: '#faf8f4', borderRadius: 8 }}>
            {t.body}
          </p>
          <input
            style={{ width: '100%', padding: 8, marginBottom: 8 }}
            aria-label={`Review note for the "${t.name}" template`}
            placeholder="Review note (shown to the agent on rejection)"
            value={note[t.id] || ''}
            onChange={(e) => setNote((n) => ({ ...n, [t.id]: e.target.value }))}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn sm" onClick={() => review(t.id, 'approve')}>Approve</button>
            <button className="btn sm" onClick={() => review(t.id, 'submit')}>Approve &amp; submit to Meta</button>
            <button className="btn secondary sm" onClick={() => review(t.id, 'reject')}>Reject</button>
          </div>
        </div>
      ))}
    </>
  )
}
