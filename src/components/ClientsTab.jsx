import { useState } from 'react'
import { api, usePoll, fmtAgo } from '../api.js'

const input =
  'w-full bg-white border border-line rounded-xl px-3 py-2.5 text-[13px] outline-none focus:border-brand/50'

function AddClient({ onAdded }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ name: '', cc: '+91', phone: '', notes: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const setCc = (v) => setForm((s) => ({ ...s, cc: '+' + v.replace(/\D/g, '').slice(0, 4) }))
  const setPhone = (v) => setForm((s) => ({ ...s, phone: v.replace(/\D/g, '').slice(0, 12) }))

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      await api.addContact({
        phone: (form.cc || '+91') + form.phone,
        name: form.name.trim(),
        notes: form.notes.trim() || null,
      })
      setForm({ name: '', cc: '+91', phone: '', notes: '' })
      setOpen(false)
      onAdded()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  if (!open)
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full bg-brand text-white font-bold text-[13.5px] rounded-2xl py-3.5 shadow-card active:scale-[0.98] transition"
      >
        + Add a client
      </button>
    )

  return (
    <div className="bg-card rounded-2xl border border-line shadow-card p-4 space-y-2.5">
      <input className={input} placeholder="Client name*" value={form.name} onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))} />
      <div className="flex items-stretch bg-white border border-line rounded-xl overflow-hidden focus-within:border-brand/50">
        <input
          className="w-[4.5rem] px-3 py-2.5 text-[13px] font-semibold text-ink-soft outline-none bg-cream border-r border-line tracking-wide"
          value={form.cc}
          onChange={(e) => setCc(e.target.value)}
          aria-label="Country code"
          placeholder="+91"
          inputMode="tel"
        />
        <input
          className="flex-1 px-3 py-2.5 text-[13px] outline-none bg-white tracking-wide"
          value={form.phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="WhatsApp number"
          inputMode="numeric"
        />
      </div>
      <input className={input} placeholder="Notes (optional)" value={form.notes} onChange={(e) => setForm((s) => ({ ...s, notes: e.target.value }))} />
      {err && <p className="text-[11.5px] text-hot">{err}</p>}
      <div className="flex gap-2">
        <button onClick={() => { setOpen(false); setErr(null) }} className="flex-1 text-[13px] font-bold text-ink-soft bg-cream border border-line rounded-xl py-3">
          Cancel
        </button>
        <button onClick={submit} disabled={busy || !form.name.trim() || !form.phone} className="flex-1 text-[13px] font-bold text-white bg-brand rounded-xl py-3 disabled:opacity-40">
          {busy ? 'Saving…' : 'Add client'}
        </button>
      </div>
    </div>
  )
}

// Parse pasted lines like "Priya Sharma, +91 98765 43210" or "9876543210".
// The token with the most digits is the phone; the rest is the name.
function parseBulk(textblock) {
  return textblock
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/[,\t]/).map((p) => p.trim()).filter(Boolean)
      let phonePart = parts[0]
      let nameParts = parts.slice(1)
      if (parts.length > 1) {
        const digitsOf = (s) => (s.match(/\d/g) || []).length
        const phoneIdx = parts.reduce((best, p, i) => (digitsOf(p) > digitsOf(parts[best]) ? i : best), 0)
        phonePart = parts[phoneIdx]
        nameParts = parts.filter((_, i) => i !== phoneIdx)
      }
      const phone = phonePart.replace(/[^\d+]/g, '')
      const name = nameParts.join(' ').trim() || phone
      return { phone, name }
    })
    .filter((r) => r.phone.replace(/\D/g, '').length >= 8)
}

