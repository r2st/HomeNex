import { useEffect, useMemo, useState } from 'react'
import { api, usePoll, fmtAgo, fmtTime } from '../api.js'
import { paiseRangeToDisplay, paiseToDisplay, lakhsToPaise, paiseToLakhs } from '../money.js'
import { ScoreRing, SlideOver, Sheet, Chip, Field, inputCls, InfoTip } from './ui.jsx'
import { buyerProfileIsEmpty } from '../lib/buyerProfile.js'
import { shouldShowScoreBreakdown } from '../lib/scoreDisplay.js'
import { glossary } from '../lib/glossary.js'
import { visitStatusLabel } from '../lib/labels.js'

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

// Where the lead came from (migration 010). Drives the source banner + CTWA window.
const SOURCE_ICON = {
  whatsapp: '💬', portal_email: '📧', portal_api: '🔌', meta_lead_ad: '📣', ctwa: '📣', walk_in: '🚶', phone: '📞', referral: '🤝',
}
const SOURCE_LABEL = {
  whatsapp: 'WhatsApp', portal_email: 'Portal email', portal_api: 'Portal push',
  meta_lead_ad: 'Facebook / Instagram Lead Ad', ctwa: 'Click-to-WhatsApp ad', walk_in: 'Walk-in', phone: 'Phone', referral: 'Referral',
}

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

