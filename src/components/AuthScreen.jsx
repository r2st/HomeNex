import { useState } from 'react'
import { api, setToken } from '../api.js'

export default function AuthScreen({ onAuthed }) {
  const [mode, setMode] = useState('signup')
  // `cc` is the editable country code (defaults to +91); `phone` holds the local part.
  const [form, setForm] = useState({ name: '', cc: '+91', phone: '', password: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [showPassword, setShowPassword] = useState(false)

  // Keep a leading "+" and up to 4 dialing digits (e.g. +1, +44, +971).
  const setCc = (v) => {
    const digits = v.replace(/\D/g, '').slice(0, 4)
    setForm((s) => ({ ...s, cc: '+' + digits }))
  }
  // Local part: digits only, up to 12 (covers longer international numbers).
  const setPhone = (v) => setForm((s) => ({ ...s, phone: v.replace(/\D/g, '').slice(0, 12) }))

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const payload = {
        phone: (form.cc || '+91') + form.phone,
        password: form.password,
        ...(mode === 'signup' ? { name: form.name } : {}),
      }
      const { token, agent } = await (mode === 'signup' ? api.signup(payload) : api.login(payload))
      setToken(token)
      onAuthed(agent)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const inputCls =
    'mt-1 w-full bg-white border border-line rounded-2xl px-4 py-3.5 text-[14px] outline-none focus:border-brand/60'

  return (
    <div className="min-h-dvh flex flex-col justify-center px-6 py-10">
      <div className="rise">
        <div className="w-12 h-12 rounded-2xl bg-brand flex items-center justify-center shadow-card">
          <svg viewBox="0 0 100 100" className="w-7 h-7" fill="white">
            <path d="M50 22 78 46h-8v30H56V58H44v18H30V46h-8z" />
          </svg>
        </div>
        <h1 className="font-display text-[30px] leading-[1.1] font-semibold text-ink mt-5">
          {mode === 'signup' ? 'Start answering every lead in 30 seconds.' : 'Welcome back.'}
        </h1>
        <p className="text-[13.5px] text-ink-soft mt-2">
          {mode === 'signup'
            ? 'Register your WhatsApp Business number — every buyer who messages it lands here, qualified by AI.'
            : 'Log in with your WhatsApp Business number.'}
        </p>
      </div>

      <form onSubmit={submit} className="mt-7 space-y-3.5 rise rise-2">
        {mode === 'signup' && (
          <label className="block">
            <span className="text-[11.5px] font-bold text-ink-soft">Your name</span>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
              placeholder="Rajesh Kumar"
              autoComplete="name"
              required
              className={inputCls}
            />
          </label>
        )}

        <label className="block">
          <span className="text-[11.5px] font-bold text-ink-soft">WhatsApp Business Number</span>
          <div className="mt-1 flex items-stretch bg-white border border-line rounded-2xl overflow-hidden focus-within:border-brand/60">
            <input
              type="text"
              inputMode="tel"
              list="country-codes"
              value={form.cc}
              onChange={(e) => setCc(e.target.value)}
              placeholder="+91"
              aria-label="Country code"
              required
              className="w-[4.5rem] px-3 py-3.5 text-[14px] font-semibold text-ink-soft outline-none bg-cream border-r border-line tracking-wide"
            />
            <datalist id="country-codes">
              <option value="+91">India</option>
              <option value="+1">USA / Canada</option>
              <option value="+44">UK</option>
              <option value="+971">UAE</option>
              <option value="+61">Australia</option>
              <option value="+65">Singapore</option>
              <option value="+92">Pakistan</option>
              <option value="+880">Bangladesh</option>
              <option value="+94">Sri Lanka</option>
              <option value="+49">Germany</option>
              <option value="+33">France</option>
              <option value="+81">Japan</option>
              <option value="+86">China</option>
            </datalist>
            <input
              type="tel"
              inputMode="numeric"
              value={form.phone}
              onChange={(e) => setPhone(e.target.value)}
              // The wrapping <label> names the country-code box beside this one — a
              // label with no `for` reaches its first labelable descendant and stops —
              // so without this the actual phone field announces as a bare "edit".
              aria-label="Phone number"
              placeholder="98xxx xxxxx"
              autoComplete="tel-national"
              required
              className="flex-1 px-4 py-3.5 text-[14px] outline-none bg-white tracking-wide"
            />
          </div>
          <span className="text-[11px] text-ink-faint mt-1 block">
            The WhatsApp Business number buyers message — also used as your login.
          </span>
        </label>

        <label className="block">
          <span className="text-[11.5px] font-bold text-ink-soft">Password</span>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={form.password}
              onChange={(e) => setForm((s) => ({ ...s, password: e.target.value }))}
              placeholder={mode === 'signup' ? 'At least 6 characters' : '••••••••'}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              required
              className={`${inputCls} pr-12`}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[18px] leading-none text-ink-faint active:scale-90 transition"
            >
              {showPassword ? '🙈' : '👁'}
            </button>
          </div>
        </label>

        {error && (
          <p className="text-[12.5px] text-hot bg-amber-wash rounded-xl px-4 py-3">{error}</p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full bg-brand hover:bg-brand-deep disabled:opacity-50 text-white font-bold text-[15px] rounded-2xl py-4 shadow-float active:scale-[0.98] transition"
        >
          {busy ? 'One moment…' : mode === 'signup' ? 'Create my dashboard →' : 'Log in →'}
        </button>
      </form>

      <button
        onClick={() => {
          setMode(mode === 'signup' ? 'login' : 'signup')
          setError(null)
        }}
        className="text-[13px] text-ink-soft underline underline-offset-4 mt-5 rise rise-3"
      >
        {mode === 'signup' ? 'Already have an account? Log in' : 'New here? Create an account'}
      </button>
    </div>
  )
}
