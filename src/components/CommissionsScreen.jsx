import { useState } from 'react'
import { api, usePoll, fmtAgo } from '../api.js'
import { paiseToDisplay } from '../money.js'
import { Chip } from './ui.jsx'
import { friendlyMessage } from '../lib/friendlyError.js'
import {
  commissionStatusLabel,
  dealTypeLabel,
  dealStatusLabel,
  invoiceStatusLabel,
  payerLabel,
} from '../lib/labels.js'

const STATUS_STYLE = {
  expected: 'text-ink-soft',
  invoiced: 'text-brand',
  overdue: 'text-hot',
  received: 'text-emerald-600',
}

// Builder receivables ledger with the 0-30 / 31-60 / 61-90 / 90+ aging report.
function Receivables() {
  const { data, error, loading } = usePoll(() => api.builderReceivables(), 8000, [])
  if (loading) return <p className="mt-6 text-[12.5px] text-ink-faint">Loading…</p>
  // Without this the screen sat on "Loading…" for ever whenever the first request
  // failed — the ledger never arrives and nothing ever says why.
  if (!data)
    return (
      <p role="alert" className="mt-6 text-[12.5px] text-hot bg-amber-wash rounded-xl px-4 py-3">
        Couldn't load receivables{error ? `: ${error.message}` : ''}
      </p>
    )
  const { builders, totals, received_paise } = data
  if (!builders.length) {
    return (
      <p className="mt-6 text-[12.5px] text-ink-faint">
        No builder receivables yet. They appear once a deal has a builder-paid commission.
      </p>
    )
  }
  const Bucket = ({ label, paise, tone }) => (
    <div className="flex-1 text-center">
      <p className={`text-[13px] font-bold tabular-nums ${tone}`}>{paiseToDisplay(paise) || '₹ 0'}</p>
      <p className="text-[10px] text-ink-faint mt-0.5">{label}</p>
    </div>
  )
  return (
    <div className="mt-4 space-y-3">
      <div className="bg-ink text-cream rounded-2xl px-4 py-3.5 shadow-card">
        <p className="text-[11px] uppercase tracking-wide opacity-70">Total outstanding</p>
        <p className="text-[22px] font-display font-semibold tabular-nums">{paiseToDisplay(totals.total_paise) || '₹ 0'}</p>
        <p className="text-[11px] opacity-70 mt-0.5">
          {totals.count} receivable{totals.count === 1 ? '' : 's'} · {paiseToDisplay(received_paise) || '₹ 0'} received
        </p>
      </div>
      {builders.map((b) => (
        <div key={b.builder_name} className="bg-card rounded-2xl border border-line shadow-card px-4 py-3.5">
          <div className="flex items-baseline justify-between">
            <p className="font-bold text-[14px] text-ink">🏗️ {b.builder_name}</p>
            <p className="text-[14px] font-bold tabular-nums text-ink">{paiseToDisplay(b.total_paise)}</p>
          </div>
          <div className="flex gap-1 mt-3">
            <Bucket label="On time" paise={b.b_0_30} tone="text-ink" />
            <Bucket label="A bit late" paise={b.b_31_60} tone="text-amber-600" />
            <Bucket label="Overdue" paise={b.b_61_90} tone="text-orange-600" />
            <Bucket label="Very overdue" paise={b.b_90_plus} tone="text-hot" />
          </div>
        </div>
      ))}
    </div>
  )
}

// Captured deals — auto-created at the booking stage, or added by hand.
function Deals({ onOpenLead }) {
  const [filter, setFilter] = useState('open') // open | won | all
  const { data: deals } = usePoll(
    () => api.deals(filter === 'all' ? {} : { status: filter }),
    8000,
    [filter],
  )
  return (
    <div>
      <div className="flex gap-2 mt-4">
        {['open', 'won', 'all'].map((f) => (
          <Chip key={f} active={filter === f} onClick={() => setFilter(f)}>
            {f[0].toUpperCase() + f.slice(1)}
          </Chip>
        ))}
      </div>
      {deals && deals.length === 0 && (
        <p className="mt-6 text-[12.5px] text-ink-faint">
          No deals yet — auto-captured at Token/Booking stage.
        </p>
      )}
      <div className="mt-4 space-y-2.5">
        {(deals || []).map((d) => (
          <button
            key={d.id}
            onClick={() => onOpenLead(d.lead_id)}
            className="w-full text-left bg-card rounded-2xl border border-line shadow-card px-4 py-3.5 active:scale-[0.99] transition"
          >
            <div className="flex items-baseline justify-between">
              <p className="font-bold text-[14px] text-ink truncate">
                {d.lead_name || d.lead_wa_id}
                {d.property_title ? <span className="text-ink-soft font-semibold"> · {d.property_title}</span> : null}
              </p>
              <span className="shrink-0 text-[10.5px] font-bold rounded-full px-2 py-0.5 bg-cream border border-line text-ink-soft">
                {dealTypeLabel(d.deal_type)}
              </span>
            </div>
            <p className="text-[12px] text-ink-soft mt-0.5">
              {d.deal_type === 'rental'
                ? `${paiseToDisplay(d.monthly_rent_paise) || '—'}/mo`
                : paiseToDisplay(d.deal_value_paise) || '—'}
              {d.builder_name ? ` · ${d.builder_name}` : ''} · {dealStatusLabel(d.status)} · {fmtAgo(d.created_at)}
            </p>
          </button>
        ))}
      </div>
    </div>
  )
}

