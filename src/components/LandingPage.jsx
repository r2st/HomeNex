import { useEffect, useState, useRef } from 'react'
import { api, setToken } from '../api.js'
import '../landing.css'

const DOAIDE_PRODUCTS = [
  { name: 'Desk', url: 'https://desk.doaide.com' },
  { name: 'Jobs', url: 'https://job.doaide.com' },
  { name: '409A', url: 'https://409a.doaide.com' },
  { name: 'GST', url: 'https://gst.doaide.com' },
  { name: 'Pulse', url: 'https://pulse.doaide.com' },
  { name: 'Med', url: 'https://med.doaide.com' },
  { name: 'Realty', url: 'https://realty.doaide.com' },
  { name: 'Reach', url: 'https://reach.doaide.com' },
  { name: 'Trade', url: 'https://trade.doaide.com' },
  { name: 'Cortex', url: 'https://cortex.doaide.com' },
]

const TYPEWRITER_PHRASES = [
  'WhatsApp-native CRM',
  'Smart lead capture',
  'Automated follow-ups',
  'AI property matching',
]

const RobotFace = ({ size = 28 }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
    <line x1="16" y1="6" x2="16" y2="2" stroke="#F0B429" strokeWidth="1.5" strokeLinecap="round"/>
    <circle cx="16" cy="1.5" r="1.5" fill="#F0B429"/>
    <rect x="5" y="6" width="22" height="17" rx="5" fill="#F0B429"/>
    <ellipse cx="11" cy="13" rx="2.5" ry="3" fill="#0A0A0B"/>
    <ellipse cx="21" cy="13" rx="2.5" ry="3" fill="#0A0A0B"/>
    <circle cx="11.5" cy="12.5" r="1" fill="#F7CC5F"/>
    <circle cx="21.5" cy="12.5" r="1" fill="#F7CC5F"/>
    <path d="M12 19Q16 22 20 19" stroke="#0A0A0B" strokeWidth="1.2" fill="none" strokeLinecap="round"/>
    <rect x="1" y="10" width="4" height="5" rx="2" fill="#D4A017"/>
    <rect x="27" y="10" width="4" height="5" rx="2" fill="#D4A017"/>
  </svg>
)

const HeroRobot = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 100" width="120" height="100" className="landing-hero-robot" aria-hidden="true">
    <defs>
      <linearGradient id="robot-gold" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#F0B429"/>
        <stop offset="100%" stopColor="#F7CC5F"/>
      </linearGradient>
    </defs>
    <line x1="60" y1="18" x2="60" y2="6" stroke="#F0B429" strokeWidth="2.5" strokeLinecap="round"/>
    <circle cx="60" cy="4" r="3" fill="#F7CC5F" className="landing-antenna-glow"/>
    <rect x="25" y="18" width="70" height="55" rx="16" fill="url(#robot-gold)"/>
    <ellipse cx="42" cy="40" rx="8" ry="10" fill="#0A0A0B"/>
    <ellipse cx="78" cy="40" rx="8" ry="10" fill="#0A0A0B"/>
    <circle cx="44" cy="38" r="3" fill="#F7CC5F" opacity="0.7"/>
    <circle cx="80" cy="38" r="3" fill="#F7CC5F" opacity="0.7"/>
    <path d="M45 60 Q60 72 75 60" stroke="#0A0A0B" strokeWidth="2.5" fill="none" strokeLinecap="round"/>
    <rect x="5" y="30" width="16" height="18" rx="6" fill="#D4A017"/>
    <rect x="99" y="30" width="16" height="18" rx="6" fill="#D4A017"/>
  </svg>
)

function TypewriterCycle() {
  const [phraseIdx, setPhraseIdx] = useState(0)
  const [charIdx, setCharIdx] = useState(0)
  const [deleting, setDeleting] = useState(false)
  const [progress, setProgress] = useState(0)
  const timerRef = useRef(null)

  useEffect(() => {
    const phrase = TYPEWRITER_PHRASES[phraseIdx]
    if (!deleting) {
      if (charIdx < phrase.length) {
        timerRef.current = setTimeout(() => setCharIdx(charIdx + 1), 60)
      } else {
        setProgress(((phraseIdx + 1) / TYPEWRITER_PHRASES.length) * 100)
        timerRef.current = setTimeout(() => setDeleting(true), 2000)
      }
    } else {
      if (charIdx > 0) {
        timerRef.current = setTimeout(() => setCharIdx(charIdx - 1), 30)
      } else {
        setDeleting(false)
        setPhraseIdx((phraseIdx + 1) % TYPEWRITER_PHRASES.length)
      }
    }
    return () => clearTimeout(timerRef.current)
  }, [charIdx, deleting, phraseIdx])

  const displayed = TYPEWRITER_PHRASES[phraseIdx].slice(0, charIdx)

  return (
    <div className="landing-value-cycle">
      <div className="landing-value-text" aria-live="polite" aria-label={displayed}>
        <span className="landing-value-typed">{displayed}</span>
        <span className="landing-value-cursor" />
      </div>
      <div className="landing-value-track">
        <div className="landing-value-progress" style={{ width: `${progress}%` }} />
      </div>
      <div className="landing-value-dots">
        {TYPEWRITER_PHRASES.map((_, i) => (
          <span key={i} className={`landing-value-dot${i === phraseIdx ? ' landing-value-dot-active' : ''}`} />
        ))}
      </div>
    </div>
  )
}

