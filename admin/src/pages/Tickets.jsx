import { useEffect, useState } from 'react'
import { api, fmtAgo } from '../api.js'

const STATUS_BADGE = { open: 'pending', pending: 'registered', resolved: 'active', closed: 'none' }
const STATUSES = ['', 'open', 'pending', 'resolved', 'closed']

function Detail({ id, onChange }) {
  const [ticket, setTicket] = useState(null)
  const [reply, setReply] = useState('')
  const [error, setError] = useState(null)

  const load = () => api.ticket(id).then(setTicket).catch((e) => setError(e.message))
  useEffect(() => { load() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    if (!reply.trim()) return
    try {
      await api.replyTicket(id, reply.trim())
      setReply('')
      load()
      onChange()
    } catch (e) {
      setError(e.message)
    }
  }

  const setStatus = async (status) => {
    await api.updateTicket(id, { status }).catch((e) => setError(e.message))
    load()
    onChange()
  }

  if (!ticket) return <div className="card">Loading…</div>
  return (
    <div className="card">
      {error && <div className="error-box">{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
        <div>
          <h2 style={{ margin: 0 }}>{ticket.subject}</h2>
          <div className="sub">
            {ticket.agent_name} · {ticket.business_name || ticket.city || '—'} · {ticket.agent_phone} · WABA {ticket.waba_status}
          </div>
          <div className="sub">Category: {ticket.category} · Priority: {ticket.priority}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <span className={`badge ${STATUS_BADGE[ticket.status]}`}>{ticket.status}</span>
          <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
            {['pending', 'resolved', 'closed'].map((s) => (
              <button key={s} className="btn secondary sm" onClick={() => setStatus(s)} disabled={ticket.status === s}>
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ margin: '14px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {ticket.messages.map((m) => (
          <div
            key={m.id}
            style={{
              alignSelf: m.is_staff ? 'flex-end' : 'flex-start',
              maxWidth: '80%',
              background: m.is_staff ? '#e8f1ec' : '#faf8f4',
              borderRadius: 10,
              padding: '8px 12px',
            }}
          >
            <div className="sub" style={{ marginBottom: 2 }}>
              {m.is_staff ? 'Staff' : ticket.agent_name} · {fmtAgo(m.created_at)}
            </div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <input
          style={{ flex: 1, padding: 8 }}
          aria-label="Reply to the agent"
          placeholder="Reply to the agent…"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
        />
        <button className="btn" onClick={send}>Send</button>
      </div>
    </div>
  )
}

export default function Tickets() {
  const [status, setStatus] = useState('')
  const [tickets, setTickets] = useState(null)
  const [sel, setSel] = useState(null)
  const [error, setError] = useState(null)

  const load = () => api.tickets(status).then(setTickets).catch((e) => setError(e.message))
  useEffect(() => { load() }, [status]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <h1 className="page-title">Support Tickets</h1>
      <p className="page-sub">In-app Help requests with full tenant context</p>
      {error && <div className="error-box">{error}</div>}

      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter tickets by status">
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s ? s[0].toUpperCase() + s.slice(1) : 'All statuses'}</option>
          ))}
        </select>
      </div>

      <div className="table-wrap" style={{ marginBottom: 16 }}>
        <table>
          <thead>
            <tr><th>Subject</th><th>Agent</th><th>Category</th><th>Priority</th><th>Status</th><th>Updated</th></tr>
          </thead>
          <tbody>
            {(tickets || []).map((t) => (
              <tr key={t.id} style={{ cursor: 'pointer', background: sel === t.id ? '#f0f5f2' : undefined }} onClick={() => setSel(t.id)}>
                <td><strong>{t.subject}</strong> <span className="sub">({t.message_count})</span></td>
                <td>{t.agent_name}</td>
                <td>{t.category}</td>
                <td>{t.priority}</td>
                <td><span className={`badge ${STATUS_BADGE[t.status]}`}>{t.status}</span></td>
                <td className="sub">{fmtAgo(t.updated_at)}</td>
              </tr>
            ))}
            {tickets && tickets.length === 0 && <tr><td colSpan={6} className="empty">No tickets.</td></tr>}
          </tbody>
        </table>
      </div>

      {sel && <Detail id={sel} onChange={load} />}
    </>
  )
}
