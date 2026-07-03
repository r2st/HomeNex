import { useState } from 'react'
import { api, setToken } from '../api.js'

const FIELDS = {
  signup: [
    { key: 'name', label: 'Your name', type: 'text', placeholder: 'Rajesh Kumar', autoComplete: 'name' },
    { key: 'phone', label: 'Phone', type: 'tel', placeholder: '+91 98xxx xxxxx', autoComplete: 'tel' },
    { key: 'email', label: 'Email', type: 'email', placeholder: 'you@example.com', autoComplete: 'email' },
    { key: 'password', label: 'Password', type: 'password', placeholder: 'At least 6 characters', autoComplete: 'new-password' },
  ],
  login: [
    { key: 'email', label: 'Email', type: 'email', placeholder: 'you@example.com', autoComplete: 'email' },
    { key: 'password', label: 'Password', type: 'password', placeholder: '••••••••', autoComplete: 'current-password' },
  ],
}

export default function AuthScreen({ onAuthed }) {
  const [mode, setMode] = useState('signup')
  const [form, setForm] = useState({ name: '', phone: '', email: '', password: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const { token, agent } = await (mode === 'signup' ? api.signup(form) : api.login(form))
      setToken(token)
      onAuthed(agent)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

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
            ? 'One quick form — you’ll be in your dashboard in under a minute.'
            : 'Log in to your HomeNex dashboard.'}
        </p>
      </div>

      <form onSubmit={submit} className="mt-7 space-y-3.5 rise rise-2">
        {FIELDS[mode].map((f) => (
          <label key={f.key} className="block">
            <span className="text-[11.5px] font-bold text-ink-soft">{f.label}</span>
            <input
              type={f.type}
              value={form[f.key]}
              onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
              placeholder={f.placeholder}
              autoComplete={f.autoComplete}
              required
              className="mt-1 w-full bg-white border border-line rounded-2xl px-4 py-3.5 text-[14px] outline-none focus:border-brand/60"
            />
          </label>
        ))}

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
