import { useState } from 'react'
import { api, setToken } from '../api.js'

const robotSvg = (
  <svg viewBox="0 0 400 320" style={{ width: 80, height: 64, margin: '0 auto 20px', display: 'block' }} aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="hg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#F0B429"/><stop offset="100%" stopColor="#D4A017"/></linearGradient></defs>
    <line x1="200" y1="45" x2="200" y2="20" stroke="#F0B429" strokeWidth="6" strokeLinecap="round"/>
    <circle cx="200" cy="14" r="10" fill="#F0B429"/><circle cx="200" cy="14" r="5" fill="#F7CC5F"/>
    <rect x="110" y="50" width="180" height="140" rx="35" fill="url(#hg)"/>
    <rect x="130" y="68" width="140" height="105" rx="25" fill="#D4A017" opacity="0.4"/>
    <ellipse cx="165" cy="115" rx="18" ry="20" fill="#0A0A0B"/><ellipse cx="235" cy="115" rx="18" ry="20" fill="#0A0A0B"/>
    <circle cx="170" cy="113" r="8" fill="#F7CC5F"/><circle cx="240" cy="113" r="8" fill="#F7CC5F"/>
    <circle cx="174" cy="109" r="3" fill="white" opacity="0.7"/><circle cx="244" cy="109" r="3" fill="white" opacity="0.7"/>
    <path d="M170 155Q200 178 230 155" stroke="#0A0A0B" strokeWidth="4" fill="none" strokeLinecap="round"/>
    <rect x="92" y="95" width="22" height="45" rx="8" fill="#D4A017"/><rect x="286" y="95" width="22" height="45" rx="8" fill="#D4A017"/>
    <rect x="175" y="190" width="50" height="14" rx="5" fill="#D4A017"/>
    <rect x="145" y="204" width="110" height="55" rx="18" fill="url(#hg)"/>
    <circle cx="200" cy="228" r="7" fill="#0A0A0B"/><circle cx="200" cy="228" r="3.5" fill="#0A0A0B"/>
    <path d="M145 218Q118 223 113 240Q108 257 120 262" stroke="#D4A017" strokeWidth="9" fill="none" strokeLinecap="round"/><circle cx="120" cy="265" r="7" fill="#D4A017"/>
    <path d="M255 218Q282 223 287 240Q292 257 280 262" stroke="#D4A017" strokeWidth="9" fill="none" strokeLinecap="round"/><circle cx="280" cy="265" r="7" fill="#D4A017"/>
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
  const [resetStep, setResetStep] = useState(null) // null | 'phone' | 'code' | 'done'
  const [resetData, setResetData] = useState({ cc: '+91', phone: '', code: '', newPassword: '', agentId: null })

  const setCc = (v) => {
    const digits = v.replace(/\D/g, '').slice(0, 4)
    setForm((s) => ({ ...s, cc: '+' + digits }))
  }
  const setPhone = (v) => setForm((s) => ({ ...s, phone: v.replace(/\D/g, '').slice(0, 12) }))

  const requestResetCode = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const phone = (resetData.cc || '+91') + resetData.phone
      const { agentId } = await api.requestReset({ phone })
      setResetData((s) => ({ ...s, agentId }))
      setResetStep('code')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const submitReset = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const { token, agent } = await api.resetPassword({
        agentId: resetData.agentId,
        code: resetData.code,
        newPassword: resetData.newPassword,
      })
      setToken(token)
      onAuthed(agent)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

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
        <p style={styles.subtitle}>Your leads, answered in seconds</p>

        <div style={styles.card}>
          {resetStep === 'phone' && (
            <form onSubmit={requestResetCode}>
              <p style={{ ...styles.label, fontSize: 12, letterSpacing: '0.06em', marginBottom: 16, textTransform: 'none', color: 'rgba(255,255,255,0.5)' }}>
                Enter the WhatsApp number you signed up with. We'll send a 6-digit code to reset your password.
              </p>
              <div style={styles.fieldGroup}>
                <label style={styles.label}>WhatsApp Number</label>
                <div style={styles.phoneRow}>
                  <input
                    type="text"
                    inputMode="tel"
                    value={resetData.cc}
                    onChange={(e) => { const d = e.target.value.replace(/\D/g, '').slice(0, 4); setResetData((s) => ({ ...s, cc: '+' + d })) }}
                    placeholder="+91"
                    aria-label="Country code"
                    required
                    style={styles.ccInput}
                    onFocus={handleFocus}
                    onBlur={handleBlur}
                  />
                  <input
                    type="tel"
                    inputMode="numeric"
                    value={resetData.phone}
                    onChange={(e) => setResetData((s) => ({ ...s, phone: e.target.value.replace(/\D/g, '').slice(0, 12) }))}
                    aria-label="Phone number"
                    placeholder="98xxx xxxxx"
                    required
                    style={styles.phoneInput}
                    onFocus={handleFocus}
                    onBlur={handleBlur}
                  />
                </div>
              </div>
              {error && <p style={styles.error}>{error}</p>}
              <button type="submit" disabled={busy} className="doaide-auth-btn" style={styles.button}>
                {busy ? 'Sending…' : 'Send reset code →'}
              </button>
              <button type="button" onClick={() => { setResetStep(null); setError(null) }} className="doaide-auth-toggle" style={styles.toggle}>
                ← Back to login
              </button>
            </form>
          )}

          {resetStep === 'code' && (
            <form onSubmit={submitReset}>
              <p style={{ ...styles.label, fontSize: 12, letterSpacing: '0.06em', marginBottom: 16, textTransform: 'none', color: 'rgba(255,255,255,0.5)' }}>
                We sent a 6-digit code to your WhatsApp. Enter it below with your new password.
              </p>
              <div style={styles.fieldGroup}>
                <label style={styles.label}>Reset Code</label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={resetData.code}
                  onChange={(e) => setResetData((s) => ({ ...s, code: e.target.value.replace(/\D/g, '').slice(0, 6) }))}
                  placeholder="6-digit code"
                  autoComplete="one-time-code"
                  required
                  style={{ ...styles.input, textAlign: 'center', fontSize: 20, letterSpacing: '0.3em', fontWeight: 600 }}
                  onFocus={handleFocus}
                  onBlur={handleBlur}
                />
              </div>
              <div style={styles.fieldGroup}>
                <label style={styles.label}>New Password</label>
                <div style={styles.passwordWrap}>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={resetData.newPassword}
                    onChange={(e) => setResetData((s) => ({ ...s, newPassword: e.target.value }))}
                    placeholder="At least 6 characters"
                    autoComplete="new-password"
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
              <button type="submit" disabled={busy} className="doaide-auth-btn" style={styles.button}>
                {busy ? 'Resetting…' : 'Set new password →'}
              </button>
              <button type="button" onClick={() => { setResetStep('phone'); setError(null) }} className="doaide-auth-toggle" style={styles.toggle}>
                ← Send a new code
              </button>
            </form>
          )}

          {!resetStep && <><form onSubmit={submit}>
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

          {mode === 'login' && (
            <button
              onClick={() => { setResetStep('phone'); setError(null); setResetData((s) => ({ ...s, cc: form.cc, phone: form.phone })) }}
              className="doaide-auth-toggle"
              style={{ ...styles.toggle, marginTop: 12 }}
            >
              Forgot password?
            </button>
          )}

          <button
            onClick={() => { setMode(mode === 'signup' ? 'login' : 'signup'); setError(null) }}
            className="doaide-auth-toggle"
            style={styles.toggle}
          >
            {mode === 'signup' ? 'Already have an account? Log in' : 'New here? Create an account'}
          </button>
          </>}
        </div>

        <p style={styles.footer}>
          A <a href="https://doaide.com" style={styles.footerLink} target="_blank" rel="noopener noreferrer">DoAide</a> product
        </p>
      </div>
    </div>
  )
}