// Commissions list, with a one-tap GST invoice action.
function Commissions() {
  const [filter, setFilter] = useState('') // '' = all
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const { data: commissions, refresh } = usePoll(
    () => api.commissions(filter || undefined),
    8000,
    [filter],
  )

  const raiseInvoice = async (c) => {
    setBusy(c.id)
    setError(null)
    try {
      await api.createCommissionInvoice(c.id)
      refresh()
    } catch (e) {
      setError(friendlyMessage(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      <div className="flex gap-2 mt-4 overflow-x-auto pb-1">
        {['', 'expected', 'invoiced', 'overdue', 'received'].map((f) => (
          <Chip key={f || 'all'} active={filter === f} onClick={() => setFilter(f)}>
            {f ? f[0].toUpperCase() + f.slice(1) : 'All'}
          </Chip>
        ))}
      </div>
      {commissions && commissions.length === 0 && (
        <p className="mt-6 text-[12.5px] text-ink-faint">No commissions yet.</p>
      )}
      {error && <p className="mt-4 text-[12.5px] text-hot bg-amber-wash rounded-xl px-3.5 py-2.5">{error}</p>}
      <div className="mt-4 space-y-2.5">
        {(commissions || []).map((c) => (
          <div key={c.id} className="bg-card rounded-2xl border border-line shadow-card px-4 py-3.5">
            <div className="flex items-baseline justify-between">
              <p className="font-bold text-[14px] tabular-nums text-ink">{paiseToDisplay(c.amount_paise) || '—'}</p>
              <span className={`text-[11px] font-bold ${STATUS_STYLE[c.status] || 'text-ink-soft'}`}>{commissionStatusLabel(c.status)}</span>
            </div>
            <p className="text-[12px] text-ink-soft mt-0.5">
              {payerLabel(c.payer_type)}
              {c.builder_name ? ` · ${c.builder_name}` : ''}
              {c.commission_pct ? ` · ${c.commission_pct}%` : ''}
              {c.expected_payout_date ? ` · due ${c.expected_payout_date}` : ''}
            </p>
            {(c.status === 'expected' || c.status === 'overdue') && c.amount_paise > 0 && (
              <button
                onClick={() => raiseInvoice(c)}
                disabled={busy === c.id}
                className="mt-2 text-[11.5px] font-bold rounded-full px-3 py-1.5 bg-brand text-white active:scale-95 transition disabled:opacity-50"
              >
                {busy === c.id ? 'Raising…' : 'Raise GST invoice'}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// GST invoices ledger with a mark-paid action.
function Invoices() {
  const { data: invoices, refresh } = usePoll(() => api.commissionInvoices({}), 8000, [])
  const markPaid = async (inv) => {
    await api.updateCommissionInvoice(inv.id, { status: 'paid' })
    refresh()
  }
  if (invoices && invoices.length === 0) {
    return <p className="mt-6 text-[12.5px] text-ink-faint">No invoices. Raise one from a commission.</p>
  }
  return (
    <div className="mt-4 space-y-2.5">
      {(invoices || []).map((inv) => (
        <div key={inv.id} className="bg-card rounded-2xl border border-line shadow-card px-4 py-3.5">
          <div className="flex items-baseline justify-between">
            <p className="font-bold text-[13px] text-ink">{inv.invoice_number}</p>
            <span className={`text-[11px] font-bold ${inv.status === 'paid' ? 'text-emerald-600' : inv.status === 'cancelled' ? 'text-ink-faint' : 'text-brand'}`}>
              {invoiceStatusLabel(inv.status)}
            </span>
          </div>
          <p className="text-[12px] text-ink-soft mt-0.5">
            {inv.lead_name || inv.lead_wa_id} · {paiseToDisplay(inv.subtotal_paise)} + {inv.gst_rate}% GST ={' '}
            <span className="font-bold text-ink tabular-nums">{paiseToDisplay(inv.total_paise)}</span>
          </p>
          {inv.status === 'issued' && (
            <button
              onClick={() => markPaid(inv)}
              className="mt-2 text-[11.5px] font-bold rounded-full px-3 py-1.5 bg-ink text-cream active:scale-95 transition"
            >
              Mark paid
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

const VIEWS = [
  { id: 'receivables', label: 'Receivables' },
  { id: 'deals', label: 'Deals' },
  { id: 'commissions', label: 'Commissions' },
  { id: 'invoices', label: 'Invoices' },
]

export default function CommissionsScreen({ onOpenLead = () => {} }) {
  const [view, setView] = useState('receivables')
  return (
    <div className="mt-2">
      <div className="flex gap-2 overflow-x-auto pb-1">
        {VIEWS.map((v) => (
          <Chip key={v.id} active={view === v.id} onClick={() => setView(v.id)}>
            {v.label}
          </Chip>
        ))}
      </div>
      {view === 'receivables' && <Receivables />}
      {view === 'deals' && <Deals onOpenLead={onOpenLead} />}
      {view === 'commissions' && <Commissions />}
      {view === 'invoices' && <Invoices />}
    </div>
  )
}
