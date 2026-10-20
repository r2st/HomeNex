import { useEffect, useState } from 'react'
import { api } from '../api.js'

// How dashboard messages reach clients. The default needs no setup at all: every
// "send" opens the agent's own WhatsApp with the chat and message ready (wa.me). The
// Meta WhatsApp Business API is an optional upgrade — sending from the business
// number, AI auto-replies, reminders and bulk greetings — switched on here once
// support has connected the number.
export default function WaSendingCard() {
  const [cfg, setCfg] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    api.phoneConfig().then(setCfg).catch(() => setCfg(null))
  }, [])

  if (!cfg) return null
  const apiOn = cfg.wa_send_mode === 'api'

  const toggle = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.setWaApi(!apiOn)
      setCfg((c) => ({ ...c, ...res }))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-card border border-line rounded-2xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[13px] font-bold text-ink-soft">WhatsApp sending</h3>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${apiOn ? 'bg-brand-wash text-brand-deep' : 'bg-cream text-ink-soft'}`}>
          {apiOn ? 'Business API' : 'Your WhatsApp app'}
        </span>
      </div>

      {apiOn ? (
        <p className="text-[12.5px] text-ink-soft leading-snug">
          Messages go out from your WhatsApp Business number through Meta, straight from the dashboard.
        </p>
      ) : (
        <p className="text-[12.5px] text-ink-soft leading-snug">
          Ready to use — no Meta setup needed. Tapping <b>Open WhatsApp</b> opens the client's chat in
          WhatsApp on your phone or computer with the message already typed. You just tap send.
        </p>
      )}

      <div className="border border-line rounded-xl px-3 py-2.5">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] font-bold text-ink">WhatsApp Business API (optional upgrade)</p>
            <p className="text-[11.5px] text-ink-faint leading-snug mt-0.5">
              Send from your business number without leaving the dashboard, plus AI auto-replies, visit
              reminders and festive greetings to all contacts.
              {!cfg.wa_api_available && !apiOn && ' Contact support to connect your number first.'}
            </p>
          </div>
          <button
            role="switch"
            aria-checked={apiOn}
            aria-label="Use the WhatsApp Business API"
            onClick={toggle}
            disabled={busy || (!apiOn && !cfg.wa_api_available)}
            className={`shrink-0 w-11 h-6 rounded-full relative transition disabled:opacity-40 ${apiOn ? 'bg-brand' : 'bg-line'}`}
          >
            <span
              aria-hidden="true"
              className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${apiOn ? 'left-[22px]' : 'left-0.5'}`}
            />
          </button>
        </div>
      </div>
      {error && <p className="text-[12px] text-hot bg-amber-wash rounded-xl px-3.5 py-2.5">{error}</p>}
    </div>
  )
}
