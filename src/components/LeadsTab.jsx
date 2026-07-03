import { useState } from 'react'
import { LEADS } from '../data.js'

const TEMP_STYLE = {
  Hot: 'bg-amber-wash text-hot border-amber/40',
  Warm: 'bg-brand-wash text-brand-deep border-brand/30',
  Cold: 'bg-cream text-ink-faint border-line',
}

function ScoreRing({ score, size = 44 }) {
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
          strokeDashoffset={c * (1 - score / 100)}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center font-display font-bold text-[13px]" style={{ color }}>
        {score}
      </span>
    </div>
  )
}

function LeadDetail({ lead, onClose }) {
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-ink/50 backdrop-blur-[2px]" onClick={onClose} />
      <div className="absolute right-0 top-0 bottom-0 w-full max-w-[440px] bg-cream shadow-float slide-in overflow-y-auto no-scrollbar">
        <div className="sticky top-0 bg-cream/95 backdrop-blur border-b border-line px-5 py-4 flex items-center gap-3 z-10">
          <button onClick={onClose} className="w-9 h-9 rounded-full bg-card border border-line flex items-center justify-center text-ink shadow-card active:scale-95 transition">
            ←
          </button>
          <div className="flex-1 min-w-0">
            <p className="font-display font-semibold text-[18px] text-ink leading-tight">{lead.name}</p>
            <p className="text-[11.5px] text-ink-faint">{lead.source} · {lead.time} · {lead.phone}</p>
          </div>
          <ScoreRing score={lead.score} size={48} />
        </div>

        <div className="px-5 py-5 space-y-5 pb-10">
          <section className="bg-card rounded-2xl border border-line shadow-card p-4">
            <p className="text-[10.5px] font-bold tracking-[0.18em] text-brand mb-3">BLTC SUMMARY</p>
            <dl className="space-y-2.5">
              {[
                ['💰 Budget', lead.bltc.budget],
                ['📍 Location', lead.bltc.location],
                ['⏱️ Timeline', lead.bltc.timeline],
                ['🏠 Config', lead.bltc.config],
              ].map(([k, v]) => (
                <div key={k} className="flex gap-3">
                  <dt className="shrink-0 w-[92px] text-[12px] font-bold text-ink-soft">{k}</dt>
                  <dd className="text-[12.5px] text-ink leading-snug">{v}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="bg-brand-wash rounded-2xl border border-brand/20 p-4">
            <p className="text-[10.5px] font-bold tracking-[0.18em] text-brand-deep mb-2">
              ✨ HOMENEX SUMMARY FOR RAJESH
            </p>
            <p className="text-[13px] text-ink leading-relaxed">{lead.aiSummary}</p>
          </section>

          <section className="bg-card rounded-2xl border border-line shadow-card p-4">
            <p className="text-[10.5px] font-bold tracking-[0.18em] text-ink-soft mb-3">
              SCORE BREAKDOWN · {lead.score}/100
            </p>
            <div className="space-y-3">
              {lead.scoreBreakdown.map((s, i) => (
                <div key={s.label}>
                  <div className="flex justify-between text-[12px] mb-1">
                    <span className="font-semibold text-ink">{s.label}</span>
                    <span className="font-bold text-ink-soft tabular-nums">{s.value}</span>
                  </div>
                  <div className="h-2 rounded-full bg-cream border border-line overflow-hidden">
                    <div
                      className="h-full rounded-full grow-bar"
                      style={{
                        width: `${s.value}%`,
                        background: s.value >= 80 ? 'var(--color-amber)' : 'var(--color-brand)',
                        animationDelay: `${0.1 + i * 0.08}s`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="bg-card rounded-2xl border border-line shadow-card overflow-hidden">
            <p className="text-[10.5px] font-bold tracking-[0.18em] text-ink-soft px-4 pt-4 pb-2">
              WHATSAPP TRANSCRIPT
            </p>
            <div className="chat-texture px-3 py-3 space-y-2">
              {lead.transcript.map((m, i) => (
                <div key={i} className={`flex ${m.from === 'buyer' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[82%] rounded-xl px-3 py-2 text-[12.5px] leading-snug shadow-sm ${
                      m.from === 'buyer'
                        ? 'bg-buyer rounded-tr-sm'
                        : 'bg-white rounded-tl-sm'
                    }`}
                  >
                    {m.text}
                  </div>
                </div>
              ))}
            </div>
            <div className="px-4 py-3 border-t border-line bg-cream/60">
              <p className="text-[11.5px] text-ink-soft">
                <strong className="text-ink">Next step:</strong> {lead.nextStep}
              </p>
            </div>
          </section>

          <button className="w-full bg-brand hover:bg-brand-deep text-white font-bold text-[14.5px] rounded-2xl py-4 shadow-float active:scale-[0.98] transition">
            Take over chat 💬
          </button>
        </div>
      </div>
    </div>
  )
}

export default function LeadsTab() {
  const [selected, setSelected] = useState(null)
  const [filter, setFilter] = useState('All')
  const filters = ['All', 'Hot', 'Warm', 'Cold']
  const leads = filter === 'All' ? LEADS : LEADS.filter((l) => l.temp === filter)

  return (
    <div className="px-5 pt-7">
      <header className="rise">
        <h1 className="font-display text-[28px] font-semibold text-ink">Leads</h1>
        <p className="text-[13px] text-ink-soft mt-0.5">
          {LEADS.length} in pipeline · every one qualified by HomeNex
        </p>
      </header>

      <div className="flex gap-2 mt-4 rise rise-1">
        {filters.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`text-[12.5px] font-bold rounded-full px-3.5 py-1.5 border transition active:scale-95 ${
              filter === f
                ? 'bg-ink text-cream border-ink'
                : 'bg-card text-ink-soft border-line'
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      <div className="space-y-2.5 mt-4">
        {leads.map((l, i) => (
          <button
            key={l.id}
            onClick={() => setSelected(l)}
            className={`w-full text-left bg-card rounded-2xl border border-line shadow-card px-4 py-3.5 active:scale-[0.99] transition rise rise-${Math.min(i + 1, 5)}`}
          >
            <div className="flex items-center gap-3">
              <span className="shrink-0 w-11 h-11 rounded-full bg-brand-wash text-brand-deep font-display font-bold text-[15px] flex items-center justify-center">
                {l.initials}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-bold text-[14.5px] text-ink truncate">{l.name}</p>
                  {l.isNew && (
                    <span className="shrink-0 text-[9.5px] font-bold bg-hot text-white rounded-full px-1.5 py-0.5">NEW</span>
                  )}
                </div>
                <p className="text-[12px] text-ink-soft truncate mt-0.5">
                  {l.config} · {l.locality} · {l.budget}
                </p>
                <div className="flex items-center gap-2 mt-1.5">
                  <span className={`text-[10.5px] font-bold border rounded-full px-2 py-0.5 ${TEMP_STYLE[l.temp]}`}>
                    {l.temp === 'Hot' ? '🔥 Hot' : l.temp === 'Warm' ? '☀️ Warm' : '❄️ Cold'}
                  </span>
                  <span className="text-[11px] text-ink-faint">{l.source} · {l.time}</span>
                </div>
              </div>
              <ScoreRing score={l.score} />
            </div>
          </button>
        ))}
      </div>

      {selected && <LeadDetail lead={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}
