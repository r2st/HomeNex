import { useState, useEffect } from 'react'
import { api, fmtTime } from '../api.js'

const statusColors = {
  none: 'bg-gray-100 text-gray-600',
  pending: 'bg-amber-100 text-amber-700',
  registered: 'bg-blue-100 text-blue-700',
  active: 'bg-green-100 text-green-700',
}

function DashboardCards({ stats }) {
  if (!stats) return null
  const cards = [
    { label: 'Total Agents', value: stats.totalAgents, color: 'text-ink' },
    { label: 'Pending WABA', value: stats.pendingWaba, color: 'text-amber-600' },
    { label: 'Registered', value: stats.registeredWaba, color: 'text-blue-600' },
    { label: 'Active WABA', value: stats.activeWaba, color: 'text-green-600' },
  ]
  return (
    <div className="grid grid-cols-2 gap-3">
      {cards.map((c) => (
        <div key={c.label} className="bg-white border border-line rounded-2xl p-3">
          <div className={`text-[22px] font-bold ${c.color}`}>{c.value}</div>
          <div className="text-[11px] text-ink-faint font-medium">{c.label}</div>
        </div>
      ))}
    </div>
  )
}

function WabaEditor({ agent, onSaved }) {
  const [status, setStatus] = useState(agent.waba_status || 'none')
  const [metaWabaId, setMetaWabaId] = useState(agent.meta_waba_id || '')
  const [phoneNumberId, setPhoneNumberId] = useState(agent.wa_phone_number_id || '')
  const [waPhone, setWaPhone] = useState(agent.wa_phone_number || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const updated = await api.adminUpdateWaba(agent.id, {
        status,
        meta_waba_id: metaWabaId || null,
        wa_phone_number_id: phoneNumberId || null,
        wa_phone_number: waPhone || null,
      })
      onSaved(updated)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const inputCls = 'w-full bg-white border border-line rounded-xl px-3 py-2.5 text-[13px] outline-none focus:border-brand/60'

  return (
    <div className="space-y-3 mt-3">
      <label className="block">
        <span className="text-[11px] font-bold text-ink-soft">WABA Status</span>
        <select value={status} onChange={(e) => setStatus(e.target.value)}
          className={`${inputCls} mt-1`}>
          <option value="none">None</option>
          <option value="pending">Pending</option>
          <option value="registered">Registered</option>
          <option value="active">Active</option>
        </select>
      </label>

      <label className="block">
        <span className="text-[11px] font-bold text-ink-soft">WA Business Phone</span>
        <input type="text" value={waPhone} onChange={(e) => setWaPhone(e.target.value)}
          placeholder="+919876543210" className={`${inputCls} mt-1`} />
      </label>

      <label className="block">
        <span className="text-[11px] font-bold text-ink-soft">Meta phone_number_id</span>
        <input type="text" value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)}
          placeholder="e.g. 123456789012345" className={`${inputCls} mt-1`} />
      </label>

      <label className="block">
        <span className="text-[11px] font-bold text-ink-soft">Meta WABA ID</span>
        <input type="text" value={metaWabaId} onChange={(e) => setMetaWabaId(e.target.value)}
          placeholder="e.g. 987654321098765" className={`${inputCls} mt-1`} />
      </label>

      {error && <p className="text-[12px] text-hot bg-amber-wash rounded-xl px-3 py-2">{error}</p>}

      <button onClick={save} disabled={busy}
        className="w-full bg-brand hover:bg-brand-deep disabled:opacity-50 text-white font-bold text-[12px] rounded-xl py-2.5 active:scale-[0.98] transition">
        {busy ? 'Saving…' : 'Save WABA Config'}
      </button>
    </div>
  )
}

