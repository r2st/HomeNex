import { useMemo, useState } from 'react'
import { api, usePoll, fmtAgo } from '../api.js'
import { paiseRangeToDisplay } from '../money.js'
import { Avatar, Chip, TEMP_STYLE } from './ui.jsx'
import LeadDetail from './LeadDetail.jsx'

const PIPELINES = [
  { id: 'buy_primary', label: 'Buy (Primary)' },
  { id: 'buy_resale', label: 'Buy (Resale)' },
  { id: 'rental', label: 'Rental' },
]

function LeadCard({ lead, onOpen }) {
  const display = lead.contact_name || lead.name || lead.wa_id
  const budget =
    paiseRangeToDisplay(lead.budget_min, lead.budget_max) ||
    (lead.budget_max_l != null || lead.budget_min_l != null
      ? paiseRangeToDisplay((lead.budget_min_l ?? lead.budget_max_l) * 1e7, (lead.budget_max_l ?? lead.budget_min_l) * 1e7)
      : null)
  return (
    <button
      onClick={onOpen}
      className={`w-full text-left bg-card rounded-2xl border shadow-card px-3.5 py-3 active:scale-[0.99] transition ${
        lead.unassigned ? 'border-amber/40' : 'border-line'
      }`}
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

// Pipeline kanban: one horizontally-scrollable column per stage; tap a card to
// open the lead, move stages from the detail panel.
export default function LeadsTab({ onOpenConversation }) {
  const [pipeline, setPipeline] = useState('buy_primary')
  const [view, setView] = useState('board') // board | list
  const [selectedId, setSelectedId] = useState(null)
  const [refreshKey, setRefreshKey] = useState(0)
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

  const openCount = leads.filter((l) => !['Lost', 'Closed', 'Registered/Closed'].includes(l.stage || 'New')).length

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

      <div className="flex gap-2 mt-4 px-5 overflow-x-auto no-scrollbar rise rise-1">
        {PIPELINES.map((p) => (
          <Chip key={p.id} active={pipeline === p.id} onClick={() => setPipeline(p.id)}>
            {p.label}
          </Chip>
        ))}
        <span className="flex-1" />
        <Chip active={view === 'board'} onClick={() => setView(view === 'board' ? 'list' : 'board')}>
          {view === 'board' ? '☰ List' : '▦ Board'}
        </Chip>
      </div>

      {allLeads && allLeads.length === 0 && (
        <div className="mx-5 mt-6 bg-card rounded-2xl border border-line shadow-card p-5 rise rise-1">
          <p className="font-bold text-[14.5px] text-ink">No leads yet</p>
          <p className="text-[12.5px] text-ink-soft leading-relaxed mt-1.5">
            Every buyer who messages your WhatsApp number becomes a lead here — auto-captured
            as a contact and dropped into the pipeline.
          </p>
        </div>
      )}

      {view === 'board' ? (
        <div className="flex gap-3 mt-4 px-5 pb-4 overflow-x-auto no-scrollbar items-start">
          {(stages || []).map((s) => {
            const col = byStage[s.stage_name] || []
            return (
              <div key={s.id} className="shrink-0 w-[240px]">
                <div className="flex items-center gap-2 px-1 mb-2">
                  <p className={`text-[11px] font-bold tracking-[0.12em] uppercase ${s.stage_name === 'Lost' ? 'text-hot' : 'text-ink-soft'}`}>
                    {s.stage_name}
                  </p>
                  <span className="text-[10.5px] font-bold text-ink-faint bg-card border border-line rounded-full px-1.5 py-0.5 tabular-nums">
                    {col.length}
                  </span>
                </div>
                <div className="space-y-2 min-h-[52px] rounded-2xl">
                  {col.map((l) => (
                    <LeadCard key={l.id} lead={l} onOpen={() => setSelectedId(l.id)} />
                  ))}
                  {col.length === 0 && (
                    <div className="border border-dashed border-line rounded-2xl h-[52px] flex items-center justify-center text-[11px] text-ink-faint">
                      empty
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
                <LeadCard lead={l} onOpen={() => setSelectedId(l.id)} />
              </div>
            ))}
        </div>
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
