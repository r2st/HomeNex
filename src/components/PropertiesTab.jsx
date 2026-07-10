import { useState } from 'react'
import { api, usePoll } from '../api.js'
import { paiseToDisplay, lakhsToPaise } from '../money.js'
import { Chip, Sheet, inputCls } from './ui.jsx'
import PropertyDetail, { PropertyForm, STATUS_LABEL } from './PropertyDetail.jsx'

const TYPE_FILTERS = [
  { id: '', label: 'All' },
  { id: 'apartment', label: 'Apartment' },
  { id: 'villa', label: 'Villa' },
  { id: 'plot', label: 'Plot' },
  { id: 'commercial', label: 'Commercial' },
]

const PRICE_BANDS = [
  { id: '', label: 'Any price' },
  { id: '0-50', label: '< ₹50L' },
  { id: '50-100', label: '₹50L–1Cr' },
  { id: '100-250', label: '₹1–2.5Cr' },
  { id: '250-', label: '> ₹2.5Cr' },
]

const STATUS_ICON = { available: '🟢', token: '🟡', sold: '⚪', rented: '⚪' }

export default function PropertiesTab({ onOpenLead }) {
  const [filters, setFilters] = useState({ type: '', bhk: '', status: '', band: '', q: '' })
  const [adding, setAdding] = useState(false)
  const [saving, setSaving] = useState(false)
  const [addError, setAddError] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const refresh = () => setRefreshKey((k) => k + 1)

  const [bandMin, bandMax] = filters.band ? filters.band.split('-') : ['', '']
  const { data: properties, error } = usePoll(
    () =>
      api.properties({
        type: filters.type,
        bhk: filters.bhk,
        status: filters.status,
        q: filters.q,
        min_price: bandMin ? lakhsToPaise(Number(bandMin)) : '',
        max_price: bandMax ? lakhsToPaise(Number(bandMax)) : '',
      }),
    8000,
    [JSON.stringify(filters), refreshKey],
  )

  const create = async (fields) => {
    setSaving(true)
    setAddError(null)
    try {
      await api.createProperty(fields)
      setAdding(false)
      refresh()
    } catch (err) {
      setAddError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="px-5 pt-7">
      <header className="rise flex items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-[28px] font-semibold text-ink">Properties</h1>
          <p className="text-[13px] text-ink-soft mt-0.5">
            {properties ? `${properties.length} in your inventory` : 'Loading…'}
          </p>
        </div>
        <button
          onClick={() => setAdding(true)}
          className="shrink-0 mt-1 text-[13px] font-bold rounded-full px-4 py-2 bg-brand text-white shadow-card active:scale-95 transition"
        >
          + Add
        </button>
      </header>

      {error && (
        <p className="mt-6 text-[12.5px] text-hot bg-amber-wash rounded-xl px-4 py-3">
          Can't reach the HomeNex server: {error.message}
        </p>
      )}

      <input
        value={filters.q}
        onChange={(e) => setFilters((s) => ({ ...s, q: e.target.value }))}
        placeholder="Search title, locality, builder…"
        className={`${inputCls} mt-4`}
      />

      <div className="flex gap-2 mt-3 overflow-x-auto no-scrollbar rise rise-1">
        {TYPE_FILTERS.map((t) => (
          <Chip key={t.id} active={filters.type === t.id} onClick={() => setFilters((s) => ({ ...s, type: t.id }))}>
            {t.label}
          </Chip>
        ))}
      </div>
      <div className="flex gap-2 mt-2 overflow-x-auto no-scrollbar">
        {PRICE_BANDS.map((b) => (
          <Chip key={b.id} active={filters.band === b.id} onClick={() => setFilters((s) => ({ ...s, band: b.id }))}>
            {b.label}
          </Chip>
        ))}
      </div>
      <div className="flex gap-2 mt-2 overflow-x-auto no-scrollbar">
        {['', '1', '2', '3', '4'].map((b) => (
          <Chip key={b || 'any'} active={filters.bhk === b} onClick={() => setFilters((s) => ({ ...s, bhk: b }))}>
            {b ? `${b} BHK` : 'Any BHK'}
          </Chip>
        ))}
        {['', 'available', 'token', 'sold'].map((st) => (
          <Chip key={st || 'anyst'} active={filters.status === st} onClick={() => setFilters((s) => ({ ...s, status: st }))}>
            {st ? STATUS_LABEL[st] : 'Any status'}
          </Chip>
        ))}
      </div>

      {properties && properties.length === 0 && (
        <div className="mt-6 bg-card rounded-2xl border border-line shadow-card p-5 rise rise-2">
          <p className="font-bold text-[14.5px] text-ink">No properties yet</p>
          <p className="text-[12.5px] text-ink-soft leading-relaxed mt-1.5">
            Add the flats, villas, and plots you're authorised to sell. One tap sends a
            formatted property card to any lead on WhatsApp.
          </p>
          <button onClick={() => setAdding(true)} className="inline-block mt-3 text-[12.5px] font-bold text-brand">
            Add your first property →
          </button>
        </div>
      )}

      <div className="space-y-2.5 mt-4">
        {(properties || []).map((p, i) => (
          <button
            key={p.id}
            onClick={() => setSelectedId(p.id)}
            className={`w-full text-left bg-card rounded-2xl border border-line shadow-card px-4 py-3.5 active:scale-[0.99] transition rise rise-${Math.min(i + 1, 5)}`}
          >
            <div className="flex items-center gap-3">
              {p.photos?.[0] ? (
                <img src={p.photos[0]} alt="" className="shrink-0 w-14 h-14 rounded-xl border border-line object-cover" />
              ) : (
                <span className="shrink-0 w-14 h-14 rounded-xl bg-brand-wash flex items-center justify-center text-[22px]">🏠</span>
              )}
              <div className="min-w-0 flex-1">
                <p className="font-bold text-[14px] text-ink truncate">{p.title}</p>
                <p className="text-[12px] text-ink-soft truncate mt-0.5">
                  {[p.bhk && `${p.bhk} BHK`, p.property_type, p.locality].filter(Boolean).join(' · ')}
                </p>
                <p className="text-[11px] text-ink-faint mt-0.5">
                  {STATUS_ICON[p.status] || ''} {STATUS_LABEL[p.status] || p.status}
                  {p.rera_project_number ? ' · RERA ✓' : ''}
                </p>
              </div>
              <span className="shrink-0 font-display font-bold text-[15px] text-brand-deep">
                {paiseToDisplay(p.price_paise) || '—'}
              </span>
            </div>
          </button>
        ))}
      </div>

      {adding && (
        <Sheet onClose={() => setAdding(false)} title="Add property">
          <PropertyForm onSave={create} onCancel={() => setAdding(false)} saving={saving} error={addError} />
        </Sheet>
      )}

      {selectedId && (
        <PropertyDetail propertyId={selectedId} onClose={() => setSelectedId(null)} onChanged={refresh} onOpenLead={onOpenLead} />
      )}
    </div>
  )
}
