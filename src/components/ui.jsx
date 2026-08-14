// Small shared UI primitives for the dashboard tabs.
import { useState, useCallback, useEffect, useId, Component } from 'react'
import { friendlyMessage } from '../lib/friendlyError.js'

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
  // Trimmed before the empty check: a name that is only whitespace (a contact saved
  // from a WhatsApp profile that is just a space) is as nameless as a null one, and
  // splitting it yields empty words — a blank circle instead of the '?' fallback.
  const initials =
    String(name ?? '')
      .trim()
      .split(/\s+/)
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '?'
  return (
    <span
      className={`shrink-0 w-11 h-11 rounded-full bg-brand-wash text-brand-deep font-display font-bold text-[15px] flex items-center justify-center ${className}`}
    >
      {initials}
    </span>
  )
}

// Escape closes any of the overlays below. Every one of them is dismissable by
// tapping the backdrop, which a keyboard has no way to reach — so without this the
// only way out of an open sheet without a mouse was to reload the app.
function useEscape(onClose) {
  useEffect(() => {
    // Overlays are rendered in unit tests that don't install the browser shim, so
    // there isn't always a document to listen on.
    if (!onClose || typeof document === 'undefined' || !document.addEventListener) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
}

// Right-hand slide-over panel (same pattern the old LeadDetail used).
export function SlideOver({ onClose, label = 'Details', children }) {
  useEscape(onClose)
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-ink/50 backdrop-blur-[2px]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="absolute right-0 top-0 bottom-0 w-full max-w-[440px] bg-cream shadow-float slide-in overflow-y-auto no-scrollbar"
      >
        {children}
      </div>
    </div>
  )
}

// Bottom sheet for quick pickers/forms.
export function Sheet({ onClose, title, children }) {
  useEscape(onClose)
  const titleId = useId()
  return (
    <div className="fixed inset-0 z-[60]">
      <div className="absolute inset-0 bg-ink/50 backdrop-blur-[2px]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        {...(title ? { 'aria-labelledby': titleId } : { 'aria-label': 'Options' })}
        className="absolute bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[480px] bg-cream rounded-t-3xl shadow-float p-5 pb-[max(env(safe-area-inset-bottom),20px)] max-h-[85vh] overflow-y-auto no-scrollbar"
      >
        <div className="w-10 h-1 rounded-full bg-line mx-auto mb-4" />
        {title && <p id={titleId} className="font-display font-semibold text-[17px] text-ink mb-3">{title}</p>}
        {children}
      </div>
    </div>
  )
}

// `active` is a selection state, not styling — a screen reader has only the colour
// to go on otherwise. Left undefined for the chips that are plain buttons, so they
// aren't announced as toggles.
export function Chip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active === undefined ? undefined : Boolean(active)}
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

