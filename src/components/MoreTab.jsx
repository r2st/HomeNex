import { useState } from 'react'
import { api, usePoll, fmtTime, fmtAgo } from '../api.js'
import { Chip } from './ui.jsx'
import { visitStatusLabel } from '../lib/labels.js'
import ContactsTab from './ContactsTab.jsx'
import InsightsTab from './InsightsTab.jsx'
import SettingsTab from './SettingsTab.jsx'
import LeadDetail from './LeadDetail.jsx'
import FestiveTab from './FestiveTab.jsx'
import LeadSourcesScreen from './LeadSourcesScreen.jsx'
import SnippetsMediaScreen from './SnippetsMediaScreen.jsx'
import TeamScreen from './TeamScreen.jsx'
import SupportScreen from './SupportScreen.jsx'
import CommissionsScreen from './CommissionsScreen.jsx'

function SubScreen({ title, onBack, children }) {
  return (
    <div className="px-5 pt-7">
      <header className="rise flex items-center gap-3">
        <button aria-label="Back" onClick={onBack} className="w-9 h-9 rounded-full bg-card border border-line flex items-center justify-center text-ink shadow-card active:scale-95 transition">
          <span aria-hidden="true">←</span>
        </button>
        <h1 className="font-display text-[24px] font-semibold text-ink">{title}</h1>
      </header>
      {children}
    </div>
  )
}