// AI auto-fill: field values the AI extracted from the conversation that differ
// from what's on the lead card. The agent accepts or rejects each one — nothing is
// ever written automatically. Renders nothing when the AI has no new suggestions.
function AutofillCard({ lead, refreshKey, onApplied }) {
  const [suggestions, setSuggestions] = useState([])
  const [busy, setBusy] = useState(null)

  useEffect(() => {
    let live = true
    api
      .autofill(lead.id)
      .then((r) => live && setSuggestions(r.suggestions || []))
      .catch(() => live && setSuggestions([]))
    return () => {
      live = false
    }
  }, [lead.id, refreshKey])

  const reject = (field) => setSuggestions((s) => s.filter((x) => x.field !== field))

  const accept = async (sug) => {
    setBusy(sug.field)
    try {
      const updated = await api.applyAutofill(lead.id, { [sug.field]: sug.suggested })
      reject(sug.field)
      onApplied?.(updated)
    } catch {
      // Leave the suggestion in place so the agent can retry.
    } finally {
      setBusy(null)
    }
  }

  if (!suggestions.length) return null

  return (
    <section className="bg-card rounded-2xl border border-line shadow-card p-4">
      <p className="text-[10.5px] font-bold tracking-[0.18em] text-brand mb-1">✨ AI SUGGESTIONS</p>
      <p className="text-[11.5px] text-ink-soft mb-3">From the conversation — tap ✓ to fill the lead card, ✕ to dismiss.</p>
      <ul className="space-y-2">
        {suggestions.map((s) => (
          <li key={s.field} className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-bold text-ink-soft">{s.label}</p>
              <p className="text-[12.5px] text-ink truncate">
                {s.suggested_display}
                {s.current != null && s.current !== '' && (
                  <span className="text-ink-faint"> (was {Array.isArray(s.current) ? s.current.join(', ') : String(s.current)})</span>
                )}
              </p>
            </div>
            <button
              onClick={() => accept(s)}
              disabled={busy === s.field}
              className="shrink-0 h-7 w-7 rounded-full bg-brand text-white font-bold disabled:opacity-50"
              aria-label={`Accept ${s.label}`}
            >
              ✓
            </button>
            <button
              onClick={() => reject(s.field)}
              disabled={busy === s.field}
              className="shrink-0 h-7 w-7 rounded-full border border-line text-ink-soft font-bold disabled:opacity-50"
              aria-label={`Reject ${s.label}`}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </section>
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
    const empty = buyerProfileIsEmpty(lead)
    return (
      <section className="bg-card rounded-2xl border border-line shadow-card p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-[10.5px] font-bold tracking-[0.18em] text-brand">BUYER PROFILE</p>
          <button onClick={startEdit} className="text-[11.5px] font-bold text-brand underline underline-offset-2">
            {empty ? 'Add details' : 'Edit'}
          </button>
        </div>
        {empty ? (
          <div className="rounded-xl bg-brand-wash/60 border border-brand/15 px-3.5 py-3">
            <p className="text-[12.5px] text-ink leading-snug">
              <span className="mr-1">✨</span>
              Budget, location and configuration will be captured automatically as this buyer chats.
            </p>
            <p className="text-[11.5px] text-ink-soft leading-snug mt-1">
              You can also tap <strong className="text-brand">Add details</strong> to fill them in now.
            </p>
          </div>
        ) : (
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
        )}
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

// One-tap follow-up presets. Date-based presets land at 10am local (agents call in
// the morning); "Custom" opens the datetime picker.
function presetDate(kind) {
  const d = new Date()
  d.setSeconds(0, 0)
  if (kind === 'tomorrow') {
    d.setDate(d.getDate() + 1)
    d.setHours(10, 0)
  } else if (kind === '3days') {
    d.setDate(d.getDate() + 3)
    d.setHours(10, 0)
  } else if (kind === 'nextweek') {
    d.setDate(d.getDate() + 7)
    d.setHours(10, 0)
  }
  return d
}

const FOLLOWUP_PRESETS = [
  { kind: 'tomorrow', label: 'Tomorrow 10am' },
  { kind: '3days', label: 'In 3 days' },
  { kind: 'nextweek', label: 'Next week' },
]

function FollowupsSection({ lead, refresh }) {
  const [custom, setCustom] = useState(false)
  const [dueAt, setDueAt] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState(null)

  const schedule = async (due, followupNote) => {
    setError(null)
    try {
      await api.createFollowup({ lead_id: lead.id, due_at: due.toISOString(), note: followupNote || null })
      setCustom(false)
      setDueAt('')
      setNote('')
      refresh()
    } catch (err) {
      setError(err.message)
    }
  }

  const add = async (e) => {
    e.preventDefault()
    if (!dueAt) return
    await schedule(new Date(dueAt), note)
  }

  const toggle = async (f) => {
    await api.updateFollowup(f.id, { completed: !f.completed_at })
    refresh()
  }

  return (
    <section className="bg-card rounded-2xl border border-line shadow-card p-4">
      <p className="text-[10.5px] font-bold tracking-[0.18em] text-ink-soft mb-2">FOLLOW-UPS</p>
      {/* One-tap presets — the fastest path; "Custom" reveals the datetime picker. */}
      <div className="flex gap-1.5 flex-wrap mb-3">
        {FOLLOWUP_PRESETS.map((p) => (
          <button
            key={p.kind}
            onClick={() => schedule(presetDate(p.kind), null)}
            className="text-[11.5px] font-bold rounded-full px-3 py-1.5 border border-line bg-card text-ink-soft active:scale-95 transition"
          >
            {p.label}
          </button>
        ))}
        <button
          onClick={() => setCustom((v) => !v)}
          className={`text-[11.5px] font-bold rounded-full px-3 py-1.5 border transition active:scale-95 ${
            custom ? 'bg-brand text-white border-brand' : 'border-line bg-card text-ink-soft'
          }`}
        >
          Custom
        </button>
      </div>
      {custom && (
        <form onSubmit={add} className="space-y-2 mb-3">
          <input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} className={inputCls} required />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className={inputCls} />
          {error && <p className="text-[12px] text-hot bg-amber-wash rounded-xl px-3.5 py-2.5">{error}</p>}
          <button type="submit" className="w-full bg-brand text-white font-bold text-[13px] rounded-full py-2.5 active:scale-[0.99] transition">
            Schedule follow-up
          </button>
        </form>
      )}
      {error && !custom && <p className="text-[12px] text-hot bg-amber-wash rounded-xl px-3.5 py-2.5 mb-3">{error}</p>}
      {(lead.followups || []).length === 0 && !custom && (
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
                  {visitStatusLabel(s)}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

// Quick match: inventory that fits this lead's budget / BHK / locality, each with a
// one-tap "Send" that pushes the property card into the WhatsApp conversation.
function QuickMatchSection({ lead }) {
  const [matches, setMatches] = useState(null)
  const [sent, setSent] = useState({})
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    api.leadPropertyMatches(lead.id).then((m) => alive && setMatches(m)).catch(() => alive && setMatches([]))
    return () => { alive = false }
  }, [lead.id])

  const send = async (p) => {
    setError(null)
    setSent((s) => ({ ...s, [p.id]: 'sending' }))
    try {
      await api.sendPropertyToChat(p.id, lead.id)
      setSent((s) => ({ ...s, [p.id]: 'sent' }))
    } catch (err) {
      setError(err.message)
      setSent((s) => ({ ...s, [p.id]: undefined }))
    }
  }

  if (!matches || matches.length === 0) return null
  return (
    <section className="bg-card rounded-2xl border border-line shadow-card p-4">
      <p className="text-[10.5px] font-bold tracking-[0.18em] text-ink-soft mb-1">🎯 MATCHING INVENTORY</p>
      <p className="text-[11.5px] text-ink-faint mb-3">Fits this buyer's budget, BHK & locality.</p>
      {error && <p className="text-[12px] text-hot bg-amber-wash rounded-xl px-3.5 py-2.5 mb-3">{error}</p>}
      <div className="space-y-2">
        {matches.slice(0, 5).map((p) => {
          const spec = [p.bhk && `${p.bhk} BHK`, p.property_type, p.locality].filter(Boolean).join(' · ')
          const state = sent[p.id]
          return (
            <div key={p.id} className="flex items-center gap-2.5 border border-line rounded-xl px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] font-bold text-ink truncate">{p.title}</p>
                <p className="text-[11.5px] text-ink-soft truncate">
                  {[spec, p.price_paise != null && paiseToDisplay(p.price_paise)].filter(Boolean).join(' · ')}
                </p>
                {Array.isArray(p.match_reasons) && p.match_reasons.length > 0 && (
                  <p className="text-[10.5px] text-brand-deep truncate mt-0.5">✓ {p.match_reasons.join(' · ')}</p>
                )}
              </div>
              <button
                onClick={() => !state && send(p)}
                disabled={state === 'sending' || state === 'sent'}
                className={`shrink-0 text-[11.5px] font-bold rounded-full px-3 py-1.5 transition active:scale-95 ${
                  state === 'sent' ? 'bg-brand-wash text-brand-deep' : 'bg-brand text-white'
                }`}
              >
                {state === 'sent' ? '✓ Sent' : state === 'sending' ? '…' : 'Send'}
              </button>
            </div>
          )
        })}
      </div>
    </section>
  )
}

// "Before you call" — rule-based talking points, the decayed score, and how long
// it's been. Server-computed (no LLM), so it's instant and always fresh.
const TONE_STYLE = {
  urgent: 'border-l-hot bg-amber-wash',
  hot: 'border-l-hot bg-amber-wash',
  warm: 'border-l-brand bg-brand-wash',
  info: 'border-l-ink-faint bg-cream',
}
function BriefingPanel({ leadId, refreshKey }) {
  const [b, setB] = useState(null)
  useEffect(() => {
    let alive = true
    api.briefing(leadId).then((d) => alive && setB(d)).catch(() => {})
    return () => { alive = false }
  }, [leadId, refreshKey])
  if (!b || !b.talking_points?.length) return null
  return (
    <section className="bg-card rounded-2xl border border-line shadow-card p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[10.5px] font-bold tracking-[0.18em] text-ink-soft">📞 BEFORE YOU CALL</p>
        <div className="flex items-center gap-2 text-[11px] font-bold">
          {b.temperature && (
            <span className={`rounded-full px-2 py-0.5 uppercase ${b.temperature === 'Hot' ? 'text-hot bg-amber-wash' : b.temperature === 'Warm' ? 'text-brand-deep bg-brand-wash' : 'text-ink-faint bg-cream'}`}>
              {b.temperature} {b.score != null ? b.score : ''}
            </span>
          )}
          {b.days_since_last_contact != null && (
            <span className="text-ink-faint">{b.days_since_last_contact === 0 ? 'today' : `${b.days_since_last_contact}d ago`}</span>
          )}
        </div>
      </div>
      <ul className="space-y-2">
        {b.talking_points.map((p, i) => (
          <li key={i} className={`text-[12.5px] text-ink leading-snug border-l-2 pl-3 py-1 rounded-r ${TONE_STYLE[p.tone] || TONE_STYLE.info}`}>
            {p.text}
          </li>
        ))}
      </ul>
      {b.missing_bltc?.length > 0 && (
        <p className="text-[11.5px] text-ink-soft mt-3">
          <strong className="text-ink">Still to learn:</strong> {b.missing_bltc.join(' · ')}
        </p>
      )}
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
    ['🎯 Intent', lead.intent && lead.intent[0].toUpperCase() + lead.intent.slice(1), null],
    ['📍 Location', lead.locality, lead.location_note],
    ['🏠 Config', lead.config, lead.config_note],
  ]

  const AI_SCORE_STYLE = {
    hot: 'bg-amber-wash text-hot border-amber/40',
    warm: 'bg-brand-wash text-brand-deep border-brand/30',
    cold: 'bg-cream text-ink-faint border-line',
  }

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
        {(lead.source_channel || lead.free_entry_window) && (
          <section className="bg-card rounded-2xl border border-line shadow-card p-4">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="text-[18px]">{SOURCE_ICON[lead.source_channel] || '💬'}</span>
              <div className="min-w-0">
                <p className="text-[10.5px] font-bold tracking-[0.18em] text-ink-soft flex items-center gap-1.5">
                  LEAD SOURCE
                  {(lead.source_channel === 'ctwa' || lead.source_channel === 'meta_lead_ad') && (
                    <InfoTip label="" text={glossary.CTWA} align="left" />
                  )}
                  {(lead.source_channel === 'portal_email' || lead.source_channel === 'portal_api') && (
                    <InfoTip label="" text={glossary.PORTAL} align="left" />
                  )}
                </p>
                <p className="text-[13px] font-bold text-ink truncate">
                  {SOURCE_LABEL[lead.source_channel] || 'WhatsApp'}
                  {lead.source_portal ? ` · ${lead.source_portal}` : ''}
                </p>
                {lead.source_ref && <p className="text-[11.5px] text-ink-soft truncate">Enquired: {lead.source_ref}</p>}
              </div>
            </div>
            {lead.free_entry_window && (
              <div className={`mt-2.5 rounded-xl px-3 py-2 text-[12px] font-semibold leading-snug ${lead.free_entry_window.open ? 'bg-brand-wash text-brand-deep' : 'bg-cream text-ink-faint'}`}>
                {lead.free_entry_window.open
                  ? `🎁 You can reply free for 72 hours — ${lead.free_entry_window.hours_left}h left. No approved message needed.`
                  : 'The 72-hour free-reply time is up — you can only send one of your approved messages now.'}
              </div>
            )}
          </section>
        )}

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

        {!unassigned && <BriefingPanel leadId={lead.id} refreshKey={refreshKey} />}

        {!unassigned && <AutofillCard lead={lead} refreshKey={refreshKey} onApplied={refresh} />}

        {!unassigned && <CrmEditor lead={lead} onSaved={refresh} />}

        {(lead.ai_summary || lead.locality || lead.config || lead.intent || lead.ai_score) && (
          <section className="bg-brand-wash rounded-2xl border border-brand/20 p-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10.5px] font-bold tracking-[0.18em] text-brand-deep">✨ AI CAPTURE</p>
              {lead.ai_score && (
                <span className={`text-[10.5px] font-bold border rounded-full px-2.5 py-0.5 uppercase ${AI_SCORE_STYLE[lead.ai_score] || AI_SCORE_STYLE.cold}`}>
                  {lead.ai_score}
                </span>
              )}
            </div>
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
            {lead.ai_score_reason && (
              <p className="text-[12px] text-ink-soft mt-2">
                <strong className="text-ink">Why {lead.ai_score}:</strong> {lead.ai_score_reason}
              </p>
            )}
            {lead.next_step && (
              <p className="text-[12px] text-ink-soft mt-2">
                <strong className="text-ink">Next step:</strong> {lead.next_step}
              </p>
            )}
          </section>
        )}

        {!unassigned && <QuickMatchSection lead={lead} />}
        {!unassigned && <FollowupsSection lead={lead} refresh={refresh} />}
        {!unassigned && <SiteVisitsSection lead={lead} refresh={refresh} />}

        {breakdown.length > 0 && !shouldShowScoreBreakdown(lead.score, breakdown) && (
          <section className="bg-card rounded-2xl border border-line shadow-card p-4">
            <p className="text-[10.5px] font-bold tracking-[0.18em] text-ink-soft mb-1.5">LEAD SCORE</p>
            <p className="text-[12.5px] text-ink leading-snug">
              Not enough data yet — the score sharpens as {lead.name || 'this buyer'} shares budget,
              location and timeline.
            </p>
          </section>
        )}

        {shouldShowScoreBreakdown(lead.score, breakdown) && (
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
