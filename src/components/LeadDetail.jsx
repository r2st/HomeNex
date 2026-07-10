import { useEffect, useMemo, useState } from 'react'
import { api, usePoll, fmtAgo, fmtTime } from '../api.js'
import { paiseRangeToDisplay, lakhsToPaise, paiseToLakhs } from '../money.js'
import { ScoreRing, SlideOver, Sheet, Chip, Field, inputCls } from './ui.jsx'

const LOST_REASONS = [
  'Bought elsewhere',
  'Budget mismatch',
  'Location mismatch',
  'Postponed decision',
  'Unresponsive',
  'Chose another agent',
]

const PIPELINE_LABEL = {
  buy_primary: 'Buy (Primary)',
  buy_resale: 'Buy (Resale)',
  rental: 'Rental',
}

const VISIT_STATUSES = ['scheduled', 'confirmed', 'completed', 'no_show', 'rescheduled']

// Stage picker: tap a stage to move the lead; Lost asks for a reason first.
function StagePicker({ lead, onClose, onMoved }) {
  const pipelineType = lead.pipeline_type || 'buy_primary'
  const [stages, setStages] = useState([])
  const [lostFor, setLostFor] = useState(false)
  const [customReason, setCustomReason] = useState('')
  const [error, setError] = useState(null)

  useEffect(() => {
    api.pipelineStages(pipelineType).then(setStages).catch(() => {})
  }, [pipelineType])

  const move = async (stage, lostReason) => {
    setError(null)
    try {
      const updated = await api.moveLeadStage(lead.id, stage, lostReason)
      onMoved(updated)
      onClose()
    } catch (err) {
      setError(err.message)
    }
  }

  if (lostFor) {
    return (
      <Sheet onClose={onClose} title="Why was this lead lost?">
        <div className="space-y-2">
          {LOST_REASONS.map((r) => (
            <button
              key={r}
              onClick={() => move('Lost', r)}
              className="w-full text-left bg-card border border-line rounded-xl px-4 py-3 text-[13.5px] font-semibold text-ink active:scale-[0.99] transition"
            >
              {r}
            </button>
          ))}
          <div className="flex gap-2">
            <input
              value={customReason}
              onChange={(e) => setCustomReason(e.target.value)}
              placeholder="Other reason…"
              className={inputCls}
            />
            <button
              onClick={() => customReason.trim() && move('Lost', customReason.trim())}
              className="shrink-0 bg-ink text-cream font-bold text-[13px] rounded-xl px-4 active:scale-95 transition"
            >
              Save
            </button>
          </div>
          {error && <p className="text-[12px] text-hot bg-amber-wash rounded-xl px-3.5 py-2.5">{error}</p>}
        </div>
      </Sheet>
    )
  }

  const current = lead.stage || 'New'
  return (
    <Sheet onClose={onClose} title={`Move stage · ${PIPELINE_LABEL[pipelineType]}`}>
      <div className="space-y-1.5">
        {stages.map((s) => {
          const active = s.stage_name === current
          return (
            <button
              key={s.id}
              onClick={() => (s.stage_name === 'Lost' ? setLostFor(true) : move(s.stage_name))}
              disabled={active}
              className={`w-full text-left rounded-xl px-4 py-3 text-[13.5px] font-semibold border transition active:scale-[0.99] ${
                active
                  ? 'bg-brand text-white border-brand'
                  : s.stage_name === 'Lost'
                    ? 'bg-card text-hot border-line'
                    : 'bg-card text-ink border-line'
              }`}
            >
              <span className="text-ink-faint mr-2 tabular-nums">{s.stage_order}.</span>
              {s.stage_name}
              {active && ' · current'}
            </button>
          )
        })}
      </div>
      {error && <p className="mt-3 text-[12px] text-hot bg-amber-wash rounded-xl px-3.5 py-2.5">{error}</p>}
    </Sheet>
  )
}

