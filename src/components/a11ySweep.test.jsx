// Every control on every screen has to say what it does — swept, not spot-checked.
//
// `accessibleNames.test.jsx` names the controls somebody already noticed were
// silent. This file mounts each screen and asks the opposite question: is there
// ANYTHING here a screen reader would announce as a bare "button" or "edit"? That
// makes the check total rather than a list, so a control added next month is
// already covered — and it is why the assertions below carry no expected names.
//
// The resolver in ../test/a11y.js follows the platform's rules (see the comment
// there), with one deliberate addition: a name has to contain a letter or a digit.
// A button whose whole accessible name is "✓" or "→" is announced as "check mark
// button", which on a list of eight follow-ups identifies nothing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, click, act } from '../test/render.jsx'
import { installBrowser, mockFetch } from '../test/browserEnv.js'
import { assertAllControlsNamed } from '../test/a11y.js'
import DashboardTab from './DashboardTab.jsx'
import LeadsTab from './LeadsTab.jsx'
import InboxTab from './InboxTab.jsx'
import PropertiesTab from './PropertiesTab.jsx'
import ContactsTab from './ContactsTab.jsx'
import MoreTab from './MoreTab.jsx'
import SettingsTab from './SettingsTab.jsx'
import InsightsTab from './InsightsTab.jsx'
import FestiveTab from './FestiveTab.jsx'
import CommissionsScreen from './CommissionsScreen.jsx'
import SupportScreen from './SupportScreen.jsx'
import LeadSourcesScreen from './LeadSourcesScreen.jsx'
import SnippetsMediaScreen from './SnippetsMediaScreen.jsx'
import TeamScreen from './TeamScreen.jsx'
import AuthScreen from './AuthScreen.jsx'
import AdminPanel from './AdminPanel.jsx'
import LeadDetail from './LeadDetail.jsx'
import PropertyDetail from './PropertyDetail.jsx'

const NOW = Date.parse('2026-08-10T12:00:00.000Z')
const HOUR = 3600_000
const iso = (offset) => new Date(NOW + offset).toISOString()

const agent = { id: 1, name: 'Ravi Kumar', phone: '919812345678', is_admin: 1, wa_phone: '919812345678' }

const lead = {
  id: 5,
  agent_id: 1,
  name: 'Priya Sharma',
  wa_id: '919876543210',
  stage: 'New',
  pipeline_type: 'buy_primary',
  temp: 'Hot',
  score: 72,
  ai_enabled: 0,
  budget_min_l: 60,
  budget_max_l: 80,
  last_inbound_at: iso(-2 * HOUR),
  updated_at: iso(-HOUR),
  labels: [],
  notes: [],
  messages: [{ id: 1, role: 'buyer', text: 'Still available?', created_at: iso(-HOUR) }],
  followups: [],
  site_visits: [],
}

const property = {
  id: 11,
  title: 'Prestige Lakeside 3BHK',
  property_type: 'apartment',
  status: 'available',
  bhk: 3,
  size_sqft: 1450,
  price_l: 95,
  locality: 'Baner',
  city: 'Pune',
  notes: '',
}

