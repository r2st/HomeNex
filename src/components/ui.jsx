// Small shared UI primitives for the dashboard tabs.
import { useState } from 'react'

// Tappable ⓘ that reveals a one-sentence plain-language explanation. Used to
// demystify jargon (RERA, WhatsApp Business / WABA) for first-time agents without
// cluttering the layout. `label` is optional text shown next to the icon.
export function InfoTip({ text, label, className = '', align = 'center' }) {
  const [open, setOpen] = useState(false)
  const pos =
    align === 'right'
      ? 'right-0'
      : align === 'left'
        ? 'left-0'
        : 'left-1/2 -translate-x-1/2'
  // Rendered as a role="button" span (not a <button>) so it can be safely nested
  // inside the card/list buttons where jargon like RERA appears.
  const toggle = (e) => {
    e.stopPropagation()
    e.preventDefault()
    setOpen((v) => !v)
  }
  return (
    <span className={`relative inline-flex items-center ${className}`}>
      <span
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') toggle(e)
        }}
        aria-label={label ? `What is ${label}?` : 'More info'}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-ink-faint active:scale-90 transition cursor-pointer"
      >
        {label && <span className="text-[11px] font-bold">{label}</span>}
        <span className="w-[15px] h-[15px] rounded-full border border-current text-[10px] font-bold leading-none flex items-center justify-center">
          i
        </span>
      </span>
      {open && (
        <>
          <span className="fixed inset-0 z-[70]" onClick={(e) => { e.stopPropagation(); setOpen(false) }} />
          <span
            role="tooltip"
            className={`absolute ${pos} top-[120%] z-[71] w-52 max-w-[78vw] bg-ink text-cream text-[11.5px] leading-snug font-medium rounded-xl px-3 py-2 shadow-float`}
          >
            {text}
          </span>
        </>
      )}
    </span>
  )
}

export function ScoreRing({ score, size = 44 }) {
  const r = (size - 6) / 2
  const c = 2 * Math.PI * r
  const color = score >= 80 ? 'var(--color-hot)' : score >= 55 ? 'var(--color-brand)' : 'var(--color-ink-faint)'
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-line)" strokeWidth="4" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - (score || 0) / 100)}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center font-display font-bold text-[13px]" style={{ color }}>
        {score ?? '–'}
      </span>
    </div>
  )
}

export const TEMP_STYLE = {
  Hot: 'bg-amber-wash text-hot border-amber/40',
  Warm: 'bg-brand-wash text-brand-deep border-brand/30',
  Cold: 'bg-cream text-ink-faint border-line',
}

export function Avatar({ name, className = '' }) {
  const initials = String(name || '?')
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
  return (
    <span
      className={`shrink-0 w-11 h-11 rounded-full bg-brand-wash text-brand-deep font-display font-bold text-[15px] flex items-center justify-center ${className}`}
    >
      {initials}
    </span>
  )
}

// Right-hand slide-over panel (same pattern the old LeadDetail used).
export function SlideOver({ onClose, children }) {
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-ink/50 backdrop-blur-[2px]" onClick={onClose} />
      <div className="absolute right-0 top-0 bottom-0 w-full max-w-[440px] bg-cream shadow-float slide-in overflow-y-auto no-scrollbar">
        {children}
      </div>
    </div>
  )
}

// Bottom sheet for quick pickers/forms.
export function Sheet({ onClose, title, children }) {
  return (
    <div className="fixed inset-0 z-[60]">
      <div className="absolute inset-0 bg-ink/50 backdrop-blur-[2px]" onClick={onClose} />
      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[480px] bg-cream rounded-t-3xl shadow-float p-5 pb-[max(env(safe-area-inset-bottom),20px)] max-h-[85vh] overflow-y-auto no-scrollbar">
        <div className="w-10 h-1 rounded-full bg-line mx-auto mb-4" />
        {title && <p className="font-display font-semibold text-[17px] text-ink mb-3">{title}</p>}
        {children}
      </div>
    </div>
  )
}

export function Chip({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 text-[12.5px] font-bold rounded-full px-3.5 py-1.5 border transition active:scale-95 ${
        active ? 'bg-ink text-cream border-ink' : 'bg-card text-ink-soft border-line'
      }`}
    >
      {children}
    </button>
  )
}

export const inputCls =
  'w-full bg-white border border-line rounded-xl px-3.5 py-2.5 text-[13px] outline-none focus:border-brand/60'

export function Field({ label, children }) {
  return (
    <label className="block">
      <span className="block text-[11.5px] font-bold text-ink-soft mb-1">{label}</span>
      {children}
    </label>
  )
}
