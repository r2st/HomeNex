// Loading, error and empty states across the list and detail screens.
//
// These three states are easy to get wrong in the same way: a screen branches on
// `!data`, which is true both while the first request is in flight AND for ever
// after it fails. The result is a skeleton that never resolves, or an empty-state
// card ("No contacts yet") shown to an agent whose contacts simply haven't arrived
// — the most alarming possible misreading of a slow network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, act, click } from '../test/render.jsx'
import { installBrowser, mockFetch } from '../test/browserEnv.js'
import ContactsTab from './ContactsTab.jsx'
import PropertiesTab from './PropertiesTab.jsx'
import CommissionsScreen from './CommissionsScreen.jsx'
import DashboardTab from './DashboardTab.jsx'
import InsightsTab from './InsightsTab.jsx'
import LeadSourcesScreen from './LeadSourcesScreen.jsx'
import MoreTab from './MoreTab.jsx'
import SupportScreen from './SupportScreen.jsx'

const pending = () => () => new Promise(() => {}) // a request that never settles
const busy = (ui) => ui.query((f) => f.props?.['aria-busy'] === 'true') !== null

function setup(t, routes = {}) {
  const env = installBrowser()
  const net = mockFetch(routes)
  t.after(() => {
    net.restore()
    env.restore()
  })
  return { env, net }
}

// --- Contacts -----------------------------------------------------------------

const CONTACT_ROUTES = {
  'GET /api/contacts': [],
  'GET /api/groups': [],
}

test('the contacts list shows skeletons while the first request is in flight', async (t) => {
  setup(t, { ...CONTACT_ROUTES, 'GET /api/contacts': pending() })
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)

  assert.equal(busy(ui), true, 'no loading affordance while contacts load')
  assert.doesNotMatch(ui.text(), /No contacts yet/, 'an empty state was shown before the data arrived')
})

test('a failed contacts request stops the skeletons and explains itself', async (t) => {
  setup(t, { ...CONTACT_ROUTES, 'GET /api/contacts': { status: 500, body: {} } })
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)

  // The skeletons used to keep pulsing under the error banner, which reads as
  // "the list is still on its way" when in fact nothing more is coming.
  assert.equal(busy(ui), false, 'skeletons kept pulsing after the request failed')
  assert.match(ui.text(), /Can't reach the HomeNex server/)
})

test('an empty contacts list is only called empty once it has actually loaded', async (t) => {
  setup(t, CONTACT_ROUTES)
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)

  assert.match(ui.text(), /No contacts yet/)
  assert.equal(busy(ui), false)
})

test('a contact whose detail fails to load offers a retry', async (t) => {
  const ctx = setup(t, {
    ...CONTACT_ROUTES,
    'GET /api/contacts': [{ id: 7, name: 'Anil Kumar', phone: '+919876500007', source: 'walk_in' }],
    'GET /api/contacts/7': { status: 500, body: {} },
  })
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)

  await click(ui.byText('Anil Kumar'))
  assert.match(ui.text(), /Couldn't load this/)

  await click(ui.byText('Try again'))
  assert.equal(ctx.net.to('/api/contacts/7', 'GET').length, 2)
})

// --- Properties ---------------------------------------------------------------