function BulkImport({ onDone }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const parsed = parseBulk(text)

  const submit = async () => {
    if (busy || parsed.length === 0) return
    setBusy(true)
    try {
      const res = await api.bulkContacts(parsed)
      setResult(res)
      setText('')
      onDone()
    } finally {
      setBusy(false)
    }
  }

  if (!open)
    return (
      <button onClick={() => setOpen(true)} className="w-full text-[12.5px] font-bold text-brand-deep bg-brand-wash border border-brand/20 rounded-2xl py-3 active:scale-[0.98] transition">
        ⇪ Bulk import — paste numbers
      </button>
    )

  return (
    <div className="bg-card rounded-2xl border border-line shadow-card p-4 space-y-2.5">
      <p className="text-[11.5px] text-ink-soft leading-snug">
        One client per line. Use <code className="bg-cream px-1 rounded">Name, +91 98765 43210</code> or just the number.
      </p>
      <textarea
        className={input}
        rows={5}
        placeholder={'Priya Sharma, +91 98765 43210\nAmit Patel, 9812345678\n9922334455'}
        value={text}
        onChange={(e) => { setText(e.target.value); setResult(null) }}
      />
      {parsed.length > 0 && <p className="text-[11.5px] text-ink-faint">{parsed.length} number{parsed.length === 1 ? '' : 's'} detected</p>}
      {result && (
        <p className="text-[11.5px] text-ink-soft">
          Added <strong className="text-brand-deep">{result.added.length}</strong>
          {result.skipped.length > 0 && <>, skipped {result.skipped.length} ({result.skipped.map((s) => s.phone).join(', ')})</>}
        </p>
      )}
      <div className="flex gap-2">
        <button onClick={() => { setOpen(false); setText(''); setResult(null) }} className="flex-1 text-[13px] font-bold text-ink-soft bg-cream border border-line rounded-xl py-3">
          Done
        </button>
        <button onClick={submit} disabled={busy || parsed.length === 0} className="flex-1 text-[13px] font-bold text-white bg-brand rounded-xl py-3 disabled:opacity-40">
          {busy ? 'Importing…' : `Import ${parsed.length || ''}`.trim()}
        </button>
      </div>
    </div>
  )
}

export default function ClientsTab() {
  const [refreshKey, setRefreshKey] = useState(0)
  const { data: contacts, error } = usePoll(api.contacts, 6000, [refreshKey])
  const refresh = () => setRefreshKey((k) => k + 1)
  const list = contacts || []
  const active = list.filter((c) => c.msg_count > 0).length

  const remove = async (c) => {
    if (!confirm(`Remove ${c.name} from your clients?`)) return
    await api.deleteContact(c.id)
    refresh()
  }

  return (
    <div className="px-5 pt-7">
      <header className="rise">
        <h1 className="font-display text-[28px] font-semibold text-ink">Clients</h1>
        <p className="text-[13px] text-ink-soft mt-0.5">
          {contacts
            ? `${list.length} saved · ${active} have messaged`
            : 'Loading…'}
        </p>
      </header>

      {error && (
        <p className="mt-6 text-[12.5px] text-hot bg-amber-wash rounded-xl px-4 py-3">
          Can't reach the HomeNex server: {error.message}
        </p>
      )}

      <div className="mt-5 space-y-2.5 rise rise-1">
        <AddClient onAdded={refresh} />
        <BulkImport onDone={refresh} />
      </div>

      {contacts && list.length === 0 && (
        <div className="mt-6 bg-card rounded-2xl border border-line shadow-card p-5 rise rise-2">
          <p className="font-bold text-[14.5px] text-ink">No clients yet</p>
          <p className="text-[12.5px] text-ink-soft leading-relaxed mt-1.5">
            Add your clients' WhatsApp numbers above. When they message the HomeNex number,
            HomeNex recognises them and routes the chat straight to you — qualified by AI.
          </p>
        </div>
      )}

      <div className="space-y-2.5 mt-5 pb-4">
        {list.map((c, i) => (
          <div key={c.id} className={`bg-card rounded-2xl border border-line shadow-card px-4 py-3.5 rise rise-${Math.min(i + 1, 5)}`}>
            <div className="flex items-center gap-3">
              <span className="shrink-0 w-11 h-11 rounded-full bg-brand-wash text-brand-deep font-display font-bold text-[15px] flex items-center justify-center">
                {c.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
              </span>
              <div className="flex-1 min-w-0">
                <p className="font-bold text-[14.5px] text-ink truncate">{c.name}</p>
                <p className="text-[12px] text-ink-soft truncate mt-0.5">{c.phone}</p>
                <div className="flex items-center gap-2 mt-1.5">
                  {c.msg_count > 0 ? (
                    <span className="text-[10.5px] font-bold border rounded-full px-2 py-0.5 bg-brand-wash text-brand-deep border-brand/30">
                      ● Active · {fmtAgo(c.last_at)}
                    </span>
                  ) : (
                    <span className="text-[10.5px] font-bold border rounded-full px-2 py-0.5 bg-cream text-ink-faint border-line">
                      ○ Never messaged
                    </span>
                  )}
                  {c.notes && <span className="text-[11px] text-ink-faint truncate">{c.notes}</span>}
                </div>
              </div>
              <button
                onClick={() => remove(c)}
                aria-label={`Remove ${c.name}`}
                className="shrink-0 w-8 h-8 rounded-full bg-cream border border-line text-ink-faint flex items-center justify-center active:scale-90 transition"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                  <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
