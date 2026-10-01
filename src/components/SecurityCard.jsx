import { useState } from 'react'
import { api, setToken } from '../api.js'
import { inputCls, Field } from './ui.jsx'

// Change the WhatsApp number the agent logs in with. Password-gated server-side.
// Minimum local-part length we'll accept (covers short international numbers).
const MIN_LOCAL_DIGITS = 6

function PhoneForm({ phone, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [cc, setCc] = useState('+91')
  const [newPhone, setNewPhone] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [error, setError] = useState(null)

  const ready = newPhone.length >= MIN_LOCAL_DIGITS && Boolean(password)

  const close = () => {
    setEditing(false)
    setCc('+91')
    setNewPhone('')
    setPassword('')
    setError(null)
  }

  const setCountryCode = (v) => setCc('+' + v.replace(/\D/g, '').slice(0, 4))

  // An agent who selects the prefix and hits backspace leaves '+' behind, because
  // setCountryCode always re-adds it. '+' is empty in intent but truthy as a string,
  // so the `cc || '+91'` fallback below never fired and the number went up as
  // '+9812345678' — a login they can never type again, changed by the one form that
  // is meant to keep them able to sign in. Ask for a digit, not for truthiness.
  const dialCode = /\d/.test(cc) ? cc : '+91'

  const submit = async (e) => {
    e.preventDefault()
    if (busy || !ready) return
    setBusy(true)
    setError(null)
    setMsg(null)
    try {
      const updated = await api.changePhone({ phone: dialCode + newPhone, password })
      onSaved(updated)
      setMsg(`Your WhatsApp number is now ${updated.phone}. Use it to log in next time.`)
      close()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="text-[11px] font-bold text-ink-faint uppercase tracking-wide">
        WhatsApp number (you log in with this)
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[15px] font-semibold text-ink tracking-wide">{phone}</span>
        {!editing && (
          <button
            onClick={() => {
              setMsg(null)
              setEditing(true)
            }}
            className="text-[12px] font-bold text-brand hover:text-brand-deep px-2 py-1 rounded-lg active:scale-[0.98] transition"
          >
            Change
          </button>
        )}
      </div>

      {msg && !editing && (
        <p className="text-[12.5px] text-[#34D399] bg-[rgba(52,211,153,0.1)] rounded-xl px-3 py-2">{msg}</p>
      )}

      {editing && (
        <form onSubmit={submit} className="space-y-3 pt-1">
          <div className="flex items-stretch bg-[#111113] border border-line rounded-2xl overflow-hidden focus-within:border-brand/60">
            <input
              type="text"
              inputMode="tel"
              list="change-country-codes"
              value={cc}
              onChange={(e) => setCountryCode(e.target.value)}
              placeholder="+91"
              aria-label="Country code"
              className="w-[4.5rem] px-3 py-3 text-[14px] font-semibold text-ink-soft bg-card border-r border-line tracking-wide outline-none"
            />
            <datalist id="change-country-codes">
              <option value="+91">India</option>
              <option value="+1">USA / Canada</option>
              <option value="+44">UK</option>
              <option value="+971">UAE</option>
              <option value="+61">Australia</option>
              <option value="+65">Singapore</option>
            </datalist>
            <input
              type="tel"
              inputMode="numeric"
              autoFocus
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value.replace(/\D/g, '').slice(0, 12))}
              placeholder="New mobile number"
              aria-label="New WhatsApp number"
              className="flex-1 px-4 py-3 text-[14px] text-ink outline-none bg-[#111113] tracking-wide"
            />
          </div>

          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Confirm your password"
            aria-label="Current password"
            autoComplete="current-password"
            className="w-full px-4 py-3 text-[14px] text-ink bg-[#111113] border border-line rounded-2xl outline-none focus:border-brand/60"
          />

          <p className="text-[11px] text-ink-faint leading-snug">
            You'll use this new number to log in from now on.
          </p>

          {error && <p className="text-[12.5px] text-hot bg-amber-wash rounded-xl px-3 py-2">{error}</p>}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={close}
              className="flex-1 border border-line text-ink-soft font-bold text-[13px] rounded-2xl py-3 active:scale-[0.98] transition hover:bg-cream"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !ready}
              className="flex-1 bg-brand hover:bg-brand-deep disabled:opacity-50 text-white font-bold text-[13px] rounded-2xl py-3 active:scale-[0.98] transition"
            >
              {busy ? 'Saving…' : 'Update number'}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

const MIN_PASSWORD = 6

function PasswordForm() {
  const [editing, setEditing] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [error, setError] = useState(null)

  const close = () => {
    setEditing(false)
    setCurrent('')
    setNext('')
    setConfirm('')
    setError(null)
  }

  // Caught here so a typo in the confirmation never reaches the server.
  const mismatch = confirm.length > 0 && next !== confirm
  const tooShort = next.length > 0 && next.length < MIN_PASSWORD
  const ready = current && next.length >= MIN_PASSWORD && next === confirm

  const submit = async (e) => {
    e.preventDefault()
    if (busy || !ready) return
    setBusy(true)
    setError(null)
    setMsg(null)
    try {
      // The server rotates the agent's token version, which signs out every other
      // device. It hands this one a token signed with the new version — store it or
      // the very next request 401s and logs the agent out of their own session.
      const { token } = await api.changePassword({ current_password: current, new_password: next })
      if (token) setToken(token)
      setMsg("Password updated. You're signed out everywhere else.")
      close()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-t border-line pt-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[11px] font-bold text-ink-faint uppercase tracking-wide">Password</div>
          <div className="text-[15px] font-semibold text-ink tracking-[0.2em]">••••••••</div>
        </div>
        {!editing && (
          <button
            onClick={() => {
              setMsg(null)
              setEditing(true)
            }}
            className="text-[12px] font-bold text-brand hover:text-brand-deep px-2 py-1 rounded-lg active:scale-[0.98] transition"
          >
            Change
          </button>
        )}
      </div>

      {msg && !editing && (
        <p className="text-[12.5px] text-[#34D399] bg-[rgba(52,211,153,0.1)] rounded-xl px-3 py-2">{msg}</p>
      )}

      {editing && (
        <form onSubmit={submit} className="space-y-3 pt-1">
          <Field label="Current password">
            <input
              type="password"
              autoFocus
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              className={inputCls}
            />
          </Field>

          <Field label="New password">
            <input
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              className={inputCls}
            />
            {tooShort && (
              <span className="block text-[11px] text-hot mt-1">
                At least {MIN_PASSWORD} characters.
              </span>
            )}
          </Field>

          <Field label="Confirm new password">
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className={inputCls}
            />
            {mismatch && <span className="block text-[11px] text-hot mt-1">Passwords don't match.</span>}
          </Field>

          {error && <p className="text-[12.5px] text-hot bg-amber-wash rounded-xl px-3 py-2">{error}</p>}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={close}
              className="flex-1 border border-line text-ink-soft font-bold text-[13px] rounded-2xl py-3 active:scale-[0.98] transition hover:bg-cream"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !ready}
              className="flex-1 bg-brand hover:bg-brand-deep disabled:opacity-50 text-white font-bold text-[13px] rounded-2xl py-3 active:scale-[0.98] transition"
            >
              {busy ? 'Saving…' : 'Update password'}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

// Everything that guards access to the account: login number and password.
export default function SecurityCard({ agent, onSaved }) {
  return (
    <div className="bg-card border border-line rounded-2xl p-4 space-y-3">
      <h3 className="text-[13px] font-bold text-ink-soft">Sign-in &amp; security</h3>
      <PhoneForm phone={agent?.phone} onSaved={onSaved} />
      <PasswordForm />
    </div>
  )
}