// Editable CRM profile: budget, BHK, property type, localities, timeline, financing.
function CrmEditor({ lead, onSaved }) {
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const startEdit = () =>
    setForm({
      budget_min_l: paiseToLakhs(lead.budget_min) ?? '',
      budget_max_l: paiseToLakhs(lead.budget_max) ?? '',
      bhk: lead.bhk || '',
      property_type: lead.property_type || '',
      preferred_localities: (lead.preferred_localities || []).join(', '),
      timeline: lead.timeline || '',
      financing: lead.financing || '',
    })

  const save = async (e) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const updated = await api.updateLead(lead.id, {
        budget_min: lakhsToPaise(form.budget_min_l),
        budget_max: lakhsToPaise(form.budget_max_l),
        bhk: form.bhk || null,
        property_type: form.property_type || null,
        preferred_localities: form.preferred_localities
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        timeline: form.timeline || null,
        financing: form.financing || null,
      })
      onSaved(updated)
      setForm(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const rows = [
    ['💰 Budget', paiseRangeToDisplay(lead.budget_min, lead.budget_max)],
    ['🏠 BHK', lead.bhk && `${lead.bhk} BHK`],
    ['🏢 Type', lead.property_type],
    ['📍 Localities', (lead.preferred_localities || []).join(', ') || null],
    ['⏱️ Timeline', lead.timeline],
    ['🏦 Financing', lead.financing],
  ]

  if (!form) {
    return (
      <section className="bg-card rounded-2xl border border-line shadow-card p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-[10.5px] font-bold tracking-[0.18em] text-brand">BUYER PROFILE</p>
          <button onClick={startEdit} className="text-[11.5px] font-bold text-brand underline underline-offset-2">
            Edit
          </button>
        </div>
        <dl className="space-y-2.5">
          {rows.map(([k, v]) => (
            <div key={k} className="flex gap-3">
              <dt className="shrink-0 w-[92px] text-[12px] font-bold text-ink-soft">{k}</dt>
              <dd className="text-[12.5px] text-ink leading-snug">
                {v || <span className="text-ink-faint">not set</span>}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    )
  }

  return (
    <section className="bg-card rounded-2xl border border-line shadow-card p-4">
      <p className="text-[10.5px] font-bold tracking-[0.18em] text-brand mb-3">EDIT BUYER PROFILE</p>
      <form onSubmit={save} className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Budget min (₹ Lakhs)">
            <input type="number" min="0" step="0.5" value={form.budget_min_l} onChange={(e) => setForm((s) => ({ ...s, budget_min_l: e.target.value }))} className={inputCls} />
          </Field>
          <Field label="Budget max (₹ Lakhs)">
            <input type="number" min="0" step="0.5" value={form.budget_max_l} onChange={(e) => setForm((s) => ({ ...s, budget_max_l: e.target.value }))} className={inputCls} />
          </Field>
        </div>
        <Field label="BHK">
          <div className="flex gap-2">
            {['1', '2', '3', '4', '5+'].map((b) => (
              <Chip key={b} active={form.bhk === b} onClick={() => setForm((s) => ({ ...s, bhk: s.bhk === b ? '' : b }))}>
                {b}
              </Chip>
            ))}
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Property type">
            <select value={form.property_type} onChange={(e) => setForm((s) => ({ ...s, property_type: e.target.value }))} className={inputCls}>
              <option value="">—</option>
              <option value="apartment">Apartment</option>
              <option value="villa">Villa</option>
              <option value="plot">Plot</option>
              <option value="commercial">Commercial</option>
            </select>
          </Field>
          <Field label="Financing">
            <select value={form.financing} onChange={(e) => setForm((s) => ({ ...s, financing: e.target.value }))} className={inputCls}>
              <option value="">—</option>
              <option value="cash">Cash</option>
              <option value="loan">Loan</option>
              <option value="undecided">Undecided</option>
            </select>
          </Field>
        </div>
        <Field label="Preferred localities (comma separated)">
          <input value={form.preferred_localities} onChange={(e) => setForm((s) => ({ ...s, preferred_localities: e.target.value }))} placeholder="Baner, Balewadi" className={inputCls} />
        </Field>
        <Field label="Timeline">
          <input value={form.timeline} onChange={(e) => setForm((s) => ({ ...s, timeline: e.target.value }))} placeholder="3 months" className={inputCls} />
        </Field>
        {error && <p className="text-[12px] text-hot bg-amber-wash rounded-xl px-3.5 py-2.5">{error}</p>}
        <div className="flex gap-2">
          <button type="submit" disabled={saving} className="flex-1 bg-brand text-white font-bold text-[13px] rounded-full py-2.5 active:scale-[0.99] transition disabled:opacity-50">
            {saving ? 'Saving…' : 'Save profile'}
          </button>
          <button type="button" onClick={() => setForm(null)} className="px-4 text-[13px] font-bold text-ink-soft rounded-full py-2.5 bg-ink/5 active:scale-[0.99] transition">
            Cancel
          </button>
        </div>
      </form>
    </section>
  )
}

function FollowupsSection({ lead, refresh }) {
  const [adding, setAdding] = useState(false)
  const [dueAt, setDueAt] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState(null)

  const add = async (e) => {
    e.preventDefault()
    if (!dueAt) return
    setError(null)
    try {
      await api.createFollowup({ lead_id: lead.id, due_at: new Date(dueAt).toISOString(), note: note || null })
      setAdding(false)
      setDueAt('')
      setNote('')
      refresh()
    } catch (err) {
      setError(err.message)
    }
  }

  const toggle = async (f) => {
    await api.updateFollowup(f.id, { completed: !f.completed_at })
    refresh()
  }

  return (
    <section className="bg-card rounded-2xl border border-line shadow-card p-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10.5px] font-bold tracking-[0.18em] text-ink-soft">FOLLOW-UPS</p>
        <button onClick={() => setAdding((v) => !v)} className="text-[11.5px] font-bold text-brand underline underline-offset-2">
          {adding ? 'Cancel' : '+ Add'}
        </button>
      </div>
      {adding && (
        <form onSubmit={add} className="space-y-2 mb-3">
          <input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} className={inputCls} required />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className={inputCls} />
          {error && <p className="text-[12px] text-hot bg-amber-wash rounded-xl px-3.5 py-2.5">{error}</p>}
          <button type="submit" className="w-full bg-brand text-white font-bold text-[13px] rounded-full py-2.5 active:scale-[0.99] transition">
            Schedule follow-up
          </button>
        </form>
      )}
      {(lead.followups || []).length === 0 && !adding && (
        <p className="text-[12px] text-ink-faint">No follow-ups yet.</p>
      )}
      <div className="space-y-2">
        {(lead.followups || []).map((f) => {
          const done = Boolean(f.completed_at)
          return (
            <div key={f.id} className="flex items-center gap-2.5">
              <button
                onClick={() => toggle(f)}
                className={`shrink-0 w-5 h-5 rounded-full border-2 text-[11px] leading-none transition active:scale-90 ${
                  done ? 'bg-brand border-brand text-white' : 'border-brand/50 text-transparent'
                }`}
              >
                ✓
              </button>
              <div className="min-w-0 flex-1">
                <p className={`text-[12.5px] ${done ? 'line-through text-ink-faint' : f.overdue ? 'text-hot font-bold' : 'text-ink font-semibold'}`}>
                  {fmtTime(f.due_at)}
                  {f.overdue && !done ? ' · overdue' : ''}
                </p>
                {f.note && <p className={`text-[12px] ${done ? 'text-ink-faint' : 'text-ink-soft'} truncate`}>{f.note}</p>}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function SiteVisitsSection({ lead, refresh }) {
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ scheduled_at: '', property_id: '', pickup_required: false, pickup_location: '' })
  const [properties, setProperties] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => {
    if (adding) api.properties().then(setProperties).catch(() => {})
  }, [adding])

  const add = async (e) => {
    e.preventDefault()
    if (!form.scheduled_at) return
    setError(null)
    try {
      await api.createSiteVisit({
        lead_id: lead.id,
        scheduled_at: new Date(form.scheduled_at).toISOString(),
        property_id: form.property_id ? Number(form.property_id) : null,
        pickup_required: form.pickup_required,
        pickup_location: form.pickup_location || null,
      })
      setAdding(false)
      setForm({ scheduled_at: '', property_id: '', pickup_required: false, pickup_location: '' })
      refresh()
    } catch (err) {
      setError(err.message)
    }
  }

  const setStatus = async (v, status) => {
    await api.updateSiteVisit(v.id, { status })
    refresh()
  }

  return (
    <section className="bg-card rounded-2xl border border-line shadow-card p-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10.5px] font-bold tracking-[0.18em] text-ink-soft">SITE VISITS</p>
        <button onClick={() => setAdding((v) => !v)} className="text-[11.5px] font-bold text-brand underline underline-offset-2">
          {adding ? 'Cancel' : '+ Schedule'}
        </button>
      </div>
      {adding && (
        <form onSubmit={add} className="space-y-2 mb-3">
          <input type="datetime-local" value={form.scheduled_at} onChange={(e) => setForm((s) => ({ ...s, scheduled_at: e.target.value }))} className={inputCls} required />
          <select value={form.property_id} onChange={(e) => setForm((s) => ({ ...s, property_id: e.target.value }))} className={inputCls}>
            <option value="">Property (optional)</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-[13px] text-ink">
            <input type="checkbox" checked={form.pickup_required} onChange={(e) => setForm((s) => ({ ...s, pickup_required: e.target.checked }))} />
            Pickup required
          </label>
          {form.pickup_required && (
            <input value={form.pickup_location} onChange={(e) => setForm((s) => ({ ...s, pickup_location: e.target.value }))} placeholder="Pickup location" className={inputCls} />
          )}
          {error && <p className="text-[12px] text-hot bg-amber-wash rounded-xl px-3.5 py-2.5">{error}</p>}
          <button type="submit" className="w-full bg-brand text-white font-bold text-[13px] rounded-full py-2.5 active:scale-[0.99] transition">
            Schedule visit
          </button>
        </form>
      )}
      {(lead.site_visits || []).length === 0 && !adding && (
        <p className="text-[12px] text-ink-faint">No site visits yet.</p>
      )}
      <div className="space-y-3">
        {(lead.site_visits || []).map((v) => (
          <div key={v.id}>
            <p className="text-[12.5px] font-semibold text-ink">
              {fmtTime(v.scheduled_at)}
              {v.property_title ? ` · ${v.property_title}` : ''}
              {v.pickup_required ? ' · 🚗' : ''}
            </p>
            <div className="flex gap-1.5 flex-wrap mt-1.5">
              {VISIT_STATUSES.map((s) => (
                <button
                  key={s}
                  onClick={() => s !== v.status && setStatus(v, s)}
                  className={`text-[10.5px] font-bold rounded-full px-2.5 py-1 border transition active:scale-95 ${
                    v.status === s ? 'bg-ink text-cream border-ink' : 'bg-card text-ink-soft border-line'
                  }`}
                >
                  {s.replace('_', ' ')}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

export default function LeadDetail({ leadId, onClose, onOpenConversation, onChanged }) {
  const [refreshKey, setRefreshKey] = useState(0)
  const refresh = () => setRefreshKey((k) => k + 1)
  const { data: lead } = usePoll(() => api.lead(leadId), 5000, [leadId, refreshKey])
  const [showStagePicker, setShowStagePicker] = useState(false)

  const breakdown = useMemo(() => {
    if (!lead?.score_breakdown) return []
    try {
      return typeof lead.score_breakdown === 'string' ? JSON.parse(lead.score_breakdown) : lead.score_breakdown
    } catch {
      return []
    }
  }, [lead?.score_breakdown])

  if (!lead)
    return (
      <div className="fixed inset-0 z-50">
        <div className="absolute inset-0 bg-ink/50" onClick={onClose} />
      </div>
    )

  const bltc = [
    ['💬 Summary', lead.ai_summary, null],
    ['📍 Location', lead.locality, lead.location_note],
    ['🏠 Config', lead.config, lead.config_note],
  ]

  const takeOver = async () => {
    if (lead.ai_enabled) await api.setAi(lead.id, false)
    onOpenConversation(lead.id)
  }

  const claim = async () => {
    await api.assignLead(lead.id)
    onChanged?.()
    onClose()
  }

  const unassigned = lead.agent_id == null
  const stage = lead.stage || 'New'

  return (
    <SlideOver onClose={onClose}>
      <div className="sticky top-0 bg-cream/95 backdrop-blur border-b border-line px-5 py-4 flex items-center gap-3 z-10">
        <button onClick={onClose} className="w-9 h-9 rounded-full bg-card border border-line flex items-center justify-center text-ink shadow-card active:scale-95 transition">
          ←
        </button>
        <div className="flex-1 min-w-0">
          <p className="font-display font-semibold text-[18px] text-ink leading-tight truncate">
            {lead.name || lead.wa_id}
          </p>
          <p className="text-[11.5px] text-ink-faint truncate">
            {PIPELINE_LABEL[lead.pipeline_type || 'buy_primary']} · +{lead.wa_id} · {fmtAgo(lead.updated_at)}
          </p>
        </div>
        <ScoreRing score={lead.score} size={48} />
      </div>

      <div className="px-5 py-5 space-y-4 pb-10">
        {!unassigned && (
          <section className="bg-card rounded-2xl border border-line shadow-card p-4 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[10.5px] font-bold tracking-[0.18em] text-ink-soft">PIPELINE STAGE</p>
              <p className={`font-display font-bold text-[17px] mt-1 ${stage === 'Lost' ? 'text-hot' : 'text-ink'}`}>
                {stage}
                {lead.lost_reason ? <span className="text-[12px] text-ink-soft font-normal"> · {lead.lost_reason}</span> : null}
              </p>
            </div>
            <button
              onClick={() => setShowStagePicker(true)}
              className="shrink-0 text-[12.5px] font-bold rounded-full px-4 py-2 bg-brand text-white active:scale-95 transition"
            >
              Move →
            </button>
          </section>
        )}

        {!unassigned && <CrmEditor lead={lead} onSaved={refresh} />}

        {(lead.ai_summary || lead.locality || lead.config) && (
          <section className="bg-brand-wash rounded-2xl border border-brand/20 p-4">
            <p className="text-[10.5px] font-bold tracking-[0.18em] text-brand-deep mb-2">✨ AI CAPTURE</p>
            <dl className="space-y-2">
              {bltc.filter(([, v]) => v).map(([k, v, note]) => (
                <div key={k} className="flex gap-3">
                  <dt className="shrink-0 w-[86px] text-[12px] font-bold text-ink-soft">{k}</dt>
                  <dd className="text-[12.5px] text-ink leading-snug">
                    {v}
                    {note && <span className="text-ink-soft"> — {note}</span>}
                  </dd>
                </div>
              ))}
            </dl>
            {lead.next_step && (
              <p className="text-[12px] text-ink-soft mt-2">
                <strong className="text-ink">Next step:</strong> {lead.next_step}
              </p>
            )}
          </section>
        )}

        {!unassigned && <FollowupsSection lead={lead} refresh={refresh} />}
        {!unassigned && <SiteVisitsSection lead={lead} refresh={refresh} />}

        {breakdown.length > 0 && (
          <section className="bg-card rounded-2xl border border-line shadow-card p-4">
            <p className="text-[10.5px] font-bold tracking-[0.18em] text-ink-soft mb-3">
              SCORE BREAKDOWN · {lead.score}/100
            </p>
            <div className="space-y-3">
              {breakdown.map((s, i) => (
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
        )}

        <section className="bg-card rounded-2xl border border-line shadow-card overflow-hidden">
          <p className="text-[10.5px] font-bold tracking-[0.18em] text-ink-soft px-4 pt-4 pb-2">
            WHATSAPP TRANSCRIPT
          </p>
          <div className="chat-texture px-3 py-3 space-y-2 max-h-[340px] overflow-y-auto no-scrollbar">
            {lead.messages.length === 0 && (
              <p className="text-center text-[12px] text-ink-soft py-3">No messages yet.</p>
            )}
            {lead.messages.map((m) => (
              <div key={m.id} className={`flex ${m.role === 'buyer' ? 'justify-start' : 'justify-end'}`}>
                <div
                  className={`max-w-[82%] rounded-xl px-3 py-2 text-[12.5px] leading-snug shadow-sm whitespace-pre-wrap ${
                    m.role === 'buyer' ? 'bg-white rounded-tl-sm' : 'bg-buyer rounded-tr-sm'
                  }`}
                >
                  {m.text}
                  <span className="block text-right text-[10px] text-ink-faint mt-1">{fmtTime(m.created_at)}</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        {unassigned ? (
          <button
            onClick={claim}
            className="w-full bg-gold hover:brightness-95 text-white font-bold text-[14.5px] rounded-2xl py-4 shadow-float active:scale-[0.98] transition"
          >
            Assign to me ✋
          </button>
        ) : (
          <button
            onClick={takeOver}
            className="w-full bg-brand hover:bg-brand-deep text-white font-bold text-[14.5px] rounded-2xl py-4 shadow-float active:scale-[0.98] transition"
          >
            Take over chat 💬
          </button>
        )}
      </div>

      {showStagePicker && (
        <StagePicker
          lead={lead}
          onClose={() => setShowStagePicker(false)}
          onMoved={() => {
            refresh()
            onChanged?.()
          }}
        />
      )}
    </SlideOver>
  )
}
