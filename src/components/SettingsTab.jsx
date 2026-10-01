import { useState, useEffect } from 'react'
import { api, setToken, parseTs } from '../api.js'
import ProfileCard from './ProfileCard.jsx'
import SecurityCard from './SecurityCard.jsx'
import PreferencesCard from './PreferencesCard.jsx'

// Brand tokens so the pills match the green/cream/amber system used everywhere else
// (no foreign blue/gray Tailwind defaults).
const statusColors = {
  none: 'bg-cream text-ink-soft',
  pending: 'bg-amber-wash text-gold',
  registered: 'bg-brand-wash text-brand-deep',
  active: 'bg-brand-wash text-brand-deep',
}

const statusLabels = {
  none: 'Not submitted',
  pending: 'Pending registration',
  registered: 'Registered — awaiting activation',
  active: 'Active',
}

function WabaCard({ agent }) {
  const status = agent?.waba_status || 'none'

  return (
    <div className="bg-card border border-line rounded-2xl p-4 space-y-3">
      <h3 className="text-[13px] font-bold text-ink-soft">WhatsApp Business Number</h3>

      {agent?.wa_phone_number ? (
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <span className="text-[15px] font-semibold text-ink tracking-wide">{agent.wa_phone_number}</span>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${statusColors[status]}`}>
              {statusLabels[status]}
            </span>
          </div>

          <p className="text-[12px] text-ink-faint leading-snug">
            This is the number you registered with — buyers message it and every lead lands in
            your dashboard. It's also your login.
          </p>

          {agent.waba_registered_at && (
            <div className="text-[12px] text-ink-faint">
              Registered on {parseTs(agent.waba_registered_at).toLocaleDateString('en-IN')}
            </div>
          )}

          {status === 'active' && (
            <div className="bg-[rgba(52,211,153,0.1)] border border-[rgba(52,211,153,0.2)] rounded-xl px-3 py-2">
              <p className="text-[12px] text-[#34D399] leading-snug">
                Active — messages tracked, new senders auto-added.
              </p>
            </div>
          )}

          {status === 'pending' && (
            <div className="bg-amber-wash border border-[rgba(251,191,36,0.2)] rounded-xl px-3 py-2">
              <p className="text-[12px] text-[#FBBF24] leading-snug">
                Being registered with Meta — usually 1-2 business days.
              </p>
            </div>
          )}

          {status === 'registered' && (
            <div className="bg-[rgba(96,165,250,0.1)] border border-[rgba(96,165,250,0.2)] rounded-xl px-3 py-2">
              <p className="text-[12px] text-[#60A5FA] leading-snug">
                Registered — final setup in progress, active shortly.
              </p>
            </div>
          )}

          {status === 'none' && (
            <div className="bg-card border border-line rounded-xl px-3 py-2">
              <p className="text-[12px] text-ink-soft leading-snug">
                Your number is saved but not yet submitted for WABA registration.
                Contact support to begin registration.
              </p>
            </div>
          )}
        </div>
      ) : (
        <p className="text-[12.5px] text-ink-soft leading-snug">
          Your WhatsApp Business number will appear here once your account finishes setting up.
        </p>
      )}
    </div>
  )
}

export default function SettingsTab({ agent, onAgentUpdate }) {
  const [current, setCurrent] = useState(agent)

  useEffect(() => {
    api.me().then(setCurrent).catch(() => {})
  }, [])

  // Every card returns the updated agent; keep the tab and the app shell in sync.
  const onSaved = (updated) => {
    setCurrent(updated)
    if (onAgentUpdate) onAgentUpdate(updated)
  }

  const logout = () => {
    setToken(null)
    window.dispatchEvent(new Event('homenex-logout'))
  }

  if (!current) return <div className="p-5 text-[13px] text-ink-faint">Loading…</div>

  return (
    <div className="p-5 pb-28 space-y-5">
      <h2 className="font-display text-[22px] font-semibold text-ink">Settings</h2>

      <ProfileCard agent={current} onSaved={onSaved} />
      <SecurityCard agent={current} onSaved={onSaved} />
      <PreferencesCard agent={current} onSaved={onSaved} />
      <WabaCard agent={current} />

      {/* Setup guide: full step-by-step for adding a number to Meta WABA. */}
      <a
        href="/setup-guide"
        target="_blank"
        rel="noopener noreferrer"
        className="block bg-card border border-line rounded-2xl p-4 active:scale-[0.99] transition hover:bg-[#222225]"
      >
        <div className="flex items-center gap-3">
          <span className="text-[22px]">📘</span>
          <div className="min-w-0 flex-1">
            <p className="font-bold text-[13.5px] text-ink">WhatsApp Business setup guide</p>
            <p className="text-[12px] text-ink-soft mt-0.5 leading-snug">
              How to add a phone number to Meta WhatsApp Business — prerequisites, steps,
              and troubleshooting.
            </p>
          </div>
          <span className="text-ink-faint text-lg">↗</span>
        </div>
      </a>

      {/* How it works */}
      <div className="bg-card border border-line rounded-2xl p-4 space-y-3">
        <h3 className="text-[13px] font-bold text-ink-soft">How it works</h3>
        <ol className="text-[12.5px] text-ink-soft space-y-1 list-decimal list-inside">
          <li>You provide a phone number</li>
          <li>We register it on Meta WABA</li>
          <li>Messages auto-track, senders auto-add</li>
        </ol>
      </div>

      {current.is_admin === 1 && (
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('homenex-navigate', { detail: 'admin' }))}
          className="w-full bg-ink text-white font-bold text-[13px] rounded-2xl py-3 active:scale-[0.98] transition"
        >
          Team &amp; admin
        </button>
      )}

      <button
        onClick={logout}
        className="w-full border border-line text-ink-soft font-bold text-[13px] rounded-2xl py-3 active:scale-[0.98] transition hover:bg-cream"
      >
        Log out
      </button>
    </div>
  )
}
