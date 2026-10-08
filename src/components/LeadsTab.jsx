import { useEffect, useMemo, useState } from 'react'
import { api, usePoll, fmtAgo } from '../api.js'
import { paiseRangeToDisplay } from '../money.js'
import { Avatar, Chip, Sheet, TEMP_STYLE, inputCls, ErrorBanner } from './ui.jsx'
import LeadDetail from './LeadDetail.jsx'
import QuickAddLead from './QuickAddLead.jsx'
import { stageEmptyText, stageEmptyIcon } from '../lib/stageEmpty.js'

// One "Load more" step. Deliberately smaller than the server's 100-lead default page:
// this is a phone screen, and a broker with 800 leads should not wait on 800 of them
// to see the top of their pipeline.
const PAGE_SIZE = 50

const PIPELINES = [
  { id: 'buy_primary', label: 'Buy (Primary)' },
  { id: 'buy_resale', label: 'Buy (Resale)' },
  { id: 'rental', label: 'Rental' },
]

const LOST_REASONS = ['Budget mismatch', 'Bought elsewhere', 'Postponed', 'Unresponsive']
const TERMINAL = ['Lost', 'Closed', 'Registered/Closed']

// "3d 4h", "5h", "12m" — compact dwell-time label for pipeline analytics.
function fmtDuration(seconds) {
  if (seconds == null) return '—'
  const s = Number(seconds)
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  const d = Math.floor(s / 86400)
  const h = Math.round((s % 86400) / 3600)
  return h ? `${d}d ${h}h` : `${d}d`
}

function LeadCard({ lead, onOpen, onDragStart, onDragEnd, dragging }) {
  const display = lead.contact_name || lead.name || lead.wa_id
  const budget =
    paiseRangeToDisplay(lead.budget_min, lead.budget_max) ||
    (lead.budget_max_l != null || lead.budget_min_l != null
      ? paiseRangeToDisplay((lead.budget_min_l ?? lead.budget_max_l) * 1e7, (lead.budget_max_l ?? lead.budget_min_l) * 1e7)
      : null)
  return (
    <button
      onClick={onOpen}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`w-full text-left bg-card rounded-2xl border shadow-card px-3.5 py-3 active:scale-[0.99] transition cursor-grab active:cursor-grabbing ${
        dragging ? 'opacity-40' : ''
      } ${lead.unassigned ? 'border-amber/40' : 'border-line'}`}
    >
      <div className="flex items-center gap-2.5">
        <Avatar name={display} className="!w-9 !h-9 text-[13px]" />
        <div className="min-w-0 flex-1">
          <p className="font-bold text-[13.5px] text-ink truncate">{display}</p>
          <p className="text-[11.5px] text-ink-soft truncate mt-0.5">
            {[lead.bhk && `${lead.bhk} BHK`, budget, (lead.preferred_localities || [])[0] || lead.locality]
              .filter(Boolean)
              .join(' · ') || 'Qualifying…'}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
        {lead.unassigned ? (
          <span className="text-[10px] font-bold border rounded-full px-2 py-0.5 bg-amber-wash text-gold border-amber/40">
            ✋ Unassigned
          </span>
        ) : (
          <span className={`text-[10px] font-bold border rounded-full px-2 py-0.5 ${TEMP_STYLE[lead.temp] || TEMP_STYLE.Cold}`}>
            {lead.temp === 'Hot' ? '🔥 Hot' : lead.temp === 'Warm' ? '☀️ Warm' : '❄️ Cold'}
          </span>
        )}
        <span className="text-[10.5px] text-ink-faint">{fmtAgo(lead.last_at || lead.updated_at)}</span>
      </div>
    </button>
  )
}

// Drop-onto-Lost asks for a reason before completing the move.
function LostReasonSheet({ onClose, onPick }) {
  const [custom, setCustom] = useState('')
  return (
    <Sheet onClose={onClose} title="Why was this lead lost?">
      <div className="space-y-2">
        {LOST_REASONS.map((r) => (
          <button
            key={r}
            onClick={() => onPick(r)}
            className="w-full text-left bg-card border border-line rounded-xl px-4 py-3 text-[13.5px] font-semibold text-ink active:scale-[0.99] transition"
          >
            {r}
          </button>
        ))}
        <div className="flex gap-2">
          <input value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Another reason this lead was lost" placeholder="Other reason…" className={inputCls} />
          <button
            onClick={() => custom.trim() && onPick(custom.trim())}
            className="shrink-0 bg-ink text-cream font-bold text-[13px] rounded-xl px-4 active:scale-95 transition"
          >
            Save
          </button>
        </div>
      </div>
    </Sheet>
  )
}

