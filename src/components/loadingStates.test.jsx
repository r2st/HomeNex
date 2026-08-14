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
import TeamScreen from './TeamScreen.jsx'
import FestiveTab from './FestiveTab.jsx'
import SnippetsMediaScreen from './SnippetsMediaScreen.jsx'
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
  // A 500 is the server answering, so the banner must not send the agent off to
  // check their signal — and it announces itself rather than only turning red.
  assert.match(ui.byRole('alert').props.children, /wrong on our side/)
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
  assert.match(failedUi.byRole('alert').props.children, /wrong on our side/)
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
  assert.equal(ui.queryByRole('alert'), null, 'a request still in flight is not a failure')
})

test('insights with no numbers at all reports the failure and stops claiming to load', async (t) => {
  setup(t, { 'GET /api/stats': { status: 500, body: {} } })
  const ui = await render(<InsightsTab />)

  assert.match(ui.byRole('alert').props.children, /wrong on our side/)
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
  assert.equal(ui.queryByRole('alert'), null, 'a soft downgrade must not interrupt')
  // Polite, not assertive: the numbers are still worth reading, but something has
  // to say they have stopped being current.
  assert.match(ui.byRole('status').props.children, /Showing the last numbers/)
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
  assert.match(ui.byRole('alert').props.children, /wrong on our side/)
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

// --- Team ------------------------------------------------------------------------
//
// The most consequential of this family. `null` is TeamScreen's word for "you are
// not in a team", so catching a failed GET into it told an agent whose request
// merely timed out that their team was gone — and then offered them a button to
// create a new one. An agent who takes that offer ends up owning a second, empty
// team while their real one still exists, and the members of the real team are not
// in it.

const OWNER_CTX = {
  team: { name: 'Sharma Realty', assignment_strategy: 'manual' },
  role: 'owner',
  members: [{ agent_id: 1, name: 'Ravi Sharma', role: 'owner', lead_count: 4, accepts_leads: 1 }],
  invites: [],
  incoming_invites: [],
}

// A roster with someone the owner can act on — an owner's own row carries no
// buttons, so OWNER_CTX alone gives nothing to click.
const TWO_MEMBER_CTX = {
  ...OWNER_CTX,
  members: [
    ...OWNER_CTX.members,
    { agent_id: 2, name: 'Priya Nair', role: 'agent', lead_count: 2, accepts_leads: 1 },
  ],
}

test('a team that fails to load never offers to create a new one', async (t) => {
  setup(t, { 'GET /api/team': { status: 500, body: {} } })
  const ui = await render(<TeamScreen />)

  // The bug, stated as an assertion: a dropped request must not be read back to the
  // agent as "you have no team".
  assert.doesNotMatch(ui.text(), /Create team/, 'a failed load offered to create a second team')
  assert.doesNotMatch(ui.text(), /Start a team/)
  assert.match(ui.byRole('alert').props.children, /wrong on our side/)
  assert.equal(busy(ui), false, 'still claiming to load after the request failed')
})

test('a team still in flight is neither an error nor an invitation to start one', async (t) => {
  setup(t, { 'GET /api/team': pending() })
  const ui = await render(<TeamScreen />)

  assert.match(ui.text(), /Loading…/)
  assert.equal(busy(ui), true)
  assert.doesNotMatch(ui.text(), /Create team/)
  assert.equal(ui.queryByRole('alert'), null, 'a request still in flight is not a failure')
})

test('the team error offers a retry that actually refetches', async (t) => {
  let calls = 0
  const ctx = setup(t, {
    'GET /api/team': () => (++calls === 1 ? { status: 500, body: {} } : OWNER_CTX),
  })
  const ui = await render(<TeamScreen />)
  assert.match(ui.text(), /wrong on our side/)

  await click(ui.byText('Try again'))

  assert.equal(ctx.net.to('/api/team', 'GET').length, 2)
  assert.match(ui.text(), /Sharma Realty/, 'the retry succeeded but the roster never appeared')
  assert.equal(ui.queryByRole('alert'), null, 'the banner outlived the failure it described')
})

test('an agent genuinely without a team is still offered one', async (t) => {
  // The other half of the fix: keeping failures out of `null` must not stop a real
  // "you are not in a team" answer from reaching NoTeam.
  setup(t, { 'GET /api/team': { team: null, incoming_invites: [] } })
  const ui = await render(<TeamScreen />)

  assert.match(ui.text(), /Start a team/)
  assert.notEqual(ui.queryByText('Create team'), null)
  assert.equal(ui.queryByRole('alert'), null)
})

test('a reload that fails after the roster is on screen keeps the roster', async (t) => {
  let calls = 0
  const ctx = setup(t, {
    // Every action on this screen ends in reload(). Only the FIRST load is allowed
    // to be blocking, so a dropped one later must leave the members where they are
    // rather than throwing the agent back to "Start a team".
    'GET /api/team': () => (++calls === 1 ? TWO_MEMBER_CTX : { status: 500, body: {} }),
    'PUT /api/team/members/2': { ok: true },
  })
  const ui = await render(<TeamScreen />)
  assert.match(ui.text(), /Priya Nair/)

  await click(ui.byText('pause', { exact: true }))
  assert.equal(ctx.net.to('/api/team', 'GET').length, 2, 'the action never triggered a reload')

  assert.match(ui.text(), /Priya Nair/, 'a later failure blanked a roster that had already loaded')
  assert.match(ui.text(), /Ravi Sharma/)
  assert.doesNotMatch(ui.text(), /Create team/, 'a dropped reload offered to create a second team')
})

// --- Festive greetings -------------------------------------------------------------
//
// `.catch(() => {})` left `data` null for ever: the festival grid rendered as an
// empty <div> with no festivals, no error and nothing spinning. Diwali and Holi are
// the two days of the year this screen exists for, and it looked like a feature
// that had been removed.

const FESTIVE = {
  festivals: [
    { key: 'diwali', name: 'Diwali', date: '2026-11-08', emoji: '🪔', message: 'Happy Diwali!' },
    { key: 'holi', name: 'Holi', date: '2027-03-13', emoji: '🎨', message: 'Happy Holi!' },
  ],
  scheduled: [],
}

test('a festive grid that fails to load says so instead of rendering nothing', async (t) => {
  setup(t, { 'GET /api/templates/festive': { status: 500, body: {} } })
  const ui = await render(<FestiveTab />)

  assert.match(ui.byRole('alert').props.children, /wrong on our side/)
  assert.equal(busy(ui), false, 'a skeleton under the banner promises data that is not coming')
})

test('festivals in flight say so rather than showing an empty grid', async (t) => {
  setup(t, { 'GET /api/templates/festive': pending() })
  const ui = await render(<FestiveTab />)

  assert.match(ui.text(), /Loading festivals…/)
  assert.equal(busy(ui), true)
  assert.equal(ui.queryByRole('alert'), null)
})

test('loaded festivals render and drop both the loading line and the banner', async (t) => {
  setup(t, { 'GET /api/templates/festive': FESTIVE })
  const ui = await render(<FestiveTab />)

  assert.match(ui.text(), /Diwali/)
  assert.match(ui.text(), /Holi/)
  assert.doesNotMatch(ui.text(), /Loading festivals…/)
  assert.equal(ui.queryByRole('alert'), null)
  assert.equal(busy(ui), false)
})

test('a festive reload that recovers clears the banner', async (t) => {
  let calls = 0
  setup(t, {
    'GET /api/templates/festive': () => (++calls === 1 ? { status: 500, body: {} } : FESTIVE),
  })
  const ui = await render(<FestiveTab />)
  assert.notEqual(ui.queryByRole('alert'), null)

  // FestiveTab has no retry button of its own — cancelling or sending triggers the
  // reload. Re-mounting is the same code path and keeps the test honest about what
  // clears the banner: a successful load, not the passage of time.
  const recovered = await render(<FestiveTab />)
  assert.equal(recovered.queryByRole('alert'), null)
  assert.match(recovered.text(), /Diwali/)
})

// --- Snippets, media, templates, labels ---------------------------------------------
//
// All four lists on this screen caught a failed request into an EMPTY ARRAY, which
// turns "we could not reach the server" into "you have nothing". On the Templates
// tab that is the most expensive misreading in the app: an agent whose approved
// templates appear to have vanished will write them again and put them back through
// Meta review, which takes days and which they cannot undo.

const SNIPPET_ROUTES = {
  'GET /api/media': [],
  'GET /api/templates': [],
  'GET /api/quick-replies': [],
  'GET /api/labels': [],
}

const openTab = (ui, label) => click(ui.byText(label, { exact: true }))

test('a media library that fails to load is not reported as an empty library', async (t) => {
  setup(t, { ...SNIPPET_ROUTES, 'GET /api/media': { status: 500, body: {} } })
  const ui = await render(<SnippetsMediaScreen />)

  assert.match(ui.byRole('alert').props.children, /wrong on our side/)
  assert.doesNotMatch(ui.text(), /Nothing in the library yet/, 'a failed load was reported as an empty library')
})

test('an empty media library is only called empty once it has loaded', async (t) => {
  setup(t, SNIPPET_ROUTES)
  const ui = await render(<SnippetsMediaScreen />)

  assert.match(ui.text(), /Nothing in the library yet/)
  assert.equal(ui.queryByRole('alert'), null)
})

test('templates that fail to load never read as "you have no templates"', async (t) => {
  setup(t, { ...SNIPPET_ROUTES, 'GET /api/templates': { status: 500, body: {} } })
  const ui = await render(<SnippetsMediaScreen />)
  await openTab(ui, 'Templates')

  assert.match(ui.byRole('alert').props.children, /wrong on our side/)
  // The expensive one: this sentence sends an agent back to Meta review.
  assert.doesNotMatch(ui.text(), /No templates yet/, 'a failed load told the agent their templates were gone')
})

test('an agent with no templates is told so only after the list has loaded', async (t) => {
  setup(t, SNIPPET_ROUTES)
  const ui = await render(<SnippetsMediaScreen />)
  await openTab(ui, 'Templates')

  assert.match(ui.text(), /No templates yet/)
  assert.equal(ui.queryByRole('alert'), null)
})

test('an approved template survives a later failure on the same screen', async (t) => {
  let calls = 0
  setup(t, {
    ...SNIPPET_ROUTES,
    'GET /api/templates': () =>
      ++calls === 1
        ? [{ id: 3, name: 'site_visit_followup', category: 'utility', body: 'Hi', meta_status: 'approved' }]
        : { status: 500, body: {} },
  })
  const ui = await render(<SnippetsMediaScreen />)
  await openTab(ui, 'Templates')

  assert.match(ui.text(), /site_visit_followup/)
  assert.doesNotMatch(ui.text(), /No templates yet/)
})

test('quick replies that fail to load are not reported as none saved', async (t) => {
  setup(t, { ...SNIPPET_ROUTES, 'GET /api/quick-replies': { status: 500, body: {} } })
  const ui = await render(<SnippetsMediaScreen />)
  await openTab(ui, 'Quick replies')

  assert.match(ui.byRole('alert').props.children, /wrong on our side/)
  assert.doesNotMatch(ui.text(), /No quick replies yet/)
})

test('an empty quick-reply list is only called empty once it has loaded', async (t) => {
  setup(t, SNIPPET_ROUTES)
  const ui = await render(<SnippetsMediaScreen />)
  await openTab(ui, 'Quick replies')

  assert.match(ui.text(), /No quick replies yet/)
  assert.equal(ui.queryByRole('alert'), null)
})

test('labels that fail to load are not reported as no labels', async (t) => {
  setup(t, { ...SNIPPET_ROUTES, 'GET /api/labels': { status: 500, body: {} } })
  const ui = await render(<SnippetsMediaScreen />)
  await openTab(ui, 'Labels')

  assert.match(ui.byRole('alert').props.children, /wrong on our side/)
  assert.doesNotMatch(ui.text(), /No labels yet/)
})

test('an empty label set is only called empty once it has loaded', async (t) => {
  setup(t, SNIPPET_ROUTES)
  const ui = await render(<SnippetsMediaScreen />)
  await openTab(ui, 'Labels')

  assert.match(ui.text(), /No labels yet/)
  assert.equal(ui.queryByRole('alert'), null)
})
