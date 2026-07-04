import { useEffect, useState } from 'react'
import { api, usePoll, fmtAgo } from '../api.js'

const DOT = {
  hot: 'bg-hot',
  ai: 'bg-brand',
  agent: 'bg-amber',
  lead: 'bg-ink-faint',
  error: 'bg-hot',
  msg: 'bg-ink-faint',
}

// Shared WhatsApp Business number that all clients message.
const WA_NUMBER = '+13652754408'
const WA_DIGITS = '13652754408'
const WA_LINK = `https://wa.me/${WA_DIGITS}`

// Card that surfaces the shared number so agents can hand it to their clients:
// a tap-to-open WhatsApp link plus a copy-to-clipboard button for the number.
function ShareNumberCard() {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(WA_NUMBER)
    } catch {
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <section className="mt-6 bg-card rounded-2xl border border-line shadow-card p-5 rise rise-2">
      <div className="flex items-center gap-2">
        <span className="text-[18px] leading-none">💬</span>
        <p className="text-[11px] font-bold tracking-[0.18em] text-brand">SHARE THIS NUMBER WITH YOUR CLIENTS</p>
      </div>
      <p className="text-[12.5px] text-ink-soft leading-relaxed mt-2">
        When a client messages this WhatsApp Business number, HomeNex recognises them and their
        qualified lead appears right here.
      </p>
      <div className="flex items-center gap-2 mt-3.5">
        <span className="font-display text-[19px] font-bold text-ink tabular-nums flex-1 truncate">{WA_NUMBER}</span>
        <button
          onClick={copy}
          className="shrink-0 text-[12px] font-bold rounded-full px-3.5 py-1.5 transition active:scale-95 bg-ink/5 text-ink-soft"
        >
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
      <a
        href={WA_LINK}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 flex items-center justify-center gap-2 w-full rounded-full bg-[#25D366] text-white font-bold text-[13.5px] py-2.5 shadow-card active:scale-[0.99] transition"
      >
        <span className="text-[16px] leading-none">💬</span>
        Open in WhatsApp
      </a>
    </section>
  )
}

function greeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

