import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { InfoTip } from './ui.jsx'
import { glossary } from '../lib/glossary.js'

// Card that surfaces the agent's WhatsApp Business number so they can share it.
// If the agent hasn't configured their own number, shows a setup prompt instead.
// `compact` collapses it to a small "WhatsApp connected" chip (used on Home, where
// the full card previously dominated the screen); the full setup lives in Settings.
export default function ShareNumberCard({ agent, compact = false }) {
  const [copied, setCopied] = useState(false)
  const [showSetup, setShowSetup] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [form, setForm] = useState({ wa_phone_number: '', wa_phone_number_id: '' })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
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

  const saveConfig = async (e) => {
    e.preventDefault()
    if (saving) return
    setSaving(true)
    setSaveError(null)
    try {
      const updated = await api.updatePhoneConfig({
        wa_phone_number: form.wa_phone_number || null,
        wa_phone_number_id: form.wa_phone_number_id || null,
      })
      setConfig({ wa_phone_number: updated.wa_phone_number, wa_phone_number_id: updated.wa_phone_number_id })
      setShowSetup(false)
    } catch (err) {
      setSaveError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const openSetup = () => {
    setForm({
      wa_phone_number: config?.wa_phone_number || '',
      wa_phone_number_id: config?.wa_phone_number_id || '',
    })
    setShowSetup(true)
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
            <p className="text-[12px] text-ink-soft leading-relaxed">
              Share this number with your clients. When they message it, HomeNex recognises them
              and their qualified lead appears on Home.
            </p>
            <div className="flex items-center gap-2 mt-3">
              <span className="font-display text-[18px] font-bold text-ink tabular-nums flex-1 truncate">{waNumber}</span>
              <button
                onClick={copy}
                className="shrink-0 text-[12px] font-bold rounded-full px-3.5 py-1.5 transition active:scale-95 bg-ink/5 text-ink-soft"
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

  if (showSetup) {
    return (
      <section className="mt-6 bg-card rounded-2xl border border-line shadow-card p-5 rise rise-2">
        <div className="flex items-center gap-2">
          <span className="text-[18px] leading-none">+</span>
          <p className="text-[11px] font-bold tracking-[0.18em] text-brand">CONFIGURE YOUR WHATSAPP NUMBER</p>
        </div>
        <p className="text-[12.5px] text-ink-soft leading-relaxed mt-2">
          Enter your WhatsApp Business number and its Meta phone_number_id from the
          Meta developer dashboard.
        </p>
        <form onSubmit={saveConfig} className="mt-3.5 space-y-3">
          <input
            type="tel"
            value={form.wa_phone_number}
            onChange={(e) => setForm((s) => ({ ...s, wa_phone_number: e.target.value }))}
            placeholder="WhatsApp number, e.g. +919812345678"
            className="w-full bg-white border border-line rounded-xl px-3.5 py-2.5 text-[13px] outline-none focus:border-brand/60"
          />
          <input
            type="text"
            value={form.wa_phone_number_id}
            onChange={(e) => setForm((s) => ({ ...s, wa_phone_number_id: e.target.value }))}
            placeholder="Meta phone_number_id"
            className="w-full bg-white border border-line rounded-xl px-3.5 py-2.5 text-[13px] outline-none focus:border-brand/60"
          />
          {saveError && (
            <p className="text-[12px] text-hot bg-amber-wash rounded-xl px-3.5 py-2.5">{saveError}</p>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={saving}
              className="flex-1 bg-brand text-white font-bold text-[13px] rounded-full py-2.5 shadow-card active:scale-[0.99] transition disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => { setShowSetup(false); setSaveError(null) }}
              className="px-4 text-[13px] font-bold text-ink-soft rounded-full py-2.5 bg-ink/5 active:scale-[0.99] transition"
            >
              Cancel
            </button>
          </div>
        </form>
      </section>
    )
  }

  if (!waNumber) {
    return (
      <section className="mt-6 bg-card rounded-2xl border border-line shadow-card p-5 rise rise-2">
        <div className="flex items-center gap-2">
          <span className="text-[18px] leading-none">+</span>
          <p className="text-[11px] font-bold tracking-[0.18em] text-brand">SET UP YOUR WHATSAPP NUMBER</p>
        </div>
        <p className="text-[12.5px] text-ink-soft leading-relaxed mt-2">
          Configure your own WhatsApp Business number so clients message you directly
          and HomeNex qualifies every lead automatically.
        </p>
        <button
          onClick={openSetup}
          className="mt-3 flex items-center justify-center gap-2 w-full rounded-full bg-brand text-white font-bold text-[13.5px] py-2.5 shadow-card active:scale-[0.99] transition"
        >
          Configure number
        </button>
      </section>
    )
  }

  return (
    <section className="mt-6 bg-card rounded-2xl border border-line shadow-card p-5 rise rise-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[18px] leading-none">+</span>
          <p className="text-[11px] font-bold tracking-[0.18em] text-brand">YOUR WHATSAPP BUSINESS NUMBER</p>
        </div>
        <button onClick={openSetup} className="text-[11px] font-semibold text-ink-faint underline underline-offset-2">
          Edit
        </button>
      </div>
      <p className="text-[12.5px] text-ink-soft leading-relaxed mt-2">
        Share this number with your clients. When they message it, HomeNex recognises them
        and their qualified lead appears right here.
      </p>
      <div className="flex items-center gap-2 mt-3.5">
        <span className="font-display text-[19px] font-bold text-ink tabular-nums flex-1 truncate">{waNumber}</span>
        <button
          onClick={copy}
          className="shrink-0 text-[12px] font-bold rounded-full px-3.5 py-1.5 transition active:scale-95 bg-ink/5 text-ink-soft"
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
