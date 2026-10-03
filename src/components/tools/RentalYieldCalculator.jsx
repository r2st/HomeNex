import { useState } from 'react'
import ShareButtons from '../ShareButtons.jsx'

export function calcYield(propertyValue, monthlyRent, annualExpenses) {
  if (propertyValue <= 0 || monthlyRent <= 0) return { grossYield: 0, netYield: 0, annualIncome: 0 }
  const annualIncome = monthlyRent * 12
  const grossYield = (annualIncome / propertyValue) * 100
  const netYield = ((annualIncome - annualExpenses) / propertyValue) * 100
  return { grossYield, netYield, annualIncome }
}

function formatInr(n) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n)
}

export default function RentalYieldCalculator() {
  const [propertyValue, setPropertyValue] = useState(5000000)
  const [monthlyRent, setMonthlyRent] = useState(20000)
  const [annualExpenses, setAnnualExpenses] = useState(30000)

  const { grossYield, netYield, annualIncome } = calcYield(propertyValue, monthlyRent, annualExpenses)

  return (
    <div>
      <h1 className="text-3xl font-bold text-[var(--doaide-text)] mb-2" style={{ fontFamily: 'var(--doaide-font-display)' }}>Rental Yield Calculator</h1>
      <p className="text-[var(--doaide-text-secondary)] mb-8">Calculate gross and net rental yield for investment properties.</p>
      <div className="space-y-6">
        <div className="p-6 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)] space-y-4">
          <div>
            <label className="block text-sm text-[var(--doaide-text-secondary)] mb-1">Property Value (₹)</label>
            <input type="number" min={100000} step={100000} value={propertyValue} onChange={(e) => setPropertyValue(Number(e.target.value) || 0)} className="w-full px-3 py-2 rounded-md text-sm" />
          </div>
          <div>
            <label className="block text-sm text-[var(--doaide-text-secondary)] mb-1">Monthly Rent (₹)</label>
            <input type="number" min={0} step={1000} value={monthlyRent} onChange={(e) => setMonthlyRent(Number(e.target.value) || 0)} className="w-full px-3 py-2 rounded-md text-sm" />
          </div>
          <div>
            <label className="block text-sm text-[var(--doaide-text-secondary)] mb-1">Annual Expenses (₹) — maintenance, taxes, insurance</label>
            <input type="number" min={0} step={5000} value={annualExpenses} onChange={(e) => setAnnualExpenses(Number(e.target.value) || 0)} className="w-full px-3 py-2 rounded-md text-sm" />
          </div>
        </div>

        {grossYield > 0 && (
          <div className="grid grid-cols-3 gap-4">
            <div className="p-4 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
              <p className="text-xs text-[var(--doaide-text-muted)] mb-1">Gross Yield</p>
              <p className={`text-xl font-bold ${grossYield >= 4 ? 'text-[var(--doaide-success)]' : 'text-[var(--doaide-warning)]'}`}>{grossYield.toFixed(2)}%</p>
            </div>
            <div className="p-4 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
              <p className="text-xs text-[var(--doaide-text-muted)] mb-1">Net Yield</p>
              <p className={`text-xl font-bold ${netYield >= 3 ? 'text-[var(--doaide-success)]' : 'text-[var(--doaide-warning)]'}`}>{netYield.toFixed(2)}%</p>
            </div>
            <div className="p-4 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
              <p className="text-xs text-[var(--doaide-text-muted)] mb-1">Annual Income</p>
              <p className="text-xl font-bold text-[var(--doaide-gold)]">{formatInr(annualIncome)}</p>
            </div>
          </div>
        )}

        <ShareButtons url="https://realty.doaide.com/tools/rental-yield-calculator" title="Rental Yield Calculator — DoAide Realty" />
      </div>
    </div>
  )
}
