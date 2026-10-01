import { useState } from 'react'
import { api, setToken } from '../api.js'

const robotSvg = (
  <svg viewBox="0 0 48 48" style={{ width: 48, height: 48, color: '#F0B429', margin: '0 auto 20px', display: 'block' }} aria-hidden="true">
    <g fill="none">
      <line x1="24" y1="8" x2="24" y2="3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="24" cy="2" r="1.8" fill="currentColor" opacity="0.9" />
      <circle cx="24" cy="2" r="2.8" fill="currentColor" opacity="0.25" />
      <rect x="14" y="8" width="20" height="14" rx="4" fill="currentColor" />
      <circle cx="19.5" cy="14" r="2.2" fill="#0A0A0B" />
      <circle cx="28.5" cy="14" r="2.2" fill="#0A0A0B" />
      <path d="M20 18.5 Q24 21.5 28 18.5" stroke="#0A0A0B" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      <rect x="16" y="23" width="16" height="12" rx="3" fill="currentColor" />
      <rect x="8" y="24" width="7" height="3.5" rx="1.8" fill="currentColor" />
      <rect x="33" y="24" width="7" height="3.5" rx="1.8" fill="currentColor" />
      <rect x="19" y="36" width="3.5" height="5" rx="1.5" fill="currentColor" />
      <rect x="25.5" y="36" width="3.5" height="5" rx="1.5" fill="currentColor" />
      <g transform="translate(36, 28)">
        <rect x="-2.5" y="0" width="7" height="5.5" rx="1" fill="#0A0A0B" stroke="currentColor" strokeWidth="0.8" />
        <path d="M-0.5 0 v-1.2 a1.2 1.2 0 0 1 1.2-1.2 h0.6 a1.2 1.2 0 0 1 1.2 1.2 v1.2" stroke="currentColor" strokeWidth="0.7" fill="none" />
        <rect x="0" y="2" width="2" height="1" rx="0.3" fill="currentColor" />
      </g>
    </g>
  </svg>
)

const s = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0A0A0B',
    padding: '24px 16px',
    fontFamily: "'Schibsted Grotesk', system-ui, -apple-system, sans-serif",
  },
  wrapper: {
    width: '100%',
    maxWidth: 380,
    animation: 'adminFadeUp 0.5s cubic-bezier(0.2,0.7,0.2,1) both',
  },
  title: {
    fontFamily: "'Instrument Serif', Georgia, serif",
    fontSize: 42,
    fontWeight: 400,
    color: '#fff',
    margin: 0,
    textAlign: 'center',
    lineHeight: 1.1,
  },
  titleAccent: {
    fontStyle: 'italic',
    color: '#F0B429',
  },
  subtitle: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.45)',
    textAlign: 'center',
    margin: '10px 0 28px',
  },
  card: {
    background: 'rgba(16,16,18,0.8)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    border: '1px solid rgba(255,255,255,0.07)',
    borderRadius: 12,
    padding: 24,
    boxShadow: '0 1px 0 0 rgba(255,255,255,.04) inset, 0 8px 24px -12px rgba(0,0,0,.9)',
  },
  label: {
    display: 'block',
    fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, monospace",
    fontSize: 10,
    fontWeight: 500,
    textTransform: 'uppercase',
    letterSpacing: '0.18em',
    color: 'rgba(255,255,255,0.35)',
    marginBottom: 6,
  },
  input: {
    width: '100%',
    background: 'rgba(10,10,11,0.6)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 8,
    padding: '10px 14px',
    fontSize: 14,
    fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, monospace",
    color: '#fff',
    outline: 'none',
    boxSizing: 'border-box',
    transition: 'border-color 150ms ease',
  },
  fieldGroup: {
    marginBottom: 16,
  },
  button: {
    width: '100%',
    background: '#F0B429',
    color: '#0A0A0B',
    border: 'none',
    borderRadius: 8,
    padding: '12px 16px',
    fontSize: 14,
    fontWeight: 600,
    fontFamily: "'Schibsted Grotesk', system-ui, sans-serif",
    cursor: 'pointer',
    transition: 'background 150ms ease',
    marginTop: 8,
  },
  error: {
    fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, monospace",
    fontSize: 12,
    color: '#F87171',
    background: 'rgba(248,113,113,0.1)',
    borderRadius: 8,
    padding: '10px 14px',
    marginBottom: 12,
  },
  footer: {
    textAlign: 'center',
    marginTop: 28,
    fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, monospace",
    fontSize: 10,
    color: 'rgba(255,255,255,0.25)',
    letterSpacing: '0.08em',
  },
  footerLink: {
    color: '#F0B429',
    textDecoration: 'underline',
    textUnderlineOffset: 2,
  },
}

const focusStyle = { borderColor: 'rgba(240,180,41,0.5)' }
const blurStyle = 'rgba(255,255,255,0.12)'

export default function Login({ onLogin }) {
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const id = identifier.trim()
      const body = id.includes('@') ? { email: id, password } : { phone: id, password }
      const { token, agent } = await api.login(body)
      if (agent.is_admin !== 1) {
        setError('This account does not have admin access.')
        return
      }
      setToken(token)
      onLogin(agent)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const handleFocus = (e) => Object.assign(e.target.style, focusStyle)
  const handleBlur = (e) => { e.target.style.borderColor = blurStyle }

  return (
    <div style={s.page}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Schibsted+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        @keyframes adminFadeUp {
          from { opacity: 0; transform: translateY(18px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .admin-auth-btn:hover:not(:disabled) { background: #F7D070 !important; }
        .admin-auth-btn:disabled { opacity: 0.55; cursor: default; }
      `}</style>

      <div style={s.wrapper}>
        {robotSvg}

        <h1 style={s.title}>
          DoAide <span style={s.titleAccent}>Realty</span>
        </h1>
        <p style={s.subtitle}>Internal staff sign-in</p>

        <div style={s.card}>
          <form onSubmit={submit}>
            <div style={s.fieldGroup}>
              <label style={s.label}>Phone or Email</label>
              <input
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="+919812345678 or you@homenex.in"
                autoFocus
                required
                style={s.input}
                onFocus={handleFocus}
                onBlur={handleBlur}
              />
            </div>

            <div style={s.fieldGroup}>
              <label style={s.label}>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                style={s.input}
                onFocus={handleFocus}
                onBlur={handleBlur}
              />
            </div>

            {error && <div style={s.error}>{error}</div>}

            <button
              type="submit"
              disabled={busy}
              className="admin-auth-btn"
              style={s.button}
            >
              {busy ? 'Signing in…' : 'Sign in →'}
            </button>
          </form>
        </div>

        <p style={s.footer}>
          A <a href="https://doaide.com" style={s.footerLink} target="_blank" rel="noopener noreferrer">DoAide</a> product
        </p>
      </div>
    </div>
  )
}
