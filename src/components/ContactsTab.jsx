import { useState } from 'react'
import { api, usePoll, fmtAgo } from '../api.js'
import { Avatar, SlideOver, inputCls } from './ui.jsx'

const SOURCE_LABEL = {
  whatsapp_inbound: '💬 WhatsApp',
  portal: '🌐 Portal',
  facebook: '📣 Facebook',
  walk_in: '🚶 Walk-in',
  referral: '🤝 Referral',
}

function ContactDetail({ contactId, onClose, onOpenLead }) {
  const [refreshKey, setRefreshKey] = useState(0)
  const { data: contact } = usePoll(() => api.contact(contactId), 10000, [contactId, refreshKey])
  const [notes, setNotes] = useState(null) // null = not editing

  if (!contact)
    return (
      <div className="fixed inset-0 z-50">
        <div className="absolute inset-0 bg-ink/50" onClick={onClose} />
      </div>
    )

  const saveNotes = async () => {
    await api.updateContact(contact.id, { notes: notes.trim() || null })
    setNotes(null)
    setRefreshKey((k) => k + 1)
  }

  return (
    <SlideOver onClose={onClose}>
      <div className="sticky top-0 bg-cream/95 backdrop-blur border-b border-line px-5 py-4 flex items-center gap-3 z-10">
        <button onClick={onClose} className="w-9 h-9 rounded-full bg-card border border-line flex items-center justify-center text-ink shadow-card active:scale-95 transition">
          ←
        </button>
        <Avatar name={contact.name} />
        <div className="flex-1 min-w-0">
          <p className="font-display font-semibold text-[18px] text-ink leading-tight truncate">{contact.name}</p>
          <p className="text-[11.5px] text-ink-faint truncate">
            {contact.phone} · {SOURCE_LABEL[contact.source] || contact.source}
          </p>
        </div>
      </div>

      <div className="px-5 py-5 space-y-4 pb-10">
        <section className="bg-card rounded-2xl border border-line shadow-card p-4">
          <p className="text-[10.5px] font-bold tracking-[0.18em] text-brand mb-3">CONTACT</p>
          <dl className="space-y-2.5">
            {[
              ['Captured', `${SOURCE_LABEL[contact.source] || contact.source}${contact.source_detail ? ` · ${contact.source_detail}` : ''}`],
              ['First message', contact.first_message_at ? fmtAgo(contact.first_message_at) : 'never'],
              ['Last message', contact.last_message_at ? fmtAgo(contact.last_message_at) : 'never'],
              ['Added', fmtAgo(contact.created_at)],
            ].map(([k, v]) => (
              <div key={k} className="flex gap-3">
                <dt className="shrink-0 w-[100px] text-[12px] font-bold text-ink-soft">{k}</dt>
                <dd className="text-[12.5px] text-ink leading-snug">{v}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="bg-card rounded-2xl border border-line shadow-card p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10.5px] font-bold tracking-[0.18em] text-ink-soft">NOTES</p>
            {notes === null ? (
              <button onClick={() => setNotes(contact.notes || '')} className="text-[11.5px] font-bold text-brand underline underline-offset-2">
                Edit
              </button>
            ) : (
              <button onClick={saveNotes} className="text-[11.5px] font-bold text-brand underline underline-offset-2">
                Save
              </button>
            )}
          </div>
          {notes === null ? (
            <p className="text-[12.5px] text-ink leading-relaxed">
              {contact.notes || <span className="text-ink-faint">No notes yet.</span>}
            </p>
          ) : (
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={inputCls} autoFocus />
          )}
        </section>

        <section className="bg-card rounded-2xl border border-line shadow-card p-4">
          <p className="text-[10.5px] font-bold tracking-[0.18em] text-ink-soft mb-2">LEADS</p>
          {(contact.leads || []).length === 0 && <p className="text-[12px] text-ink-faint">No leads yet.</p>}
          <div className="space-y-2">
            {(contact.leads || []).map((l) => (
              <button
                key={l.id}
                onClick={() => onOpenLead(l.id)}
                className="w-full text-left bg-cream border border-line rounded-xl px-3.5 py-2.5 active:scale-[0.99] transition"
              >
                <p className="text-[13px] font-bold text-ink">
                  {l.stage || 'New'} <span className="text-ink-faint font-medium">· {l.pipeline_type || 'buy_primary'}</span>
                </p>
                <p className="text-[11.5px] text-ink-soft mt-0.5">
                  {l.temp} · score {l.score ?? 0} · {fmtAgo(l.updated_at)}
                </p>
              </button>
            ))}
          </div>
        </section>
      </div>
    </SlideOver>
  )
}

// Contacts are captured automatically from WhatsApp conversations — this tab is
// search + review, not data entry.
export default function ContactsTab({ onOpenLead }) {
  const [q, setQ] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const { data: contacts, error } = usePoll(() => api.contacts(q), 6000, [q])

  return (
    <div className="px-5 pt-7">
      <header className="rise">
        <h1 className="font-display text-[28px] font-semibold text-ink">Contacts</h1>
        <p className="text-[13px] text-ink-soft mt-0.5">
          {contacts ? `${contacts.length} auto-captured from WhatsApp` : 'Loading…'}
        </p>
      </header>

      {error && (
        <p className="mt-6 text-[12.5px] text-hot bg-amber-wash rounded-xl px-4 py-3">
          Can't reach the HomeNex server: {error.message}
        </p>
      )}

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search name or phone…"
        className={`${inputCls} mt-4`}
      />

      {contacts && contacts.length === 0 && !q && (
        <div className="mt-6 bg-card rounded-2xl border border-line shadow-card p-5 rise rise-1">
          <p className="font-bold text-[14.5px] text-ink">No contacts yet</p>
          <p className="text-[12.5px] text-ink-soft leading-relaxed mt-1.5">
            Contacts appear here automatically the moment someone messages your WhatsApp
            Business number — name, number, and source captured for you.
          </p>
        </div>
      )}

      <div className="space-y-2.5 mt-4">
        {(contacts || []).map((c, i) => (
          <button
            key={c.id}
            onClick={() => setSelectedId(c.id)}
            className={`w-full text-left bg-card rounded-2xl border border-line shadow-card px-4 py-3.5 active:scale-[0.99] transition rise rise-${Math.min(i + 1, 5)}`}
          >
            <div className="flex items-center gap-3">
              <Avatar name={c.name} />
              <div className="min-w-0 flex-1">
                <p className="font-bold text-[14px] text-ink truncate">{c.name}</p>
                <p className="text-[12px] text-ink-soft truncate mt-0.5">{c.phone}</p>
                <p className="text-[11px] text-ink-faint mt-0.5">
                  {SOURCE_LABEL[c.source] || c.source}
                  {c.last_message_at ? ` · last msg ${fmtAgo(c.last_message_at)}` : ''}
                </p>
              </div>
              {c.msg_count > 0 && (
                <span className="shrink-0 text-[11px] font-bold text-brand-deep bg-brand-wash rounded-full px-2.5 py-1 tabular-nums">
                  {c.msg_count} msg{c.msg_count === 1 ? '' : 's'}
                </span>
              )}
            </div>
          </button>
        ))}
      </div>

      {selectedId && (
        <ContactDetail
          contactId={selectedId}
          onClose={() => setSelectedId(null)}
          onOpenLead={(leadId) => {
            setSelectedId(null)
            onOpenLead(leadId)
          }}
        />
      )}
    </div>
  )
}
