import { useState } from 'react'
import { api } from '../api.js'
import { inputCls, Field } from './ui.jsx'
import { timezoneOptions, DEFAULT_TIMEZONE } from '../lib/timezones.js'

// Must match LANGUAGES in server/db.js — the API rejects anything else.
const LANGUAGES = [
  ['en', 'English'],
  ['hi', 'हिन्दी — Hindi'],
  ['mr', 'मराठी — Marathi'],
  ['ta', 'தமிழ் — Tamil'],
  ['te', 'తెలుగు — Telugu'],
  ['kn', 'ಕನ್ನಡ — Kannada'],
  ['gu', 'ગુજરાતી — Gujarati'],
  ['bn', 'বাংলা — Bengali'],
  ['pa', 'ਪੰਜਾਬੀ — Punjabi'],
  ['ml', 'മലയാളം — Malayalam'],
  ['or', 'ଓଡ଼ିଆ — Odia'],
]

const NOTIFICATIONS = [
  ['notify_new_lead', 'New lead arrives', 'A buyer messages you for the first time'],
  ['notify_followup_due', 'Follow-up is due', 'A reminder you scheduled comes due'],
  ['notify_daily_digest', 'Daily digest', "A morning summary of yesterday's pipeline"],
]

const HOURS = Array.from({ length: 24 }, (_, h) => [
  h,
  new Date(Date.UTC(2000, 0, 1, h)).toLocaleTimeString('en-IN', { hour: 'numeric', hour12: true, timeZone: 'UTC' }),
])

function Toggle({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`shrink-0 w-11 h-6 rounded-full p-0.5 transition disabled:opacity-50 ${
        checked ? 'bg-brand' : 'bg-line'
      }`}
    >
      <span
        className={`block w-5 h-5 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  )
}

// Locale and alert preferences. Each control saves on change — there is no
// half-filled state worth batching, and a dropped save is reported inline.
export default function PreferencesCard({ agent, onSaved }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [error, setError] = useState(null)

  const quietOn = agent?.quiet_hours_start != null
  const zones = timezoneOptions(agent?.timezone)

  const save = async (patch) => {
    setBusy(true)
    setError(null)
    setMsg(null)
    try {
      onSaved(await api.updatePreferences(patch))
      setMsg('Saved')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const setQuietHours = (on) =>
    save(
      on
        ? { quiet_hours_start: 22, quiet_hours_end: 7 }
        : { quiet_hours_start: null, quiet_hours_end: null },
    )

  return (
    <div className="bg-white border border-line rounded-2xl p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-[13px] font-bold text-ink-soft">Preferences</h3>
        {msg && <span className="text-[11px] font-bold text-green-700">{msg}</span>}
      </div>

      <Field label="Language">
        <select
          value={agent?.language || 'en'}
          disabled={busy}
          onChange={(e) => save({ language: e.target.value })}
          className={inputCls}
        >
          {LANGUAGES.map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Timezone">
        <select
          value={agent?.timezone || DEFAULT_TIMEZONE}
          disabled={busy}
          onChange={(e) => save({ timezone: e.target.value })}
          className={inputCls}
        >
          {zones.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <span className="block text-[11px] text-ink-faint mt-1 leading-snug">
          Sets what counts as "today" for your dashboard, follow-ups and site visits.
        </span>
      </Field>

      <div className="border-t border-line pt-3 space-y-3">
        <div>
          <div className="flex items-center gap-2">
            <div className="text-[11px] font-bold text-ink-faint uppercase tracking-wide">Alerts</div>
            <span className="text-[9.5px] font-bold bg-amber-wash text-gold rounded-full px-2 py-0.5">Coming soon</span>
          </div>
          <p className="text-[11px] text-ink-faint mt-0.5 leading-snug">
            We're still building alert delivery. You'll be able to choose these once it's ready.
          </p>
        </div>

        {NOTIFICATIONS.map(([key, label, sub]) => (
          <div key={key} className="flex items-center gap-3 opacity-60">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-ink">{label}</p>
              <p className="text-[11.5px] text-ink-faint leading-snug">{sub}</p>
            </div>
            <Toggle
              label={label}
              checked={agent?.[key] === 1}
              disabled
              onChange={() => {}}
            />
          </div>
        ))}
      </div>

      <div className="border-t border-line pt-3 space-y-3">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-ink">Quiet hours</p>
            <p className="text-[11.5px] text-ink-faint leading-snug">Pause alerts overnight</p>
          </div>
          <Toggle label="Quiet hours" checked={quietOn} disabled={busy} onChange={setQuietHours} />
        </div>

        {quietOn && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="From">
              <select
                value={agent.quiet_hours_start}
                disabled={busy}
                onChange={(e) => save({ quiet_hours_start: Number(e.target.value) })}
                className={inputCls}
              >
                {HOURS.map(([h, label]) => (
                  <option key={h} value={h} disabled={h === agent.quiet_hours_end}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="To">
              <select
                value={agent.quiet_hours_end}
                disabled={busy}
                onChange={(e) => save({ quiet_hours_end: Number(e.target.value) })}
                className={inputCls}
              >
                {HOURS.map(([h, label]) => (
                  <option key={h} value={h} disabled={h === agent.quiet_hours_start}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}
      </div>

      {error && <p className="text-[12.5px] text-hot bg-amber-wash rounded-xl px-3 py-2">{error}</p>}
    </div>
  )
}
