import { useEffect, useState } from 'react'
import { api, fmtAgo } from '../api.js'
import { Chip, Field, inputCls } from './ui.jsx'

const fmtRs = (paise) => (paise == null ? '—' : `₹${(Number(paise) / 100).toLocaleString('en-IN')}`)
const CATEGORIES = ['general', 'billing', 'whatsapp', 'technical', 'feature_request']

function NewTicket({ onCreated }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ subject: '', body: '', category: 'general' })
  const [error, setError] = useState(null)

  const submit = async () => {
    setError(null)
    try {
      await api.createSupportTicket(form)
      setForm({ subject: '', body: '', category: 'general' })
      setOpen(false)
      onCreated()
    } catch (e) {
      setError(e.message)
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full bg-ink text-cream font-bold text-[13px] rounded-xl py-2.5 active:scale-95 transition"
      >
        + New support request
      </button>
    )
  }
  return (
    <div className="bg-card rounded-2xl border border-line shadow-card p-4 space-y-2.5">
      <Field label="Subject">
        <input className={inputCls} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
      </Field>
      <Field label="Category">
        <select className={inputCls} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{c.replace('_', ' ')}</option>
          ))}
        </select>
      </Field>
      <Field label="How can we help?">
        <textarea className={`${inputCls} min-h-[80px]`} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
      </Field>
      {error && <p className="text-[12px] text-hot font-semibold">{error}</p>}
      <div className="flex gap-2">
        <button onClick={submit} disabled={!form.subject.trim() || !form.body.trim()} className="flex-1 bg-brand text-white font-bold text-[13px] rounded-xl py-2 disabled:opacity-40 active:scale-95 transition">
          Send
        </button>
        <button onClick={() => setOpen(false)} className="flex-1 bg-card border border-line text-ink-soft font-bold text-[13px] rounded-xl py-2">
          Cancel
        </button>
      </div>
    </div>
  )
}

function TicketThread({ id, onBack }) {
  const [ticket, setTicket] = useState(null)
  const [reply, setReply] = useState('')
  const load = () => api.supportTicket(id).then(setTicket).catch(() => {})
  useEffect(() => { load() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    if (!reply.trim()) return
    await api.replySupportTicket(id, reply.trim())
    setReply('')
    load()
  }

  if (!ticket) return null
  return (
    <div className="mt-4">
      <button onClick={onBack} className="text-[12.5px] font-bold text-ink-soft mb-2">← All requests</button>
      <p className="font-display text-[17px] font-semibold text-ink">{ticket.subject}</p>
      <p className="text-[11.5px] text-ink-soft mb-3">{ticket.category} · {ticket.status}</p>
      <div className="space-y-2">
        {ticket.messages.map((m) => (
          <div key={m.id} className={`max-w-[85%] rounded-2xl px-3.5 py-2 ${m.is_staff ? 'ml-auto bg-brand-wash' : 'bg-card border border-line'}`}>
            <p className="text-[10.5px] text-ink-faint mb-0.5">{m.is_staff ? 'HomeNex support' : 'You'} · {fmtAgo(m.created_at)}</p>
            <p className="text-[13px] text-ink whitespace-pre-wrap">{m.body}</p>
          </div>
        ))}
      </div>
      {ticket.status !== 'closed' && (
        <div className="flex gap-2 mt-3">
          <input className={inputCls} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply…" onKeyDown={(e) => e.key === 'Enter' && send()} />
          <button onClick={send} className="bg-brand text-white font-bold text-[13px] rounded-xl px-4 active:scale-95 transition">Send</button>
        </div>
      )}
    </div>
  )
}

export default function SupportScreen() {
  const [tab, setTab] = useState('help')
  const [tickets, setTickets] = useState(null)
  const [billing, setBilling] = useState(null)
  const [openId, setOpenId] = useState(null)

  const loadTickets = () => api.supportTickets().then(setTickets).catch(() => {})
  useEffect(() => {
    loadTickets()
    api.billing().then(setBilling).catch(() => {})
  }, [])

  if (openId) return <TicketThread id={openId} onBack={() => { setOpenId(null); loadTickets() }} />

  return (
    <div>
      <div className="flex gap-2 mt-3">
        <Chip active={tab === 'help'} onClick={() => setTab('help')}>Help</Chip>
        <Chip active={tab === 'billing'} onClick={() => setTab('billing')}>Plan &amp; billing</Chip>
      </div>

      {tab === 'help' && (
        <div className="mt-4 space-y-3">
          <NewTicket onCreated={loadTickets} />
          {tickets && tickets.length === 0 && <p className="text-[12.5px] text-ink-faint">No support requests yet.</p>}
          <div className="space-y-2">
            {(tickets || []).map((t) => (
              <button key={t.id} onClick={() => setOpenId(t.id)} className="w-full text-left bg-card rounded-2xl border border-line shadow-card px-4 py-3 active:scale-[0.99] transition">
                <div className="flex items-center gap-2">
                  <p className="font-bold text-[13.5px] text-ink flex-1 truncate">{t.subject}</p>
                  <span className="text-[10.5px] font-bold text-ink-soft">{t.status}</span>
                </div>
                <p className="text-[11.5px] text-ink-soft">{t.category} · {fmtAgo(t.updated_at)}</p>
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === 'billing' && billing && (
        <div className="mt-4 space-y-3">
          <div className="bg-card rounded-2xl border border-line shadow-card p-4">
            <p className="font-bold text-[14px] text-ink">
              {billing.subscription ? billing.subscription.plan_name : 'No plan assigned'}
            </p>
            {billing.subscription && (
              <p className="text-[12px] text-ink-soft">
                {fmtRs(billing.subscription.price_paise)}/mo · {billing.subscription.conversation_quota ?? 'unlimited'} conversations
              </p>
            )}
          </div>
          <div className="bg-card rounded-2xl border border-line shadow-card p-4">
            <p className="font-bold text-[13px] text-ink mb-1">This month's usage</p>
            <p className="text-[12px] text-ink-soft">
              {billing.usage.total_conversations} conversations · est. Meta cost {fmtRs(billing.usage.meta_cost_paise)}
            </p>
          </div>
          {(billing.invoices || []).length > 0 && (
            <div className="bg-card rounded-2xl border border-line shadow-card divide-y divide-line">
              {billing.invoices.map((inv) => (
                <div key={inv.id} className="flex items-center gap-2 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-[12.5px] font-semibold text-ink font-mono">{inv.number}</p>
                    <p className="text-[11px] text-ink-soft">{inv.status}</p>
                  </div>
                  <span className="font-bold text-[13px] text-ink">{fmtRs(inv.total_paise)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
