import { useEffect, useState } from 'react'
import { api, fmtPaise, fmtDate } from '../api.js'

const STATUS_BADGE = { paid: 'active', issued: 'registered', draft: 'pending', void: 'none' }

// §7.3 Billing & usage: the plan catalogue, plus per-tenant metering, plan
// assignment, and GST invoice generation.
export default function Billing() {
  const [plans, setPlans] = useState([])
  const [agents, setAgents] = useState([])
  const [sel, setSel] = useState('')
  const [billing, setBilling] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    api.plans().then(setPlans).catch((e) => setError(e.message))
    api.agents({ pageSize: 100 }).then((r) => setAgents(r.agents || r)).catch(() => {})
  }, [])

  const loadBilling = (id) => {
    setSel(id)
    setBilling(null)
    if (id) api.agentBilling(id).then(setBilling).catch((e) => setError(e.message))
  }

  const act = async (fn) => {
    try {
      await fn()
      if (sel) api.agentBilling(sel).then(setBilling)
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <>
      <h1 className="page-title">Billing &amp; Usage</h1>
      <p className="page-sub">Plans, per-tenant metering and GST invoices (all amounts include 18% GST at issue)</p>
      {error && <div className="error-box">{error}</div>}

      <div className="section-title">Plan catalogue</div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Code</th><th>Name</th><th>Price / month</th><th>Conversation quota</th><th>Active</th></tr>
          </thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.code}</td>
                <td>{p.name}</td>
                <td>{fmtPaise(p.price_paise)}</td>
                <td>{p.conversation_quota ?? 'Unlimited'}</td>
                <td>{p.is_active ? 'Yes' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section-title">Per-agent billing</div>
      <div className="toolbar">
        <select value={sel} onChange={(e) => loadBilling(e.target.value)} aria-label="Agent to show billing for">
          <option value="">Select an agent…</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>{a.name} ({a.phone})</option>
          ))}
        </select>
      </div>

      {billing && (
        <>
          <div className="card" style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <strong>Plan:</strong>
              <select
                value={billing.subscription?.plan_id || ''}
                aria-label="Subscription plan for this agent"
                onChange={(e) => act(() => api.setSubscription(sel, Number(e.target.value)))}
              >
                <option value="" disabled>Assign a plan…</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} — {fmtPaise(p.price_paise)}</option>
                ))}
              </select>
              {billing.subscription && <span className="sub">status: {billing.subscription.status}</span>}
            </div>
          </div>

          <div className="card" style={{ marginBottom: 14 }}>
            <strong>Usage — {billing.usage.period_start} to {billing.usage.period_end}</strong>
            <table style={{ marginTop: 8 }}>
              <thead>
                <tr><th>Category</th><th>Conversations</th><th>Rate</th><th>Meta cost</th></tr>
              </thead>
              <tbody>
                {billing.usage.by_category.map((c) => (
                  <tr key={c.category}>
                    <td>{c.category}</td>
                    <td>{c.count}</td>
                    <td>{fmtPaise(c.rate_paise)}</td>
                    <td>{fmtPaise(c.cost_paise)}</td>
                  </tr>
                ))}
                <tr>
                  <td><strong>Total</strong></td>
                  <td><strong>{billing.usage.total_conversations}</strong></td>
                  <td />
                  <td><strong>{fmtPaise(billing.usage.meta_cost_paise)}</strong></td>
                </tr>
              </tbody>
            </table>
            {billing.usage.quota != null && (
              <p className="sub" style={{ marginTop: 6 }}>
                Quota {billing.usage.quota} · over quota {billing.usage.over_quota}
              </p>
            )}
          </div>

          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>Invoices</strong>
              <button className="btn sm" onClick={() => act(() => api.generateInvoice(sel, {}))}>
                Generate invoice (GST 18%)
              </button>
            </div>
            <table style={{ marginTop: 8 }}>
              <thead>
                <tr><th>Number</th><th>Period</th><th>Subtotal</th><th>GST</th><th>Total</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {billing.invoices.map((inv) => (
                  <tr key={inv.id}>
                    <td className="mono">{inv.number}</td>
                    <td className="sub">{fmtDate(inv.period_start)} – {fmtDate(inv.period_end)}</td>
                    <td>{fmtPaise(inv.subtotal_paise)}</td>
                    <td>{fmtPaise(inv.gst_paise)}</td>
                    <td><strong>{fmtPaise(inv.total_paise)}</strong></td>
                    <td><span className={`badge ${STATUS_BADGE[inv.status] || 'none'}`}>{inv.status}</span></td>
                    <td>
                      {inv.status !== 'paid' && (
                        <button className="btn secondary sm" onClick={() => act(() => api.setInvoiceStatus(inv.id, 'paid'))}>
                          Mark paid
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {billing.invoices.length === 0 && (
                  <tr><td colSpan={7} className="empty">No invoices yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  )
}
