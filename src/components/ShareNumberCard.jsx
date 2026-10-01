import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { InfoTip } from './ui.jsx'
import { glossary } from '../lib/glossary.js'

// Card that surfaces the agent's WhatsApp Business number so they can share it.
// Setup is done *for* the agent by the HomeNex support team (they register the
// number with Meta) — the agent never touches a developer dashboard or pastes a
// technical id. So this card only ever displays the connected number + Share
// actions, or a friendly "being set up" message while support finishes.
// `compact` collapses it to a small "WhatsApp connected" chip (used on Home).
export default function ShareNumberCard({ agent, compact = false }) {
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [config, setConfig] = useState(null)

  useEffect(() => {
    api.phoneConfig().then(setConfig).catch(() => {})
  }, [])

  const waNumber = config?.wa_phone_number || agent?.wa_phone_number
  const waDigits = waNumber ? waNumber.replace(/\D/g, '') : null
  const waLink = waDigits ? `https://wa.me/${waDigits}` : null

  const copy = async () => {
    if (!waNumber) return
    try {
      await navigator.clipboard.writeText(waNumber)
    } catch {
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  // Compact chip for Home: once a number is connected, don't dominate the screen —
  // show a small confirmation with an on-demand Share panel. No number → render
  // nothing (the onboarding banner + Settings handle first-time setup).
  if (compact) {
    if (!waNumber) return null
    return (
      <section className="mt-5 rise rise-1">
        <div className="flex items-center gap-2 bg-brand-wash border border-brand/20 rounded-2xl px-4 py-2.5">
          <span className="w-2 h-2 rounded-full bg-brand shrink-0" />
          <p className="text-[12.5px] font-bold text-brand-deep">WhatsApp connected</p>
          <InfoTip label="" text={glossary.WABA} />
          <span className="text-[12px] text-ink-soft tabular-nums truncate">{waNumber}</span>
          <button
            onClick={() => setExpanded((v) => !v)}
            className="ml-auto shrink-0 text-[11.5px] font-bold text-brand active:scale-95 transition"
          >
            Share {expanded ? '▴' : '▾'}
          </button>
        </div>
        {expanded && (
          <div className="mt-2 bg-card rounded-2xl border border-line shadow-card p-4">
            <p className="text-[12px] text-ink-soft">
              Share with clients — messages auto-capture as qualified leads.
            </p>
            <div className="flex items-center gap-2 mt-3">
              <span className="font-display text-[18px] font-bold text-ink tabular-nums flex-1 truncate">{waNumber}</span>
              <button
                onClick={copy}
                className="shrink-0 text-[12px] font-bold rounded-full px-3.5 py-1.5 transition active:scale-95 bg-[#222225] text-ink-soft"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            {waLink && (
              <a
                href={waLink}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 flex items-center justify-center gap-2 w-full rounded-full bg-[#25D366] text-white font-bold text-[13px] py-2.5 shadow-card active:scale-[0.99] transition"
              >
                Open in WhatsApp
              </a>
            )}
          </div>
        )}
      </section>
    )
  }

  // No number yet — support is still connecting it. Reassure, don't ask the agent to
  // configure anything technical themselves.
  if (!waNumber) {
    return (
      <section className="mt-6 bg-card rounded-2xl border border-line shadow-card p-5 rise rise-2">
        <div className="flex items-center gap-2">
          <span className="text-[18px] leading-none">🟡</span>
          <p className="text-[11px] font-bold tracking-[0.18em] text-brand">WHATSAPP NUMBER BEING SET UP</p>
        </div>
        <p className="text-[12.5px] text-ink-soft mt-2">
          Your WhatsApp number is being connected. You'll be notified when it's live.
        </p>
      </section>
    )
  }

  return (
    <section className="mt-6 bg-card rounded-2xl border border-line shadow-card p-5 rise rise-2">
      <div className="flex items-center gap-2">
        <span className="text-[18px] leading-none">+</span>
        <p className="text-[11px] font-bold tracking-[0.18em] text-brand">YOUR WHATSAPP BUSINESS NUMBER</p>
        <InfoTip label="" text={glossary.WABA} />
      </div>
      <p className="text-[12.5px] text-ink-soft mt-2">
        Share with clients — messages auto-capture as qualified leads.
      </p>
      <div className="flex items-center gap-2 mt-3.5">
        <span className="font-display text-[19px] font-bold text-ink tabular-nums flex-1 truncate">{waNumber}</span>
        <button
          onClick={copy}
          className="shrink-0 text-[12px] font-bold rounded-full px-3.5 py-1.5 transition active:scale-95 bg-[#222225] text-ink-soft"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {waLink && (
        <a
          href={waLink}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 flex items-center justify-center gap-2 w-full rounded-full bg-[#25D366] text-white font-bold text-[13.5px] py-2.5 shadow-card active:scale-[0.99] transition"
        >
          <span className="text-[16px] leading-none">+</span>
          Open in WhatsApp
        </a>
      )}
    </section>
  )
}
