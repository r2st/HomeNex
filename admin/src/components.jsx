import { WABA_STATUSES } from './api.js'

export function StatusBadge({ status }) {
  const s = status || 'none'
  return <span className={`badge ${s}`}>{s}</span>
}

export function WabaFilter({ value, onChange }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">All WABA statuses</option>
      {WABA_STATUSES.map((s) => (
        <option key={s} value={s}>
          {s.charAt(0).toUpperCase() + s.slice(1)}
        </option>
      ))}
    </select>
  )
}

export function Pager({ page, totalPages, total, onPage }) {
  if (!total) return null
  return (
    <div className="pager">
      <button className="btn secondary sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ← Prev
      </button>
      <span>
        Page {page} of {totalPages} · {total} agent{total === 1 ? '' : 's'}
      </span>
      <button className="btn secondary sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
        Next →
      </button>
    </div>
  )
}
