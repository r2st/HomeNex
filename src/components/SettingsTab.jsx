import { useState, useEffect } from 'react'
import { api, setToken } from '../api.js'

const statusColors = {
  none: 'bg-gray-100 text-gray-600',
  pending: 'bg-amber-100 text-amber-700',
  registered: 'bg-blue-100 text-blue-700',
  active: 'bg-green-100 text-green-700',
}

const statusLabels = {
  none: 'Not submitted',
  pending: 'Pending registration',
  registered: 'Registered — awaiting activation',
  active: 'Active',
}

export default function SettingsTab({ agent, onAgentUpdate }) {
  const [waCC, setWaCC] = useState('+91')
  const [waPhone, setWaPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [error, setError] = useState(null)
  const [current, setCurrent] = useState(agent)

  useEffect(() => {
    api.me().then(setCurrent).catch(() => {})
  }, [])

  const handleSetWaCC = (v) => {
    const digits = v.replace(/\D/g, '').slice(0, 4)
    setWaCC('+' + digits)
  }

  const submitWaPhone = async (e) => {
    e.preventDefault()
    if (busy || !waPhone) return
    setBusy(true)
    setError(null)
    setMsg(null)
    try {
      const updated = await api.updateWaPhone({ wa_phone_number: waCC + waPhone })
      setCurrent(updated)
      if (onAgentUpdate) onAgentUpdate(updated)
      setMsg('WhatsApp Business number saved! Our team will register it on WABA.')
      setWaPhone('')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const logout = () => {
    setToken(null)
    window.dispatchEvent(new Event('homenex-logout'))
  }

  const status = current?.waba_status || 'none'

  return (
    <div className="p-5 pb-28 space-y-5">
      <h2 className="font-display text-[22px] font-semibold text-ink">Settings</h2>

      {/* Account info */}
      <div className="bg-white border border-line rounded-2xl p-4 space-y-2">
        <h3 className="text-[13px] font-bold text-ink-soft">Account</h3>
        <div className="text-[14px] text-ink">{current?.name}</div>
        <div className="text-[13px] text-ink-soft">{current?.phone}</div>
        {current?.email && <div className="text-[13px] text-ink-soft">{current.email}</div>}
      </div>

      {/* WABA Status */}
      <div className="bg-white border border-line rounded-2xl p-4 space-y-3">
        <h3 className="text-[13px] font-bold text-ink-soft">WhatsApp Business Number</h3>

        {current?.wa_phone_number ? (
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <span className="text-[15px] font-semibold text-ink tracking-wide">
                {current.wa_phone_number}
              </span>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${statusColors[status]}`}>
                {statusLabels[status]}
              </span>
            </div>

            {current.waba_registered_at && (
              <div className="text-[12px] text-ink-faint">
                Registered on {new Date(current.waba_registered_at + 'Z').toLocaleDateString('en-IN')}
              </div>
            )}

            {status === 'active' && (
              <div className="bg-green-50 border border-green-200 rounded-xl px-3 py-2">
                <p className="text-[12px] text-green-800 leading-snug">
                  Your WhatsApp Business number is active! All incoming messages are automatically
                  tracked in your dashboard. New senders are auto-added as clients.
                </p>
              </div>
            )}

            {status === 'pending' && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                <p className="text-[12px] text-amber-800 leading-snug">
                  Our support team is registering this number on Meta WABA.
                  You'll be notified once it's active. This usually takes 1-2 business days.
                </p>
              </div>
            )}

            {status === 'registered' && (
              <div className="bg-blue-50 border border-blue-200 rounded-xl px-3 py-2">
                <p className="text-[12px] text-blue-800 leading-snug">
                  Your number is registered with Meta. Our team is completing the final setup.
                  It will be active shortly.
                </p>
              </div>
            )}

            {status === 'none' && (
              <div className="bg-gray-50 border border-gray-200 rounded-xl px-3 py-2">
                <p className="text-[12px] text-gray-700 leading-snug">
                  Your number is saved but not yet submitted for WABA registration.
                  Contact support to begin registration.
                </p>
              </div>
            )}
          </div>
        ) : (
          <form onSubmit={submitWaPhone} className="space-y-3">
            <p className="text-[12.5px] text-ink-soft leading-snug">
              Add a phone number to be registered as your WhatsApp Business number.
              This must be a separate number from your personal WhatsApp.
            </p>
            <div className="flex items-stretch bg-white border border-line rounded-2xl overflow-hidden focus-within:border-brand/60">
              <input
                type="text"
                inputMode="tel"
                value={waCC}
                onChange={(e) => handleSetWaCC(e.target.value)}
                placeholder="+91"
                aria-label="Country code"
                className="w-[4.5rem] px-3 py-3 text-[14px] font-semibold text-ink-soft outline-none bg-cream border-r border-line tracking-wide"
              />
              <input
                type="tel"
                inputMode="numeric"
                value={waPhone}
                onChange={(e) => setWaPhone(e.target.value.replace(/\D/g, '').slice(0, 12))}
                placeholder="Enter WA Business number"
                className="flex-1 px-4 py-3 text-[14px] outline-none bg-white tracking-wide"
              />
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
              <p className="text-[11px] text-amber-800 leading-snug">
                This number will be registered as your WhatsApp Business number.
                Do <strong>not</strong> use your personal WhatsApp number.
              </p>
            </div>

            {error && (
              <p className="text-[12.5px] text-hot bg-amber-wash rounded-xl px-3 py-2">{error}</p>
            )}
            {msg && (
              <p className="text-[12.5px] text-green-700 bg-green-50 rounded-xl px-3 py-2">{msg}</p>
            )}

            <button
              type="submit"
              disabled={busy || !waPhone}
              className="w-full bg-brand hover:bg-brand-deep disabled:opacity-50 text-white font-bold text-[13px] rounded-2xl py-3 active:scale-[0.98] transition"
            >
              {busy ? 'Saving…' : 'Save Business Number'}
            </button>
          </form>
        )}
      </div>

      {/* How it works */}
      <div className="bg-white border border-line rounded-2xl p-4 space-y-3">
        <h3 className="text-[13px] font-bold text-ink-soft">How WABA Registration Works</h3>
        <ol className="text-[12.5px] text-ink-soft leading-relaxed space-y-1.5 list-decimal list-inside">
          <li>Provide a phone number (not your personal WhatsApp)</li>
          <li>Our support team registers it on Meta WhatsApp Business API</li>
          <li>Once active, all incoming messages are auto-tracked in your dashboard</li>
          <li>New senders are automatically added as your clients</li>
        </ol>
      </div>

      {/* Admin link */}
      {current?.is_admin === 1 && (
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('homenex-navigate', { detail: 'admin' }))}
          className="w-full bg-ink text-white font-bold text-[13px] rounded-2xl py-3 active:scale-[0.98] transition"
        >
          Open Admin Panel
        </button>
      )}

      {/* Logout */}
      <button
        onClick={logout}
        className="w-full border border-line text-ink-soft font-bold text-[13px] rounded-2xl py-3 active:scale-[0.98] transition hover:bg-cream"
      >
        Log out
      </button>
    </div>
  )
}