// Detect the user's city via the browser Geolocation API + OpenStreetMap reverse
// geocoding. Result is cached in localStorage so we don't re-request every load.
// Returns '' when geolocation is unavailable/denied — callers should hide the label.
function useCity() {
  const [city, setCity] = useState(() => {
    try {
      return localStorage.getItem('homenex.city') || ''
    } catch {
      return ''
    }
  })

  useEffect(() => {
    // Already resolved (from cache) or no geolocation support → nothing to do.
    if (city) return
    if (typeof navigator === 'undefined' || !navigator.geolocation) return

    let cancelled = false
    navigator.geolocation.getCurrentPosition(
      async ({ coords }) => {
        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${coords.latitude}&lon=${coords.longitude}&format=json`,
            { headers: { 'Accept-Language': 'en' } }
          )
          const data = await res.json()
          const a = data?.address || {}
          const name = a.city || a.town || a.village || a.county || a.state || ''
          if (name && !cancelled) {
            setCity(name)
            try {
              localStorage.setItem('homenex.city', name)
            } catch {}
          }
        } catch {
          // Reverse geocoding failed → leave the label hidden.
        }
      },
      () => {
        // Permission denied or position unavailable → leave the label hidden.
      },
      { timeout: 10000, maximumAge: 24 * 60 * 60 * 1000 }
    )

    return () => {
      cancelled = true
    }
  }, [city])

  return city
}

export default function TodayTab({ agent, onGoTo, onOpenConversation, onSignOut }) {
  const city = useCity()
  const { data: stats } = usePoll(api.stats, 6000)
  const { data: leads } = usePoll(api.leads, 6000)
  const { data: activity } = usePoll(api.activity, 6000)

  const kpis = stats && [
    { label: 'New leads today', value: String(stats.newToday), accent: false },
    { label: 'Hot right now', value: String(stats.hotNow), accent: stats.hotNow > 0 },
    { label: 'Messages today', value: String(stats.msgsToday), accent: false },
    {
      label: 'Pipeline value',
      value: stats.pipelineCr >= 1 ? `₹${stats.pipelineCr.toFixed(1)} Cr` : `₹${Math.round(stats.pipelineCr * 100)} L`,
      accent: false,
    },
  ]

  // Real attention queue: hot leads, and any lead whose last message is an unanswered buyer message.
  const attention = (leads || [])
    .filter((l) => l.temp === 'Hot' || l.last_role === 'buyer')
    .slice(0, 3)

  const empty = leads && leads.length === 0

  return (
    <div className="px-5 pt-7">
      <header className="rise">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-[11px] font-bold tracking-[0.18em] text-ink-faint uppercase">
            {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
            {city ? ` · ${city}` : ''}
          </p>
          <button onClick={onSignOut} className="text-[11px] font-semibold text-ink-faint underline underline-offset-2">
            Sign out
          </button>
        </div>
        <h1 className="font-display text-[30px] font-semibold text-ink mt-1 leading-tight">
          {greeting()}, {(agent?.name || '').split(/\s+/)[0] || 'there'}
        </h1>
        {stats && (
          <p className="text-[13.5px] text-ink-soft mt-1.5 leading-snug">
            {stats.total === 0 ? (
              <>HomeNex is live and waiting for your first WhatsApp lead</>
            ) : (
              <>
                HomeNex is working{' '}
                <strong className="text-brand-deep">{stats.active24h} active conversation{stats.active24h === 1 ? '' : 's'}</strong>{' '}
                for you
              </>
            )}
          </p>
        )}
      </header>

      {kpis && (
        <div className="grid grid-cols-2 gap-2.5 mt-5">
          {kpis.map((k, i) => (
            <div
              key={k.label}
              className={`rounded-2xl px-4 py-3.5 shadow-card border rise rise-${i + 1} ${
                k.accent ? 'bg-amber-wash border-amber/30' : 'bg-card border-line'
              }`}
            >
              <p className={`font-display text-[26px] font-bold leading-none ${k.accent ? 'text-hot' : 'text-ink'}`}>
                {k.value}
                {k.accent && <span className="text-[15px] ml-1">🔥</span>}
              </p>
              <p className="text-[11.5px] font-semibold text-ink-soft mt-1.5">{k.label}</p>
            </div>
          ))}
        </div>
      )}

      <ShareNumberCard />

      {empty && (
        <button
          onClick={() => onGoTo('clients')}
          className="w-full text-left mt-6 bg-card rounded-2xl border border-line shadow-card p-5 rise rise-2 active:scale-[0.99] transition"
        >
          <p className="text-[11px] font-bold tracking-[0.18em] text-brand mb-2">GET STARTED</p>
          <p className="font-bold text-[15px] text-ink">Add your clients' WhatsApp numbers</p>
          <p className="text-[12.5px] text-ink-soft leading-relaxed mt-2">
            HomeNex shares one WhatsApp Business number. Save a client's number and the moment
            they message it, HomeNex recognises them and their qualified lead appears right here.
          </p>
          <span className="inline-block mt-3 text-[12.5px] font-bold text-brand">Add clients →</span>
        </button>
      )}

      {attention.length > 0 && (
        <section className="mt-7 rise rise-3">
          <p className="text-[11px] font-bold tracking-[0.18em] text-brand">
            NEEDS YOUR ATTENTION
          </p>
          <div className="space-y-2.5 mt-3">
            {attention.map((l) => (
              <div key={l.id} className="bg-card rounded-2xl border border-line shadow-card px-4 py-4">
                <div className="flex items-start gap-3">
                  <span className="text-[20px] leading-none mt-0.5">{l.temp === 'Hot' ? '🔥' : '💬'}</span>
                  <div className="min-w-0 flex-1">
                    <p className="font-bold text-[14px] text-ink leading-snug">
                      {l.name || l.wa_id}
                      {l.temp === 'Hot' && <span className="text-hot"> · Hot ({l.score})</span>}
                    </p>
                    <p className="text-[12.5px] text-ink-soft leading-snug mt-1">
                      {l.last_role === 'buyer' ? 'Waiting on a reply: ' : 'Last: '}
                      “{(l.last_msg || '').slice(0, 90)}{(l.last_msg || '').length > 90 ? '…' : ''}”
                      {l.next_step ? ` — ${l.next_step}` : ''}
                    </p>
                    <button
                      onClick={() => onOpenConversation(l.id)}
                      className="mt-2.5 text-[12.5px] font-bold rounded-full px-3.5 py-1.5 transition active:scale-95 bg-brand text-white"
                    >
                      Act now →
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <button
        onClick={() => onGoTo('clients')}
        className="w-full text-left mt-6 rounded-2xl bg-gradient-to-br from-brand-deep to-brand px-4 py-4 shadow-float rise rise-4 active:scale-[0.99] transition"
      >
        <div className="flex items-center gap-3">
          <span className="text-[22px]">👥</span>
          <div className="min-w-0 flex-1">
            <p className="text-white font-bold text-[14px]">Your clients</p>
            <p className="text-white/80 text-[12.5px] leading-snug mt-0.5">
              Add clients' WhatsApp numbers so their messages route straight to you.
            </p>
          </div>
          <span className="text-white/90 text-lg">→</span>
        </div>
      </button>

      {activity && activity.length > 0 && (
        <section className="mt-7 rise rise-5">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-hot opacity-60 pulse-dot" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-hot" />
            </span>
            <p className="text-[11px] font-bold tracking-[0.18em] text-ink">
              LIVE <span className="text-ink-faint font-semibold tracking-normal">Activity</span>
            </p>
          </div>
          <div className="mt-3 bg-card rounded-2xl border border-line shadow-card divide-y divide-line">
            {activity.map((a) => (
              <div key={a.id} className="flex items-start gap-3 px-4 py-3">
                <span className={`shrink-0 w-1.5 h-1.5 rounded-full mt-[7px] ${DOT[a.kind] || 'bg-ink-faint'}`} />
                <p className="text-[12.5px] text-ink leading-snug flex-1">{a.text}</p>
                <span className="shrink-0 text-[11px] text-ink-faint font-medium tabular-nums">
                  {fmtAgo(a.created_at)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
