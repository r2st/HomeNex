import { SUGGESTIONS, ACTIVITY } from '../data.js'

const KPIS = [
  { label: 'New leads today', value: '7', accent: false },
  { label: 'Hot right now', value: '2', accent: true },
  { label: 'Site visits weekend', value: '4', accent: false },
  { label: 'Pipeline value', value: '₹6.8 Cr', accent: false },
]

const DOT = {
  hot: 'bg-hot',
  ai: 'bg-brand',
  calendar: 'bg-amber',
  network: 'bg-gold',
  lead: 'bg-ink-faint',
}

export default function TodayTab({ onGoTo }) {
  return (
    <div className="px-5 pt-7">
      <header className="rise">
        <p className="text-[11px] font-bold tracking-[0.18em] text-ink-faint uppercase">
          Thursday, 3 July · Pune
        </p>
        <h1 className="font-display text-[30px] font-semibold text-ink mt-1 leading-tight">
          Good evening, Rajesh
        </h1>
        <p className="text-[13.5px] text-ink-soft mt-1.5 leading-snug">
          HomeNex handled <strong className="text-brand-deep">7 conversations</strong> while you
          were at site visits today
        </p>
      </header>

      <div className="grid grid-cols-2 gap-2.5 mt-5">
        {KPIS.map((k, i) => (
          <div
            key={k.label}
            className={`rounded-2xl px-4 py-3.5 shadow-card border rise rise-${i + 1} ${
              k.accent
                ? 'bg-amber-wash border-amber/30'
                : 'bg-card border-line'
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

      <section className="mt-7 rise rise-3">
        <p className="text-[11px] font-bold tracking-[0.18em] text-brand">
          HOMENEX SUGGESTS <span className="text-ink-faint font-semibold tracking-normal">— Needs your attention</span>
        </p>
        <div className="space-y-2.5 mt-3">
          {SUGGESTIONS.map((s) => (
            <div key={s.title} className="bg-card rounded-2xl border border-line shadow-card px-4 py-4">
              <div className="flex items-start gap-3">
                <span className="text-[20px] leading-none mt-0.5">{s.icon}</span>
                <div className="min-w-0">
                  <p className="font-bold text-[14px] text-ink leading-snug">{s.title}</p>
                  <p className="text-[12.5px] text-ink-soft leading-snug mt-1">{s.body}</p>
                  <button
                    className={`mt-2.5 text-[12.5px] font-bold rounded-full px-3.5 py-1.5 transition active:scale-95 ${
                      s.urgent
                        ? 'bg-brand text-white'
                        : 'bg-brand-wash text-brand-deep'
                    }`}
                  >
                    {s.cta} →
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <button
        onClick={() => onGoTo('network')}
        className="w-full text-left mt-6 rounded-2xl bg-gradient-to-br from-brand-deep to-brand px-4 py-4 shadow-float rise rise-4 active:scale-[0.99] transition"
      >
        <div className="flex items-center gap-3">
          <span className="text-[22px]">🤝</span>
          <div className="min-w-0 flex-1">
            <p className="text-white font-bold text-[14px]">Co-broke match found on the network</p>
            <p className="text-white/80 text-[12.5px] leading-snug mt-0.5">
              Your buyer Vikram ↔ Meera Joshi's exclusive Koregaon Park villa. 94% match.
            </p>
          </div>
          <span className="text-white/90 text-lg">→</span>
        </div>
      </button>

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
          {ACTIVITY.map((a, i) => (
            <div key={i} className="flex items-start gap-3 px-4 py-3">
              <span className={`shrink-0 w-1.5 h-1.5 rounded-full mt-[7px] ${DOT[a.type]}`} />
              <p className="text-[12.5px] text-ink leading-snug flex-1">{a.text}</p>
              <span className="shrink-0 text-[11px] text-ink-faint font-medium tabular-nums">{a.time}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
