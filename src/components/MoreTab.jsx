import { useState } from 'react'
import { api, usePoll, fmtTime, fmtAgo } from '../api.js'
import { Chip } from './ui.jsx'
import ContactsTab from './ContactsTab.jsx'
import InsightsTab from './InsightsTab.jsx'
import SettingsTab from './SettingsTab.jsx'
import LeadDetail from './LeadDetail.jsx'
import FestiveTab from './FestiveTab.jsx'
import LeadSourcesScreen from './LeadSourcesScreen.jsx'
import SnippetsMediaScreen from './SnippetsMediaScreen.jsx'
import TeamScreen from './TeamScreen.jsx'

function SubScreen({ title, onBack, children }) {
  return (
    <div className="px-5 pt-7">
      <header className="rise flex items-center gap-3">
        <button onClick={onBack} className="w-9 h-9 rounded-full bg-card border border-line flex items-center justify-center text-ink shadow-card active:scale-95 transition">
          ←
        </button>
        <h1 className="font-display text-[24px] font-semibold text-ink">{title}</h1>
      </header>
      {children}
    </div>
  )
}

function FollowupsScreen({ onBack, onOpenLead }) {
  const [filter, setFilter] = useState('pending') // pending | today | all
  const [refreshKey, setRefreshKey] = useState(0)
  const { data: followups } = usePoll(
    () => api.followups(filter === 'all' ? {} : filter === 'today' ? { pending: '1', today: '1' } : { pending: '1' }),
    6000,
    [filter, refreshKey],
  )

  const toggle = async (f) => {
    await api.updateFollowup(f.id, { completed: !f.completed_at })
    setRefreshKey((k) => k + 1)
  }

  return (
    <SubScreen title="Follow-ups" onBack={onBack}>
      <div className="flex gap-2 mt-4">
        {['pending', 'today', 'all'].map((f) => (
          <Chip key={f} active={filter === f} onClick={() => setFilter(f)}>
            {f === 'pending' ? 'Pending' : f === 'today' ? 'Due today' : 'All'}
          </Chip>
        ))}
      </div>
      {followups && followups.length === 0 && (
        <p className="mt-6 text-[12.5px] text-ink-faint">Nothing here. Schedule follow-ups from any lead.</p>
      )}
      <div className="mt-4 bg-card rounded-2xl border border-line shadow-card divide-y divide-line">
        {(followups || []).map((f) => {
          const done = Boolean(f.completed_at)
          return (
            <div key={f.id} className="flex items-center gap-3 px-4 py-3">
              <button
                onClick={() => toggle(f)}
                className={`shrink-0 w-6 h-6 rounded-full border-2 text-[12px] leading-none transition active:scale-90 ${
                  done ? 'bg-brand border-brand text-white' : 'border-brand/50 text-transparent'
                }`}
              >
                ✓
              </button>
              <button onClick={() => onOpenLead(f.lead_id)} className="min-w-0 flex-1 text-left">
                <p className={`text-[13px] font-bold truncate ${done ? 'line-through text-ink-faint' : f.overdue ? 'text-hot' : 'text-ink'}`}>
                  {f.lead_name || f.lead_wa_id}
                  {f.overdue && !done ? ' · overdue' : ''}
                </p>
                {f.note && <p className={`text-[12px] truncate ${done ? 'text-ink-faint' : 'text-ink-soft'}`}>{f.note}</p>}
              </button>
              <span className={`shrink-0 text-[11px] font-medium tabular-nums ${f.overdue && !done ? 'text-hot' : 'text-ink-faint'}`}>
                {fmtTime(f.due_at)}
              </span>
            </div>
          )
        })}
      </div>
    </SubScreen>
  )
}

