import { useState } from 'react'
import ShareButtons from '../ShareButtons.jsx'

export const STAMP_DUTY_RATES = {
  'Maharashtra': { duty: 5, registration: 1 },
  'Karnataka': { duty: 5, registration: 1 },
  'Tamil Nadu': { duty: 7, registration: 1 },
  'Delhi': { duty: 6, registration: 1 },
  'Uttar Pradesh': { duty: 5, registration: 1 },
  'Gujarat': { duty: 4.9, registration: 1 },
  'Rajasthan': { duty: 5, registration: 1 },
  'West Bengal': { duty: 5, registration: 1 },
  'Telangana': { duty: 5, registration: 0.5 },
  'Kerala': { duty: 8, registration: 2 },
  'Madhya Pradesh': { duty: 7.5, registration: 3 },
  'Haryana': { duty: 5, registration: 1.5 },
  'Punjab': { duty: 6, registration: 1 },
  'Andhra Pradesh': { duty: 5, registration: 0.5 },
  'Bihar': { duty: 6, registration: 2 },
}

export function calcStampDuty(value, state) {
  const rates = STAMP_DUTY_RATES[state]
  if (!rates || value <= 0) return { stampDuty: 0, registration: 0, total: 0 }
  const stampDuty = Math.round(value * rates.duty / 100)
  const registration = Math.round(value * rates.registration / 100)
  return { stampDuty, registration, total: stampDuty + registration }
}

function formatInr(n) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n)
}

export default function StampDutyCalculator() {
  const [value, setValue] = useState(5000000)
  const [state, setState] = useState('Maharashtra')
  const states = Object.keys(STAMP_DUTY_RATES)

  const { stampDuty, registration, total } = calcStampDuty(value, state)
  const rates = STAMP_DUTY_RATES[state]

  return (
    <div>
      <h1 className="text-3xl font-bold text-[var(--doaide-text)] mb-2" style={{ fontFamily: 'var(--doaide-font-display)' }}>Stamp Duty Calculator</h1>
      <p className="text-[var(--doaide-text-secondary)] mb-8">Estimate stamp duty and registration charges by Indian state.</p>
      <div className="space-y-6">
        <div className="p-6 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)] space-y-4">
          <div>
            <label className="block text-sm text-[var(--doaide-text-secondary)] mb-1">Property Value (₹)</label>
            <input type="number" min={100000} step={100000} value={value} onChange={(e) => setValue(Number(e.target.value) || 0)} className="w-full px-3 py-2 rounded-md text-sm" />
          </div>
          <div>
            <label className="block text-sm text-[var(--doaide-text-secondary)] mb-1">State</label>
            <select value={state} onChange={(e) => setState(e.target.value)} className="w-full px-3 py-2 rounded-md text-sm">
              {states.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        {total > 0 && (
          <div className="grid grid-cols-3 gap-4">
            <div className="p-4 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
              <p className="text-xs text-[var(--doaide-text-muted)] mb-1">Stamp Duty ({rates.duty}%)</p>
              <p className="text-xl font-bold text-[var(--doaide-gold)]">{formatInr(stampDuty)}</p>
            </div>
            <div className="p-4 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
              <p className="text-xs text-[var(--doaide-text-muted)] mb-1">Registration ({rates.registration}%)</p>
              <p className="text-xl font-bold text-[var(--doaide-text)]">{formatInr(registration)}</p>
            </div>
            <div className="p-4 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
              <p className="text-xs text-[var(--doaide-text-muted)] mb-1">Total Charges</p>
              <p className="text-xl font-bold text-[var(--doaide-warning)]">{formatInr(total)}</p>
            </div>
          </div>
        )}

        <ShareButtons url="https://realty.doaide.com/tools/stamp-duty-calculator" title="Stamp Duty Calculator — DoAide Realty" />
      </div>
    </div>
  )
}
