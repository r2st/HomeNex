import { useEffect, useRef, useState } from 'react'
import { api, usePoll, fmtTime, fmtAgo } from '../api.js'

const ROLE_LABEL = { ai: 'HomeNex AI', agent: 'You' }

function Conversation({ leadId, onBack }) {
  const [sendError, setSendError] = useState(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef(null)
  const { data: lead } = usePoll(() => api.lead(leadId), 3000, [leadId])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [lead?.messages?.length])

  if (!lead) return <p className="text-center text-[13px] text-ink-faint pt-16">Loading…</p>

  const toggleAi = async () => {
    await api.setAi(lead.id, !lead.ai_enabled)
  }

  const send = async () => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setSendError(null)
    try {
      await api.reply(lead.id, text)
      setDraft('')
    } catch (e) {
      setSendError(e.message)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex flex-col h-[calc(100dvh-88px)]">
      <div className="bg-brand-deep px-4 py-3 flex items-center gap-3 shrink-0">
        <button onClick={onBack} className="text-white/90 text-[18px] px-1 active:scale-95 transition">
          ←
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-white font-bold text-[14.5px] leading-tight truncate">
            {lead.name || lead.wa_id}
          </p>
          <p className="text-white/75 text-[11px] truncate">
            +{lead.wa_id} · {lead.temp} · score {lead.score}
          </p>
        </div>
        <button
          onClick={toggleAi}
          className={`shrink-0 text-[10.5px] font-bold rounded-full px-2.5 py-1.5 transition active:scale-95 ${
            lead.ai_enabled ? 'bg-white text-brand-deep' : 'bg-white/20 text-white'
          }`}
        >
          {lead.ai_enabled ? '🤖 AI on' : 'AI off — you have the chat'}
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto no-scrollbar chat-texture px-3 py-3 space-y-2">
        {lead.messages.length === 0 && (
          <p className="text-center text-[12px] text-ink-soft bg-white/80 rounded-lg px-3 py-2 shadow-sm mx-8">
            No messages yet.
          </p>
        )}
        {lead.messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === 'buyer' ? 'justify-start' : 'justify-end'}`}>
            <div
              className={`max-w-[85%] rounded-xl px-3 py-2 shadow-sm text-[13.5px] leading-snug whitespace-pre-line ${
                m.role === 'buyer' ? 'bg-white rounded-tl-sm' : 'bg-buyer rounded-tr-sm'
              }`}
            >
              {m.role !== 'buyer' && (
                <span className={`block text-[10px] font-bold ${m.role === 'ai' ? 'text-brand-deep' : 'text-gold'}`}>
                  {ROLE_LABEL[m.role]}
                </span>
              )}
              {m.text}
              <span className="block text-right text-[10px] text-ink-faint mt-1">{fmtTime(m.created_at)}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="shrink-0 bg-cream border-t border-line px-3 pt-2.5 pb-3">
        {sendError && (
          <p className="text-[11.5px] text-hot bg-amber-wash rounded-lg px-3 py-2 mb-2">{sendError}</p>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            rows={1}
            placeholder={`Reply to ${lead.name || 'buyer'} on WhatsApp…`}
            className="flex-1 resize-none bg-white border border-line rounded-2xl px-4 py-3 text-[13.5px] outline-none focus:border-brand/50"
          />
          <button
            onClick={send}
            disabled={sending || !draft.trim()}
            className="shrink-0 w-11 h-11 rounded-full bg-brand disabled:opacity-40 text-white flex items-center justify-center shadow-card active:scale-95 transition"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 translate-x-[1px]">
              <path d="M3.4 20.4 21.8 12 3.4 3.6 3.4 10l13 2-13 2z" />
            </svg>
          </button>
        </div>
        <p className="text-[10.5px] text-ink-faint mt-1.5 px-1">
          Sends a real WhatsApp message from your business number.
        </p>
      </div>
    </div>
  )
}

export default function InboxTab({ leadId, onSelectLead }) {
  const { data: leads, error } = usePoll(api.leads, 4000)

  if (leadId) return <Conversation leadId={leadId} onBack={() => onSelectLead(null)} />

  return (
    <div className="px-5 pt-7">
      <header className="rise">
        <h1 className="font-display text-[28px] font-semibold text-ink">Inbox</h1>
        <p className="text-[13px] text-ink-soft mt-0.5">
          Real WhatsApp conversations · AI answers, you take over anytime
        </p>
      </header>

      {error && (
        <p className="mt-6 text-[12.5px] text-hot bg-amber-wash rounded-xl px-4 py-3">
          Can't reach the HomeNex server: {error.message}
        </p>
      )}

      {leads && leads.length === 0 && (
        <div className="mt-6 bg-card rounded-2xl border border-line shadow-card p-5 rise rise-1">
          <p className="font-bold text-[14.5px] text-ink">No conversations yet</p>
          <p className="text-[12.5px] text-ink-soft leading-relaxed mt-1.5">
            When a buyer messages your WhatsApp Business number, the conversation lands here and
            HomeNex AI replies within seconds. Wire the Meta webhook to{' '}
            <code className="bg-cream px-1 rounded">/webhook</code> to go live.
          </p>
        </div>
      )}

      <div className="space-y-2.5 mt-4">
        {(leads || []).map((l, i) => (
          <button
            key={l.id}
            onClick={() => onSelectLead(l.id)}
            className={`w-full text-left bg-card rounded-2xl border border-line shadow-card px-4 py-3.5 active:scale-[0.99] transition rise rise-${Math.min(i + 1, 5)}`}
          >
            <div className="flex items-center gap-3">
              <span className="shrink-0 w-11 h-11 rounded-full bg-brand-wash text-brand-deep font-display font-bold text-[15px] flex items-center justify-center">
                {(l.name || l.wa_id).split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-bold text-[14.5px] text-ink truncate">{l.name || l.wa_id}</p>
                  <span className="shrink-0 text-[11px] text-ink-faint">{fmtAgo(l.last_at)}</span>
                </div>
                <p className="text-[12.5px] text-ink-soft truncate mt-0.5">
                  {l.last_role === 'buyer' ? '' : l.last_role === 'ai' ? '🤖 ' : 'You: '}
                  {l.last_msg || '—'}
                </p>
              </div>
              {!l.ai_enabled && (
                <span className="shrink-0 text-[9.5px] font-bold bg-amber-wash text-gold rounded-full px-2 py-0.5">
                  MANUAL
                </span>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