function Particles() {
  return (
    <div className="landing-particles">
      {Array.from({ length: 10 }, (_, i) => (
        <div key={i} className="landing-particle" />
      ))}
    </div>
  )
}

function AuthForm({ onAuthed }) {
  const [mode, setMode] = useState('login')
  const [form, setForm] = useState({ name: '', cc: '+91', phone: '', password: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [showPassword, setShowPassword] = useState(false)
  const [resetStep, setResetStep] = useState(null)
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

  return (
    <div className="landing-auth-card">
      <div className="landing-mobile-brand">
        <RobotFace size={24} />
        <span className="landing-brand-text">Do<em>Aide</em> Realty</span>
      </div>

      {!resetStep && (
        <div className="landing-tabs">
          <button
            type="button"
            className={`landing-tab${mode === 'login' ? ' landing-tab-active' : ''}`}
            onClick={() => { setMode('login'); setError(null) }}
          >
            Sign in
          </button>
          <button
            type="button"
            className={`landing-tab${mode === 'signup' ? ' landing-tab-active' : ''}`}
            onClick={() => { setMode('signup'); setError(null) }}
          >
            Create account
          </button>
        </div>
      )}

      <div className="landing-form-area">
        {resetStep === 'phone' && (
          <form onSubmit={requestResetCode} noValidate>
            <p className="landing-form-hint">
              Enter the WhatsApp number you signed up with. We'll send a 6-digit code to reset your password.
            </p>
            <div className="landing-field">
              <label className="landing-label">WhatsApp Number</label>
              <div className="landing-phone-row">
                <input
                  type="text"
                  inputMode="tel"
                  value={resetData.cc}
                  onChange={(e) => { const d = e.target.value.replace(/\D/g, '').slice(0, 4); setResetData((s) => ({ ...s, cc: '+' + d })) }}
                  placeholder="+91"
                  aria-label="Country code"
                  required
                  className="landing-input landing-cc-input"
                />
                <input
                  type="tel"
                  inputMode="numeric"
                  value={resetData.phone}
                  onChange={(e) => setResetData((s) => ({ ...s, phone: e.target.value.replace(/\D/g, '').slice(0, 12) }))}
                  aria-label="Phone number"
                  placeholder="98xxx xxxxx"
                  required
                  className="landing-input landing-phone-input"
                />
              </div>
            </div>
            {error && <p className="landing-error">{error}</p>}
            <button type="submit" disabled={busy} className="landing-submit-btn">
              {busy ? 'Sending…' : 'Send reset code'}
            </button>
            <button type="button" onClick={() => { setResetStep(null); setError(null) }} className="landing-toggle-btn">
              ← Back to sign in
            </button>
          </form>
        )}

        {resetStep === 'code' && (
          <form onSubmit={submitReset} noValidate>
            <p className="landing-form-hint">
              We sent a 6-digit code to your WhatsApp. Enter it below with your new password.
            </p>
            <div className="landing-field">
              <label className="landing-label">Reset Code</label>
              <input
                type="text"
                inputMode="numeric"
                value={resetData.code}
                onChange={(e) => setResetData((s) => ({ ...s, code: e.target.value.replace(/\D/g, '').slice(0, 6) }))}
                placeholder="6-digit code"
                autoComplete="one-time-code"
                required
                className="landing-input landing-code-input"
              />
            </div>
            <div className="landing-field">
              <label className="landing-label">New Password</label>
              <div className="landing-pw-wrap">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={resetData.newPassword}
                  onChange={(e) => setResetData((s) => ({ ...s, newPassword: e.target.value }))}
                  placeholder="At least 6 characters"
                  autoComplete="new-password"
                  required
                  className="landing-input"
                />
                <button type="button" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? 'Hide password' : 'Show password'} className="landing-eye-btn">
                  {showPassword ? '●' : '○'}
                </button>
              </div>
            </div>
            {error && <p className="landing-error">{error}</p>}
            <button type="submit" disabled={busy} className="landing-submit-btn">
              {busy ? 'Resetting…' : 'Set new password'}
            </button>
            <button type="button" onClick={() => { setResetStep('phone'); setError(null) }} className="landing-toggle-btn">
              ← Send a new code
            </button>
          </form>
        )}

        {!resetStep && (
          <form onSubmit={submit} noValidate>
            {mode === 'signup' && (
              <div className="landing-field">
                <label className="landing-label">Your Name <span className="landing-req">*</span></label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
                  placeholder="Rajesh Kumar"
                  autoComplete="name"
                  required
                  className="landing-input"
                />
              </div>
            )}

            <div className="landing-field">
              <label className="landing-label">WhatsApp Business Number <span className="landing-req">*</span></label>
              <div className="landing-phone-row">
                <input
                  type="text"
                  inputMode="tel"
                  list="country-codes"
                  value={form.cc}
                  onChange={(e) => setCc(e.target.value)}
                  placeholder="+91"
                  aria-label="Country code"
                  required
                  className="landing-input landing-cc-input"
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
                  className="landing-input landing-phone-input"
                />
              </div>
            </div>

            <div className="landing-field">
              <label className="landing-label">Password <span className="landing-req">*</span></label>
              <div className="landing-pw-wrap">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={form.password}
                  onChange={(e) => setForm((s) => ({ ...s, password: e.target.value }))}
                  placeholder={mode === 'signup' ? 'At least 6 characters' : '••••••••••'}
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  required
                  className="landing-input"
                />
                <button type="button" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? 'Hide password' : 'Show password'} className="landing-eye-btn">
                  {showPassword ? '●' : '○'}
                </button>
              </div>
            </div>

            {mode === 'login' && (
              <div className="landing-forgot-row">
                <button
                  type="button"
                  onClick={() => { setResetStep('phone'); setError(null); setResetData((s) => ({ ...s, cc: form.cc, phone: form.phone })) }}
                  className="landing-forgot-btn"
                >
                  Forgot password?
                </button>
              </div>
            )}

            {error && <p className="landing-error">{error}</p>}

            <button type="submit" disabled={busy} className="landing-submit-btn">
              {busy ? 'One moment…' : mode === 'signup' ? 'Create my dashboard' : 'Sign in'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

export default function LandingPage({ onAuthed }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 0)
    const id = raf(() => setVisible(true))
    return () => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout)(id)
  }, [])

  return (
    <div className="landing-root">
      <div className="landing-bg">
        <div className="landing-orb landing-orb-1" />
        <div className="landing-orb landing-orb-2" />
        <div className="landing-orb landing-orb-3" />
      </div>

      <div className="landing-split">
        <div className={`landing-left${visible ? ' landing-visible' : ''}`}>
          <Particles />

          <div className="landing-left-inner">
            <a href="https://doaide.com" className="landing-brand" target="_blank" rel="noopener noreferrer">
              <RobotFace size={28} />
              <span className="landing-brand-text">Do<em>Aide</em> Realty</span>
            </a>

            <div className="landing-hero-area">
              <div className="landing-hero-robot-wrap">
                <div className="landing-hero-glow" />
                <HeroRobot />
              </div>
              <h1 className="landing-title">
                Real estate CRM,{'\n'}reimagined.
              </h1>
              <p className="landing-subtitle">
                WhatsApp-native client management for Indian real estate agents.
              </p>
            </div>

            <TypewriterCycle />

            <footer className="landing-footer">
              <div className="landing-footer-products">
                {DOAIDE_PRODUCTS.map((p) => (
                  <a key={p.name} href={p.url} className="landing-footer-link" target="_blank" rel="noopener noreferrer">
                    {p.name}
                  </a>
                ))}
              </div>
              <div className="landing-footer-bottom">
                <a href="https://doaide.com" className="landing-footer-home" target="_blank" rel="noopener noreferrer">
                  <RobotFace size={14} />
                  doaide.com
                </a>
                <span className="landing-footer-copy">&copy; {new Date().getFullYear()} DoAide</span>
              </div>
            </footer>
          </div>
        </div>

        <div className={`landing-right${visible ? ' landing-visible' : ''}`}>
          <AuthForm onAuthed={onAuthed} />
        </div>
      </div>
    </div>
  )
}