// Read-only funnel + lost-reason mix + average time-in-stage, from /api/pipeline/analytics.
function AnalyticsPanel({ pipeline }) {
  const { data } = usePoll(() => api.pipelineAnalytics(pipeline), 30000, [pipeline])
  if (!data) return <p className="px-5 mt-6 text-[12.5px] text-ink-soft">Loading analytics…</p>
  const max = Math.max(1, ...data.funnel.map((f) => f.open))
  return (
    <div className="px-5 mt-4 space-y-4 pb-6">
      <div className="grid grid-cols-3 gap-2">
        {[
          ['Open', data.totals.open, 'text-ink'],
          ['Won', data.totals.won, 'text-brand-deep'],
          ['Lost', data.totals.lost, 'text-hot'],
        ].map(([k, v, cls]) => (
          <div key={k} className="bg-card rounded-2xl border border-line shadow-card p-3 text-center">
            <p className={`font-display text-[22px] font-semibold tabular-nums ${cls}`}>{v}</p>
            <p className="text-[10.5px] font-bold tracking-[0.12em] uppercase text-ink-soft">{k}</p>
          </div>
        ))}
      </div>

      <section className="bg-card rounded-2xl border border-line shadow-card p-4">
        <p className="text-[10.5px] font-bold tracking-[0.18em] text-ink-soft mb-3">FUNNEL · AVG TIME IN STAGE</p>
        <div className="space-y-2.5">
          {data.funnel.map((f) => (
            <div key={f.stage} className="flex items-center gap-2">
              <span className={`w-[128px] shrink-0 text-[11.5px] font-semibold truncate ${f.stage === 'Lost' ? 'text-hot' : 'text-ink'}`}>
                {f.stage}
              </span>
              <div className="flex-1 h-4 rounded-full bg-[#111113] border border-line overflow-hidden">
                <div className="h-full rounded-full bg-brand" style={{ width: `${(f.open / max) * 100}%` }} />
              </div>
              <span className="w-6 text-right text-[11.5px] font-bold text-ink tabular-nums">{f.open}</span>
              <span className="w-12 text-right text-[10.5px] text-ink-faint tabular-nums">{fmtDuration(f.avg_seconds_in_stage)}</span>
            </div>
          ))}
        </div>
      </section>

      {data.lost_reasons.length > 0 && (
        <section className="bg-card rounded-2xl border border-line shadow-card p-4">
          <p className="text-[10.5px] font-bold tracking-[0.18em] text-ink-soft mb-3">WHY LEADS ARE LOST</p>
          <div className="space-y-2">
            {data.lost_reasons.map((r) => (
              <div key={r.reason} className="flex justify-between text-[12.5px]">
                <span className="text-ink">{r.reason}</span>
                <span className="font-bold text-ink-soft tabular-nums">{r.n}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

// Pipeline kanban: one column per stage. Tap a card to open the lead; drag a card
// onto another column to move stages (dropping on Lost asks for a reason first).
export default function LeadsTab({ onOpenConversation }) {
  const [pipeline, setPipeline] = useState('buy_primary')
  // Default to the tap-friendly List — the drag-only board is fiddly on a phone for
  // non-tech users, so they start on List and can opt into Board.
  const [view, setView] = useState('list') // board | list | stats
  const [selectedId, setSelectedId] = useState(null)
  const [drag, setDrag] = useState(null) // { leadId, from }
  const [dropTarget, setDropTarget] = useState(null) // stage name being hovered
  const [lostFor, setLostFor] = useState(null) // { leadId } awaiting a lost reason
  const [moveError, setMoveError] = useState(null)
  const [quickAdd, setQuickAdd] = useState(false)
  // How many pages of this pipeline are on screen. The poll always asks for the whole
  // run in one request (pages * PAGE_SIZE) rather than appending pages client-side —
  // one request stays consistent with itself, and leads that moved stage between polls
  // can't end up in two columns at once.
  const [pages, setPages] = useState(1)

  const limit = PAGE_SIZE * pages
  // The pipeline filter is applied by the server now: at 10k leads, fetching every
  // pipeline to show one of them was most of a 12MB body.
  const { data: leads, error, loading, refresh } = usePoll(
    () => api.leads({ pipeline_type: pipeline, limit }),
    5000,
    [pipeline],
  )
  const { data: stages } = usePoll(() => api.pipelineStages(pipeline), 60000, [pipeline])
  // Totals come from a grouped count query, not from measuring the page we were given
  // — a page of 50 can't tell you there are 800 leads behind it.
  const { data: counts } = usePoll(api.leadCounts, 15000, [])

  // `pages` is deliberately not a usePoll dep: changing a dep resets the hook's data to
  // null, which would blank the board on "Load more". Instead the poll closure reads
  // the current `limit` (usePoll always calls the latest one) and this fires the
  // request immediately rather than waiting out the interval.
  useEffect(() => {
    if (pages > 1) refresh()
  }, [pages, refresh])

  const byStage = useMemo(() => {
    const m = {}
    for (const l of leads || []) {
      const s = l.stage || 'New'
      ;(m[s] ||= []).push(l)
    }
    return m
  }, [leads])

  const stageTotals = counts?.by_stage?.[pipeline] || null
  const pipelineTotal = counts?.by_pipeline?.[pipeline] ?? null
  const openCount = stageTotals
    ? Object.entries(stageTotals).reduce((n, [stage, c]) => (TERMINAL.includes(stage) ? n : n + c), 0)
    : (leads || []).filter((l) => !TERMINAL.includes(l.stage || 'New')).length
  // A full page means the server had at least that many rows to give.
  const hasMore = (leads?.length ?? 0) >= limit
  const chipCounts = counts?.by_pipeline || {}

  const move = async (leadId, stage, lostReason) => {
    setMoveError(null)
    try {
      await api.moveLeadStage(leadId, stage, lostReason)
      refresh()
    } catch (err) {
      setMoveError(err.message)
    }
  }

  // Drop handler: move the dragged lead to this column's stage. Lost needs a reason.
  const onDropStage = (stageName) => (e) => {
    e.preventDefault()
    setDropTarget(null)
    const leadId = drag?.leadId
    setDrag(null)
    if (!leadId || stageName === drag?.from) return
    if (stageName === 'Lost') setLostFor({ leadId })
    else move(leadId, stageName)
  }

  return (
    <div className="pt-7">
      <header className="rise px-5">
        <h1 className="font-display text-[28px] font-semibold text-ink">Leads</h1>
        <p className="text-[13px] text-ink-soft mt-0.5">
          {loading && !leads
            ? 'Loading…'
            : `${openCount} open in this pipeline · qualified by DoAide AI`}
        </p>
      </header>

      <ErrorBanner error={error} className="mx-5 mt-6" />
      {moveError && (
        <p className="mx-5 mt-3 text-[12.5px] text-hot bg-amber-wash rounded-xl px-4 py-2.5">{moveError}</p>
      )}

      <div className="flex gap-2 mt-4 px-5 overflow-x-auto no-scrollbar rise rise-1">
        {PIPELINES.map((p) => (
          <Chip
            key={p.id}
            active={pipeline === p.id}
            onClick={() => {
              setPipeline(p.id)
              setPages(1) // a new pipeline starts at its first page, not the last one's depth
            }}
          >
            {p.label}
            {chipCounts[p.id] > 0 && (
              <span
                className={`ml-1.5 text-[10.5px] font-bold tabular-nums rounded-full px-1.5 py-0.5 ${
                  pipeline === p.id ? 'bg-ink/15 text-ink' : 'bg-ink/10 text-ink-soft'
                }`}
              >
                {chipCounts[p.id]}
              </span>
            )}
          </Chip>
        ))}
        <span className="flex-1" />
        <Chip active={view === 'board'} onClick={() => setView('board')}>▦ Board</Chip>
        <Chip active={view === 'list'} onClick={() => setView('list')}>☰ List</Chip>
        <Chip active={view === 'stats'} onClick={() => setView('stats')}>📊 Stats</Chip>
      </div>

      {/* Three distinct states, because they need three different answers: still
          loading, no leads anywhere yet, and leads exist but none in THIS pipeline.
          The last used to render as the "No leads yet" onboarding copy, which reads
          as "your WhatsApp number is broken" to an agent who has 200 leads. */}
      {view !== 'stats' && loading && !leads && (
        <div className="mx-5 mt-6 space-y-2.5" aria-busy="true" aria-label="Loading leads">
          {[0, 1, 2].map((i) => (
            <div key={i} className="bg-card rounded-2xl border border-line shadow-card h-[76px] animate-pulse" />
          ))}
        </div>
      )}

      {view !== 'stats' && leads && leads.length === 0 && (
        <div className="mx-5 mt-6 bg-card rounded-2xl border border-line shadow-card p-5 rise rise-1">
          {counts && counts.total > 0 ? (
            <>
              <p className="font-bold text-[14.5px] text-ink">Nothing in this pipeline</p>
              <p className="text-[12.5px] text-ink-soft mt-1.5">
                {counts.total} lead{counts.total === 1 ? '' : 's'} in other pipelines — switch tabs above.
              </p>
            </>
          ) : (
            <>
              <p className="font-bold text-[14.5px] text-ink">No leads yet</p>
              <p className="text-[12.5px] text-ink-soft mt-1.5">
                WhatsApp enquiries auto-capture as leads in your pipeline.
              </p>
            </>
          )}
        </div>
      )}

      {view === 'stats' ? (
        <AnalyticsPanel pipeline={pipeline} />
      ) : view === 'board' ? (
        <div className="flex gap-3 mt-4 px-5 pb-4 overflow-x-auto no-scrollbar items-start">
          {(stages || []).map((s) => {
            const col = byStage[s.stage_name] || []
            const isTarget = dropTarget === s.stage_name
            return (
              <div
                key={s.id}
                className="shrink-0 w-[240px]"
                onDragOver={(e) => {
                  if (drag) {
                    e.preventDefault()
                    setDropTarget(s.stage_name)
                  }
                }}
                onDragLeave={() => setDropTarget((t) => (t === s.stage_name ? null : t))}
                onDrop={onDropStage(s.stage_name)}
              >
                <div className="flex items-center gap-2 px-1 mb-2">
                  <p className={`text-[11px] font-bold tracking-[0.12em] uppercase ${s.stage_name === 'Lost' ? 'text-hot' : 'text-ink-soft'}`}>
                    {s.stage_name}
                  </p>
                  {/* The true stage size from the count query, not how many of it
                      happen to be loaded — "New 4" under a board holding the first
                      page of 240 would be a lie. */}
                  <span className="text-[10.5px] font-bold text-ink-faint bg-card border border-line rounded-full px-1.5 py-0.5 tabular-nums">
                    {stageTotals && stageTotals[s.stage_name] > col.length
                      ? `${col.length} / ${stageTotals[s.stage_name]}`
                      : col.length}
                  </span>
                </div>
                <div
                  className={`space-y-2 min-h-[52px] rounded-2xl transition ${
                    isTarget ? 'ring-2 ring-brand ring-offset-2 ring-offset-cream bg-brand-wash/40' : ''
                  }`}
                >
                  {col.map((l) => (
                    <LeadCard
                      key={l.id}
                      lead={l}
                      dragging={drag?.leadId === l.id}
                      onOpen={() => setSelectedId(l.id)}
                      onDragStart={() => setDrag({ leadId: l.id, from: s.stage_name })}
                      onDragEnd={() => {
                        setDrag(null)
                        setDropTarget(null)
                      }}
                    />
                  ))}
                  {col.length === 0 && (
                    <div className="border border-dashed border-line rounded-2xl min-h-[64px] flex flex-col items-center justify-center gap-1 px-3 py-3 text-center">
                      {isTarget ? (
                        <span className="text-[12px] font-bold text-brand">Drop here</span>
                      ) : (
                        <>
                          <span className="text-[16px] leading-none opacity-70">{stageEmptyIcon(s.stage_name)}</span>
                          <span className="text-[11px] text-ink-faint leading-snug">{stageEmptyText(s.stage_name)}</span>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="space-y-2.5 mt-4 px-5">
          {(stages || [])
            .flatMap((s) => byStage[s.stage_name] || [])
            .map((l) => (
              <div key={l.id}>
                <LeadCard lead={l} onOpen={() => setSelectedId(l.id)} onDragStart={() => {}} onDragEnd={() => {}} />
              </div>
            ))}
        </div>
      )}

      {/* Paging control, shared by Board and List. Kept out of the stats view, which
          doesn't read the lead rows at all. */}
      {view !== 'stats' && hasMore && (
        <div className="px-5 mt-4 text-center">
          <button
            onClick={() => setPages((p) => p + 1)}
            className="w-full bg-card border border-line rounded-2xl px-4 py-3 text-[13px] font-bold text-ink active:scale-[0.99] transition"
          >
            Load more leads
          </button>
          {pipelineTotal != null && (
            <p className="text-[11px] text-ink-faint mt-1.5 tabular-nums">
              Showing {leads.length} of {pipelineTotal}
            </p>
          )}
        </div>
      )}

      {/* 10-second walk-in / phone lead capture (§4.4) */}
      <button
        onClick={() => setQuickAdd(true)}
        className="fixed bottom-24 right-5 z-30 h-14 pl-4 pr-5 rounded-full bg-brand text-white font-bold text-[14px] shadow-float flex items-center gap-1.5 active:scale-95 transition"
      >
        <span className="text-[20px] leading-none">+</span> Add lead
      </button>

      {quickAdd && <QuickAddLead onClose={() => setQuickAdd(false)} onAdded={refresh} />}

      {lostFor && (
        <LostReasonSheet
          onClose={() => setLostFor(null)}
          onPick={(reason) => {
            move(lostFor.leadId, 'Lost', reason)
            setLostFor(null)
          }}
        />
      )}

      {selectedId && (
        <LeadDetail
          leadId={selectedId}
          onClose={() => setSelectedId(null)}
          onOpenConversation={onOpenConversation}
          onChanged={refresh}
        />
      )}
    </div>
  )
}