// One table wide enough for any screen to mount. A screen that asks for something
// missing gets a 404 and renders its error state — which is still a screen whose
// controls must be named, so an unlisted route weakens the sweep rather than
// breaking it. Everything a screen actually reads is listed.
const ROUTES = {
  'GET /api/auth/me': agent,
  'GET /api/health': { ok: true, whatsapp: true, whatsapp_send: true },
  'GET /api/stats': {
    total: 4,
    newToday: 2,
    active24h: 3,
    avgFirstResponseS: 42,
    qualifiedPct: 75,
    afterHours: 1,
    daily: [{ day: '2026-08-10', avg_s: 42, count: 2 }],
    sources: [{ source: 'whatsapp_inbound', count: 4 }],
  },
  'GET /api/dashboard': {
    unanswered: [{ ...lead, last_msg: 'Still available?' }],
    hotLeads: [lead],
    followupsToday: [{ id: 9, lead_id: 5, lead_name: 'Priya Sharma', note: 'Call back', due_at: iso(HOUR) }],
    overdueFollowups: [{ id: 10, lead_id: 5, lead_name: 'Arjun Rao', note: 'Send options', due_at: iso(-3 * HOUR) }],
    siteVisitsToday: [{ id: 3, lead_id: 5, lead_name: 'Priya Sharma', scheduled_at: iso(HOUR), status: 'scheduled' }],
    activity: [{ id: 1, kind: 'message', body: 'Priya messaged you', created_at: iso(-HOUR) }],
  },
  'GET /api/activity': [],
  'GET /api/worklist': {
    items: [{ lead_id: 5, name: 'Priya Sharma', wa_id: '919876543210', reason: 'waiting', action: 'reply_now', rank: 1, score: 72 }],
    counts: { total: 1, reply_now: 1 },
  },
  'GET /api/notifications': {
    notifications: [{ id: 3, kind: 'lead_hot', body: 'Priya went hot', entity_id: 5, read_at: null, created_at: iso(-HOUR) }],
  },
  'GET /api/leads': [lead],
  'GET /api/leads/count': { total: 1, unassigned: 0, by_pipeline: { buy_primary: 1 }, by_stage: {} },
  'GET /api/leads/5': lead,
  'GET /api/leads/5/suggestions': { suggestions: [] },
  'GET /api/leads/5/autofill': { suggestions: [] },
  'GET /api/leads/5/briefing': { talking_points: [] },
  'GET /api/leads/5/property-matches': [],
  'GET /api/leads/5/notes': [],
  'POST /api/leads/5/read': { ok: true },
  'GET /api/pipeline-stages': [
    { id: 1, stage_name: 'New', stage_order: 1 },
    { id: 2, stage_name: 'Contacted', stage_order: 2 },
  ],
  'GET /api/pipeline/analytics': { stages: [], conversion: [] },
  'GET /api/properties': [property],
  'GET /api/properties/count': { total: 1 },
  'GET /api/properties/11': property,
  'GET /api/properties/11/analytics': { views: 0, shares: 0, matches: 0 },
  'GET /api/properties/11/syndications': [],
  'GET /api/contacts': [{ id: 4, name: 'Priya Sharma', phone: '+919876543210', source: 'whatsapp_inbound', msg_count: 2 }],
  'GET /api/contacts/count': { total: 1 },
  'GET /api/contacts/4': { id: 4, name: 'Priya Sharma', phone: '+919876543210', notes: '', leads: [] },
  'GET /api/groups': [{ id: 2, name: 'Baner buyers', member_count: 3 }],
  'GET /api/groups/2/members': [],
  'GET /api/followups': [
    { id: 9, lead_id: 5, lead_name: 'Priya Sharma', note: 'Call back', due_at: iso(HOUR), overdue: 0, completed_at: null },
  ],
  'GET /api/site-visits': [
    { id: 3, lead_id: 5, lead_name: 'Priya Sharma', property_title: 'Prestige Lakeside 3BHK', scheduled_at: iso(HOUR), status: 'scheduled' },
  ],
  'GET /api/templates': [{ id: 1, name: 'Welcome', body: 'Hi {{1}}', status: 'approved' }],
  'GET /api/templates/festive': { upcoming: [], scheduled: [] },
  'GET /api/quick-replies': [{ id: 1, shortcut: '/price', body: 'The price is…' }],
  'GET /api/labels': [{ id: 1, name: 'Investor', colour: '#22c55e' }],
  'GET /api/media': [],
  'GET /api/deals': [],
  'GET /api/commissions': [],
  'GET /api/commissions/receivables': { builders: [], totals: { d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 }, received_paise: 0 },
  'GET /api/commission-invoices': [],
  'GET /api/support/tickets': [],
  'GET /api/billing': { plan: 'starter', status: 'active', renews_at: iso(30 * 24 * HOUR), usage: {} },
  'GET /api/lead-sources': { ingest_email: 'leads+ravi@homenex.in', leadgen_form_id: null, events: [] },
  'GET /api/portal-integrations': [],
  'GET /api/network': [],
  'GET /api/agent/phone-config': { wa_phone: '919812345678', phone_number_id: '1234', verified: true },
  'GET /api/team': {
    team: { id: 1, name: 'Sharma Realty', assignment_strategy: 'manual' },
    members: [{ member_id: 1, agent_id: 1, name: 'Ravi Kumar', role: 'owner' }],
    role: 'owner',
    invites: [],
  },
  'GET /api/team/leads': [{ id: 7, name: 'Arjun Rao', wa_id: '919876543211', unassigned: 1, updated_at: iso(0) }],
  'GET /api/team/leaderboard': [],
  'GET /api/team/pipeline': { stages: [] },
  'GET /api/team/stale': [],
  'GET /api/admin/agents': { agents: [{ id: 1, name: 'Ravi Kumar', phone: '919812345678', is_admin: 1, is_active: 1 }], total: 1 },
  'GET /api/admin/dashboard': { agents: 1, leads: 4, messages: 12 },
  'GET /api/admin/audit-logs': [],
}

function mount(t, extra = {}) {
  const env = installBrowser({ now: NOW })
  const net = mockFetch({ ...ROUTES, ...extra })
  t.after(() => {
    net.restore()
    env.restore()
  })
  return { env, net }
}

