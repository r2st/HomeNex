import { useEffect, useRef, useState } from 'react'
import { api, usePoll, fmtTime, fmtAgo } from '../api.js'
import { Sheet, Field, inputCls, InfoTip } from './ui.jsx'
import { glossary } from '../lib/glossary.js'
import { replyModeBadge, REPLY_MODE_HELP } from '../lib/replyMode.js'
import { windowState, fmtCountdown } from '../lib/waWindow.js'
import { varsOf, fillKnown } from '../lib/templateVars.js'

// Colour classes for the reply-mode badge tones (keeps green/white theme).
const REPLY_TONE = {
  brand: 'bg-brand-wash text-brand-deep',
  amber: 'bg-amber-wash text-gold',
}

const ROLE_LABEL = { ai: 'HomeNex AI', agent: 'You' }

const LabelChip = ({ label, onRemove }) => (
  <span
    className="shrink-0 inline-flex items-center gap-1 text-[10.5px] font-bold rounded-full px-2 py-0.5 text-white"
    style={{ backgroundColor: label.color || '#64748b' }}
  >
    {label.name}
    {onRemove && (
      <button onClick={onRemove} className="opacity-80 hover:opacity-100 leading-none">
        ✕
      </button>
    )}
  </span>
)

// Sheet to toggle the workspace labels on/off for this thread.
function LabelSheet({ lead, onClose, onChanged }) {
  const [labels, setLabels] = useState(null)
  const active = new Set((lead.labels || []).map((l) => l.id))
  useEffect(() => {
    api.labels().then(setLabels).catch(() => setLabels([]))
  }, [])
  const toggle = async (l) => {
    await api.setLeadLabel(lead.id, l.id, !active.has(l.id))
    onChanged()
  }
  return (
    <Sheet onClose={onClose} title="Labels">
      <div className="flex flex-wrap gap-2">
        {(labels || []).map((l) => {
          const on = active.has(l.id)
          return (
            <button
              key={l.id}
              onClick={() => toggle(l)}
              className={`text-[12px] font-bold rounded-full px-3 py-1.5 border transition active:scale-95 ${
                on ? 'text-white border-transparent' : 'text-ink-soft border-line bg-card'
              }`}
              style={on ? { backgroundColor: l.color } : undefined}
            >
              {on ? '✓ ' : ''}
              {l.name}
            </button>
          )
        })}
      </div>
    </Sheet>
  )
}

// Internal notes: private to the team, never sent to WhatsApp.
function NotesSheet({ lead, onClose, onChanged }) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const notes = lead.notes || []
  const add = async () => {
    const body = draft.trim()
    if (!body || busy) return
    setBusy(true)
    try {
      await api.addLeadNote(lead.id, body)
      setDraft('')
      onChanged()
    } finally {
      setBusy(false)
    }
  }
  const remove = async (n) => {
    await api.deleteLeadNote(lead.id, n.id)
    onChanged()
  }
  return (
    <Sheet onClose={onClose} title="Internal notes">
      <p className="text-[11.5px] text-ink-faint mb-3">Only your team sees these — never sent to the client.</p>
      <div className="space-y-2 mb-3 max-h-52 overflow-y-auto no-scrollbar">
        {notes.length === 0 && <p className="text-[12px] text-ink-soft">No notes yet.</p>}
        {notes.map((n) => (
          <div key={n.id} className="bg-white border border-line rounded-xl px-3 py-2">
            <p className="text-[12.5px] text-ink whitespace-pre-line">{n.body}</p>
            <div className="flex items-center justify-between mt-1">
              <span className="text-[10px] text-ink-faint">
                {n.agent_name} · {fmtTime(n.created_at)}
              </span>
              <button onClick={() => remove(n)} className="text-[10px] text-hot font-bold">
                delete
              </button>
            </div>
          </div>
        ))}
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={2}
        placeholder="Add a private note…"
        className={inputCls + ' resize-none'}
      />
      <button
        onClick={add}
        disabled={busy || !draft.trim()}
        className="mt-2 w-full bg-brand text-white font-bold text-[13px] rounded-xl py-2.5 disabled:opacity-40 active:scale-[0.99] transition"
      >
        Add note
      </button>
    </Sheet>
  )
}

