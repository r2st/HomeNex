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

const styles = {
  page: {
    minHeight: '100dvh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0A0A0B',
    padding: '24px 16px',
  },
  wrapper: {
    width: '100%',
    maxWidth: 380,
    animation: 'authFadeUp 0.5s cubic-bezier(0.2,0.7,0.2,1) both',
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
    fontFamily: "'Schibsted Grotesk', system-ui, sans-serif",
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
  phoneRow: {
    display: 'flex',
    gap: 8,
  },
  ccInput: {
    width: 72,
    flexShrink: 0,
    background: 'rgba(10,10,11,0.6)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 8,
    padding: '10px 10px',
    fontSize: 14,
    fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, monospace",
    color: '#fff',
    outline: 'none',
    textAlign: 'center',
    fontWeight: 600,
    boxSizing: 'border-box',
    transition: 'border-color 150ms ease',
  },
  phoneInput: {
    flex: 1,
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
  toggle: {
    display: 'block',
    background: 'none',
    border: 'none',
    fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, monospace",
    fontSize: 11,
    color: 'rgba(255,255,255,0.35)',
    textAlign: 'center',
    cursor: 'pointer',
    marginTop: 20,
    padding: 0,
    letterSpacing: '0.04em',
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
  hint: {
    fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, monospace",
    fontSize: 10,
    color: 'rgba(255,255,255,0.25)',
    marginTop: 6,
  },
  passwordWrap: {
    position: 'relative',
  },
  eyeBtn: {
    position: 'absolute',
    right: 10,
    top: '50%',
    transform: 'translateY(-50%)',
    background: 'none',
    border: 'none',
    color: 'rgba(255,255,255,0.35)',
    cursor: 'pointer',
    fontSize: 16,
    padding: 4,
    lineHeight: 1,
  },
}

const focusStyle = { borderColor: 'rgba(240,180,41,0.5)' }

export default function AuthScreen({ onAuthed }) {
  const [mode, setMode] = useState('signup')
  const [form, setForm] = useState({ name: '', cc: '+91', phone: '', password: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [showPassword, setShowPassword] = useState(false)

  const setCc = (v) => {
    const digits = v.replace(/\D/g, '').slice(0, 4)
    setForm((s) => ({ ...s, cc: '+' + digits }))
  }
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

  const handleFocus = (e) => Object.assign(e.target.style, focusStyle)
  const handleBlur = (e) => { e.target.style.borderColor = 'rgba(255,255,255,0.12)' }

  return (
    <div style={styles.page}>
      <style>{`
        @keyframes authFadeUp {
          from { opacity: 0; transform: translateY(18px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .doaide-auth-btn:hover:not(:disabled) { background: #F7D070 !important; }
        .doaide-auth-btn:disabled { opacity: 0.55; cursor: default; }
        .doaide-auth-toggle:hover { color: rgba(255,255,255,0.55) !important; }
      `}</style>

      <div style={styles.wrapper}>
        {robotSvg}

        <h1 style={styles.title}>
          DoAide <span style={styles.titleAccent}>HomeNex</span>
        </h1>
        <p style={styles.subtitle}>AI-powered CRM for Indian real estate agents</p>

        <div style={styles.card}>
          <form onSubmit={submit}>
            {mode === 'signup' && (
              <div style={styles.fieldGroup}>
                <label style={styles.label}>Your Name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
                  placeholder="Rajesh Kumar"
                  autoComplete="name"
                  required
                  style={styles.input}
                  onFocus={handleFocus}
                  onBlur={handleBlur}
                />
              </div>
            )}

            <div style={styles.fieldGroup}>
              <label style={styles.label}>WhatsApp Business Number</label>
              <div style={styles.phoneRow}>
                <input
                  type="text"
                  inputMode="tel"
                  list="country-codes"
                  value={form.cc}
                  onChange={(e) => setCc(e.target.value)}
                  placeholder="+91"
                  aria-label="Country code"
                  required
                  style={styles.ccInput}
                  onFocus={handleFocus}
                  onBlur={handleBlur}
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
                  aria-label="Phone number"
                  placeholder="98xxx xxxxx"
                  autoComplete="tel-national"
                  required
                  style={styles.phoneInput}
                  onFocus={handleFocus}
                  onBlur={handleBlur}
                />
              </div>
              <p style={styles.hint}>
                The WhatsApp Business number buyers message — also used as your login.
              </p>
            </div>

            <div style={styles.fieldGroup}>
              <label style={styles.label}>Password</label>
              <div style={styles.passwordWrap}>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={form.password}
                  onChange={(e) => setForm((s) => ({ ...s, password: e.target.value }))}
                  placeholder={mode === 'signup' ? 'At least 6 characters' : '••••••••'}
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  required
                  style={{ ...styles.input, paddingRight: 40 }}
                  onFocus={handleFocus}
                  onBlur={handleBlur}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  style={styles.eyeBtn}
                >
                  {showPassword ? '●' : '○'}
                </button>
              </div>
            </div>

            {error && <p style={styles.error}>{error}</p>}

            <button
              type="submit"
              disabled={busy}
              className="doaide-auth-btn"
              style={styles.button}
            >
              {busy ? 'One moment…' : mode === 'signup' ? 'Create my dashboard →' : 'Log in →'}
            </button>
          </form>

          <button
            onClick={() => { setMode(mode === 'signup' ? 'login' : 'signup'); setError(null) }}
            className="doaide-auth-toggle"
            style={styles.toggle}
          >
            {mode === 'signup' ? 'Already have an account? Log in' : 'New here? Create an account'}
          </button>
        </div>

        <p style={styles.footer}>
          A <a href="https://doaide.com" style={styles.footerLink} target="_blank" rel="noopener noreferrer">DoAide</a> product
        </p>
      </div>
    </div>
  )
}