test('the properties list shows skeletons while loading and drops them on failure', async (t) => {
  const slow = setup(t, { 'GET /api/properties': pending() })
  const loadingUi = await render(<PropertiesTab onOpenLead={() => {}} />)
  assert.equal(busy(loadingUi), true)
  slow.net.restore()
  slow.env.restore()

  setup(t, { 'GET /api/properties': { status: 500, body: {} } })
  const failedUi = await render(<PropertiesTab onOpenLead={() => {}} />)
  assert.equal(busy(failedUi), false, 'skeletons outlived a failed properties request')
  assert.match(failedUi.text(), /Can't reach the HomeNex server/)
})

// --- Commissions: receivables -------------------------------------------------

test('receivables that fail to load say so instead of loading for ever', async (t) => {
  setup(t, { 'GET /api/commissions/receivables': { status: 500, body: {} } })
  const ui = await render(<CommissionsScreen onBack={() => {}} />)

  assert.match(ui.text(), /Couldn't load receivables/)
  assert.doesNotMatch(ui.text(), /Loading…/, 'the screen was still claiming to load')
})

test('receivables show a loading line only while the request is genuinely in flight', async (t) => {
  setup(t, { 'GET /api/commissions/receivables': pending() })
  const ui = await render(<CommissionsScreen onBack={() => {}} />)

  assert.match(ui.text(), /Loading…/)
  assert.doesNotMatch(ui.text(), /Couldn't load receivables/)
})

// --- Insights ------------------------------------------------------------------
//
// Insights polls every 8 seconds, so unlike the screens above its interesting case
// is the SECOND request: a screen that hands itself over to an error banner on any
// failure flickers between numbers and a red page all day on a patchy connection.

const STATS = {
  avgFirstResponseS: 45,
  qualifiedPct: 62,
  afterHours: 3,
  total: 12,
  newToday: 2,
  active24h: 4,
  daily: [{ day: '2026-08-09', avg_s: 40, leads: 2 }],
  sources: [{ name: '99acres', count: 7 }],
}

test('insights says it is loading, not that the server is unreachable, while the first request is in flight', async (t) => {
  setup(t, { 'GET /api/stats': pending() })
  const ui = await render(<InsightsTab />)

  assert.match(ui.text(), /Loading…/)
  assert.equal(busy(ui), true)
  assert.doesNotMatch(ui.text(), /Can't reach the HomeNex server/)
})

test('insights with no numbers at all reports the failure and stops claiming to load', async (t) => {
  setup(t, { 'GET /api/stats': { status: 500, body: {} } })
  const ui = await render(<InsightsTab />)

  assert.match(ui.text(), /Can't reach the HomeNex server/)
  assert.equal(busy(ui), false, 'still advertising a load that has already failed')
})

test('a dropped poll leaves the numbers on screen and downgrades the error to a strip', async (t) => {
  let calls = 0
  const ctx = setup(t, {
    'GET /api/stats': () => (++calls === 1 ? STATS : { status: 500, body: {} }),
  })
  const ui = await render(<InsightsTab />)
  assert.match(ui.text(), /Your numbers with HomeNex/)

  await act(() => ctx.env.advance(8000)) // the poll that fails
  assert.equal(ctx.net.to('/api/stats', 'GET').length, 2)

  // The whole point of the fix: numbers that were right 8 seconds ago beat a blank
  // page, so the failure must not take the screen over.
  assert.match(ui.text(), /Your numbers with HomeNex/, 'one dropped poll replaced the charts screen')
  assert.match(ui.text(), /62%/, 'the last good numbers were thrown away')
  assert.match(ui.text(), /Showing the last numbers HomeNex could load/)
  assert.doesNotMatch(ui.text(), /Can't reach the HomeNex server/)
})

test('a poll that recovers clears the stale strip', async (t) => {
  let calls = 0
  const ctx = setup(t, {
    'GET /api/stats': () => (++calls === 2 ? { status: 500, body: {} } : STATS),
  })
  const ui = await render(<InsightsTab />)

  await act(() => ctx.env.advance(8000))
  assert.match(ui.text(), /Showing the last numbers HomeNex could load/)

  await act(() => ctx.env.advance(8000))
  assert.doesNotMatch(ui.text(), /Showing the last numbers HomeNex could load/)
  assert.match(ui.text(), /Your numbers with HomeNex/)
})

// --- Home ----------------------------------------------------------------------

const DASHBOARD = {
  unanswered: [],
  hotLeads: [],
  followupsToday: [],
  siteVisitsToday: [],
  overdueFollowups: [],
  activity: [],
}

const HOME_ROUTES = {
  'GET /api/dashboard': DASHBOARD,
  'GET /api/stats': STATS,
  'GET /api/worklist': { items: [], counts: { total: 0 } },
  'GET /api/notifications': { notifications: [], unread: 0 },
  // Home asks for the inventory COUNT, not the inventory — it only needs to know
  // whether the agent has added any properties yet.
  'GET /api/properties/count': { total: 0 },
  'GET /api/agent/phone-config': {},
}

const AGENT = { name: 'Ravi Sharma', wa_phone_number: '+919876500000' }
const home = () => (
  <DashboardTab agent={AGENT} onGoTo={() => {}} onOpenConversation={() => {}} onOpenLead={() => {}} onSignOut={() => {}} />
)
const skeleton = (ui) => ui.queryByLabel('Loading your day')

test('home shows a first-load skeleton instead of a greeting over empty space', async (t) => {
  setup(t, { ...HOME_ROUTES, 'GET /api/dashboard': pending() })
  const ui = await render(home())

  assert.notEqual(skeleton(ui), null, 'nothing on Home said it was still working')
  assert.equal(busy(ui), true)
})

test('the home skeleton clears once the day has loaded', async (t) => {
  setup(t, HOME_ROUTES)
  const ui = await render(home())

  assert.equal(skeleton(ui), null, 'the skeleton outlived the data it was waiting for')
  assert.match(ui.text(), /Waiting for reply/)
})

test('the home skeleton clears on failure too, and the failure is named', async (t) => {
  setup(t, { ...HOME_ROUTES, 'GET /api/dashboard': { status: 500, body: {} } })
  const ui = await render(home())

  // A skeleton that never resolves is the worst of both: it hides the error AND
  // promises data that is never coming.
  assert.equal(skeleton(ui), null, 'the skeleton kept pulsing after the request failed')
  assert.match(ui.text(), /Can't reach the HomeNex server/)
})

// --- Follow-ups and site visits (More tab) --------------------------------------
//
// A missed follow-up is money. These two screens rendered a failure and an empty
// list identically, so an agent with three overdue callbacks and an agent with none
// saw the same blank card.

const MORE_ROUTES = {
  'GET /api/followups': [],
  'GET /api/site-visits': [],
}
const more = () => <MoreTab agent={AGENT} onAgentUpdate={() => {}} onOpenConversation={() => {}} />

const openMenu = async (ui, label) => {
  await click(ui.byText(label, { exact: true }))
}

test('follow-ups that fail to load say so instead of "nothing here"', async (t) => {
  setup(t, { ...MORE_ROUTES, 'GET /api/followups': { status: 500, body: {} } })
  const ui = await render(more())
  await openMenu(ui, 'Follow-ups')

  assert.match(ui.text(), /Can't load your follow-ups/)
  assert.doesNotMatch(ui.text(), /Nothing here\./, 'a failed load was reported as an empty list')
})

test('follow-ups in flight are neither an error nor an empty list', async (t) => {
  setup(t, { ...MORE_ROUTES, 'GET /api/followups': pending() })
  const ui = await render(more())
  await openMenu(ui, 'Follow-ups')

  assert.match(ui.text(), /Loading your follow-ups…/)
  assert.equal(busy(ui), true)
  assert.doesNotMatch(ui.text(), /Nothing here\./)
  assert.doesNotMatch(ui.text(), /Can't load your follow-ups/)
})

test('an empty follow-up list is only called empty once it has loaded', async (t) => {
  setup(t, MORE_ROUTES)
  const ui = await render(more())
  await openMenu(ui, 'Follow-ups')

  assert.match(ui.text(), /Nothing here\./)
  assert.equal(busy(ui), false)
  assert.doesNotMatch(ui.text(), /Can't load your follow-ups/)
})

test('site visits that fail to load say so instead of "no site visits"', async (t) => {
  setup(t, { ...MORE_ROUTES, 'GET /api/site-visits': { status: 500, body: {} } })
  const ui = await render(more())
  await openMenu(ui, 'Site visits')

  assert.match(ui.text(), /Can't load your site visits/)
  assert.doesNotMatch(ui.text(), /No site visits\./, 'a failed load was reported as an empty schedule')
})

test('site visits in flight are neither an error nor an empty schedule', async (t) => {
  setup(t, { ...MORE_ROUTES, 'GET /api/site-visits': pending() })
  const ui = await render(more())
  await openMenu(ui, 'Site visits')

  assert.match(ui.text(), /Loading your site visits…/)
  assert.equal(busy(ui), true)
  assert.doesNotMatch(ui.text(), /No site visits\./)
})

test('an empty site-visit list is only called empty once it has loaded', async (t) => {
  setup(t, MORE_ROUTES)
  const ui = await render(more())
  await openMenu(ui, 'Site visits')

  assert.match(ui.text(), /No site visits\./)
  assert.equal(busy(ui), false)
})

// --- Support --------------------------------------------------------------------
//
// The one screen an agent opens when something is already wrong. Both of its loads
// used to swallow the failure into an empty catch, which is indistinguishable from
// a load that never finishes.

const SUPPORT_ROUTES = {
  'GET /api/support/tickets': [],
  'GET /api/billing': { subscription: null, usage: { total_conversations: 0 }, invoices: [] },
}

test('support requests that fail to load explain themselves', async (t) => {
  setup(t, { ...SUPPORT_ROUTES, 'GET /api/support/tickets': { status: 500, body: {} } })
  const ui = await render(<SupportScreen />)

  assert.match(ui.text(), /Can't load your support requests/)
  assert.doesNotMatch(ui.text(), /No support requests yet/, 'a failed load was reported as an empty list')
  assert.equal(busy(ui), false, 'still claiming to load after the request failed')
})

test('support requests in flight say so instead of sitting blank', async (t) => {
  setup(t, { ...SUPPORT_ROUTES, 'GET /api/support/tickets': pending() })
  const ui = await render(<SupportScreen />)

  assert.match(ui.text(), /Loading your support requests…/)
  assert.equal(busy(ui), true)
  assert.doesNotMatch(ui.text(), /No support requests yet/)
})

test('an empty support list is only called empty once it has loaded', async (t) => {
  setup(t, SUPPORT_ROUTES)
  const ui = await render(<SupportScreen />)

  assert.match(ui.text(), /No support requests yet/)
  assert.equal(busy(ui), false)
})

test('the billing tab reports a failed plan load instead of rendering nothing', async (t) => {
  setup(t, { ...SUPPORT_ROUTES, 'GET /api/billing': { status: 500, body: {} } })
  const ui = await render(<SupportScreen />)
  await click(ui.byText('Plan & billing'))

  // Gated on `billing &&`, this tab used to be entirely empty on failure — a tab
  // that looks broken on the screen you open when something is broken.
  assert.match(ui.text(), /Can't load your plan right now/)
  assert.equal(busy(ui), false)
})

test('the billing tab shows a loading line while the plan is in flight', async (t) => {
  setup(t, { ...SUPPORT_ROUTES, 'GET /api/billing': pending() })
  const ui = await render(<SupportScreen />)
  await click(ui.byText('Plan & billing'))

  assert.match(ui.text(), /Loading your plan…/)
  assert.equal(busy(ui), true)
  assert.doesNotMatch(ui.text(), /Can't load your plan right now/)
})

test('a loaded plan renders and drops both the loading and error lines', async (t) => {
  setup(t, {
    ...SUPPORT_ROUTES,
    'GET /api/billing': {
      subscription: { plan_name: 'Growth', price_paise: 199900, conversation_quota: 1000 },
      usage: { total_conversations: 12 },
      invoices: [],
    },
  })
  const ui = await render(<SupportScreen />)
  await click(ui.byText('Plan & billing'))

  assert.match(ui.text(), /Growth/)
  assert.doesNotMatch(ui.text(), /Loading your plan…/)
  assert.doesNotMatch(ui.text(), /Can't load your plan right now/)
})

// --- Lead sources ---------------------------------------------------------------
//
// "No captured leads yet" is a claim about the agent's portal setup — that they have
// not wired 99acres or their ads up yet. It must never be what a request in flight
// or a dead request looks like.

const SOURCES_ROUTES = {
  'GET /api/lead-sources': { ingest_email: 'leads+abc@homenex.in', ingest_token: 'abc', stats: [], events: [] },
  'GET /api/portal-integrations': [],
}

test('captured leads in flight do not claim the agent has captured none', async (t) => {
  setup(t, { ...SOURCES_ROUTES, 'GET /api/lead-sources': pending() })
  const ui = await render(<LeadSourcesScreen />)

  assert.match(ui.text(), /Loading captured leads…/)
  assert.equal(busy(ui), true)
  assert.doesNotMatch(ui.text(), /No captured leads yet/)
})

test('a failed captured-leads request is reported, not disguised as an empty feed', async (t) => {
  setup(t, { ...SOURCES_ROUTES, 'GET /api/lead-sources': { status: 500, body: {} } })
  const ui = await render(<LeadSourcesScreen />)

  assert.match(ui.text(), /Can't load your captured leads/)
  assert.doesNotMatch(ui.text(), /No captured leads yet/)
  assert.equal(busy(ui), false)
})

test('an empty capture feed is only called empty once it has loaded', async (t) => {
  setup(t, SOURCES_ROUTES)
  const ui = await render(<LeadSourcesScreen />)

  assert.match(ui.text(), /No captured leads yet/)
  assert.equal(busy(ui), false)
  assert.doesNotMatch(ui.text(), /Can't load your captured leads/)
})