// Quick-reply picker — tap a snippet to drop it (with {{name}} filled) into the draft.
function QuickReplySheet({ lead, onClose, onPick }) {
  const [replies, setReplies] = useState(null)
  useEffect(() => {
    api.quickReplies().then(setReplies).catch(() => setReplies([]))
  }, [])
  return (
    <Sheet onClose={onClose} title="Quick replies">
      {replies?.length === 0 && (
        <p className="text-[12px] text-ink-soft">No quick replies yet. Add some in More → Snippets &amp; media.</p>
      )}
      <div className="space-y-1.5">
        {(replies || []).map((r) => (
          <button
            key={r.id}
            onClick={() => onPick(fillKnown(r.body, lead))}
            className="w-full text-left bg-white border border-line rounded-xl px-3.5 py-2.5 active:scale-[0.99] transition"
          >
            <p className="text-[12px] font-bold text-ink">{r.title}</p>
            <p className="text-[11.5px] text-ink-soft line-clamp-2">{fillKnown(r.body, lead)}</p>
          </button>
        ))}
      </div>
    </Sheet>
  )
}

// Media library picker — two taps to attach a saved asset. Marks what's already sent.
function MediaSheet({ lead, onClose, onSent, onError }) {
  const [assets, setAssets] = useState(null)
  const [sendingId, setSendingId] = useState(null)
  const sent = new Set(lead.media_sent_ids || [])
  useEffect(() => {
    api.media().then(setAssets).catch(() => setAssets([]))
  }, [])
  const send = async (a) => {
    setSendingId(a.id)
    try {
      await api.sendMedia(a.id, lead.id)
      onSent()
    } catch (e) {
      onError(e.message)
    } finally {
      setSendingId(null)
    }
  }
  const ICON = { brochure: '📄', floor_plan: '📐', photo: '🖼️', video: '🎬', document: '📎' }
  return (
    <Sheet onClose={onClose} title="Attach from media library">
      {assets?.length === 0 && (
        <p className="text-[12px] text-ink-soft">Library is empty. Add files in More → Snippets &amp; media.</p>
      )}
      <div className="space-y-1.5">
        {(assets || []).map((a) => (
          <button
            key={a.id}
            onClick={() => send(a)}
            disabled={sendingId != null}
            className="w-full text-left bg-white border border-line rounded-xl px-3.5 py-2.5 flex items-center gap-3 active:scale-[0.99] transition disabled:opacity-50"
          >
            <span className="text-[20px]">{ICON[a.kind] || '📎'}</span>
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] font-bold text-ink truncate">{a.title}</p>
              <p className="text-[11px] text-ink-faint truncate">{a.kind.replace('_', ' ')}</p>
            </div>
            {sendingId === a.id ? (
              <span className="text-[10.5px] text-brand font-bold">Sending…</span>
            ) : sent.has(a.id) ? (
              <span className="text-[10px] text-emerald-600 font-bold">✓ sent</span>
            ) : (
              <span className="text-[10.5px] text-brand font-bold">Send</span>
            )}
          </button>
        ))}
      </div>
    </Sheet>
  )
}

