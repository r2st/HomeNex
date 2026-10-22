import { useState } from 'react'
import ShareButtons from '../ShareButtons.jsx'

// Per-property metrics; null when the inputs don't support the calculation.
export function compareProperties(properties) {
  return properties.map((p) => {
    const price = Number(p.price) || 0
    const area = Number(p.area) || 0
    const rent = Number(p.monthlyRent) || 0
    const pricePerSqft = price > 0 && area > 0 ? price / area : null
    const grossYield = price > 0 && rent > 0 ? ((rent * 12) / price) * 100 : null
    return { ...p, pricePerSqft, grossYield }
  })
}

// Index of the best (lowest price/sqft, highest yield) among comparable rows.
export function bestIndex(metrics, key) {
  let best = -1
  metrics.forEach((m, i) => {
    if (m[key] === null) return
    if (best === -1) {
      best = i
      return
    }
    const better = key === 'pricePerSqft' ? m[key] < metrics[best][key] : m[key] > metrics[best][key]
    if (better) best = i
  })
  return best
}

function formatInr(n) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n)
}

const EMPTY = { name: '', price: '', area: '', monthlyRent: '' }

export default function PropertyComparison() {
  const [properties, setProperties] = useState([
    { name: 'Property A', price: 7500000, area: 1200, monthlyRent: 22000 },
    { name: 'Property B', price: 9000000, area: 1500, monthlyRent: 26000 },
  ])

  const metrics = compareProperties(properties)
  const bestPrice = bestIndex(metrics, 'pricePerSqft')
  const bestYield = bestIndex(metrics, 'grossYield')

  const update = (i, field, value) =>
    setProperties((prev) => prev.map((p, j) => (j === i ? { ...p, [field]: value } : p)))

  const addProperty = () =>
    setProperties((prev) => [...prev, { ...EMPTY, name: `Property ${String.fromCharCode(65 + prev.length)}` }])

  const removeProperty = (i) => setProperties((prev) => prev.filter((_, j) => j !== i))

  return (
    <div>
      <h1 className="text-3xl font-bold text-[var(--da-text)] mb-2" style={{ fontFamily: 'var(--da-font)' }}>Property Comparison Tool</h1>
      <p className="text-[var(--da-text-secondary)] mb-8">Compare up to four properties side by side on price per sq ft and rental yield.</p>
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          {properties.map((p, i) => (
            <div key={i} className="p-5 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)] space-y-3">
              <div className="flex items-center justify-between gap-2">
                <input
                  type="text"
                  value={p.name}
                  aria-label={`Property ${i + 1} name`}
                  onChange={(e) => update(i, 'name', e.target.value)}
                  className="flex-1 px-2 py-1.5 rounded-md text-sm font-semibold bg-transparent"
                />
                {properties.length > 2 && (
                  <button onClick={() => removeProperty(i)} aria-label={`Remove property ${i + 1}`} className="text-xs px-2 py-1 rounded-md border border-[var(--da-border)] text-[var(--da-text-muted)] hover:text-[var(--da-text)]">✕</button>
                )}
              </div>
              <div>
                <label className="block text-xs text-[var(--da-text-secondary)] mb-1">Price (₹)</label>
                <input type="number" min={0} value={p.price} onChange={(e) => update(i, 'price', Number(e.target.value) || 0)} className="w-full px-3 py-2 rounded-md text-sm" />
              </div>
              <div>
                <label className="block text-xs text-[var(--da-text-secondary)] mb-1">Carpet / Built-up Area (sq ft)</label>
                <input type="number" min={0} value={p.area} onChange={(e) => update(i, 'area', Number(e.target.value) || 0)} className="w-full px-3 py-2 rounded-md text-sm" />
              </div>
              <div>
                <label className="block text-xs text-[var(--da-text-secondary)] mb-1">Expected Monthly Rent (₹, optional)</label>
                <input type="number" min={0} value={p.monthlyRent} onChange={(e) => update(i, 'monthlyRent', Number(e.target.value) || 0)} className="w-full px-3 py-2 rounded-md text-sm" />
              </div>
            </div>
          ))}
        </div>

        {properties.length < 4 && (
          <button onClick={addProperty} className="px-4 py-2 rounded-md text-sm font-medium border border-[var(--da-border)] text-[var(--da-text-secondary)] hover:border-[var(--da-primary)] hover:text-[var(--da-primary)] transition-colors">
            + Add Property
          </button>
        )}

        <div className="p-6 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)] overflow-x-auto">
          <h2 className="text-sm font-medium text-[var(--da-text-secondary)] mb-3">Comparison</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--da-border)] text-left text-[var(--da-text-muted)]">
                <th className="py-2 pr-4">Metric</th>
                {metrics.map((m, i) => (
                  <th key={i} className="py-2 pr-4">{m.name || `Property ${i + 1}`}</th>
                ))}
              </tr>
            </thead>
            <tbody className="text-[var(--da-text)]">
              <tr className="border-b border-[var(--da-border)]">
                <td className="py-2 pr-4 text-[var(--da-text-secondary)]">Price</td>
                {metrics.map((m, i) => (
                  <td key={i} className="py-2 pr-4 font-mono">{Number(m.price) > 0 ? formatInr(Number(m.price)) : '—'}</td>
                ))}
              </tr>
              <tr className="border-b border-[var(--da-border)]">
                <td className="py-2 pr-4 text-[var(--da-text-secondary)]">Price per sq ft</td>
                {metrics.map((m, i) => (
                  <td key={i} className={`py-2 pr-4 font-mono ${i === bestPrice ? 'text-[var(--da-success)] font-bold' : ''}`}>
                    {m.pricePerSqft !== null ? formatInr(m.pricePerSqft) : '—'}
                    {i === bestPrice ? ' ★' : ''}
                  </td>
                ))}
              </tr>
              <tr>
                <td className="py-2 pr-4 text-[var(--da-text-secondary)]">Gross Rental Yield</td>
                {metrics.map((m, i) => (
                  <td key={i} className={`py-2 pr-4 font-mono ${i === bestYield ? 'text-[var(--da-success)] font-bold' : ''}`}>
                    {m.grossYield !== null ? `${m.grossYield.toFixed(2)}%` : '—'}
                    {i === bestYield ? ' ★' : ''}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
          <p className="text-xs text-[var(--da-text-muted)] mt-3">★ marks the best value — lowest price per sq ft and highest gross yield.</p>
        </div>

        <ShareButtons url="https://realty.doaide.com/tools/property-comparison" title="Property Comparison Tool — DoAide Realty" />
      </div>
    </div>
  )
}
