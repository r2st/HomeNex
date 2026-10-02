const robotSvg = (
  <svg viewBox="0 0 400 320" style={{ width: 100, height: 80 }} aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#F0B429"/><stop offset="100%" stopColor="#D4A017"/></linearGradient></defs>
    <line x1="200" y1="45" x2="200" y2="20" stroke="#F0B429" strokeWidth="6" strokeLinecap="round"/>
    <circle cx="200" cy="14" r="10" fill="#F0B429"/><circle cx="200" cy="14" r="5" fill="#F7CC5F"/>
    <rect x="110" y="50" width="180" height="140" rx="35" fill="url(#lg)"/>
    <rect x="130" y="68" width="140" height="105" rx="25" fill="#D4A017" opacity="0.4"/>
    <ellipse cx="165" cy="115" rx="18" ry="20" fill="#0A0A0B"/><ellipse cx="235" cy="115" rx="18" ry="20" fill="#0A0A0B"/>
    <circle cx="170" cy="113" r="8" fill="#F7CC5F"/><circle cx="240" cy="113" r="8" fill="#F7CC5F"/>
    <circle cx="174" cy="109" r="3" fill="white" opacity="0.7"/><circle cx="244" cy="109" r="3" fill="white" opacity="0.7"/>
    <path d="M170 155Q200 178 230 155" stroke="#0A0A0B" strokeWidth="4" fill="none" strokeLinecap="round"/>
    <rect x="92" y="95" width="22" height="45" rx="8" fill="#D4A017"/><rect x="286" y="95" width="22" height="45" rx="8" fill="#D4A017"/>
    <rect x="175" y="190" width="50" height="14" rx="5" fill="#D4A017"/>
    <rect x="145" y="204" width="110" height="55" rx="18" fill="url(#lg)"/>
    <circle cx="200" cy="228" r="7" fill="#0A0A0B"/><circle cx="200" cy="228" r="3.5" fill="#0A0A0B"/>
    <path d="M145 218Q118 223 113 240Q108 257 120 262" stroke="#D4A017" strokeWidth="9" fill="none" strokeLinecap="round"/><circle cx="120" cy="265" r="7" fill="#D4A017"/>
    <path d="M255 218Q282 223 287 240Q292 257 280 262" stroke="#D4A017" strokeWidth="9" fill="none" strokeLinecap="round"/><circle cx="280" cy="265" r="7" fill="#D4A017"/>
  </svg>
)

const features = [
  { icon: '💬', title: 'WhatsApp CRM', desc: 'Every lead conversation in one inbox — auto-replies in seconds' },
  { icon: '🏠', title: 'Property Matching', desc: 'AI matches buyers to listings from your inventory instantly' },
  { icon: '📊', title: 'Smart Follow-ups', desc: 'Never lose a lead — automated reminders and pipeline tracking' },
]

export default function LandingPage({ onLogin, onSignup }) {
  return (
    <div style={styles.page}>
      <style>{css}</style>

      <div style={styles.glow} aria-hidden="true" />

      <header className="lp-fade-in" style={styles.header}>
        <div className="lp-float" style={styles.robotWrap}>{robotSvg}</div>
        <h1 style={styles.title}>
          DoAide <span style={styles.accent}>Realty</span>
        </h1>
        <p className="lp-fade-in lp-d1" style={styles.subtitle}>
          AI-powered WhatsApp CRM for Indian real estate agents
        </p>
      </header>

      <section className="lp-slide-up lp-d2" style={styles.ctas}>
        <button onClick={onSignup} className="lp-btn-primary" style={styles.btnPrimary}>
          Get Started Free
        </button>
        <button onClick={onLogin} className="lp-btn-outline" style={styles.btnOutline}>
          Log In
        </button>
      </section>

      <section style={styles.features}>
        {features.map((f, i) => (
          <div key={f.title} className={`lp-slide-up lp-d${i + 3}`} style={styles.featureCard}>
            <span style={styles.featureIcon}>{f.icon}</span>
            <h3 style={styles.featureTitle}>{f.title}</h3>
            <p style={styles.featureDesc}>{f.desc}</p>
          </div>
        ))}
      </section>

      <p className="lp-fade-in lp-d6" style={styles.tagline}>
        Your leads, answered in seconds
      </p>

      <footer className="lp-fade-in lp-d7" style={styles.footer}>
        <div style={styles.footerNav}>
          <a href="https://desk.doaide.com" style={styles.footerLink} target="_blank" rel="noopener noreferrer">Desk</a>
          <a href="https://herald.doaide.com" style={styles.footerLink} target="_blank" rel="noopener noreferrer">Herald</a>
          <a href="https://409.doaide.com" style={styles.footerLink} target="_blank" rel="noopener noreferrer">409A</a>
          <a href="https://job.doaide.com" style={styles.footerLink} target="_blank" rel="noopener noreferrer">AutoApply</a>
          <span style={{ ...styles.footerLink, color: '#F0B429' }}>Realty</span>
        </div>
        <p style={styles.footerCopy}>
          &copy; {new Date().getFullYear()}{' '}
          <a href="https://doaide.com" style={styles.footerCopyLink} target="_blank" rel="noopener noreferrer">DoAide</a>
          {' '}&middot; AI tools for small businesses
        </p>
      </footer>
    </div>
  )
}

