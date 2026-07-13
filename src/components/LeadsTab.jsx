import { useMemo, useState } from 'react'
import { api, usePoll, fmtAgo } from '../api.js'
import { paiseRangeToDisplay } from '../money.js'
import { Avatar, Chip, Sheet, TEMP_STYLE, inputCls } from './ui.jsx'
import LeadDetail from './LeadDetail.jsx'
import QuickAddLead from './QuickAddLead.jsx'
import { pipelineCounts } from '../lib/pipelineCounts.js'
import { stageEmptyText, stageEmptyIcon } from '../lib/stageEmpty.js'

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
            {lead.temp === 'Hot' ? '🔥' : lead.temp === 'Warm' ? '☀️' : '❄️'} {lead.score ?? 0}
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
          <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Other reason…" className={inputCls} />
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
              <div className="flex-1 h-4 rounded-full bg-cream border border-line overflow-hidden">
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
  const [view, setView] = useState('board') // board | list | stats
  const [selectedId, setSelectedId] = useState(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [drag, setDrag] = useState(null) // { leadId, from }
  const [dropTarget, setDropTarget] = useState(null) // stage name being hovered
  const [lostFor, setLostFor] = useState(null) // { leadId } awaiting a lost reason
  const [moveError, setMoveError] = useState(null)
  const [quickAdd, setQuickAdd] = useState(false)
  const refresh = () => setRefreshKey((k) => k + 1)

  const { data: allLeads, error } = usePoll(api.leads, 5000, [refreshKey])
  const { data: stages } = usePoll(() => api.pipelineStages(pipeline), 60000, [pipeline])

  // A lead with no pipeline yet counts as buy_primary/New (webhook defaults).
  const leads = useMemo(
    () => (allLeads || []).filter((l) => (l.pipeline_type || 'buy_primary') === pipeline),
    [allLeads, pipeline],
  )
  const byStage = useMemo(() => {
    const m = {}
    for (const l of leads) {
      const s = l.stage || 'New'
      ;(m[s] ||= []).push(l)
    }
    return m
  }, [leads])

  const openCount = leads.filter((l) => !TERMINAL.includes(l.stage || 'New')).length
  const counts = pipelineCounts(allLeads || [])

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
          {allLeads ? `${openCount} open in this pipeline · qualified by HomeNex AI` : 'Loading…'}
        </p>
      </header>

      {error && (
        <p className="mx-5 mt-6 text-[12.5px] text-hot bg-amber-wash rounded-xl px-4 py-3">
          Can't reach the HomeNex server: {error.message}
        </p>
      )}
      {moveError && (
        <p className="mx-5 mt-3 text-[12.5px] text-hot bg-amber-wash rounded-xl px-4 py-2.5">{moveError}</p>
      )}

      <div className="flex gap-2 mt-4 px-5 overflow-x-auto no-scrollbar rise rise-1">
        {PIPELINES.map((p) => (
          <Chip key={p.id} active={pipeline === p.id} onClick={() => setPipeline(p.id)}>
            {p.label}
            {counts[p.id] > 0 && (
              <span
                className={`ml-1.5 text-[10.5px] font-bold tabular-nums rounded-full px-1.5 py-0.5 ${
                  pipeline === p.id ? 'bg-cream/25 text-cream' : 'bg-ink/10 text-ink-soft'
                }`}
              >
                {counts[p.id]}
              </span>
            )}
          </Chip>
        ))}
        <span className="flex-1" />
        <Chip active={view === 'board'} onClick={() => setView('board')}>▦ Board</Chip>
        <Chip active={view === 'list'} onClick={() => setView('list')}>☰ List</Chip>
        <Chip active={view === 'stats'} onClick={() => setView('stats')}>📊 Stats</Chip>
      </div>

      {allLeads && allLeads.length === 0 && view !== 'stats' && (
        <div className="mx-5 mt-6 bg-card rounded-2xl border border-line shadow-card p-5 rise rise-1">
          <p className="font-bold text-[14.5px] text-ink">No leads yet</p>
          <p className="text-[12.5px] text-ink-soft leading-relaxed mt-1.5">
            Every buyer who messages your WhatsApp number becomes a lead here — auto-captured
            as a contact and dropped into the pipeline.
          </p>
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
                  <span className="text-[10.5px] font-bold text-ink-faint bg-card border border-line rounded-full px-1.5 py-0.5 tabular-nums">
                    {col.length}
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
