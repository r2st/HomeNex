import { useEffect, useState } from 'react'
import { api, fmtTime } from '../api.js'
import { Sheet, Field, inputCls } from './ui.jsx'

// Customize-and-send sheet for one festival greeting.
function SendSheet({ festival, onClose, onDone }) {
  const [message, setMessage] = useState(festival.default_message)
  const [sendAt, setSendAt] = useState(() => {
    // Default to 9 AM on the festival's suggested date (if still in the future).
    const d = new Date(`${festival.suggested_date}T09:00:00`)
    return d.getTime() > Date.now() ? `${festival.suggested_date}T09:00` : ''
  })
  const [mode, setMode] = useState('schedule') // schedule | now
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await api.sendFestive({
        festival: festival.key,
        message,
        ...(mode === 'schedule' && sendAt ? { send_at: new Date(sendAt).toISOString() } : {}),
      })
      onDone(
        result.scheduled
          ? `${festival.name} greeting scheduled ✓`
          : `Sent to ${result.sent} of ${result.recipients} contacts ✓`,
      )
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet onClose={onClose} title={`${festival.emoji} ${festival.name} greeting`}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Message (each client's name fills in automatically)">
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={5} className={inputCls} />
        </Field>
        <div className="flex gap-2">
          {[
            ['schedule', '📅 Schedule'],
            ['now', '⚡ Send now'],
          ].map(([m, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`flex-1 text-[12.5px] font-bold rounded-full py-2 border transition ${
                mode === m ? 'bg-ink text-cream border-ink' : 'bg-card text-ink-soft border-line'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {mode === 'schedule' && (
          <Field label="Send at">
            <input type="datetime-local" value={sendAt} onChange={(e) => setSendAt(e.target.value)} className={inputCls} required />
          </Field>
        )}
        <p className="text-[11px] text-ink-faint">
          Goes to all your contacts who haven't opted out, personalised with each client's name.
        </p>
        {error && <p className="text-[12px] text-hot bg-amber-wash rounded-xl px-3.5 py-2.5">{error}</p>}
        <button type="submit" disabled={busy || !message.trim()} className="w-full bg-brand text-white font-bold text-[13.5px] rounded-full py-3 active:scale-[0.99] transition disabled:opacity-50">
          {busy ? 'Working…' : mode === 'schedule' ? 'Schedule greeting' : 'Send to all contacts'}
        </button>
      </form>
    </Sheet>
  )
}

const STATUS_BADGE = {
  scheduled: 'bg-brand-wash text-brand-deep',
  sent: 'bg-cream text-ink-soft',
  cancelled: 'bg-cream text-ink-faint line-through',
  failed: 'bg-amber-wash text-hot',
}

export default function FestiveTab() {
  const [data, setData] = useState(null)
  const [picked, setPicked] = useState(null)
  const [toast, setToast] = useState(null)

  const load = () => api.festive().then(setData).catch(() => {})
  useEffect(() => {
    load()
  }, [])

  const done = (msg) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
    load()
  }

  const cancel = async (s) => {
    await api.cancelFestive(s.id).catch(() => {})
    load()
  }

  const festivalByKey = Object.fromEntries((data?.festivals || []).map((f) => [f.key, f]))

  return (
    <div>
      {toast && (
        <p className="mt-4 text-[12.5px] font-bold text-brand-deep bg-brand-wash rounded-xl px-4 py-3">{toast}</p>
      )}

      <div className="grid grid-cols-2 gap-2.5 mt-4">
        {(data?.festivals || []).map((f) => (
          <button
            key={f.key}
            onClick={() => setPicked(f)}
            className="text-left bg-card rounded-2xl border border-line shadow-card px-4 py-3.5 active:scale-[0.98] transition"
          >
            <span className="text-[26px]">{f.emoji}</span>
            <p className="font-bold text-[13.5px] text-ink mt-1">{f.name}</p>
            <p className="text-[11px] text-ink-faint mt-0.5">
              {new Date(`${f.suggested_date}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
            </p>
          </button>
        ))}
      </div>

      {(data?.scheduled || []).length > 0 && (
        <section className="mt-6">
          <p className="text-[10.5px] font-bold tracking-[0.18em] text-ink-soft mb-2">SCHEDULED & SENT</p>
          <div className="bg-card rounded-2xl border border-line shadow-card divide-y divide-line">
            {data.scheduled.map((s) => {
              const f = festivalByKey[s.festival_key]
              return (
                <div key={s.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="text-[20px]">{f?.emoji || '🎉'}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-bold text-ink truncate">{f?.name || s.festival_key}</p>
                    <p className="text-[11.5px] text-ink-soft">
                      {fmtTime(s.send_at)}
                      {s.status === 'sent' ? ` · ${s.sent_count} sent` : ''}
                    </p>
                  </div>
                  <span className={`shrink-0 text-[10px] font-bold rounded-full px-2 py-0.5 ${STATUS_BADGE[s.status] || ''}`}>
                    {s.status}
                  </span>
                  {s.status === 'scheduled' && (
                    <button onClick={() => cancel(s)} className="shrink-0 text-[11px] font-bold text-hot">
                      Cancel
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {picked && <SendSheet festival={picked} onClose={() => setPicked(null)} onDone={done} />}
    </div>
  )
}
