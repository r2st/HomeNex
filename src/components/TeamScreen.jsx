import { useEffect, useState, useCallback } from 'react'
import { api, fmtAgo } from '../api.js'
import { Chip, Field, inputCls, Avatar } from './ui.jsx'

const STRATEGIES = [
  { id: 'manual', label: 'Manual', sub: 'A manager assigns every lead' },
  { id: 'round_robin', label: 'Round-robin', sub: 'Cycle new leads through the team' },
  { id: 'locality', label: 'By locality', sub: "Match each member's areas" },
  { id: 'pool', label: 'Shared pool', sub: 'Members claim leads themselves' },
]

const ROLE_BADGE = {
  owner: 'bg-amber-wash text-hot border-amber/40',
  manager: 'bg-brand-wash text-brand-deep border-brand/30',
  agent: 'bg-cream text-ink-faint border-line',
}

function fmtDur(s) {
  if (s == null) return '—'
  const n = Number(s)
  if (n < 60) return `${Math.round(n)}s`
  if (n < 3600) return `${Math.round(n / 60)}m`
  return `${(n / 3600).toFixed(1)}h`
}

function Err({ error }) {
  if (!error) return null
  return <p className="text-[12px] text-hot font-semibold mt-2">{error}</p>
}

// --- No team yet: create one, or accept a pending invite. ---
function NoTeam({ ctx, reload }) {
  const [name, setName] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.createTeam(name.trim())
      reload()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const respond = async (id, accept) => {
    try {
      await (accept ? api.acceptTeamInvite(id) : api.declineTeamInvite(id))
      reload()
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <div className="mt-5 space-y-5">
      {(ctx.incoming_invites || []).length > 0 && (
        <div>
          <p className="text-[12px] font-bold text-ink-soft mb-2">You've been invited</p>
          <div className="space-y-2">
            {ctx.incoming_invites.map((inv) => (
              <div key={inv.id} className="bg-card rounded-2xl border border-line shadow-card px-4 py-3">
                <p className="font-bold text-[14px] text-ink">{inv.team_name}</p>
                <p className="text-[12px] text-ink-soft">
                  as {inv.role}
                  {inv.invited_by_name ? ` · from ${inv.invited_by_name}` : ''}
                </p>
                <div className="flex gap-2 mt-2.5">
                  <button
                    onClick={() => respond(inv.id, true)}
                    className="flex-1 bg-brand text-white font-bold text-[13px] rounded-xl py-2 active:scale-95 transition"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => respond(inv.id, false)}
                    className="flex-1 bg-card border border-line text-ink-soft font-bold text-[13px] rounded-xl py-2 active:scale-95 transition"
                  >
                    Decline
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-card rounded-2xl border border-line shadow-card p-4">
        <p className="font-bold text-[14px] text-ink">Start a team</p>
        <p className="text-[12px] text-ink-soft mt-0.5 mb-3">
          Bring managers and agents onto one WhatsApp Business number, share an inbox, and split leads.
        </p>
        <Field label="Team name">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sharma Realty" />
        </Field>
        <button
          onClick={create}
          disabled={busy || !name.trim()}
          className="mt-3 w-full bg-ink text-cream font-bold text-[13px] rounded-xl py-2.5 disabled:opacity-40 active:scale-95 transition"
        >
          Create team
        </button>
        <Err error={error} />
      </div>
    </div>
  )
}

// --- Members list + invitations (managers can invite; owner can change roles). ---
function Members({ ctx, reload }) {
  const canManage = ctx.role === 'owner' || ctx.role === 'manager'
  const isOwner = ctx.role === 'owner'
  const [phone, setPhone] = useState('')
  const [role, setRole] = useState('agent')
  const [error, setError] = useState(null)

  const invite = async () => {
    setError(null)
    try {
      await api.inviteTeamMember(phone.trim(), role)
      setPhone('')
      reload()
    } catch (e) {
      setError(e.message)
    }
  }

  const act = async (fn) => {
    setError(null)
    try {
      await fn()
      reload()
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="bg-card rounded-2xl border border-line shadow-card divide-y divide-line">
        {ctx.members.map((m) => (
          <div key={m.agent_id} className="flex items-center gap-3 px-4 py-3">
            <Avatar name={m.name} />
            <div className="min-w-0 flex-1">
              <p className="font-bold text-[13.5px] text-ink truncate">
                {m.name}
                {m.is_active === 0 && <span className="text-ink-faint font-semibold"> · suspended</span>}
              </p>
              <p className="text-[11.5px] text-ink-soft">
                {m.lead_count} lead{m.lead_count === 1 ? '' : 's'}
                {m.accepts_leads === 0 ? ' · not receiving' : ''}
                {(m.localities || []).length ? ` · ${(m.localities || []).join(', ')}` : ''}
              </p>
            </div>
            <span className={`shrink-0 text-[10.5px] font-bold rounded-full px-2 py-0.5 border ${ROLE_BADGE[m.role]}`}>
              {m.role}
            </span>
            {canManage && m.role !== 'owner' && (
              <div className="flex flex-col gap-1">
                {isOwner && (
                  <button
                    onClick={() => act(() => api.setTeamMemberRole(m.agent_id, m.role === 'manager' ? 'agent' : 'manager'))}
                    className="text-[10px] font-bold text-brand-deep"
                  >
                    {m.role === 'manager' ? '↓ agent' : '↑ manager'}
                  </button>
                )}
                <button
                  onClick={() => act(() => api.updateTeamMember(m.agent_id, { accepts_leads: m.accepts_leads === 0 }))}
                  className="text-[10px] font-bold text-ink-soft"
                >
                  {m.accepts_leads === 0 ? 'enable' : 'pause'}
                </button>
                <button onClick={() => act(() => api.removeTeamMember(m.agent_id))} className="text-[10px] font-bold text-hot">
                  remove
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {canManage && (
        <div className="bg-card rounded-2xl border border-line shadow-card p-4">
          <p className="font-bold text-[13px] text-ink mb-2">Invite a teammate</p>
          <div className="flex gap-2">
            <input
              className={inputCls}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="WhatsApp number"
            />
            <select value={role} onChange={(e) => setRole(e.target.value)} className={`${inputCls} w-32`}>
              <option value="agent">Agent</option>
              <option value="manager">Manager</option>
            </select>
          </div>
          <button
            onClick={invite}
            disabled={!phone.trim()}
            className="mt-2.5 w-full bg-brand text-white font-bold text-[13px] rounded-xl py-2 disabled:opacity-40 active:scale-95 transition"
          >
            Send invite
          </button>
          <Err error={error} />
        </div>
      )}

      {canManage && (ctx.invites || []).length > 0 && (
        <div>
          <p className="text-[12px] font-bold text-ink-soft mb-2">Pending invites</p>
          <div className="bg-card rounded-2xl border border-line shadow-card divide-y divide-line">
            {ctx.invites.map((inv) => (
              <div key={inv.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-ink">{inv.phone}</p>
                  <p className="text-[11px] text-ink-soft">invited as {inv.role}</p>
                </div>
                <button onClick={() => act(() => api.revokeTeamInvite(inv.id))} className="text-[11px] font-bold text-hot">
                  revoke
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// --- Shared team inbox: reassign owned leads, claim/distribute the pool. ---
function Inbox({ ctx, reload }) {
  const [leads, setLeads] = useState(null)
  const [error, setError] = useState(null)
  const load = useCallback(() => api.teamLeads({}).then(setLeads).catch((e) => setError(e.message)), [])
  useEffect(() => {
    load()
  }, [load])

  const act = async (fn) => {
    setError(null)
    try {
      await fn()
      load()
      reload()
    } catch (e) {
      setError(e.message)
    }
  }

  const assignable = ctx.members.filter((m) => m.accepts_leads !== 0)
  const pool = (leads || []).filter((l) => l.unassigned)

  return (
    <div className="mt-4 space-y-3">
      {ctx.team.assignment_strategy !== 'manual' && ctx.team.assignment_strategy !== 'pool' && pool.length > 0 && (
        <button
          onClick={() => act(() => api.distributeTeamPool())}
          className="w-full bg-ink text-cream font-bold text-[12.5px] rounded-xl py-2 active:scale-95 transition"
        >
          Distribute {pool.length} pooled lead{pool.length === 1 ? '' : 's'} by {ctx.team.assignment_strategy.replace('_', '-')}
        </button>
      )}
      <Err error={error} />
      {leads && leads.length === 0 && <p className="text-[12.5px] text-ink-faint mt-3">No leads in the team yet.</p>}
      <div className="space-y-2">
        {(leads || []).map((l) => (
          <div key={l.id} className="bg-card rounded-2xl border border-line shadow-card px-4 py-3">
            <div className="flex items-center gap-2">
              <p className="font-bold text-[13.5px] text-ink flex-1 truncate">{l.name || l.wa_id}</p>
              {l.unassigned ? (
                <span className="text-[10px] font-bold rounded-full px-2 py-0.5 border bg-amber-wash text-hot border-amber/40">pool</span>
              ) : (
                <span className="text-[11px] text-ink-soft">{l.agent_name}</span>
              )}
            </div>
            {l.last_msg && <p className="text-[11.5px] text-ink-soft truncate mt-0.5">{l.last_msg}</p>}
            <div className="flex items-center gap-2 mt-2">
              <span className="text-[10.5px] text-ink-faint">{fmtAgo(l.last_at || l.updated_at)}</span>
              <span className="flex-1" />
              <select
                defaultValue=""
                onChange={(e) => e.target.value && act(() => api.assignTeamLead(l.id, Number(e.target.value)))}
                className="text-[11px] bg-white border border-line rounded-lg px-2 py-1 outline-none"
              >
                <option value="" disabled>
                  {l.unassigned ? 'Assign to…' : 'Reassign…'}
                </option>
                {assignable.map((m) => (
                  <option key={m.agent_id} value={m.agent_id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// --- Manager board: response-time leaderboard + stale leads to reassign. ---
function Board({ reload }) {
  const [board, setBoard] = useState(null)
  const [stale, setStale] = useState(null)
  useEffect(() => {
    api.teamLeaderboard().then(setBoard).catch(() => {})
    api.teamStale(3).then(setStale).catch(() => {})
  }, [reload])

  return (
    <div className="mt-4 space-y-5">
      <div>
        <p className="text-[12px] font-bold text-ink-soft mb-2">Response-time leaderboard</p>
        <div className="bg-card rounded-2xl border border-line shadow-card divide-y divide-line">
          {(board || []).map((r, i) => (
            <div key={r.agent_id} className="flex items-center gap-3 px-4 py-2.5">
              <span className="w-5 text-center font-display font-bold text-[13px] text-ink-faint">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="font-bold text-[13px] text-ink truncate">{r.name}</p>
                <p className="text-[11px] text-ink-soft">
                  {r.total_leads} leads · {r.hot_leads} hot · {r.won_leads} won
                  {r.stale_leads ? ` · ${r.stale_leads} stale` : ''}
                </p>
              </div>
              <span className="shrink-0 font-display font-bold text-[13px] text-ink tabular-nums">
                {fmtDur(r.avg_first_response_s)}
              </span>
            </div>
          ))}
        </div>
      </div>

      {(stale || []).length > 0 && (
        <div>
          <p className="text-[12px] font-bold text-ink-soft mb-2">Stale leads (idle 3+ days)</p>
          <div className="bg-card rounded-2xl border border-line shadow-card divide-y divide-line">
            {stale.map((l) => (
              <div key={l.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-[13px] text-ink truncate">{l.name || l.wa_id}</p>
                  <p className="text-[11px] text-ink-soft">
                    {l.agent_name || 'pool'} · idle {Math.floor(Number(l.idle_s) / 86400)}d
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// --- Owner settings: assignment strategy, rename, disband. ---
function Settings({ ctx, reload }) {
  const [name, setName] = useState(ctx.team.name)
  const [error, setError] = useState(null)

  const save = async (fields) => {
    setError(null)
    try {
      await api.updateTeam(fields)
      reload()
    } catch (e) {
      setError(e.message)
    }
  }

  const disband = async () => {
    if (!window.confirm('Disband this team? Members become solo agents; their leads stay with them.')) return
    try {
      await api.deleteTeam()
      reload()
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="bg-card rounded-2xl border border-line shadow-card p-4">
        <p className="font-bold text-[13px] text-ink mb-2">Lead assignment</p>
        <div className="space-y-2">
          {STRATEGIES.map((s) => (
            <button
              key={s.id}
              onClick={() => save({ assignment_strategy: s.id })}
              className={`w-full text-left rounded-xl px-3 py-2.5 border transition active:scale-[0.99] ${
                ctx.team.assignment_strategy === s.id ? 'bg-brand-wash border-brand/40' : 'bg-white border-line'
              }`}
            >
              <p className="font-bold text-[13px] text-ink">{s.label}</p>
              <p className="text-[11.5px] text-ink-soft">{s.sub}</p>
            </button>
          ))}
        </div>
      </div>

      <div className="bg-card rounded-2xl border border-line shadow-card p-4">
        <Field label="Team name">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <button
          onClick={() => save({ name: name.trim() })}
          disabled={!name.trim() || name.trim() === ctx.team.name}
          className="mt-2.5 w-full bg-ink text-cream font-bold text-[13px] rounded-xl py-2 disabled:opacity-40 active:scale-95 transition"
        >
          Save name
        </button>
      </div>

      <button onClick={disband} className="w-full text-hot font-bold text-[13px] py-2">
        Disband team
      </button>
      <Err error={error} />
    </div>
  )
}

export default function TeamScreen() {
  const [ctx, setCtx] = useState(undefined)
  const [view, setView] = useState('members')
  const reload = useCallback(() => api.team().then(setCtx).catch(() => setCtx(null)), [])
  useEffect(() => {
    reload()
  }, [reload])

  if (ctx === undefined) return <p className="mt-6 text-[13px] text-ink-faint">Loading…</p>
  if (!ctx || !ctx.team) return <NoTeam ctx={ctx || { incoming_invites: [] }} reload={reload} />

  const canManage = ctx.role === 'owner' || ctx.role === 'manager'
  const isOwner = ctx.role === 'owner'
  const tabs = [
    ['members', 'Members'],
    ...(canManage ? [['inbox', 'Inbox'], ['board', 'Board']] : []),
    ...(isOwner ? [['settings', 'Settings']] : []),
  ]

  return (
    <div>
      <div className="mt-3 flex items-center gap-2">
        <span className={`text-[10.5px] font-bold rounded-full px-2 py-0.5 border ${ROLE_BADGE[ctx.role]}`}>
          {ctx.role}
        </span>
        <span className="text-[12px] text-ink-soft">{ctx.team.name}</span>
      </div>
      <div className="flex gap-2 mt-3 overflow-x-auto no-scrollbar">
        {tabs.map(([id, label]) => (
          <Chip key={id} active={view === id} onClick={() => setView(id)}>
            {label}
          </Chip>
        ))}
      </div>

      {view === 'members' && <Members ctx={ctx} reload={reload} />}
      {view === 'inbox' && canManage && <Inbox ctx={ctx} reload={reload} />}
      {view === 'board' && canManage && <Board reload={ctx} />}
      {view === 'settings' && isOwner && <Settings ctx={ctx} reload={reload} />}
    </div>
  )
}
