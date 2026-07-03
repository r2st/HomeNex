import { INSIGHT_WEEKS, LEAD_SOURCES } from '../data.js'

const KPIS = [
  { label: 'Avg first response', value: '38s', sub: 'was 4.3 hrs before', accent: true },
  { label: 'Leads qualified', value: '58%', sub: 'of all enquiries', accent: false },
  { label: 'After-hours leads saved', value: '31', sub: 'this month', accent: false },
  { label: 'Closings GCI', value: '₹18.4 L', sub: 'last 90 days', accent: false },
]

export default function InsightsTab() {
  const max = Math.max(...INSIGHT_WEEKS.map((w) => w.before))

  return (
    <div className="px-5 pt-7">
      <header className="rise">
        <h1 className="font-display text-[28px] font-semibold text-ink">Your numbers with HomeNex</h1>
        <p className="text-[13px] text-ink-soft mt-0.5">June 2026 · Kumar Realty, Pune</p>
      </header>

      <div className="grid grid-cols-2 gap-2.5 mt-5">
        {KPIS.map((k, i) => (
          <div
            key={k.label}
            className={`rounded-2xl px-4 py-3.5 border shadow-card rise rise-${i + 1} ${
              k.accent ? 'bg-brand-deep border-brand-deep' : 'bg-card border-line'
            }`}
          >
            <p className={`font-display text-[25px] font-bold leading-none ${k.accent ? 'text-white' : 'text-ink'}`}>
              {k.value}
            </p>
            <p className={`text-[11.5px] font-semibold mt-1.5 ${k.accent ? 'text-white/90' : 'text-ink-soft'}`}>
              {k.label}
            </p>
            <p className={`text-[10.5px] mt-0.5 ${k.accent ? 'text-white/60' : 'text-ink-faint'}`}>{k.sub}</p>
          </div>
        ))}
      </div>

      <section className="mt-7 bg-card rounded-2xl border border-line shadow-card p-4 rise rise-3">
        <p className="text-[11px] font-bold tracking-[0.18em] text-ink">
          FIRST-RESPONSE TIME <span className="text-ink-faint font-semibold tracking-normal">— week by week</span>
        </p>
        <div className="flex items-end justify-between gap-3 h-36 mt-5 px-1">
          {INSIGHT_WEEKS.map((w, i) => (
            <div key={w.week} className="flex-1 flex flex-col items-center gap-1.5">
              <div className="w-full flex items-end justify-center gap-1.5 h-28">
                <div
                  className="w-4 rounded-t-md bg-line grow-col"
                  style={{ height: `${(w.before / max) * 100}%`, animationDelay: `${i * 0.08}s` }}
                  title={`Before: ${Math.round(w.before / 60)}h avg`}
                />
                <div
                  className="w-4 rounded-t-md bg-brand grow-col"
                  style={{ height: `${Math.max((w.after / max) * 100, 4)}%`, animationDelay: `${0.1 + i * 0.08}s` }}
                  title={`With HomeNex: ${w.after}s`}
                />
              </div>
              <span className="text-[10.5px] font-bold text-ink-faint">{w.week}</span>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-4 mt-3 pt-3 border-t border-line">
          <span className="flex items-center gap-1.5 text-[11px] text-ink-soft font-semibold">
            <span className="w-2.5 h-2.5 rounded-sm bg-line inline-block" /> Before (avg 4+ hrs)
          </span>
          <span className="flex items-center gap-1.5 text-[11px] text-ink-soft font-semibold">
            <span className="w-2.5 h-2.5 rounded-sm bg-brand inline-block" /> With HomeNex (seconds)
          </span>
        </div>
      </section>

      <section className="mt-5 bg-card rounded-2xl border border-line shadow-card p-4 rise rise-4 mb-4">
        <p className="text-[11px] font-bold tracking-[0.18em] text-ink">
          LEADS BY SOURCE <span className="text-ink-faint font-semibold tracking-normal">— this month</span>
        </p>
        <div className="space-y-3 mt-4">
          {LEAD_SOURCES.map((s, i) => (
            <div key={s.name}>
              <div className="flex justify-between text-[12px] mb-1">
                <span className="font-semibold text-ink">{s.name}</span>
                <span className="font-bold text-ink-soft tabular-nums">
                  {s.count} <span className="text-ink-faint font-medium">({s.pct}%)</span>
                </span>
              </div>
              <div className="h-2 rounded-full bg-cream border border-line overflow-hidden">
                <div
                  className="h-full rounded-full grow-bar"
                  style={{
                    width: `${s.pct * 2.4}%`,
                    background: i === 0 ? 'var(--color-amber)' : 'var(--color-brand)',
                    animationDelay: `${0.1 + i * 0.07}s`,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
        <p className="text-[11.5px] text-ink-soft leading-snug mt-4 pt-3 border-t border-line">
          💡 <strong className="text-ink">HomeNex insight:</strong> 99acres leads convert 2.1× better
          after 6 PM — that's when HomeNex answers alone. Consider moving ad spend to evening slots.
        </p>
      </section>
    </div>
  )
}
