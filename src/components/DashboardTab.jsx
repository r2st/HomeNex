import { api, usePoll, fmtAgo, fmtTime, fmtWait } from '../api.js'
import ShareNumberCard from './ShareNumberCard.jsx'

const DOT = {
  hot: 'bg-hot',
  ai: 'bg-brand',
  agent: 'bg-amber',
  lead: 'bg-ink-faint',
  error: 'bg-hot',
  msg: 'bg-ink-faint',
}

function greeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

function SectionHeader({ children, badge }) {
  return (
    <div className="flex items-center gap-2">
      <p className="text-[11px] font-bold tracking-[0.18em] text-brand">{children}</p>
      {badge != null && badge > 0 && (
        <span className="text-[10.5px] font-bold bg-amber-wash text-hot rounded-full px-2 py-0.5">{badge}</span>
      )}
    </div>
  )
}

// The Home tab: everything the agent needs to act on right now.
export default function DashboardTab({ agent, onGoTo, onOpenConversation, onOpenLead, onSignOut }) {
  const { data: d, error } = usePoll(api.dashboard, 6000)
  const { data: stats } = usePoll(api.stats, 10000)

  const complete = async (id) => {
    await api.updateFollowup(id, { completed: true })
  }

  const kpis = d && [
    { label: 'Waiting for reply', value: String(d.unanswered.length), accent: d.unanswered.length > 0 },
    { label: 'Hot leads', value: String(d.hotLeads.length), accent: d.hotLeads.length > 0 },
    { label: "Today's follow-ups", value: String(d.followupsToday.length), accent: false },
    { label: "Today's site visits", value: String(d.siteVisitsToday.length), accent: false },
  ]

  return (
    <div className="px-5 pt-7">
      <header className="rise">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-[11px] font-bold tracking-[0.18em] text-ink-faint uppercase">
            {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
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
                <strong className="text-brand-deep">{stats.newToday}</strong> new lead{stats.newToday === 1 ? '' : 's'} today ·{' '}
                <strong className="text-brand-deep">{stats.active24h}</strong> active conversation{stats.active24h === 1 ? '' : 's'}
              </>
            )}
          </p>
        )}
      </header>

      {error && (
        <p className="mt-6 text-[12.5px] text-hot bg-amber-wash rounded-xl px-4 py-3">
          Can't reach the HomeNex server: {error.message}
        </p>
      )}

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
              </p>
              <p className="text-[11.5px] font-semibold text-ink-soft mt-1.5">{k.label}</p>
            </div>
          ))}
        </div>
      )}

      {d && d.unanswered.length > 0 && (
        <section className="mt-7 rise rise-2">
          <SectionHeader badge={d.unanswered.length}>UNANSWERED — REPLY NOW</SectionHeader>
          <div className="space-y-2.5 mt-3">
            {d.unanswered.slice(0, 5).map((l) => (
              <div key={l.id} className="bg-card rounded-2xl border border-amber/40 shadow-card px-4 py-3.5">
                <div className="flex items-start gap-3">
                  <span className="shrink-0 mt-0.5 min-w-[42px] text-center text-[11px] font-bold text-hot bg-amber-wash rounded-full px-2 py-1">
                    ⏱ {fmtWait(l.last_at)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-bold text-[14px] text-ink truncate">{l.name || l.wa_id}</p>
                    <p className="text-[12.5px] text-ink-soft leading-snug mt-0.5 truncate">
                      “{(l.last_msg || '').slice(0, 80)}{(l.last_msg || '').length > 80 ? '…' : ''}”
                    </p>
                  </div>
                  <button
                    onClick={() => onOpenConversation(l.id)}
                    className="shrink-0 text-[12px] font-bold rounded-full px-3.5 py-1.5 bg-brand text-white active:scale-95 transition"
                  >
                    Reply →
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {d && d.followupsToday.length > 0 && (
        <section className="mt-7 rise rise-3">
          <SectionHeader badge={d.followupsToday.length}>TODAY'S FOLLOW-UPS</SectionHeader>
          <div className="mt-3 bg-card rounded-2xl border border-line shadow-card divide-y divide-line">
            {d.followupsToday.map((f) => (
              <div key={f.id} className="flex items-center gap-3 px-4 py-3">
                <button
                  onClick={() => complete(f.id)}
                  title="Mark done"
                  className="shrink-0 w-6 h-6 rounded-full border-2 border-brand/50 text-transparent hover:text-brand text-[13px] leading-none active:scale-90 transition"
                >
                  ✓
                </button>
                <div className="min-w-0 flex-1">
                  <p className={`text-[13px] font-bold truncate ${f.overdue ? 'text-hot' : 'text-ink'}`}>
                    {f.lead_name || f.lead_wa_id}
                    {f.overdue ? ' · overdue' : ''}
                  </p>
                  {f.note && <p className="text-[12px] text-ink-soft truncate">{f.note}</p>}
                </div>
                <span className={`shrink-0 text-[11px] font-medium tabular-nums ${f.overdue ? 'text-hot' : 'text-ink-faint'}`}>
                  {fmtTime(f.due_at)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {d && d.siteVisitsToday.length > 0 && (
        <section className="mt-7 rise rise-3">
          <SectionHeader badge={d.siteVisitsToday.length}>TODAY'S SITE VISITS</SectionHeader>
          <div className="mt-3 bg-card rounded-2xl border border-line shadow-card divide-y divide-line">
            {d.siteVisitsToday.map((v) => (
              <div key={v.id} className="flex items-center gap-3 px-4 py-3">
                <span className="text-[18px]">🏗️</span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-bold text-ink truncate">
                    {v.lead_name || v.lead_wa_id}
                    {v.property_title ? ` → ${v.property_title}` : ''}
                  </p>
                  <p className="text-[12px] text-ink-soft">
                    {fmtTime(v.scheduled_at)} · {v.status}
                    {v.pickup_required ? ' · 🚗 pickup' : ''}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {d && d.hotLeads.length > 0 && (
        <section className="mt-7 rise rise-4">
          <SectionHeader>🔥 HOT LEADS</SectionHeader>
          <div className="space-y-2.5 mt-3">
            {d.hotLeads.slice(0, 4).map((l) => (
              <button
                key={l.id}
                onClick={() => (onOpenLead ? onOpenLead(l.id) : onOpenConversation(l.id))}
                className="w-full text-left bg-card rounded-2xl border border-line shadow-card px-4 py-3.5 active:scale-[0.99] transition"
              >
                <p className="font-bold text-[14px] text-ink">
                  {l.name || l.wa_id} <span className="text-hot">· {l.score}/100</span>
                </p>
                {l.next_step && <p className="text-[12.5px] text-ink-soft mt-1 leading-snug">Next: {l.next_step}</p>}
                <p className="text-[11px] text-ink-faint mt-1">
                  {l.stage || 'New'} · {fmtAgo(l.updated_at)}
                </p>
              </button>
            ))}
          </div>
        </section>
      )}

      {d && d.unanswered.length === 0 && d.followupsToday.length === 0 && d.siteVisitsToday.length === 0 && (
        <ShareNumberCard agent={agent} />
      )}

      {d && d.activity.length > 0 && (
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
            {d.activity.map((a) => (
              <div key={a.id} className="flex items-start gap-3 px-4 py-3">
                <span className={`shrink-0 w-1.5 h-1.5 rounded-full mt-[7px] ${DOT[a.kind] || 'bg-ink-faint'}`} />
                <p className="text-[12.5px] text-ink leading-snug flex-1">{a.text}</p>
                <span className="shrink-0 text-[11px] text-ink-faint font-medium tabular-nums">{fmtAgo(a.created_at)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="h-8" />
    </div>
  )
}