function FollowupsScreen({ onBack, onOpenLead }) {
  const [filter, setFilter] = useState('pending') // pending | today | all
  const { data: followups, error, loading, refresh } = usePoll(
    () => api.followups(filter === 'all' ? {} : filter === 'today' ? { pending: '1', today: '1' } : { pending: '1' }),
    6000,
    [filter],
  )

  const toggle = async (f) => {
    await api.updateFollowup(f.id, { completed: !f.completed_at })
    refresh()
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
      {/* A missed follow-up is money, so "we couldn't load them" must never look the
          same as "you have none" — this screen used to render both as a blank card. */}
      {error && !followups && (
        <p className="mt-6 text-[12.5px] text-hot bg-amber-wash rounded-xl px-4 py-3">
          Can't load your follow-ups: {error.message}
        </p>
      )}
      {loading && !followups && !error && (
        <p className="mt-6 text-[12.5px] text-ink-faint" aria-busy="true">
          Loading your follow-ups…
        </p>
      )}
      {followups && followups.length === 0 && (
        <p className="mt-6 text-[12.5px] text-ink-faint">Nothing here. Schedule follow-ups from any lead.</p>
      )}
      <div className="mt-4 bg-card rounded-2xl border border-line shadow-card divide-y divide-line">
        {(followups || []).map((f) => {
          const done = Boolean(f.completed_at)
          return (
            <div key={f.id} className="flex items-center gap-3 px-4 py-3">
              {/* The tick is `text-transparent` until the follow-up is done, so this
                  control's entire visible content is invisible half the time and a bare
                  "✓" the other half. aria-pressed carries the state; the name carries
                  which of the listed follow-ups it belongs to. */}
              <button
                onClick={() => toggle(f)}
                aria-pressed={done}
                aria-label={`Mark the follow-up for ${f.lead_name || f.lead_wa_id} ${done ? 'not done' : 'done'}`}
                className={`shrink-0 w-6 h-6 rounded-full border-2 text-[12px] leading-none transition active:scale-90 ${
                  done ? 'bg-brand border-brand text-white' : 'border-brand/50 text-transparent'
                }`}
              >
                <span aria-hidden="true">✓</span>
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
  const { data: visits, error, loading, refresh } = usePoll(
    () => api.siteVisits(filter === 'today' ? { today: '1' } : {}),
    6000,
    [filter],
  )

  const shown = (visits || []).filter((v) => {
    if (filter !== 'upcoming') return true
    return !['completed', 'no_show'].includes(v.status)
  })

  const advance = async (v, status) => {
    await api.updateSiteVisit(v.id, { status })
    refresh()
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
      {error && !visits && (
        <p className="mt-6 text-[12.5px] text-hot bg-amber-wash rounded-xl px-4 py-3">
          Can't load your site visits: {error.message}
        </p>
      )}
      {loading && !visits && !error && (
        <p className="mt-6 text-[12.5px] text-ink-faint" aria-busy="true">
          Loading your site visits…
        </p>
      )}
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
                  {visitStatusLabel(s)}
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
  { id: 'followups', icon: '⏰', label: 'Follow-ups', sub: 'Reminders to call leads back — never miss one' },
  { id: 'sitevisits', icon: '🏗️', label: 'Site visits', sub: 'Schedule and track property tours' },
  { id: 'team', icon: '🤝', label: 'Team', sub: 'Add teammates and share leads' },
  { id: 'sources', icon: '🎯', label: 'Lead sources', sub: 'Get leads from 99acres, Facebook ads and more' },
  { id: 'commissions', icon: '💰', label: 'Deals & commissions', sub: 'Track earnings, payments due and invoices' },
  { id: 'contacts', icon: '👥', label: 'Contacts', sub: 'Everyone who has messaged you, saved automatically' },
  { id: 'snippets', icon: '⚡', label: 'Snippets & media', sub: 'Saved replies, message templates and files to send' },
  { id: 'festive', icon: '🪔', label: 'Festive greetings', sub: 'Schedule Diwali, Holi, Eid & other wishes' },
  { id: 'insights', icon: '📊', label: 'Insights', sub: 'See how you and your leads are performing' },
  { id: 'support', icon: '💬', label: 'Help & billing', sub: 'Get support and manage your plan' },
  { id: 'settings', icon: '⚙️', label: 'Settings', sub: 'Profile, password and your WhatsApp Business number' },
]

// The "More" tab: follow-ups, site visits, contacts, insights, and settings.
export default function MoreTab({ agent, onAgentUpdate, onOpenConversation, followupBadge }) {
  const [screen, setScreen] = useState(null)
  const [leadId, setLeadId] = useState(null)

  const openLead = (id) => setLeadId(id)

  if (screen === 'followups') return <FollowupsWrap onBack={() => setScreen(null)} openLead={openLead} leadId={leadId} setLeadId={setLeadId} onOpenConversation={onOpenConversation} />
  if (screen === 'sitevisits') return <SiteVisitsWrap onBack={() => setScreen(null)} openLead={openLead} leadId={leadId} setLeadId={setLeadId} onOpenConversation={onOpenConversation} />
  if (screen === 'commissions')
    return (
      <div>
        <SubScreen title="Deals & commissions" onBack={() => setScreen(null)}>
          <CommissionsScreen onOpenLead={openLead} />
        </SubScreen>
        {leadId && <LeadDetail leadId={leadId} onClose={() => setLeadId(null)} onOpenConversation={onOpenConversation} />}
      </div>
    )
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
  if (screen === 'support')
    return (
      <SubScreen title="Help & billing" onBack={() => setScreen(null)}>
        <SupportScreen />
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
        <p className="text-[13px] text-ink-soft mt-0.5">Everything else in your DoAide Realty toolkit</p>
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
                <div className="flex items-center gap-2">
                  <p className="font-bold text-[14.5px] text-ink">{m.label}</p>
                  {m.id === 'followups' && followupBadge && (
                    <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-hot text-white text-[10px] font-bold flex items-center justify-center leading-none">
                      {followupBadge}
                    </span>
                  )}
                </div>
                <p className="text-[12px] text-ink-soft mt-0.5">{m.sub}</p>
              </div>
              <span className="text-ink-faint text-lg">→</span>
            </div>
          </button>
        ))}
        {agent?.is_admin === 1 && (
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('realty-navigate', { detail: 'admin' }))}
            className="w-full text-left bg-card rounded-2xl border border-line shadow-card px-4 py-4 active:scale-[0.99] transition"
          >
            <div className="flex items-center gap-3">
              <span className="text-[22px]">🛡️</span>
              <div className="min-w-0 flex-1">
                <p className="font-bold text-[14.5px] text-ink">Team &amp; admin</p>
                <p className="text-[12px] text-ink-soft mt-0.5">Agents, admin access, WhatsApp number setup</p>
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