// Styled confirm dialog for destructive actions — replaces the browser's jarring
// window.confirm(), which is easy to mis-tap on a phone and doesn't match the app.
// The destructive button is red and the exact object is named in the title so an
// agent always knows what they're about to delete.
export function Confirm({ title, message, confirmLabel = 'Delete', cancelLabel = 'Cancel', danger = true, onConfirm, onCancel, busy = false }) {
  // Escape cancels, but never while the action is in flight — the dialog stays up
  // until the delete it is guarding actually resolves.
  useEscape(busy ? null : onCancel)
  const titleId = useId()
  const msgId = useId()
  return (
    <div className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-ink/50 backdrop-blur-[2px]" onClick={busy ? undefined : onCancel} />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={message ? msgId : undefined}
        className="relative w-full max-w-[420px] bg-cream rounded-t-3xl sm:rounded-3xl shadow-float p-5 pb-[max(env(safe-area-inset-bottom),20px)] slide-in"
      >
        <p id={titleId} className="font-display font-semibold text-[17px] text-ink">{title}</p>
        {message && <p id={msgId} className="text-[13px] text-ink-soft mt-1.5 leading-snug">{message}</p>}
        <div className="flex gap-2.5 mt-5">
          <button
            onClick={onCancel}
            disabled={busy}
            className="flex-1 rounded-xl py-2.5 text-[14px] font-bold bg-card text-ink-soft border border-line active:scale-95 transition disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className={`flex-1 rounded-xl py-2.5 text-[14px] font-bold text-white active:scale-95 transition disabled:opacity-60 ${
              danger ? 'bg-hot' : 'bg-brand'
            }`}
          >
            {busy ? 'Please wait…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// Hook that turns a destructive action into a two-step confirm without every screen
// wiring its own modal state. Usage:
//   const confirm = useConfirm()
//   ...
//   <button onClick={() => confirm({ title: 'Delete "X"?', onConfirm: doDelete })}>Delete</button>
//   {confirm.dialog}
export function useConfirm() {
  const [state, setState] = useState(null)
  const [busy, setBusy] = useState(false)
  const open = useCallback((opts) => setState(opts), [])
  const close = useCallback(() => {
    setState(null)
    setBusy(false)
  }, [])
  const run = useCallback(async () => {
    if (!state?.onConfirm) return close()
    try {
      setBusy(true)
      await state.onConfirm()
      close()
    } catch {
      // Leave the dialog open on failure; the calling screen surfaces the error.
      setBusy(false)
    }
  }, [state, close])

  const fn = useCallback((opts) => open(opts), [open])
  fn.dialog = state ? (
    <Confirm {...state} busy={busy} onConfirm={run} onCancel={close} />
  ) : null
  return fn
}

// Loading skeleton bars — shown while a list/detail is loading so the screen never
// flashes empty (which reads as "nothing here" instead of "loading").
export function Skeleton({ className = '' }) {
  return <div className={`animate-pulse bg-line/60 rounded-lg ${className}`} />
}

export function LoadingRows({ rows = 4 }) {
  return (
    <div className="space-y-2.5 px-1" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 bg-card border border-line rounded-2xl p-3">
          <Skeleton className="w-11 h-11 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-2.5 w-3/4" />
          </div>
        </div>
      ))}
    </div>
  )
}

// The banner a polled screen shows when its refresh stops coming back.
//
// Six screens each carried their own copy, and every copy said the same thing:
// "Can't reach the HomeNex server: " followed by the raw error message. It was
// wrong twice over. The server usually HAD been reached — a 500, an expired
// session, a 403 all arrived as an answer, and the sentence told the agent to go
// looking at their phone signal instead. And what followed the colon was whatever
// string the failure carried, which is exactly the "HTTP 500" and "Failed to fetch"
// that friendlyMessage exists to keep off an agent's screen. Both are fixed by
// letting friendlyMessage write the whole sentence, which it already knows how to
// do — including the offline case the old wording was guessing at.
//
// role="alert" is the accessibility half, and it is the half that matters most on a
// polled screen: these banners appear on their own, seconds after the agent stopped
// touching anything, over a list that still shows the last data that arrived.
// Without it the only signal that the screen has gone stale is a colour, and an
// agent reading the list aloud carries on trusting it.
export function ErrorBanner({ error, className = '' }) {
  if (!error) return null
  return (
    <p role="alert" className={`text-[12.5px] text-hot bg-amber-wash rounded-xl px-4 py-3 ${className}`}>
      {friendlyMessage(error)}
    </p>
  )
}

// What a full-screen detail panel (a lead, a property, a contact) shows before its
// subject has loaded. All three used to render a bare dimmed backdrop: indistinguishable
// from a panel that opened empty, and — if the request failed — permanent, with no
// error, no retry and nothing but a stray tap on the backdrop to escape it.
export function DetailOverlay({ error, onClose, onRetry }) {
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-ink/50 backdrop-blur-[2px]" onClick={onClose} />
      <div className="absolute right-0 top-0 bottom-0 w-full max-w-[440px] bg-cream shadow-float slide-in p-5">
        <button
          aria-label="Close"
          onClick={onClose}
          className="w-9 h-9 rounded-full bg-card border border-line flex items-center justify-center text-ink shadow-card active:scale-95 transition"
        >
          <span aria-hidden="true">←</span>
        </button>
        {error ? (
          <div role="alert" className="mt-8 text-center px-4">
            <p className="font-display font-semibold text-[16px] text-ink">Couldn't load this</p>
            <p className="text-[12.5px] text-ink-soft leading-snug mt-1.5">{error.message}</p>
            {onRetry && (
              <button
                onClick={onRetry}
                className="mt-4 rounded-xl px-5 py-2.5 text-[13.5px] font-bold text-white bg-brand active:scale-95 transition"
              >
                Try again
              </button>
            )}
          </div>
        ) : (
          <div className="mt-6 space-y-3" aria-busy="true" aria-label="Loading">
            <div className="flex items-center gap-3">
              <Skeleton className="w-11 h-11 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-2/5" />
                <Skeleton className="h-2.5 w-3/5" />
              </div>
            </div>
            <Skeleton className="h-24 w-full rounded-2xl" />
            <Skeleton className="h-32 w-full rounded-2xl" />
          </div>
        )}
      </div>
    </div>
  )
}

// Error boundary: a rendering crash shows a friendly recovery card instead of a blank
// white screen, and the agent can retry without losing the whole session.
//
// Two shapes. The default fills the phone frame and is the last line of defence at the
// root. `compact` fills only the screen area, so a crash inside one tab leaves the
// bottom nav alive and the agent can simply move to another tab — remounting the
// boundary and clearing the failure — instead of reloading the app and losing their
// place. The root boundary still catches anything that escapes the compact one.
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(err, info) {
    console.error('UI crash caught by ErrorBoundary:', err, info?.componentStack)
  }
  render() {
    if (!this.state.failed) return this.props.children
    const compact = this.props.compact
    return (
      <div
        role="alert"
        className={
          compact
            ? 'flex flex-col items-center justify-center text-center px-8 gap-3 py-20'
            : 'phone flex flex-col items-center justify-center text-center px-8 gap-3'
        }
      >
        <div className="text-4xl" aria-hidden="true">
          🙏
        </div>
        <p className="font-display font-semibold text-[17px] text-ink">Something went wrong</p>
        <p className="text-[13px] text-ink-soft leading-snug">
          {compact
            ? 'This screen hit an unexpected problem. Your data is safe — try another tab, or reload.'
            : 'The app hit an unexpected problem. Your data is safe — please reload to continue.'}
        </p>
        <button
          onClick={() => window.location.reload()}
          className="mt-2 rounded-xl px-5 py-2.5 text-[14px] font-bold text-white bg-brand active:scale-95 transition"
        >
          Reload
        </button>
      </div>
    )
  }
}
