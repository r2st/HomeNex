import { useState } from 'react'
import { api, usePoll, fmtAgo } from '../api.js'
import { Avatar, SlideOver, Sheet, inputCls, useConfirm, LoadingRows, InfoTip, DetailOverlay, ErrorBanner } from './ui.jsx'
import { glossary } from '../lib/glossary.js'
import { friendlyMessage } from '../lib/friendlyError.js'
import { pipelineLabel, tempBadge } from '../lib/labels.js'

const SOURCE_LABEL = {
  whatsapp_inbound: '💬 WhatsApp',
  portal: '🌐 Portal',
  facebook: '📣 Facebook',
  walk_in: '🚶 Walk-in',
  referral: '🤝 Referral',
}

function ContactDetail({ contactId, onClose, onOpenLead }) {
  const { data: contact, error, refresh } = usePoll(() => api.contact(contactId), 10000, [contactId])
  const [notes, setNotes] = useState(null) // null = not editing

  if (!contact) return <DetailOverlay error={error} onClose={onClose} onRetry={refresh} />

  const saveNotes = async () => {
    await api.updateContact(contact.id, { notes: notes.trim() || null })
    setNotes(null)
    refresh()
  }

  return (
    <SlideOver onClose={onClose}>
      <div className="sticky top-0 bg-cream/95 backdrop-blur border-b border-line px-5 py-4 flex items-center gap-3 z-10">
        <button aria-label="Back to contacts" onClick={onClose} className="w-9 h-9 rounded-full bg-card border border-line flex items-center justify-center text-ink shadow-card active:scale-95 transition">
          <span aria-hidden="true">←</span>
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
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              aria-label="Notes about this contact"
              className={inputCls}
              autoFocus
            />
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
                  {l.stage || 'New'} <span className="text-ink-faint font-medium">· {pipelineLabel(l.pipeline_type)}</span>
                </p>
                <p className="text-[11.5px] text-ink-soft mt-0.5">
                  {tempBadge(l.temp).icon} {tempBadge(l.temp).word} · {fmtAgo(l.updated_at)}
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
// Contact groups / segments with one-click auto-grouping and a limiter-gated blast.
// Themed compose-and-send sheet for a group blast — replaces the raw window.prompt().
// Shows the recipient count up front and a Confirm step before it actually sends.
function BlastSheet({ group, onClose, onSent }) {
  const [message, setMessage] = useState('')
  const [error, setError] = useState(null)
  const confirm = useConfirm()

  const doSend = async () => {
    const r = await api.sendToGroup(group.id, message.trim())
    onSent(r)
  }

  const ask = () => {
    if (!message.trim()) return
    setError(null)
    confirm({
      title: `Send to ${group.member_count} contact${group.member_count === 1 ? '' : 's'}?`,
      message: `Everyone in "${group.name}" who has agreed to your messages will get this.`,
      confirmLabel: 'Send now',
      danger: false,
      onConfirm: async () => {
        try {
          await doSend()
        } catch (e) {
          setError(friendlyMessage(e))
          throw e
        }
      },
    })
  }

  return (
    <Sheet onClose={onClose} title={`Message "${group.name}"`}>
      <p className="text-[12px] text-ink-soft leading-snug mb-3 flex items-center gap-1.5 flex-wrap">
        Goes to {group.member_count} contact{group.member_count === 1 ? '' : 's'} who have agreed to your messages.
        <InfoTip label="" text={glossary.OPT_IN} align="left" />
      </p>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={4}
        autoFocus
        aria-label={`Message to send to the "${group.name}" group`}
        placeholder="Type your message…"
        className={`${inputCls} resize-none`}
      />
      {error && <p className="text-[12px] text-hot bg-amber-wash rounded-xl px-3 py-2 mt-2">{error}</p>}
      <button
        onClick={ask}
        disabled={!message.trim()}
        className="mt-3 w-full bg-brand text-white font-bold text-[13.5px] rounded-full py-3 active:scale-[0.99] transition disabled:opacity-40"
      >
        Review &amp; send →
      </button>
      {confirm.dialog}
    </Sheet>
  )
}

function GroupsPanel() {
  const [open, setOpen] = useState(false)
  const [groups, setGroups] = useState(null)
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState(null)
  const [blastGroup, setBlastGroup] = useState(null)
  const confirm = useConfirm()
  const load = () => api.groups().then(setGroups).catch(() => setGroups([]))

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && groups === null) load()
  }

  const auto = async (by) => {
    setBusy(true)
    try {
      await api.autoGroup(by)
      await load()
      setFlash(`Grouped by ${by}`)
    } catch (e) {
      setFlash(friendlyMessage(e))
    } finally {
      setBusy(false)
      setTimeout(() => setFlash(null), 2500)
    }
  }

  const onSent = (r) => {
    setBlastGroup(null)
    const skipped = r.skipped
      ? ` ${r.skipped} skipped — they haven't agreed to messages yet.`
      : ''
    setFlash(`Sent to ${r.sent}.${skipped}`)
    setTimeout(() => setFlash(null), 4000)
  }

  const remove = (g) =>
    confirm({
      title: `Delete group "${g.name}"?`,
      message: 'The group is removed. The contacts in it are not deleted.',
      onConfirm: async () => {
        await api.deleteGroup(g.id).catch(() => {})
        load()
      },
    })

  return (
    <section className="mt-4 bg-card rounded-2xl border border-line shadow-card overflow-hidden">
      {/* aria-expanded is the whole state of this control: the caret is the only thing
          that says whether the panel below is open, and a caret is not announced. */}
      <button
        onClick={toggle}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-4 py-3 active:scale-[0.99] transition"
      >
        <span className="text-[10.5px] font-bold tracking-[0.18em] text-brand">GROUPS &amp; SEGMENTS</span>
        <span aria-hidden="true" className="text-ink-faint text-[13px]">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4">
          <p className="text-[11.5px] text-ink-soft mb-2">Auto-group your contacts in one tap:</p>
          <div className="flex gap-2 flex-wrap">
            {[['locality', '📍 Locality'], ['intent', '🎯 Intent'], ['temp', '🌡 Interest level']].map(([by, label]) => (
              <button
                key={by}
                disabled={busy}
                onClick={() => auto(by)}
                className="text-[12px] font-bold text-brand-deep bg-brand-wash rounded-full px-3 py-1.5 active:scale-95 transition disabled:opacity-50"
              >
                {label}
              </button>
            ))}
          </div>
          {flash && <p className="text-[11.5px] text-ink-soft mt-2">{flash}</p>}
          <div className="mt-3 space-y-1.5">
            {(groups || []).map((g) => (
              <div key={g.id} className="flex items-center gap-2.5 py-1.5">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: g.color }} />
                <span className="text-[13px] font-bold text-ink truncate flex-1">{g.name}</span>
                <span className="text-[11px] text-ink-faint tabular-nums">{g.member_count}</span>
                {/* Both controls repeat once per group, so the group has to be in the
                    name — especially the second one, which is a delete announced as
                    nothing more than "button". */}
                <button
                  onClick={() => setBlastGroup(g)}
                  aria-label={`Send a message to ${g.name}`}
                  className="text-[11.5px] font-bold text-brand active:scale-95 transition"
                >
                  Send
                </button>
                <button
                  onClick={() => remove(g)}
                  aria-label={`Delete the group ${g.name}`}
                  className="text-ink-faint text-[14px] leading-none active:scale-90 transition"
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>
            ))}
            {groups && groups.length === 0 && (
              <p className="text-[12px] text-ink-faint">No groups yet — auto-group above to start.</p>
            )}
          </div>
        </div>
      )}
      {blastGroup && <BlastSheet group={blastGroup} onClose={() => setBlastGroup(null)} onSent={onSent} />}
      {confirm.dialog}
    </section>
  )
}