function AgentCard({ agent, onUpdate }) {
  const [expanded, setExpanded] = useState(false)

  const handleSaved = (updated) => {
    onUpdate(updated)
    setExpanded(false)
  }

  return (
    <div className="bg-white border border-line rounded-2xl p-4">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-full bg-brand/10 flex items-center justify-center text-[13px] font-bold text-brand shrink-0">
              {(agent.name || '?')[0].toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="text-[14px] font-semibold text-ink truncate">{agent.name}</div>
              <div className="text-[12px] text-ink-faint">{agent.phone}</div>
            </div>
          </div>
        </div>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${statusColors[agent.waba_status || 'none']}`}>
          {(agent.waba_status || 'none').toUpperCase()}
        </span>
      </div>

      {agent.wa_phone_number && (
        <div className="mt-2 text-[12px] text-ink-soft">
          WA Business: <span className="font-semibold">{agent.wa_phone_number}</span>
        </div>
      )}
      {!agent.wa_phone_number && (
        <div className="mt-2 text-[12px] text-ink-faint italic">No business number provided</div>
      )}

      {agent.wa_phone_number_id && (
        <div className="mt-1 text-[11px] text-ink-faint font-mono">
          phone_id: {agent.wa_phone_number_id}
        </div>
      )}
      {agent.meta_waba_id && (
        <div className="text-[11px] text-ink-faint font-mono">
          waba_id: {agent.meta_waba_id}
        </div>
      )}

      {agent.waba_registered_at && (
        <div className="mt-1 text-[11px] text-ink-faint">
          Registered: {fmtTime(agent.waba_registered_at)}
        </div>
      )}

      <button onClick={() => setExpanded(!expanded)}
        className="mt-3 text-[12px] font-bold text-brand hover:text-brand-deep">
        {expanded ? 'Close' : 'Edit WABA Config'}
      </button>

      {expanded && <WabaEditor agent={agent} onSaved={handleSaved} />}
    </div>
  )
}

export default function AdminPanel({ onBack }) {
  const [dashData, setDashData] = useState(null)
  const [agents, setAgents] = useState(null)
  const [filter, setFilter] = useState('all')
  const [error, setError] = useState(null)

  useEffect(() => {
    api.adminDashboard().then(setDashData).catch((e) => setError(e.message))
    api.adminAgents().then(setAgents).catch((e) => setError(e.message))
  }, [])

  const handleAgentUpdate = (updated) => {
    setAgents((prev) => prev?.map((a) => (a.id === updated.id ? updated : a)))
    // Refresh dashboard stats
    api.adminDashboard().then(setDashData).catch(() => {})
  }

  const filtered = agents?.filter((a) => {
    if (filter === 'all') return true
    return (a.waba_status || 'none') === filter
  })

  if (error) {
    return (
      <div className="p-5 pb-28">
        <button onClick={onBack} className="text-[13px] text-brand font-bold mb-4">← Back to Settings</button>
        <div className="bg-amber-wash rounded-2xl p-4">
          <p className="text-[13px] text-hot">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-5 pb-28 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <button onClick={onBack} className="text-[13px] text-brand font-bold">← Back</button>
          <h2 className="font-display text-[22px] font-semibold text-ink mt-1">Admin Panel</h2>
        </div>
      </div>

      {/* Dashboard Stats */}
      <DashboardCards stats={dashData} />

      {/* Agent filter */}
      <div className="flex gap-2 overflow-x-auto">
        {['all', 'none', 'pending', 'registered', 'active'].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`text-[11px] font-bold px-3 py-1.5 rounded-full shrink-0 transition ${
              filter === f ? 'bg-brand text-white' : 'bg-cream text-ink-soft'
            }`}
          >
            {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
            {agents && ` (${f === 'all' ? agents.length : agents.filter((a) => (a.waba_status || 'none') === f).length})`}
          </button>
        ))}
      </div>

      {/* Agent list */}
      <div className="space-y-3">
        {!agents && <p className="text-[13px] text-ink-faint text-center py-8">Loading agents…</p>}
        {filtered?.length === 0 && <p className="text-[13px] text-ink-faint text-center py-8">No agents match this filter</p>}
        {filtered?.map((a) => (
          <AgentCard key={a.id} agent={a} onUpdate={handleAgentUpdate} />
        ))}
      </div>
    </div>
  )
}
