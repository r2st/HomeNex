import { api, usePoll } from '../api.js'
import { ErrorBanner } from './ui.jsx'

function fmtSeconds(s) {
  if (s == null) return '—'
  if (s < 60) return `${Math.round(s)}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${(s / 3600).toFixed(1)}h`
}

export default function InsightsTab() {
  const { data: stats, error } = usePoll(api.stats, 8000)

  // Only take over the screen when there is nothing to show. This polls every 8s, and
  // returning the error first meant one dropped request — a lift, a tunnel, a flaky
  // café Wi-Fi — replaced the whole charts screen with a red banner, then the next
  // poll put it back. Numbers that were correct 8 seconds ago are far more useful
  // than a blank page, so once data has loaded the failure becomes a strip above it.
  if (!stats)
    return (
      <div className="px-5 pt-7">
        {error ? (
          <ErrorBanner error={error} />
        ) : (
          <p className="text-center text-[13px] text-ink-faint pt-16" aria-busy="true">
            Loading…
          </p>
        )}
      </div>
    )

  const kpis = [
    { label: 'Avg first response', value: fmtSeconds(stats.avgFirstResponseS), sub: 'buyer message → first reply', accent: true },
    { label: 'Leads qualified', value: `${stats.qualifiedPct}%`, sub: 'budget, location, timeline & home type captured', accent: false },
    { label: 'After-hours leads', value: String(stats.afterHours), sub: 'arrived 9 PM – 9 AM', accent: false },
    { label: 'Total leads', value: String(stats.total), sub: 'all time', accent: false },
  ]

  const maxAvg = Math.max(...stats.daily.map((d) => d.avg_s || 0), 1)
  const maxSource = Math.max(...stats.sources.map((s) => s.count), 1)

  return (
    <div className="px-5 pt-7">
      <header className="rise">
        <h1 className="font-display text-[28px] font-semibold text-ink">Your numbers with DoAide Realty</h1>
        <p className="text-[13px] text-ink-soft mt-0.5">Computed live from your real conversations</p>
      </header>

      {/* role="status" and not "alert": the numbers on screen are still worth
          reading, so this is advice rather than an interruption. It is a live
          region all the same — it appears on its own, mid-poll, and without one
          nothing tells an agent reading the screen that the figures have stopped
          being current. */}
      {error && (
        <p role="status" className="mt-4 text-[12px] text-gold bg-amber-wash rounded-xl px-4 py-2.5">
          Showing the last numbers we could load — the server isn't answering right now.
        </p>
      )}

      <div className="grid grid-cols-2 gap-2.5 mt-5">
        {kpis.map((k, i) => (
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
          FIRST-RESPONSE TIME <span className="text-ink-faint font-semibold tracking-normal">— last 7 days</span>
        </p>
        {stats.daily.length === 0 ? (
          <p className="text-[12.5px] text-ink-soft mt-4">No leads in the last 7 days yet.</p>
        ) : (
          <>
            <div className="flex items-end justify-around gap-3 h-32 mt-5 px-1">
              {stats.daily.map((d, i) => (
                <div key={d.day} className="flex-1 flex flex-col items-center gap-1.5 max-w-[56px]">
                  <span className="text-[9.5px] font-bold text-brand-deep">{fmtSeconds(d.avg_s)}</span>
                  <div className="w-full flex items-end justify-center h-20">
                    <div
                      className="w-5 rounded-t-md bg-brand grow-col"
                      style={{ height: `${Math.max(((d.avg_s || 0) / maxAvg) * 100, 4)}%`, animationDelay: `${i * 0.08}s` }}
                      title={`${d.leads} lead(s)`}
                    />
                  </div>
                  <span className="text-[10px] font-bold text-ink-faint">
                    {new Date(d.day).toLocaleDateString('en-IN', { weekday: 'short' })}
                  </span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-ink-soft mt-3 pt-3 border-t border-line">
              Average time from a buyer's first message to the first reply, per day.
            </p>
          </>
        )}
      </section>

      <section className="mt-5 bg-card rounded-2xl border border-line shadow-card p-4 rise rise-4 mb-4">
        <p className="text-[11px] font-bold tracking-[0.18em] text-ink">
          LEADS BY SOURCE <span className="text-ink-faint font-semibold tracking-normal">— all time</span>
        </p>
        {stats.sources.length === 0 ? (
          <p className="text-[12.5px] text-ink-soft mt-4 mb-1">No leads yet.</p>
        ) : (
          <div className="space-y-3 mt-4">
            {stats.sources.map((s, i) => (
              <div key={s.name}>
                <div className="flex justify-between text-[12px] mb-1">
                  <span className="font-semibold text-ink">{s.name}</span>
                  <span className="font-bold text-ink-soft tabular-nums">
                    {s.count} <span className="text-ink-faint font-medium">({Math.round((s.count / stats.total) * 100)}%)</span>
                  </span>
                </div>
                <div className="h-2 rounded-full bg-[#111113] border border-line overflow-hidden">
                  <div
                    className="h-full rounded-full grow-bar"
                    style={{
                      width: `${(s.count / maxSource) * 100}%`,
                      background: i === 0 ? 'var(--color-amber)' : 'var(--color-brand)',
                      animationDelay: `${0.1 + i * 0.07}s`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
