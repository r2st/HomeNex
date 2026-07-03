import { useState } from 'react'
import { api, setToken } from '../api.js'

export default function AuthScreen({ onAuthed }) {
  const [mode, setMode] = useState('signup')
  // `phone` holds the local part only; the +91 country code is fixed in the UI.
  const [form, setForm] = useState({ name: '', phone: '', password: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const setPhone = (v) => setForm((s) => ({ ...s, phone: v.replace(/\D/g, '').slice(0, 10) }))

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const payload = {
        phone: '+91' + form.phone,
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
            ? 'Register your WhatsApp number — every buyer who messages it lands here, qualified by AI.'
            : 'Log in with your WhatsApp number.'}
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
          <span className="text-[11.5px] font-bold text-ink-soft">WhatsApp Number</span>
          <div className="mt-1 flex items-stretch bg-white border border-line rounded-2xl overflow-hidden focus-within:border-brand/60">
            <span className="flex items-center px-4 text-[14px] font-semibold text-ink-soft bg-cream border-r border-line select-none">
              +91
            </span>
            <input
              type="tel"
              inputMode="numeric"
              value={form.phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="98xxx xxxxx"
              autoComplete="tel-national"
              required
              className="flex-1 px-4 py-3.5 text-[14px] outline-none bg-white tracking-wide"
            />
          </div>
          <span className="text-[11px] text-ink-faint mt-1 block">
            This is the number buyers will message on WhatsApp.
          </span>
        </label>

        <label className="block">
          <span className="text-[11.5px] font-bold text-ink-soft">Password</span>
          <input
            type="password"
            value={form.password}
            onChange={(e) => setForm((s) => ({ ...s, password: e.target.value }))}
            placeholder={mode === 'signup' ? 'At least 6 characters' : '••••••••'}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            required
            className={inputCls}
          />
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