const css = `
  @keyframes lpFadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes lpSlideUp {
    from { opacity: 0; transform: translateY(28px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes lpFloat {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-8px); }
  }
  @keyframes lpGlow {
    0%, 100% { opacity: 0.35; transform: scale(1); }
    50% { opacity: 0.55; transform: scale(1.08); }
  }
  @keyframes lpShimmer {
    0% { background-position: -200% center; }
    100% { background-position: 200% center; }
  }
  .lp-fade-in {
    animation: lpFadeIn 0.8s cubic-bezier(0.2, 0.7, 0.2, 1) both;
  }
  .lp-slide-up {
    animation: lpSlideUp 0.7s cubic-bezier(0.2, 0.7, 0.2, 1) both;
  }
  .lp-float {
    animation: lpFloat 4s ease-in-out infinite;
  }
  .lp-d1 { animation-delay: 0.15s; }
  .lp-d2 { animation-delay: 0.3s; }
  .lp-d3 { animation-delay: 0.45s; }
  .lp-d4 { animation-delay: 0.55s; }
  .lp-d5 { animation-delay: 0.65s; }
  .lp-d6 { animation-delay: 0.8s; }
  .lp-d7 { animation-delay: 0.95s; }
  .lp-btn-primary:hover {
    background: #F7D070 !important;
    transform: translateY(-1px);
    box-shadow: 0 0 28px rgba(240, 180, 41, 0.3) !important;
  }
  .lp-btn-primary:active { transform: translateY(0); }
  .lp-btn-outline:hover {
    border-color: rgba(240, 180, 41, 0.6) !important;
    color: #F0B429 !important;
    background: rgba(240, 180, 41, 0.06) !important;
  }
`

const styles = {
  page: {
    minHeight: '100dvh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    background: '#0A0A0B',
    padding: '0 20px',
    position: 'relative',
    overflow: 'hidden',
  },
  glow: {
    position: 'absolute',
    top: -120,
    left: '50%',
    transform: 'translateX(-50%)',
    width: 480,
    height: 480,
    borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(240,180,41,0.12) 0%, transparent 70%)',
    animation: 'lpGlow 6s ease-in-out infinite',
    pointerEvents: 'none',
  },
  header: {
    textAlign: 'center',
    paddingTop: 'clamp(48px, 12vh, 100px)',
    position: 'relative',
    zIndex: 1,
  },
  robotWrap: {
    marginBottom: 20,
  },
  title: {
    fontFamily: "'Instrument Serif', Georgia, serif",
    fontSize: 'clamp(36px, 8vw, 52px)',
    fontWeight: 400,
    color: '#fff',
    margin: 0,
    lineHeight: 1.1,
  },
  accent: {
    fontStyle: 'italic',
    color: '#F0B429',
  },
  subtitle: {
    fontFamily: "'Schibsted Grotesk', system-ui, sans-serif",
    fontSize: 'clamp(14px, 3.5vw, 17px)',
    color: 'rgba(255,255,255,0.5)',
    margin: '12px 0 0',
    maxWidth: 360,
    lineHeight: 1.5,
  },
  ctas: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    width: '100%',
    maxWidth: 320,
    marginTop: 36,
    position: 'relative',
    zIndex: 1,
  },
  btnPrimary: {
    width: '100%',
    background: '#F0B429',
    color: '#0A0A0B',
    border: 'none',
    borderRadius: 10,
    padding: '14px 24px',
    fontSize: 15,
    fontWeight: 700,
    fontFamily: "'Schibsted Grotesk', system-ui, sans-serif",
    cursor: 'pointer',
    transition: 'all 200ms ease',
    boxShadow: '0 0 20px rgba(240,180,41,0.15)',
  },
  btnOutline: {
    width: '100%',
    background: 'transparent',
    color: 'rgba(255,255,255,0.7)',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: 10,
    padding: '13px 24px',
    fontSize: 15,
    fontWeight: 600,
    fontFamily: "'Schibsted Grotesk', system-ui, sans-serif",
    cursor: 'pointer',
    transition: 'all 200ms ease',
  },
  features: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
    gap: 16,
    width: '100%',
    maxWidth: 800,
    marginTop: 48,
    position: 'relative',
    zIndex: 1,
  },
  featureCard: {
    background: 'rgba(26,26,29,0.6)',
    backdropFilter: 'blur(8px)',
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: 12,
    padding: '20px 18px',
    textAlign: 'center',
  },
  featureIcon: {
    fontSize: 28,
    display: 'block',
    marginBottom: 10,
  },
  featureTitle: {
    fontFamily: "'Schibsted Grotesk', system-ui, sans-serif",
    fontSize: 15,
    fontWeight: 700,
    color: '#fff',
    margin: '0 0 6px',
  },
  featureDesc: {
    fontFamily: "'Schibsted Grotesk', system-ui, sans-serif",
    fontSize: 13,
    color: 'rgba(255,255,255,0.45)',
    margin: 0,
    lineHeight: 1.5,
  },
  tagline: {
    fontFamily: "'Instrument Serif', Georgia, serif",
    fontStyle: 'italic',
    fontSize: 'clamp(16px, 4vw, 20px)',
    color: 'rgba(240,180,41,0.5)',
    marginTop: 40,
    textAlign: 'center',
  },
  footer: {
    marginTop: 'auto',
    paddingTop: 32,
    paddingBottom: 28,
    textAlign: 'center',
    width: '100%',
  },
  footerNav: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: '0 16px',
    fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, monospace",
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: '0.14em',
    marginBottom: 10,
  },
  footerLink: {
    color: 'rgba(255,255,255,0.2)',
    textDecoration: 'none',
    transition: 'color 150ms ease',
  },
  footerCopy: {
    fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, monospace",
    fontSize: 10,
    color: 'rgba(255,255,255,0.2)',
    letterSpacing: '0.04em',
    margin: 0,
  },
  footerCopyLink: {
    color: 'rgba(255,255,255,0.2)',
    textDecoration: 'none',
  },
}