// Each entry mounts one screen exactly as App.jsx (or MoreTab) does. `open` runs the
// taps needed to reach a screen's non-default state — the forms and pickers are
// where nameless controls hide, and a sweep that only ever saw the list view would
// miss all of them.
const SCREENS = [
  {
    name: 'Home',
    el: () => <DashboardTab agent={agent} onGoTo={() => {}} onOpenConversation={() => {}} onOpenLead={() => {}} onSignOut={() => {}} />,
  },
  { name: 'Leads', el: () => <LeadsTab onOpenConversation={() => {}} /> },
  { name: 'Inbox (thread open)', el: () => <InboxTab leadId={5} onSelectLead={() => {}} /> },
  { name: 'Inbox (list)', el: () => <InboxTab leadId={null} onSelectLead={() => {}} /> },
  { name: 'Properties', el: () => <PropertiesTab onOpenLead={() => {}} /> },
  { name: 'Contacts', el: () => <ContactsTab onOpenLead={() => {}} /> },
  { name: 'More (menu)', el: () => <MoreTab agent={agent} onAgentUpdate={() => {}} onOpenConversation={() => {}} followupBadge="3" /> },
  { name: 'Settings', el: () => <SettingsTab agent={agent} onAgentUpdate={() => {}} /> },
  { name: 'Insights', el: () => <InsightsTab /> },
  { name: 'Festive greetings', el: () => <FestiveTab /> },
  { name: 'Deals & commissions', el: () => <CommissionsScreen onOpenLead={() => {}} /> },
  { name: 'Help & billing', el: () => <SupportScreen /> },
  { name: 'Lead sources', el: () => <LeadSourcesScreen /> },
  { name: 'Snippets & media', el: () => <SnippetsMediaScreen /> },
  { name: 'Team', el: () => <TeamScreen /> },
  { name: 'Sign in', el: () => <AuthScreen onAuthed={() => {}} /> },
  { name: 'Admin panel', el: () => <AdminPanel agent={agent} onBack={() => {}} /> },
  { name: 'Lead detail', el: () => <LeadDetail leadId={5} onClose={() => {}} onChanged={() => {}} onOpenConversation={() => {}} /> },
  { name: 'Property detail', el: () => <PropertyDetail propertyId={11} onClose={() => {}} onChanged={() => {}} onOpenLead={() => {}} /> },
  {
    name: 'More → Follow-ups',
    el: () => <MoreTab agent={agent} onAgentUpdate={() => {}} onOpenConversation={() => {}} />,
    open: (ui) => click(ui.byText('Follow-ups', { selector: 'button' })),
  },
  {
    name: 'More → Site visits',
    el: () => <MoreTab agent={agent} onAgentUpdate={() => {}} onOpenConversation={() => {}} />,
    open: (ui) => click(ui.byText('Site visits', { selector: 'button' })),
  },
]

for (const screen of SCREENS) {
  test(`every control on ${screen.name} announces what it does`, async (t) => {
    mount(t)
    const ui = await render(screen.el())
    if (screen.open) {
      await screen.open(ui)
      await act(() => {})
    }
    assertAllControlsNamed(assert, ui, screen.name)
  })
}

// --- The states a sweep of the resting screen never reaches ----------------------

test('every control in the groups panel announces what it does', async (t) => {
  // Collapsed on arrival, so the resting sweep of Contacts never sees it — and the
  // rows inside it are the shape most likely to go unnamed: one line per group with
  // an icon-only delete at the end.
  mount(t)
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)
  const panel = ui.byText('GROUPS & SEGMENTS', { selector: 'button' })
  assert.equal(panel.props['aria-expanded'], false, 'collapsed panel must say so')

  await click(panel)
  await act(() => {})

  assert.equal(ui.byText('GROUPS & SEGMENTS', { selector: 'button' }).props['aria-expanded'], true)
  assertAllControlsNamed(assert, ui, 'Contacts → groups')
})

test('every control in the new-property form announces what it does', async (t) => {
  mount(t)
  const ui = await render(<PropertiesTab onOpenLead={() => {}} />)
  await click(ui.byText('+ Add', { selector: 'button' }))
  await act(() => {})

  assertAllControlsNamed(assert, ui, 'Properties → new property')
})

test('every control in the lead edit form announces what it does', async (t) => {
  mount(t)
  const ui = await render(<LeadDetail leadId={5} onClose={() => {}} onChanged={() => {}} onOpenConversation={() => {}} />)
  await click(ui.byText('Add details', { selector: 'button' }))
  await act(() => {})

  assertAllControlsNamed(assert, ui, 'Lead detail → edit')
})

test('every control on an errored screen announces what it does', async (t) => {
  // The failure path renders its own retry affordances, and they are exactly the
  // controls an agent needs when they can least afford a mystery button.
  mount(t, {
    'GET /api/leads': { status: 500, body: { error: 'boom' } },
    'GET /api/leads/count': { status: 500, body: { error: 'boom' } },
  })
  const ui = await render(<LeadsTab onOpenConversation={() => {}} />)

  assertAllControlsNamed(assert, ui, 'Leads (server error)')
})
