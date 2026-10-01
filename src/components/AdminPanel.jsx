import { useState, useEffect, useCallback } from 'react'
import { api, fmtTime, fmtAgo } from '../api.js'
import { inputCls } from './ui.jsx'

const statusColors = {
  none: 'bg-card text-ink-faint',
  pending: 'bg-amber-wash text-[#FBBF24]',
  registered: 'bg-[rgba(96,165,250,0.1)] text-[#60A5FA]',
  active: 'bg-[rgba(52,211,153,0.1)] text-[#34D399]',
}

// Each label is followed by details.target when present, so it must read as a verb
// phrase that takes an object: "<actor> granted admin to <target>".
const AUDIT_LABELS = {
  admin_granted: 'granted admin to',
  admin_revoked: 'removed admin from',
  agent_deactivated: 'deactivated',
  agent_reactivated: 'reactivated',
  phone_changed: 'changed their WhatsApp number',
  password_changed: 'changed their password',
  profile_updated: 'updated their profile',
  preferences_updated: 'updated their preferences',
}

function DashboardCards({ stats }) {
  if (!stats) return null
  const cards = [
    { label: 'Total Agents', value: stats.totalAgents, color: 'text-ink' },
    { label: 'Pending WABA', value: stats.pendingWaba, color: 'text-[#FBBF24]' },
    { label: 'Registered', value: stats.registeredWaba, color: 'text-[#60A5FA]' },
    { label: 'Active WABA', value: stats.activeWaba, color: 'text-[#34D399]' },
  ]
  return (
    <div className="grid grid-cols-2 gap-3">
      {cards.map((c) => (
        <div key={c.label} className="bg-card border border-line rounded-2xl p-3">
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
      onSaved(
        await api.adminUpdateWaba(agent.id, {
          status,
          meta_waba_id: metaWabaId || null,
          wa_phone_number_id: phoneNumberId || null,
          wa_phone_number: waPhone || null,
        }),
      )
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 mt-3">
      <label className="block">
        <span className="text-[11px] font-bold text-ink-soft">WABA Status</span>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={`${inputCls} mt-1`}>
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

// Destructive-ish team actions get a confirm step: revoking admin or cutting off
// an agent's access is easy to fat-finger on a phone.
function ConfirmRow({ prompt, confirmLabel, danger, onConfirm, onCancel, busy }) {
  return (
    <div className="mt-3 bg-cream border border-line rounded-xl p-3 space-y-2">
      <p className="text-[12px] text-ink-soft leading-snug">{prompt}</p>
      <div className="flex gap-2">
        <button
          onClick={onCancel}
          disabled={busy}
          className="flex-1 border border-line text-ink-soft font-bold text-[12px] rounded-xl py-2 active:scale-[0.98] transition"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={busy}
          className={`flex-1 text-white font-bold text-[12px] rounded-xl py-2 active:scale-[0.98] transition disabled:opacity-50 ${
            danger ? 'bg-hot hover:opacity-90' : 'bg-brand hover:bg-brand-deep'
          }`}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </div>
  )
}

function AgentCard({ agent, me, onUpdate }) {
  const [panel, setPanel] = useState(null) // 'waba' | 'admin' | 'active'
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const isSelf = agent.id === me?.id
  const inactive = agent.is_active === 0
  const isAdmin = agent.is_admin === 1

  const run = async (fn) => {
    setBusy(true)
    setError(null)
    try {
      onUpdate(await fn())
      setPanel(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`bg-card border rounded-2xl p-4 ${inactive ? 'border-line opacity-70' : 'border-line'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {agent.avatar_url ? (
            <img src={agent.avatar_url} alt="" className="w-9 h-9 rounded-full object-cover shrink-0" />
          ) : (
            <div className="w-9 h-9 rounded-full bg-brand/10 flex items-center justify-center text-[13px] font-bold text-brand shrink-0">
              {(agent.name || '?')[0].toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-[14px] font-semibold text-ink truncate">{agent.name}</span>
              {isSelf && <span className="text-[10px] font-bold text-ink-faint">(you)</span>}
            </div>
            <div className="text-[12px] text-ink-faint">{agent.phone}</div>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${statusColors[agent.waba_status || 'none']}`}>
            {(agent.waba_status || 'none').toUpperCase()}
          </span>
          {isAdmin && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-ink text-cream">ADMIN</span>
          )}
          {inactive && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-wash text-hot">
              DEACTIVATED
            </span>
          )}
        </div>
      </div>

      {agent.business_name && (
        <div className="mt-2 text-[12px] text-ink-soft truncate">{agent.business_name}</div>
      )}
      {agent.wa_phone_number ? (
        <div className="mt-1 text-[12px] text-ink-soft">
          WA Business: <span className="font-semibold">{agent.wa_phone_number}</span>
        </div>
      ) : (
        <div className="mt-1 text-[12px] text-ink-faint italic">No business number provided</div>
      )}
      {agent.wa_phone_number_id && (
        <div className="mt-1 text-[11px] text-ink-faint font-mono">phone_id: {agent.wa_phone_number_id}</div>
      )}
      {agent.meta_waba_id && (
        <div className="text-[11px] text-ink-faint font-mono">waba_id: {agent.meta_waba_id}</div>
      )}
      {agent.waba_registered_at && (
        <div className="mt-1 text-[11px] text-ink-faint">Registered: {fmtTime(agent.waba_registered_at)}</div>
      )}
      {inactive && agent.deactivated_at && (
        <div className="mt-1 text-[11px] text-hot">Deactivated {fmtAgo(agent.deactivated_at)}</div>
      )}

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        <button
          onClick={() => setPanel(panel === 'waba' ? null : 'waba')}
          className="text-[12px] font-bold text-brand hover:text-brand-deep"
        >
          {panel === 'waba' ? 'Close' : 'Edit WABA Config'}
        </button>

        {/* An admin can't demote or deactivate themselves — the server rejects it too. */}
        {!isSelf && (
          <button
            onClick={() => setPanel(panel === 'admin' ? null : 'admin')}
            disabled={inactive && !isAdmin}
            className="text-[12px] font-bold text-brand hover:text-brand-deep disabled:text-ink-faint disabled:cursor-not-allowed"
            title={inactive && !isAdmin ? 'Reactivate this agent first' : undefined}
          >
            {isAdmin ? 'Remove admin' : 'Make admin'}
          </button>
        )}

        {!isSelf && (
          <button
            onClick={() => setPanel(panel === 'active' ? null : 'active')}
            className={`text-[12px] font-bold ${inactive ? 'text-brand hover:text-brand-deep' : 'text-hot hover:opacity-80'}`}
          >
            {inactive ? 'Reactivate' : 'Deactivate'}
          </button>
        )}
      </div>

      {error && <p className="mt-2 text-[12px] text-hot bg-amber-wash rounded-xl px-3 py-2">{error}</p>}

      {panel === 'waba' && <WabaEditor agent={agent} onSaved={onUpdate} />}

      {panel === 'admin' && (
        <ConfirmRow
          busy={busy}
          danger={isAdmin}
          prompt={
            isAdmin
              ? `Remove admin access from ${agent.name}? They keep their leads and can still log in.`
              : `Make ${agent.name} an admin? They'll be able to manage every agent on this account.`
          }
          confirmLabel={isAdmin ? 'Remove admin' : 'Make admin'}
          onCancel={() => setPanel(null)}
          onConfirm={() => run(() => api.adminSetAdmin(agent.id, !isAdmin))}
        />
      )}

      {panel === 'active' && (
        <ConfirmRow
          busy={busy}
          danger={!inactive}
          prompt={
            inactive
              ? `Reactivate ${agent.name}? They'll be able to log in again and their WhatsApp line resumes capturing leads.`
              : `Deactivate ${agent.name}? They're signed out everywhere immediately and their WhatsApp line stops capturing leads. Nothing is deleted.`
          }
          confirmLabel={inactive ? 'Reactivate' : 'Deactivate'}
          onCancel={() => setPanel(null)}
          onConfirm={() => run(() => api.adminSetActive(agent.id, inactive))}
        />
      )}
    </div>
  )
}

function AuditLog() {
  const [logs, setLogs] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    api.adminAuditLogs(50).then(setLogs).catch((e) => setError(e.message))
  }, [])

  if (error) return <p className="text-[13px] text-hot">{error}</p>
  if (!logs) return <p className="text-[13px] text-ink-faint text-center py-8">Loading activity…</p>
  if (!logs.length) return <p className="text-[13px] text-ink-faint text-center py-8">No activity yet</p>

  return (
    <div className="bg-card border border-line rounded-2xl divide-y divide-line">
      {logs.map((log) => (
        <div key={log.id} className="px-4 py-3">
          <p className="text-[13px] text-ink leading-snug">
            <span className="font-semibold">{log.agent_name || 'Someone'}</span>{' '}
            {AUDIT_LABELS[log.action] || log.action.replace(/_/g, ' ')}
            {log.details?.target && <span className="font-semibold"> {log.details.target}</span>}
          </p>
          <p className="text-[11px] text-ink-faint mt-0.5">{fmtAgo(log.created_at)}</p>
        </div>
      ))}
    </div>
  )
}

export default function AdminPanel({ agent: me, onBack }) {
  const [tab, setTab] = useState('agents') // 'agents' | 'activity'
  const [dashData, setDashData] = useState(null)
  const [agents, setAgents] = useState(null)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [error, setError] = useState(null)

  const refresh = useCallback(() => {
    api.adminDashboard().then(setDashData).catch((e) => setError(e.message))
    api.adminAgents().then(setAgents).catch((e) => setError(e.message))
  }, [])

  useEffect(refresh, [refresh])

  const handleAgentUpdate = (updated) => {
    setAgents((prev) => prev?.map((a) => (a.id === updated.id ? { ...a, ...updated } : a)))
    api.adminDashboard().then(setDashData).catch(() => {})
  }

  const FILTERS = ['all', 'admins', 'deactivated', 'pending', 'registered', 'active']
  const matches = (a, f) => {
    if (f === 'all') return true
    if (f === 'admins') return a.is_admin === 1
    if (f === 'deactivated') return a.is_active === 0
    return (a.waba_status || 'none') === f
  }

  const needle = search.trim().toLowerCase()
  const filtered = agents
    ?.filter((a) => matches(a, filter))
    .filter((a) =>
      !needle ||
      [a.name, a.email, a.phone, a.wa_phone_number, a.business_name]
        .some((v) => String(v || '').toLowerCase().includes(needle)),
    )

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
      <div>
        <button onClick={onBack} className="text-[13px] text-brand font-bold">← Back</button>
        <h2 className="font-display text-[22px] font-semibold text-ink mt-1">Team &amp; admin</h2>
      </div>

      <DashboardCards stats={dashData} />

      <div className="flex gap-2">
        {[['agents', 'Agents'], ['activity', 'Activity']].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`text-[12px] font-bold px-3.5 py-2 rounded-xl transition ${
              tab === id ? 'bg-ink text-cream' : 'bg-cream text-ink-soft'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'activity' ? (
        <AuditLog />
      ) : (
        <>
          <input
            type="search"
            aria-label="Search agents"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, phone, email or business"
            className={inputCls}
          />

          <div className="flex gap-2 overflow-x-auto no-scrollbar">
            {FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`text-[11px] font-bold px-3 py-1.5 rounded-full shrink-0 transition ${
                  filter === f ? 'bg-brand text-white' : 'bg-cream text-ink-soft'
                }`}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
                {agents && ` (${agents.filter((a) => matches(a, f)).length})`}
              </button>
            ))}
          </div>

          <div className="space-y-3">
            {!agents && <p className="text-[13px] text-ink-faint text-center py-8">Loading agents…</p>}
            {filtered?.length === 0 && (
              <p className="text-[13px] text-ink-faint text-center py-8">No agents match</p>
            )}
            {filtered?.map((a) => (
              <AgentCard key={a.id} agent={a} me={me} onUpdate={handleAgentUpdate} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
