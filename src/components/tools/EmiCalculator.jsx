import { useState } from 'react'
import ShareButtons from '../ShareButtons.jsx'

export function calcEmi(principal, annualRate, years) {
  if (principal <= 0 || annualRate <= 0 || years <= 0) return { emi: 0, totalPayment: 0, totalInterest: 0 }
  const r = annualRate / 12 / 100
  const n = years * 12
  const emi = (principal * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1)
  const totalPayment = emi * n
  const totalInterest = totalPayment - principal
  return { emi: Math.round(emi), totalPayment: Math.round(totalPayment), totalInterest: Math.round(totalInterest) }
}

function formatInr(n) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n)
}

export default function EmiCalculator() {
  const [principal, setPrincipal] = useState(5000000)
  const [rate, setRate] = useState(8.5)
  const [years, setYears] = useState(20)

  const { emi, totalPayment, totalInterest } = calcEmi(principal, rate, years)

  return (
    <div>
      <h1 className="text-3xl font-bold text-[var(--doaide-text)] mb-2" style={{ fontFamily: 'var(--doaide-font-display)' }}>Home Loan EMI Calculator</h1>
      <p className="text-[var(--doaide-text-secondary)] mb-8">Calculate your monthly EMI for home loans in India.</p>
      <div className="space-y-6">
        <div className="p-6 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)] space-y-4">
          <div>
            <label className="block text-sm text-[var(--doaide-text-secondary)] mb-1">Loan Amount (₹)</label>
            <input type="number" min={100000} step={100000} value={principal} onChange={(e) => setPrincipal(Number(e.target.value) || 0)} className="w-full px-3 py-2 rounded-md text-sm" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-[var(--doaide-text-secondary)] mb-1">Interest Rate (% p.a.)</label>
              <input type="number" min={1} max={20} step={0.1} value={rate} onChange={(e) => setRate(Number(e.target.value) || 0)} className="w-full px-3 py-2 rounded-md text-sm" />
            </div>
            <div>
              <label className="block text-sm text-[var(--doaide-text-secondary)] mb-1">Tenure (years)</label>
              <input type="number" min={1} max={30} value={years} onChange={(e) => setYears(Number(e.target.value) || 0)} className="w-full px-3 py-2 rounded-md text-sm" />
            </div>
          </div>
        </div>

        {emi > 0 && (
          <div className="grid grid-cols-3 gap-4">
            <div className="p-4 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
              <p className="text-xs text-[var(--doaide-text-muted)] mb-1">Monthly EMI</p>
              <p className="text-xl font-bold text-[var(--doaide-gold)]">{formatInr(emi)}</p>
            </div>
            <div className="p-4 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
              <p className="text-xs text-[var(--doaide-text-muted)] mb-1">Total Payment</p>
              <p className="text-xl font-bold text-[var(--doaide-text)]">{formatInr(totalPayment)}</p>
            </div>
            <div className="p-4 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
              <p className="text-xs text-[var(--doaide-text-muted)] mb-1">Total Interest</p>
              <p className="text-xl font-bold text-[var(--doaide-error)]">{formatInr(totalInterest)}</p>
            </div>
          </div>
        )}

        <ShareButtons url="https://realty.doaide.com/tools/emi-calculator" title="Home Loan EMI Calculator — DoAide Realty" />
      </div>
    </div>
  )
}
