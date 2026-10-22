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

function PipelineViz() {
  const stages = [
    { label: 'Capture', icon: 'M7 4v16M17 4v16M3 8h4M13 8h8M3 12h18M3 16h4M13 16h8' },
    { label: 'Qualify', icon: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5' },
    { label: 'Nurture', icon: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z' },
    { label: 'Close', icon: 'M22 11.08V12a10 10 0 11-5.93-9.14M22 4L12 14.01l-3-3' },
  ]

  const nodeW = 80
  const nodeH = 52
  const gap = 34
  const totalW = stages.length * nodeW + (stages.length - 1) * gap
  const svgW = totalW + 20
  const svgH = nodeH + 36
  const y = 18

  return (
    <div className="landing-pipeline" aria-label="Lead pipeline: Capture, Qualify, Nurture, Close">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={`0 0 ${svgW} ${svgH}`}
        className="landing-pipeline-svg"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="pipe-gold" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#F0B429"/>
            <stop offset="100%" stopColor="#F7CC5F"/>
          </linearGradient>
          <filter id="pipe-glow">
            <feGaussianBlur stdDeviation="3" result="blur"/>
            <feMerge>
              <feMergeNode in="blur"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>
          <radialGradient id="dot-glow">
            <stop offset="0%" stopColor="#F0B429" stopOpacity="1"/>
            <stop offset="100%" stopColor="#F0B429" stopOpacity="0"/>
          </radialGradient>
        </defs>

        {stages.map((stage, i) => {
          const x = 10 + i * (nodeW + gap)
          const cx = x + nodeW / 2
          const cy = y + nodeH / 2

          return (
            <g key={stage.label}>
              {i < stages.length - 1 && (
                <>
                  <line
                    x1={x + nodeW}
                    y1={cy}
                    x2={x + nodeW + gap}
                    y2={cy}
                    stroke="rgba(13,148,136,0.15)"
                    strokeWidth="1"
                  />
                  <circle r="2.5" fill="url(#pipe-gold)" filter="url(#pipe-glow)" className={`landing-pipe-dot landing-pipe-dot-${i}`}>
                    <animateMotion
                      dur="2s"
                      repeatCount="indefinite"
                      begin={`${i * 0.5}s`}
                      path={`M${x + nodeW},${cy} L${x + nodeW + gap},${cy}`}
                    />
                  </circle>
                  <circle r="5" fill="url(#dot-glow)" opacity="0.4" className={`landing-pipe-dot landing-pipe-dot-${i}`}>
                    <animateMotion
                      dur="2s"
                      repeatCount="indefinite"
                      begin={`${i * 0.5}s`}
                      path={`M${x + nodeW},${cy} L${x + nodeW + gap},${cy}`}
                    />
                  </circle>
                </>
              )}

              <rect
                x={x}
                y={y}
                width={nodeW}
                height={nodeH}
                rx="12"
                fill="rgba(16,16,18,0.8)"
                stroke="rgba(13,148,136,0.2)"
                strokeWidth="1"
                className="landing-pipe-node"
                style={{ animationDelay: `${i * 0.12}s` }}
              />

              <g transform={`translate(${cx},${cy - 6})`}>
                <g transform="translate(-9,-9) scale(0.75)" stroke="#F0B429" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round">
                  <path d={stage.icon}/>
                </g>
              </g>

              <text
                x={cx}
                y={cy + 17}
                textAnchor="middle"
                fill="rgba(255,255,255,0.5)"
                fontSize="9"
                fontFamily="'IBM Plex Mono', monospace"
                fontWeight="500"
                letterSpacing="0.04em"
              >
                {stage.label}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

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
  const [form, setForm] = useState({ name: '', email: '', password: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [showPassword, setShowPassword] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const payload = {
        email: form.email.trim(),
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
        <span className="landing-brand-text">DoAide <em>Realty</em></span>
      </div>

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

      <div className="landing-form-area">
        <form onSubmit={submit} noValidate>
          {mode === 'signup' && (
            <div className="landing-field">
              <label className="landing-label" htmlFor="landing-name">Your Name <span className="landing-req">*</span></label>
              <input
                id="landing-name"
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
            <label className="landing-label" htmlFor="landing-email">Email <span className="landing-req">*</span></label>
            <input
              id="landing-email"
              type="email"
              inputMode="email"
              value={form.email}
              onChange={(e) => setForm((s) => ({ ...s, email: e.target.value }))}
              placeholder="you@example.com"
              autoComplete="email"
              required
              className="landing-input"
            />
          </div>

          <div className="landing-field">
            <label className="landing-label" htmlFor="landing-password">Password <span className="landing-req">*</span></label>
            <div className="landing-pw-wrap">
              <input
                id="landing-password"
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

          {error && <p className="landing-error">{error}</p>}

          <button type="submit" disabled={busy} className="landing-submit-btn">
            {busy ? 'One moment…' : mode === 'signup' ? 'Create my dashboard' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}

export default function LandingPage({ onAuthed }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    // Handle SSO callback token from URL query param
    const params = new URLSearchParams(window.location.search)
    const ssoToken = params.get('sso_token')
    if (ssoToken) {
      setToken(ssoToken)
      window.history.replaceState({}, '', '/')
      api.me().then(onAuthed).catch(() => setToken(null))
      return
    }
  }, [onAuthed])

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
              <span className="landing-brand-text">DoAide <em>Realty</em></span>
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

            <PipelineViz />
            <TypewriterCycle />

            <footer className="landing-footer landing-footer-desktop">
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

        <footer className="landing-footer landing-footer-mobile">
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
  )
}
