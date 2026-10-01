import { useState } from 'react'
import { api, usePoll } from '../api.js'
import { paiseToDisplay, lakhsToPaise } from '../money.js'
import { Chip, Sheet, inputCls, LoadingRows, ErrorBanner } from './ui.jsx'
import PropertyDetail, { PropertyForm, STATUS_LABEL } from './PropertyDetail.jsx'
import { activeFilterCount, clearedFilters } from '../lib/propertyFilters.js'

const BHK_FILTERS = ['', '1', '2', '3', '4']
const STATUS_FILTERS = ['', 'available', 'token', 'sold']

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

// A labelled row of filter chips inside the Filters sheet.
function FilterGroup({ label, children }) {
  return (
    <div>
      <p className="text-[11.5px] font-bold text-ink-soft mb-2">{label}</p>
      <div className="flex gap-2 flex-wrap">{children}</div>
    </div>
  )
}

export default function PropertiesTab({ onOpenLead }) {
  const [filters, setFilters] = useState({ type: '', bhk: '', status: '', band: '', q: '' })
  const [showFilters, setShowFilters] = useState(false)
  const [adding, setAdding] = useState(false)
  const [saving, setSaving] = useState(false)
  const [addError, setAddError] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const filterCount = activeFilterCount(filters)
  const [bandMin, bandMax] = filters.band ? filters.band.split('-') : ['', '']
  const serverFilters = {
    type: filters.type,
    bhk: filters.bhk,
    status: filters.status,
    q: filters.q,
    min_price: bandMin ? lakhsToPaise(Number(bandMin)) : '',
    max_price: bandMax ? lakhsToPaise(Number(bandMax)) : '',
  }
  const { data: properties, error, loading, refresh } = usePoll(
    () => api.properties(serverFilters),
    8000,
    [JSON.stringify(filters)],
  )
  // The list is one page now, so its length is no longer the total. Polled less often
  // than the list because a property that fell off the end of page one is not news.
  const { data: count } = usePoll(() => api.propertyCount(serverFilters), 20000, [JSON.stringify(filters)])
  const total = count?.total ?? null
  const shown = properties?.length ?? 0

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
            {total === null
              ? 'Loading…'
              : `${total.toLocaleString('en-IN')} ${filterCount > 0 || filters.q ? 'matching' : 'in your inventory'}`}
          </p>
        </div>
        <button
          onClick={() => setAdding(true)}
          className="shrink-0 mt-1 text-[13px] font-bold rounded-full px-4 py-2 bg-brand text-white shadow-card active:scale-95 transition"
        >
          + Add
        </button>
      </header>

      <ErrorBanner error={error} className="mt-6" />

      {/* The placeholder is short enough to fit the box it sits in. At 375px — the
          phone this is built for — the field shares its row with the Filters button
          and gets 208px of inner width; "Search title, locality, builder…" measured
          212px and clipped mid-word to "…locality, builde", which reads as a broken
          control rather than a hint. The leading "Search" is the part worth losing:
          the input is type="search" and already names itself "Search properties" to
          a screen reader, so dropping it keeps every searchable field listed. */}
      <div className="flex items-center gap-2 mt-4">
        <input
          type="search"
          aria-label="Search properties"
          value={filters.q}
          onChange={(e) => setFilters((s) => ({ ...s, q: e.target.value }))}
          placeholder="Title, locality or builder…"
          className={`${inputCls} flex-1`}
        />
        <button
          onClick={() => setShowFilters(true)}
          className={`shrink-0 flex items-center gap-1.5 text-[12.5px] font-bold rounded-xl px-3.5 py-2.5 border transition active:scale-95 ${
            filterCount > 0 ? 'bg-brand text-white border-brand' : 'bg-card text-ink-soft border-line'
          }`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
            <path d="M3 5h18M6 12h12M10 19h4" />
          </svg>
          Filters
          {filterCount > 0 && (
            <span className="ml-0.5 min-w-[18px] text-center text-[10.5px] font-bold bg-white/25 rounded-full px-1">
              {filterCount}
            </span>
          )}
        </button>
      </div>
      {filterCount > 0 && (
        <button
          onClick={() => setFilters((s) => clearedFilters(s))}
          className="mt-2 text-[11.5px] font-bold text-brand active:scale-95 transition"
        >
          Clear all filters
        </button>
      )}

      {properties && properties.length === 0 && (
        <div className="mt-6 bg-card rounded-2xl border border-line shadow-card p-5 rise rise-2">
          <span className="text-[26px]">🏠</span>
          <p className="font-bold text-[14.5px] text-ink mt-2">
            {filterCount > 0 || filters.q ? 'No properties match these filters' : 'No properties yet'}
          </p>
          {filterCount > 0 || filters.q ? (
            <>
              <p className="text-[12.5px] text-ink-soft mt-1.5">Try a different search or clear filters.</p>
              <button
                onClick={() => setFilters({ type: '', bhk: '', status: '', band: '', q: '' })}
                className="inline-block mt-3 text-[12.5px] font-bold text-brand"
              >
                Clear filters
              </button>
            </>
          ) : (
            <>
              <p className="text-[12.5px] text-ink-soft mt-1.5">
                Add your inventory — HomeNex auto-matches properties to leads.
              </p>
              <button
                onClick={() => setAdding(true)}
                className="mt-3.5 w-full rounded-full bg-brand text-white font-bold text-[13.5px] py-2.5 shadow-card active:scale-[0.99] transition"
              >
                Add your first property
              </button>
            </>
          )}
        </div>
      )}

      {/* `loading`, not `!properties`: a failed first request would otherwise leave
          these skeletons pulsing under the error banner for ever. */}
      {loading && <LoadingRows rows={4} />}

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

      {/* Without this the list simply stops at 100 and looks like the whole inventory.
          Search and the filter sheet are the way through rather than a pager: the rows
          past the first page are the ones untouched the longest, so scrolling to them
          finds nothing that a locality or a price band would not have found faster. */}
      {total !== null && total > shown && (
        <p className="mt-4 text-center text-[12px] text-ink-faint">
          Showing the {shown.toLocaleString('en-IN')} most recently updated of {total.toLocaleString('en-IN')} — search or filter to find the rest.
        </p>
      )}

      {showFilters && (
        <Sheet onClose={() => setShowFilters(false)} title="Filter properties">
          <div className="space-y-4">
            <FilterGroup label="Type">
              {TYPE_FILTERS.map((t) => (
                <Chip key={t.id} active={filters.type === t.id} onClick={() => setFilters((s) => ({ ...s, type: t.id }))}>
                  {t.label}
                </Chip>
              ))}
            </FilterGroup>
            <FilterGroup label="Price">
              {PRICE_BANDS.map((b) => (
                <Chip key={b.id} active={filters.band === b.id} onClick={() => setFilters((s) => ({ ...s, band: b.id }))}>
                  {b.label}
                </Chip>
              ))}
            </FilterGroup>
            <FilterGroup label="Bedrooms (BHK)">
              {BHK_FILTERS.map((b) => (
                <Chip key={b || 'any'} active={filters.bhk === b} onClick={() => setFilters((s) => ({ ...s, bhk: b }))}>
                  {b ? `${b} BHK` : 'Any BHK'}
                </Chip>
              ))}
            </FilterGroup>
            <FilterGroup label="Status">
              {STATUS_FILTERS.map((st) => (
                <Chip key={st || 'anyst'} active={filters.status === st} onClick={() => setFilters((s) => ({ ...s, status: st }))}>
                  {st ? STATUS_LABEL[st] : 'Any status'}
                </Chip>
              ))}
            </FilterGroup>
          </div>
          <div className="flex gap-2 mt-5">
            <button
              onClick={() => setFilters((s) => clearedFilters(s))}
              className="px-4 text-[13px] font-bold text-ink-soft rounded-full py-2.5 bg-[#222225] active:scale-[0.99] transition"
            >
              Clear all
            </button>
            <button
              onClick={() => setShowFilters(false)}
              className="flex-1 bg-brand text-white font-bold text-[13px] rounded-full py-2.5 active:scale-[0.99] transition"
            >
              {/* The count, not the page: "Show 100 results" under a filter that matches
                  1,204 would be the sheet quoting its own page size back at the agent. */}
              {total === null ? 'Show results' : `Show ${total.toLocaleString('en-IN')} result${total === 1 ? '' : 's'}`}
            </button>
          </div>
        </Sheet>
      )}

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