export default function ContactsTab({ onOpenLead }) {
  const [q, setQ] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const { data: contacts, error, loading } = usePoll(() => api.contacts({ q }), 6000, [q])
  // The list is one page now, so its length is no longer the total. Polled less often
  // than the list because a number that fell off the end of page one is not news.
  const { data: count } = usePoll(() => api.contactCount({ q }), 15000, [q])
  const total = count?.total ?? null
  const shown = contacts?.length ?? 0

  return (
    <div className="px-5 pt-7">
      <header className="rise">
        <h1 className="font-display text-[28px] font-semibold text-ink">Contacts</h1>
        <p className="text-[13px] text-ink-soft mt-0.5">
          {total === null
            ? 'Loading…'
            : `${total.toLocaleString('en-IN')} ${q ? 'matching' : 'auto-captured from WhatsApp'}`}
        </p>
      </header>

      <ErrorBanner error={error} className="mt-6" />

      <GroupsPanel />

      <input
        type="search"
        aria-label="Search contacts"
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

      {/* `loading`, not `!contacts`: a first request that FAILS leaves contacts null
          for ever, and skeleton rows next to the error banner read as "still coming". */}
      {loading && <LoadingRows rows={5} />}

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

      {/* Without this the list simply stops at 100 and looks like the whole of it.
          Search is the way through, not a pager: the numbers past the first page are
          the ones nobody has messaged in months, so scrolling to them finds nothing
          that typing a name would not have found faster. */}
      {total !== null && total > shown && (
        <p className="mt-4 text-center text-[12px] text-ink-faint">
          Showing the {shown.toLocaleString('en-IN')} most recent of {total.toLocaleString('en-IN')} — search to find the rest.
        </p>
      )}

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
