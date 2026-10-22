import { useState } from 'react'
import ShareButtons from '../ShareButtons.jsx'

// Square feet per unit. Marla uses the 272.25 sq ft convention common in
// North India; bigha is omitted because its size differs by state.
export const AREA_UNITS = [
  { key: 'sqft', label: 'Square Feet (sq ft)', sqft: 1 },
  { key: 'sqm', label: 'Square Metres (sq m)', sqft: 10.7639 },
  { key: 'sqyd', label: 'Square Yards (gaj)', sqft: 9 },
  { key: 'acre', label: 'Acres', sqft: 43560 },
  { key: 'hectare', label: 'Hectares', sqft: 107639.104 },
  { key: 'cent', label: 'Cents', sqft: 435.6 },
  { key: 'guntha', label: 'Gunthas', sqft: 1089 },
  { key: 'ground', label: 'Grounds', sqft: 2400 },
  { key: 'marla', label: 'Marlas', sqft: 272.25 },
  { key: 'kanal', label: 'Kanals', sqft: 5445 },
]

export function convertArea(value, fromKey, toKey) {
  const from = AREA_UNITS.find((u) => u.key === fromKey)
  const to = AREA_UNITS.find((u) => u.key === toKey)
  if (!from || !to || !(value > 0)) return 0
  return (value * from.sqft) / to.sqft
}

function formatNumber(n) {
  if (n === 0) return '0'
  if (n < 0.01) return n.toExponential(2)
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: n < 10 ? 4 : 2 }).format(n)
}

export default function AreaConverter() {
  const [value, setValue] = useState(1000)
  const [fromUnit, setFromUnit] = useState('sqft')

  return (
    <div>
      <h1 className="text-3xl font-bold text-[var(--da-text)] mb-2" style={{ fontFamily: 'var(--da-font)' }}>Area Converter</h1>
      <p className="text-[var(--da-text-secondary)] mb-8">Convert between square feet, square metres, gaj, acres and other Indian land units.</p>
      <div className="space-y-6">
        <div className="p-6 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)] space-y-4">
          <div>
            <label className="block text-sm text-[var(--da-text-secondary)] mb-1">Area Value</label>
            <input type="number" min={0} value={value} onChange={(e) => setValue(Number(e.target.value) || 0)} className="w-full px-3 py-2 rounded-md text-sm" />
          </div>
          <div>
            <label className="block text-sm text-[var(--da-text-secondary)] mb-1">From Unit</label>
            <select value={fromUnit} onChange={(e) => setFromUnit(e.target.value)} className="w-full px-3 py-2 rounded-md text-sm bg-[var(--da-bg)] border border-[var(--da-border)] text-[var(--da-text)]">
              {AREA_UNITS.map((u) => (
                <option key={u.key} value={u.key}>{u.label}</option>
              ))}
            </select>
          </div>
        </div>

        {value > 0 && (
          <div className="p-6 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)]">
            <h2 className="text-sm font-medium text-[var(--da-text-secondary)] mb-3">Converted Values</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {AREA_UNITS.filter((u) => u.key !== fromUnit).map((u) => (
                <div key={u.key} className="flex items-baseline justify-between p-3 rounded-lg bg-[var(--da-bg)] border border-[var(--da-border)]">
                  <span className="text-sm text-[var(--da-text-secondary)]">{u.label}</span>
                  <span className="text-sm font-bold text-[var(--da-text)] font-mono">{formatNumber(convertArea(value, fromUnit, u.key))}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <p className="text-xs text-[var(--da-text-muted)] p-4 rounded-lg bg-[var(--da-surface)] border border-[var(--da-border)]">
          Marla uses the 272.25 sq ft convention common in North India (225 sq ft in some regions). Bigha is not included because its size varies widely by state — always confirm local land units with the registrar&apos;s office.
        </p>

        <ShareButtons url="https://realty.doaide.com/tools/area-converter" title="Area Converter (sq ft, sq m, gaj, acre) — DoAide Realty" />
      </div>
    </div>
  )
}
