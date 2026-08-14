// The two mutations on the home screen.
//
// loadingStates.test.jsx covers Home's first-load skeleton. It does not touch the only
// two things this screen lets an agent CHANGE, and both were written the same wrong
// way: no catch and no refresh.
//
//   * "Mark done" on a follow-up is the most-tapped control in the app, on the screen
//     agents open it to. A refused request escaped an onClick as an unhandled
//     rejection; a SUCCESSFUL one left the follow-up in the list until the next
//     six-second poll. Either way the agent taps the tick, nothing moves, and they
//     tap it again — which is how one follow-up gets completed twice.
//   * Dismissing an alert swallowed its failure and never refreshed either, so the ×
//     removed nothing for up to twenty seconds on success and for ever on failure. An
//     alert that will not go away reads as a stuck app.
//
// Asserted through what the agent sees and what the network received.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, click } from '../test/render.jsx'
import { installBrowser, mockFetch } from '../test/browserEnv.js'
import DashboardTab from './DashboardTab.jsx'

const followup = (over = {}) => ({
  id: 91,
  lead_id: 501,
  lead_name: 'Anand Rao',
  lead_wa_id: '919000000001',
  note: 'Send the floor plan',
  due_at: new Date().toISOString(),
  overdue: false,
  ...over,
})

const DASHBOARD = {
  unanswered: [],
  hotLeads: [],
  followupsToday: [followup()],
  siteVisitsToday: [],
  overdueFollowups: [],
  activity: [],
}

const STATS = { total: 4, newToday: 1, active24h: 2 }

const ALERT = {
  id: 77,
  title: 'Window closing: Anand Rao',
  body: 'The 24h free-reply window closes soon.',
  entity_type: 'lead',
  entity_id: 501,
  read_at: null,
}

const BASE_ROUTES = {
  'GET /api/dashboard': DASHBOARD,
  'GET /api/stats': STATS,
  'GET /api/worklist': { items: [], counts: { total: 0 } },
  'GET /api/notifications': { notifications: [], unread: 0 },
  'GET /api/properties/count': { total: 3 },
  'GET /api/agent/phone-config': {},
}

function setup(t, routes = {}) {
  const env = installBrowser()
  const net = mockFetch({ ...BASE_ROUTES, ...routes })
  t.after(() => {
    net.restore()
    env.restore()
  })
  return { env, net }
}

const AGENT = { name: 'Ravi Sharma', wa_phone_number: '+919876500000' }
const home = (props = {}) => (
  <DashboardTab
    agent={AGENT}
    onGoTo={() => {}}
    onOpenConversation={() => {}}
    onOpenLead={() => {}}
    onSignOut={() => {}}
    {...props}
  />
)

/** The round "Mark done" tick beside a follow-up. */
const tick = (ui) => ui.byText('✓', { exact: true, selector: 'button' })

// --- Marking a follow-up done --------------------------------------------------

test('marking a follow-up done completes that follow-up', async (t) => {
  const ctx = setup(t, { 'PUT /api/followups/91': { ok: true } })
  const ui = await render(home())
  assert.match(ui.text(), /Anand Rao/)

  await click(tick(ui))

  const [call] = ctx.net.to('/api/followups/91', 'PUT')
  assert.ok(call, 'the tick never reached the server')
  assert.deepEqual(call.body, { completed: true })
})

test('a completed follow-up leaves the list without waiting for the next poll', async (t) => {
  let calls = 0
  const ctx = setup(t, {
    'PUT /api/followups/91': { ok: true },
    'GET /api/dashboard': () => (++calls === 1 ? DASHBOARD : { ...DASHBOARD, followupsToday: [] }),
  })
  const ui = await render(home())

  await click(tick(ui))

  // Without the refresh the row sat there for up to six seconds looking untouched,
  // which is how an agent taps the same tick twice.
  assert.equal(ctx.net.to('/api/dashboard', 'GET').length, 2, 'the day was never refreshed')
  assert.doesNotMatch(ui.text(), /Send the floor plan/, 'the completed follow-up stayed on the list')
})

test('completing also refreshes the worklist the follow-up is rolled up into', async (t) => {
  const ctx = setup(t, { 'PUT /api/followups/91': { ok: true } })
  const ui = await render(home())

  await click(tick(ui))

  assert.equal(ctx.net.to('/api/worklist', 'GET').length, 2, 'the worklist kept its stale copy of the item')
})

test('a refused completion says so instead of failing silently', async (t) => {
  setup(t, { 'PUT /api/followups/91': { status: 500, body: { error: 'Could not save that' } } })
  const ui = await render(home())

  await click(tick(ui))

  // This handler had no catch at all: the rejection escaped an onClick and reached
  // nothing, so the agent saw exactly what a success looked like — nothing.
  assert.match(ui.text(), /Could not save that/)
  assert.notEqual(ui.queryByRole('alert'), null)
  assert.match(ui.text(), /Send the floor plan/, 'the row vanished over a completion that never happened')
})

test('a failed completion does not blank the day that is already on screen', async (t) => {
  setup(t, { 'PUT /api/followups/91': { status: 500, body: {} } })
  const ui = await render(home())

  await click(tick(ui))

  assert.match(ui.text(), /Anand Rao/, 'a refused action took the whole screen with it')
  assert.match(ui.text(), /Ravi Sharma|Ravi/, 'the greeting survived')
})

// --- Dismissing an alert -------------------------------------------------------

test('dismissing an alert marks it read and clears it from the screen', async (t) => {
  let calls = 0
  const ctx = setup(t, {
    'GET /api/notifications': () =>
      ++calls === 1 ? { notifications: [ALERT], unread: 1 } : { notifications: [], unread: 0 },
    'PUT /api/notifications/77/read': { ok: true },
  })
  const ui = await render(home())
  assert.match(ui.text(), /Window closing/)

  await click(ui.byLabel(/Dismiss alert/))

  assert.equal(ctx.net.to('/api/notifications/77/read', 'PUT').length, 1)
  assert.equal(ctx.net.to('/api/notifications', 'GET').length, 2, 'the alert list was never refetched')
  assert.doesNotMatch(ui.text(), /Window closing/, 'the dismissed alert stayed on screen')
})

test('an alert that cannot be dismissed says why rather than sitting there', async (t) => {
  setup(t, {
    'GET /api/notifications': { notifications: [ALERT], unread: 1 },
    'PUT /api/notifications/77/read': { status: 500, body: { error: 'Could not dismiss that' } },
  })
  const ui = await render(home())

  await click(ui.byLabel(/Dismiss alert/))

  assert.match(ui.text(), /Could not dismiss that/)
  assert.match(ui.text(), /Window closing/, 'an alert that was never dismissed disappeared anyway')
})

test('the alert still offers to open the lead it is about', async (t) => {
  const opened = []
  setup(t, { 'GET /api/notifications': { notifications: [ALERT], unread: 1 } })
  const ui = await render(home({ onOpenLead: (id) => opened.push(id) }))

  await click(ui.byLabel(/Open the lead/))

  assert.deepEqual(opened, [501])
})

// --- The polled load is a separate channel from a refused action ---------------

test('an action error and a load error do not overwrite each other', async (t) => {
  setup(t, { 'PUT /api/followups/91': { status: 500, body: { error: 'Could not save that' } } })
  const ui = await render(home())

  await click(tick(ui))

  // The poll is still succeeding, so the load banner stays empty — which is exactly
  // why the refused action needed a channel of its own rather than reusing it.
  const alerts = ui.allByRole('alert')
  assert.equal(alerts.length, 1, 'a refused action reported itself more than once')
  assert.match(ui.text(), /Could not save that/)
})