function SiteVisitsScreen({ onBack, onOpenLead }) {
  const [filter, setFilter] = useState('upcoming') // today | upcoming | all
  const [refreshKey, setRefreshKey] = useState(0)
  const { data: visits } = usePoll(
    () => api.siteVisits(filter === 'today' ? { today: '1' } : {}),
    6000,
    [filter, refreshKey],
  )

  const shown = (visits || []).filter((v) => {
    if (filter !== 'upcoming') return true
    return !['completed', 'no_show'].includes(v.status)
  })

  const advance = async (v, status) => {
    await api.updateSiteVisit(v.id, { status })
    setRefreshKey((k) => k + 1)
  }

  return (
    <SubScreen title="Site visits" onBack={onBack}>
      <div className="flex gap-2 mt-4">
        {['today', 'upcoming', 'all'].map((f) => (
          <Chip key={f} active={filter === f} onClick={() => setFilter(f)}>
            {f[0].toUpperCase() + f.slice(1)}
          </Chip>
        ))}
      </div>
      {visits && shown.length === 0 && (
        <p className="mt-6 text-[12.5px] text-ink-faint">No site visits. Schedule one from any lead.</p>
      )}
      <div className="space-y-2.5 mt-4">
        {shown.map((v) => (
          <div key={v.id} className="bg-card rounded-2xl border border-line shadow-card px-4 py-3.5">
            <button onClick={() => onOpenLead(v.lead_id)} className="w-full text-left">
              <p className="font-bold text-[14px] text-ink">
                {v.lead_name || v.lead_wa_id}
                {v.property_title ? <span className="text-ink-soft font-semibold"> → {v.property_title}</span> : null}
              </p>
              <p className="text-[12px] text-ink-soft mt-0.5">
                {fmtTime(v.scheduled_at)} · {fmtAgo(v.scheduled_at)}
                {v.pickup_required ? ` · 🚗 ${v.pickup_location || 'pickup'}` : ''}
              </p>
            </button>
            <div className="flex gap-1.5 flex-wrap mt-2">
              {['scheduled', 'confirmed', 'completed', 'no_show', 'rescheduled'].map((s) => (
                <button
                  key={s}
                  onClick={() => s !== v.status && advance(v, s)}
                  className={`text-[10.5px] font-bold rounded-full px-2.5 py-1 border transition active:scale-95 ${
                    v.status === s ? 'bg-ink text-cream border-ink' : 'bg-card text-ink-soft border-line'
                  }`}
                >
                  {s.replace('_', ' ')}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </SubScreen>
  )
}

const MENU = [
  { id: 'team', icon: '🤝', label: 'Team', sub: 'Roles, lead assignment, shared inbox' },
  { id: 'sources', icon: '🎯', label: 'Lead sources', sub: 'Portals, Lead Ads, click-to-WhatsApp' },
  { id: 'followups', icon: '⏰', label: 'Follow-ups', sub: 'Reminders and overdue nudges' },
  { id: 'sitevisits', icon: '🏗️', label: 'Site visits', sub: "Today's and upcoming visits" },
  { id: 'contacts', icon: '👥', label: 'Contacts', sub: 'Auto-captured from WhatsApp' },
  { id: 'snippets', icon: '⚡', label: 'Snippets & media', sub: 'Templates, quick replies, media library, labels' },
  { id: 'festive', icon: '🪔', label: 'Festive greetings', sub: 'Diwali, Holi, Eid & more — schedule wishes' },
  { id: 'insights', icon: '📊', label: 'Insights', sub: 'Performance and market network' },
  { id: 'settings', icon: '⚙️', label: 'Settings', sub: 'Profile, password, preferences, WhatsApp Business' },
]

// The "More" tab: follow-ups, site visits, contacts, insights, and settings.
export default function MoreTab({ agent, onAgentUpdate, onOpenConversation }) {
  const [screen, setScreen] = useState(null)
  const [leadId, setLeadId] = useState(null)

  const openLead = (id) => setLeadId(id)

  if (screen === 'followups') return <FollowupsWrap onBack={() => setScreen(null)} openLead={openLead} leadId={leadId} setLeadId={setLeadId} onOpenConversation={onOpenConversation} />
  if (screen === 'sitevisits') return <SiteVisitsWrap onBack={() => setScreen(null)} openLead={openLead} leadId={leadId} setLeadId={setLeadId} onOpenConversation={onOpenConversation} />
  if (screen === 'contacts')
    return (
      <div>
        <div className="px-5 pt-7 pb-0">
          <button onClick={() => setScreen(null)} className="text-[12.5px] font-bold text-ink-soft">← More</button>
        </div>
        <ContactsTab onOpenLead={openLead} />
        {leadId && (
          <LeadDetail leadId={leadId} onClose={() => setLeadId(null)} onOpenConversation={onOpenConversation} />
        )}
      </div>
    )
  if (screen === 'team')
    return (
      <SubScreen title="Team" onBack={() => setScreen(null)}>
        <TeamScreen />
      </SubScreen>
    )
  if (screen === 'sources')
    return (
      <SubScreen title="Lead sources" onBack={() => setScreen(null)}>
        <LeadSourcesScreen />
      </SubScreen>
    )
  if (screen === 'snippets')
    return (
      <SubScreen title="Snippets & media" onBack={() => setScreen(null)}>
        <SnippetsMediaScreen />
      </SubScreen>
    )
  if (screen === 'festive')
    return (
      <SubScreen title="Festive greetings" onBack={() => setScreen(null)}>
        <FestiveTab />
      </SubScreen>
    )
  if (screen === 'insights')
    return (
      <div>
        <div className="px-5 pt-7 pb-0">
          <button onClick={() => setScreen(null)} className="text-[12.5px] font-bold text-ink-soft">← More</button>
        </div>
        <InsightsTab />
      </div>
    )
  if (screen === 'settings')
    return (
      <div>
        <div className="px-5 pt-7 pb-0">
          <button onClick={() => setScreen(null)} className="text-[12.5px] font-bold text-ink-soft">← More</button>
        </div>
        <SettingsTab agent={agent} onAgentUpdate={onAgentUpdate} />
      </div>
    )

  return (
    <div className="px-5 pt-7">
      <header className="rise">
        <h1 className="font-display text-[28px] font-semibold text-ink">More</h1>
        <p className="text-[13px] text-ink-soft mt-0.5">Everything else in your HomeNex toolkit</p>
      </header>
      <div className="space-y-2.5 mt-5">
        {MENU.map((m, i) => (
          <button
            key={m.id}
            onClick={() => setScreen(m.id)}
            className={`w-full text-left bg-card rounded-2xl border border-line shadow-card px-4 py-4 active:scale-[0.99] transition rise rise-${Math.min(i + 1, 5)}`}
          >
            <div className="flex items-center gap-3">
              <span className="text-[22px]">{m.icon}</span>
              <div className="min-w-0 flex-1">
                <p className="font-bold text-[14.5px] text-ink">{m.label}</p>
                <p className="text-[12px] text-ink-soft mt-0.5">{m.sub}</p>
              </div>
              <span className="text-ink-faint text-lg">→</span>
            </div>
          </button>
        ))}
        {agent?.is_admin === 1 && (
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('homenex-navigate', { detail: 'admin' }))}
            className="w-full text-left bg-card rounded-2xl border border-line shadow-card px-4 py-4 active:scale-[0.99] transition"
          >
            <div className="flex items-center gap-3">
              <span className="text-[22px]">🛡️</span>
              <div className="min-w-0 flex-1">
                <p className="font-bold text-[14.5px] text-ink">Team &amp; admin</p>
                <p className="text-[12px] text-ink-soft mt-0.5">Agents, admin access, WABA registrations</p>
              </div>
              <span className="text-ink-faint text-lg">→</span>
            </div>
          </button>
        )}
      </div>
    </div>
  )
}

function FollowupsWrap({ onBack, openLead, leadId, setLeadId, onOpenConversation }) {
  return (
    <div>
      <FollowupsScreen onBack={onBack} onOpenLead={openLead} />
      {leadId && <LeadDetail leadId={leadId} onClose={() => setLeadId(null)} onOpenConversation={onOpenConversation} />}
    </div>
  )
}

function SiteVisitsWrap({ onBack, openLead, leadId, setLeadId, onOpenConversation }) {
  return (
    <div>
      <SiteVisitsScreen onBack={onBack} onOpenLead={openLead} />
      {leadId && <LeadDetail leadId={leadId} onClose={() => setLeadId(null)} onOpenConversation={onOpenConversation} />}
    </div>
  )
}