// Template picker shown when the service window has closed (Meta policy:
// only approved templates may start a business-initiated conversation). Agents
// fill the variables; the approved body is never edited here.
function TemplateComposer({ lead, onSent, onError }) {
  const [templates, setTemplates] = useState(null)
  const [openId, setOpenId] = useState(null)
  const [vars, setVars] = useState({})
  const [sendingId, setSendingId] = useState(null)

  useEffect(() => {
    api.templates().then(setTemplates).catch(() => setTemplates([]))
  }, [])

  const open = (t) => {
    setOpenId(openId === t.id ? null : t.id)
    setVars({ name: lead.name || '' })
  }

  const sendTemplate = async (t) => {
    setSendingId(t.id)
    try {
      await api.replyTemplate(lead.id, t.id, vars)
      onSent()
      setOpenId(null)
    } catch (e) {
      onError(e.message)
    } finally {
      setSendingId(null)
    }
  }

  return (
    <div>
      <p className="text-[11.5px] font-bold text-hot bg-amber-wash rounded-lg px-3 py-2 mb-2">
        ⏱️ You can send free replies for 24 hours after the buyer's last message. That time's up —
        pick one of your approved messages below until {lead.name || 'the client'} replies again.
      </p>
      {templates === null && <p className="text-[11.5px] text-ink-faint px-1">Loading templates…</p>}
      {templates?.length === 0 && (
        <p className="text-[11.5px] text-ink-soft px-1">
          No templates yet. Add one in More → Snippets &amp; media.
        </p>
      )}
      <div className="space-y-1.5 max-h-56 overflow-y-auto no-scrollbar">
        {(templates || []).map((t) => {
          const names = varsOf(t.body)
          const isOpen = openId === t.id
          return (
            <div key={t.id} className="bg-white border border-line rounded-xl px-3.5 py-2.5">
              <button onClick={() => open(t)} className="w-full text-left">
                <div className="flex items-center gap-2">
                  <p className="text-[12px] font-bold text-ink flex-1">{t.name}</p>
                  {t.category === 'marketing' && (
                    <span className="inline-flex items-center gap-1">
                      <span className="text-[9px] font-bold bg-brand-wash text-brand-deep rounded-full px-1.5 py-0.5">
                        RERA auto
                      </span>
                      <InfoTip label="" text={glossary.RERA} />
                    </span>
                  )}
                  {(t.is_locked || t.meta_status === 'approved') && <span className="text-[10px]">🔒</span>}
                </div>
                <p className="text-[11.5px] text-ink-soft">{t.body}</p>
              </button>
              {isOpen && (
                <div className="mt-2 space-y-2">
                  {names.map((n) => (
                    <Field key={n} label={n.replace('_', ' ')}>
                      <input
                        value={vars[n] || ''}
                        onChange={(e) => setVars((v) => ({ ...v, [n]: e.target.value }))}
                        className={inputCls}
                        placeholder={n === 'name' ? lead.name || '' : ''}
                      />
                    </Field>
                  ))}
                  <button
                    onClick={() => sendTemplate(t)}
                    disabled={sendingId != null}
                    className="w-full bg-brand text-white font-bold text-[13px] rounded-xl py-2.5 disabled:opacity-40 active:scale-[0.99] transition"
                  >
                    {sendingId === t.id ? 'Sending…' : 'Send template'}
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Conversation({ leadId, onBack }) {
  const [sendError, setSendError] = useState(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [suggestions, setSuggestions] = useState([])
  const [now, setNow] = useState(Date.now())
  const [sheet, setSheet] = useState(null) // 'labels' | 'notes' | 'quick' | 'media'
  const suggestedForRef = useRef(null)
  const readForRef = useRef(null)
  const scrollRef = useRef(null)
  const { data: lead, error } = usePoll(() => api.lead(leadId), 3000, [leadId])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [lead?.messages?.length])

  // Tick every 30s so the 24h-window countdown stays fresh.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  // Mark the thread read once per lead (clears the unread badge in the list).
  useEffect(() => {
    if (!lead || readForRef.current === lead.id) return
    readForRef.current = lead.id
    api.markLeadRead(lead.id).catch(() => {})
  }, [lead?.id])

  // Fetch AI reply suggestions when the buyer is waiting on an answer.
  const lastMsg = lead?.messages?.[lead.messages.length - 1]
  useEffect(() => {
    if (!lead || !lastMsg) return
    if (lastMsg.role !== 'buyer') {
      suggestedForRef.current = null
      setSuggestions([])
      return
    }
    if (suggestedForRef.current === lastMsg.id) return
    suggestedForRef.current = lastMsg.id
    api
      .suggestions(lead.id)
      .then((r) => {
        if (suggestedForRef.current === lastMsg.id) setSuggestions(r.suggestions || [])
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead?.id, lastMsg?.id, lastMsg?.role])

  if (error) return <p className="text-center text-[13px] text-hot pt-16">Couldn't load this chat.</p>
  if (!lead) return <p className="text-center text-[13px] text-ink-faint pt-16">Loading…</p>

  const win = windowState(lead, now)
  const labels = lead.labels || []

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
          <p className="text-white font-bold text-[14.5px] leading-tight truncate">{lead.name || lead.wa_id}</p>
          <p className="text-white/75 text-[11px] truncate">
            +{lead.wa_id} · {lead.temp}
          </p>
          {win.known && (
            <p className={`text-[10px] font-bold inline-flex items-center gap-1 ${win.open ? 'text-emerald-300' : 'text-amber-300'}`}>
              {win.open ? `🟢 Free replies · ${fmtCountdown(win.msLeft)} left` : '🔒 Free-reply time is up'}
              <InfoTip label="" text={glossary.SERVICE_WINDOW} align="left" />
            </p>
          )}
        </div>
        <button
          onClick={() => setSheet('notes')}
          className="shrink-0 text-white/90 text-[11px] font-bold bg-white/15 rounded-full px-2.5 py-1.5 active:scale-95 transition"
        >
          📝{lead.notes?.length ? ` ${lead.notes.length}` : ''}
        </button>
        <button
          onClick={toggleAi}
          className={`shrink-0 text-[10.5px] font-bold rounded-full px-2.5 py-1.5 transition active:scale-95 ${
            lead.ai_enabled ? 'bg-white text-brand-deep' : 'bg-white/20 text-white'
          }`}
        >
          {lead.ai_enabled ? '🤖 Auto-reply' : '✋ You reply'}
        </button>
      </div>

      {/* Labels bar */}
      <div className="shrink-0 bg-cream border-b border-line px-3 py-1.5 flex items-center gap-1.5 overflow-x-auto no-scrollbar">
        {labels.map((l) => (
          <LabelChip key={l.id} label={l} onRemove={() => api.setLeadLabel(lead.id, l.id, false)} />
        ))}
        <button
          onClick={() => setSheet('labels')}
          className="shrink-0 text-[10.5px] font-bold text-ink-soft border border-line rounded-full px-2 py-0.5 active:scale-95 transition"
        >
          + Label
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
        {sendError && <p className="text-[11.5px] text-hot bg-amber-wash rounded-lg px-3 py-2 mb-2">{sendError}</p>}
        {!win.open ? (
          <TemplateComposer lead={lead} onSent={() => setSendError(null)} onError={setSendError} />
        ) : (
          <>
            {suggestions.length > 0 && (
              <div className="flex gap-2 overflow-x-auto no-scrollbar pb-2">
                {suggestions.map((s, i) => (
                  <button
                    key={i}
                    onClick={() => setDraft(s)}
                    className="shrink-0 max-w-[240px] text-left text-[11.5px] leading-snug bg-brand-wash text-brand-deep border border-brand/25 rounded-xl px-3 py-2 active:scale-95 transition"
                  >
                    ✨ <span className="line-clamp-2">{s}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2 pb-2">
              <button
                onClick={() => setSheet('quick')}
                className="shrink-0 text-[11px] font-bold text-brand-deep bg-brand-wash border border-brand/25 rounded-full px-3 py-1.5 active:scale-95 transition"
              >
                ⚡ Quick reply
              </button>
              <button
                onClick={() => setSheet('media')}
                className="shrink-0 text-[11px] font-bold text-brand-deep bg-brand-wash border border-brand/25 rounded-full px-3 py-1.5 active:scale-95 transition"
              >
                📎 Media
              </button>
            </div>
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
          </>
        )}
      </div>

      {sheet === 'labels' && <LabelSheet lead={lead} onClose={() => setSheet(null)} onChanged={() => {}} />}
      {sheet === 'notes' && <NotesSheet lead={lead} onClose={() => setSheet(null)} onChanged={() => {}} />}
      {sheet === 'quick' && (
        <QuickReplySheet
          lead={lead}
          onClose={() => setSheet(null)}
          onPick={(text) => {
            setDraft((d) => (d ? `${d} ${text}` : text))
            setSheet(null)
          }}
        />
      )}
      {sheet === 'media' && (
        <MediaSheet
          lead={lead}
          onClose={() => setSheet(null)}
          onSent={() => setSheet(null)}
          onError={(m) => {
            setSendError(m)
            setSheet(null)
          }}
        />
      )}
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
        <p className="text-[11.5px] text-ink-faint mt-2 leading-snug">{REPLY_MODE_HELP}</p>
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
            When one of your clients messages HomeNex, the conversation lands here and HomeNex AI
            replies within seconds. Add your clients to start receiving their messages.
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
              <span className="relative shrink-0 w-11 h-11 rounded-full bg-brand-wash text-brand-deep font-display font-bold text-[15px] flex items-center justify-center">
                {(l.name || l.wa_id).split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
                {l.unread_count > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-hot text-white text-[10px] font-bold flex items-center justify-center">
                    {l.unread_count}
                  </span>
                )}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <p className={`text-[14.5px] truncate ${l.unread_count > 0 ? 'font-extrabold text-ink' : 'font-bold text-ink'}`}>
                    {l.name || l.wa_id}
                  </p>
                  <span className="shrink-0 text-[11px] text-ink-faint">{fmtAgo(l.last_at)}</span>
                </div>
                <p className={`text-[12.5px] truncate mt-0.5 ${l.unread_count > 0 ? 'text-ink font-semibold' : 'text-ink-soft'}`}>
                  {l.last_role === 'buyer' ? '' : l.last_role === 'ai' ? '🤖 ' : 'You: '}
                  {l.last_msg || '—'}
                </p>
                {l.labels?.length > 0 && (
                  <div className="flex items-center gap-1 mt-1.5 overflow-hidden">
                    {l.labels.slice(0, 3).map((lb) => (
                      <LabelChip key={lb.id} label={lb} />
                    ))}
                  </div>
                )}
              </div>
              {(() => {
                const badge = replyModeBadge(l)
                return (
                  <span
                    className={`shrink-0 text-[9.5px] font-bold rounded-full px-2 py-0.5 whitespace-nowrap ${REPLY_TONE[badge.tone]}`}
                  >
                    {badge.icon} {badge.label}
                  </span>
                )
              })()}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
