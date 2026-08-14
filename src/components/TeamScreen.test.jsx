// The team screen — 500 lines and four sub-views that had no behavioural test.
//
// loadingStates.test.jsx covers the outer ctx load (a dropped GET must not read back
// as "you have no team"), and a11ySweep covers the naming. Nothing covered what the
// screen actually does: who is allowed to see which tab, what each button sends, and
// whether the roster on screen still matches the server after an action.
//
// The expensive mistakes on this screen are all in that last category, because every
// control here acts on somebody else's account:
//
//   * a privacy wall that leaks — a plain agent reaching the manager's inbox, board
//     or settings, which is the whole point of the role gate in teamRoutes.js;
//   * a button that hits the wrong member, or the wrong direction (promote vs demote,
//     pause vs enable), because the row it belongs to was resolved by position;
//   * an action that appears to work and never reaches the server, or reaches it and
//     never refreshes, so the manager acts twice on a stale roster;
//   * an error swallowed into an empty list, which on the Board reads as "nobody on
//     this team has responded to anything".
//
// Everything is asserted through what the manager sees and what the network received,
// never through component internals.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, click, change } from '../test/render.jsx'
import { installBrowser, mockFetch } from '../test/browserEnv.js'
import TeamScreen from './TeamScreen.jsx'

const pending = () => () => new Promise(() => {})
const busy = (ui) => ui.query((f) => f.props?.['aria-busy'] === 'true') !== null

const member = (over = {}) => ({
  agent_id: 2,
  name: 'Priya Nair',
  role: 'agent',
  lead_count: 3,
  accepts_leads: 1,
  is_active: 1,
  localities: [],
  ...over,
})

const OWNER = {
  team: { id: 7, name: 'Sharma Realty', assignment_strategy: 'manual' },
  role: 'owner',
  members: [
    { agent_id: 1, name: 'Ravi Sharma', role: 'owner', lead_count: 9, accepts_leads: 1, is_active: 1, localities: [] },
    member(),
  ],
  invites: [],
  incoming_invites: [],
}

const ctxAs = (role, over = {}) => ({ ...OWNER, role, ...over })

// Every sub-view fetches on mount, so the manager tabs need their routes present
// even in tests that only care about the members list.
const BASE_ROUTES = {
  'GET /api/team': OWNER,
  'GET /api/team/leads': [],
  'GET /api/team/leaderboard': [],
  'GET /api/team/stale': [],
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

const openTab = async (ui, label) => click(ui.byText(label, { exact: true, selector: 'button' }))

const isInside = (node, ancestor) => {
  for (let cur = node.parent; cur; cur = cur.parent) if (cur === ancestor) return true
  return false
}

/**
 * The confirm button INSIDE the open dialog. "Disband team" is also the label of the
 * button that opens it, so a plain byText finds the opener and silently re-opens the
 * dialog instead of confirming — a test that then passes for the wrong reason.
 */
const confirmButton = (ui, label) => {
  const dialog = ui.byRole('alertdialog')
  return ui.get(
    (f) => f.type === 'button' && isInside(f, dialog) && (f.props?.children === label || f.props?.children === 'Please wait…'),
    `confirm button "${label}" inside the dialog`,
  )
}

// --- The privacy wall ---------------------------------------------------------
//
// teamRoutes.js gates the manager views server-side; these assert the client does
// not offer a door the server will slam. An agent shown a tab that 403s reads it as
// the app being broken, and an agent shown the data would be a real leak.

test('a plain agent is offered only the members tab', async (t) => {
  setup(t, { 'GET /api/team': ctxAs('agent') })
  const ui = await render(<TeamScreen />)

  assert.notEqual(ui.queryByText('Members', { exact: true }), null)
  assert.equal(ui.queryByText('Inbox', { exact: true }), null, 'an agent was offered the shared inbox')
  assert.equal(ui.queryByText('Board', { exact: true }), null, 'an agent was offered the manager board')
  assert.equal(ui.queryByText('Settings', { exact: true }), null, 'an agent was offered team settings')
})

test('a manager gets the inbox and the board but not the owner settings', async (t) => {
  setup(t, { 'GET /api/team': ctxAs('manager') })
  const ui = await render(<TeamScreen />)

  assert.notEqual(ui.queryByText('Inbox', { exact: true }), null)
  assert.notEqual(ui.queryByText('Board', { exact: true }), null)
  assert.equal(ui.queryByText('Settings', { exact: true }), null, 'a manager was offered the disband button')
})

test('the owner gets every tab', async (t) => {
  setup(t)
  const ui = await render(<TeamScreen />)

  for (const tab of ['Members', 'Inbox', 'Board', 'Settings']) {
    assert.notEqual(ui.queryByText(tab, { exact: true }), null, `the owner is missing ${tab}`)
  }
})

test('a plain agent cannot invite, promote, pause or remove anyone', async (t) => {
  setup(t, { 'GET /api/team': ctxAs('agent') })
  const ui = await render(<TeamScreen />)

  assert.match(ui.text(), /Priya Nair/, 'the roster itself is not the privileged part')
  assert.equal(ui.queryByText('Send invite'), null)
  assert.equal(ui.queryByText('remove', { exact: true }), null)
  assert.equal(ui.queryByText('pause', { exact: true }), null)
  assert.equal(ui.queryByText('↑ manager'), null)
})

test('a manager can pause and remove, but only the owner changes roles', async (t) => {
  setup(t, { 'GET /api/team': ctxAs('manager') })
  const ui = await render(<TeamScreen />)

  assert.notEqual(ui.queryByText('pause', { exact: true }), null)
  assert.notEqual(ui.queryByText('remove', { exact: true }), null)
  assert.equal(ui.queryByText('↑ manager'), null, 'a manager was offered a promotion button')
})

test('the owner\'s own row carries no buttons to demote or remove themselves', async (t) => {
  setup(t)
  const ui = await render(<TeamScreen />)

  // Two members are on the roster and only one of them is actionable, so a single
  // control of each kind is the assertion that the owner row was skipped.
  assert.equal(ui.allByText('remove', { exact: true }).length, 1)
  assert.equal(ui.allByText('pause', { exact: true }).length, 1)
})

// --- Members: the roster reads what the server sent ----------------------------

test('the roster shows each member\'s role, lead count and paused state', async (t) => {
  setup(t, {
    'GET /api/team': ctxAs('owner', {
      members: [
        member({ agent_id: 2, name: 'Priya Nair', lead_count: 1, accepts_leads: 0 }),
        member({ agent_id: 3, name: 'Imran Qadri', lead_count: 4, localities: ['Andheri', 'Bandra'] }),
      ],
    }),
  })
  const ui = await render(<TeamScreen />)

  assert.match(ui.text(), /1 lead\b/, 'a single lead was pluralised')
  assert.match(ui.text(), /4 leads/)
  assert.match(ui.text(), /not receiving/, 'a paused member looked like an active one')
  assert.match(ui.text(), /Andheri, Bandra/)
})

test('a suspended member is marked as one', async (t) => {
  setup(t, { 'GET /api/team': ctxAs('owner', { members: [member({ is_active: 0 })] }) })
  const ui = await render(<TeamScreen />)

  assert.match(ui.text(), /suspended/)
})

// --- Members: the actions hit the right member, in the right direction ---------

test('promoting sends manager for that member, and refreshes the roster', async (t) => {
  const ctx = setup(t, { 'PUT /api/team/members/2/role': { ok: true } })
  const ui = await render(<TeamScreen />)

  await click(ui.byText('↑ manager'))

  const [call] = ctx.net.to('/api/team/members/2/role', 'PUT')
  assert.ok(call, 'the promotion never reached the server')
  assert.deepEqual(call.body, { role: 'manager' })
  assert.equal(ctx.net.to('/api/team', 'GET').length, 2, 'the roster was never refreshed after the change')
})

test('demoting a manager sends agent, not manager again', async (t) => {
  const ctx = setup(t, {
    'GET /api/team': ctxAs('owner', { members: [member({ role: 'manager' })] }),
    'PUT /api/team/members/2/role': { ok: true },
  })
  const ui = await render(<TeamScreen />)

  assert.equal(ui.queryByText('↑ manager'), null, 'an existing manager was offered a promotion')
  await click(ui.byText('↓ agent'))

  assert.deepEqual(ctx.net.to('/api/team/members/2/role', 'PUT')[0].body, { role: 'agent' })
})

test('pausing a member turns their lead intake off, and enabling turns it back on', async (t) => {
  const ctx = setup(t, { 'PUT /api/team/members/2': { ok: true } })
  const ui = await render(<TeamScreen />)

  await click(ui.byText('pause', { exact: true }))
  assert.deepEqual(ctx.net.to('/api/team/members/2', 'PUT')[0].body, { accepts_leads: false })

  ctx.net.set('GET /api/team', ctxAs('owner', { members: [member({ accepts_leads: 0 })] }))
  const ui2 = await render(<TeamScreen />)
  await click(ui2.byText('enable', { exact: true }))
  assert.deepEqual(ctx.net.to('/api/team/members/2', 'PUT')[1].body, { accepts_leads: true })
})

test('the right member is acted on when several rows carry the same button', async (t) => {
  const ctx = setup(t, {
    'GET /api/team': ctxAs('owner', {
      members: [member({ agent_id: 4, name: 'Asha Pillai' }), member({ agent_id: 9, name: 'Imran Qadri' })],
    }),
    'PUT /api/team/members/9': { ok: true },
  })
  const ui = await render(<TeamScreen />)

  // Second row's pause button — the shape that breaks when a handler closes over
  // the wrong row, which is invisible with a one-member fixture.
  await click(ui.allByText('pause', { exact: true })[1])

  assert.equal(ctx.net.to('/api/team/members/4', 'PUT').length, 0, 'the wrong member was paused')
  assert.equal(ctx.net.to('/api/team/members/9', 'PUT').length, 1)
})

test('removing a member asks first, and does nothing until it is confirmed', async (t) => {
  const ctx = setup(t, { 'DELETE /api/team/members/2': { ok: true } })
  const ui = await render(<TeamScreen />)

  await click(ui.byText('remove', { exact: true }))
  assert.match(ui.text(), /Remove Priya Nair from the team\?/)
  assert.match(ui.text(), /Their leads stay with them/, 'the dialog does not say what happens to the leads')
  assert.equal(ctx.net.to('/api/team/members/2', 'DELETE').length, 0, 'removed before the manager confirmed')

  await click(confirmButton(ui, 'Remove'))
  assert.equal(ctx.net.to('/api/team/members/2', 'DELETE').length, 1)
})

test('cancelling the removal dialog leaves the member on the team', async (t) => {
  const ctx = setup(t, { 'DELETE /api/team/members/2': { ok: true } })
  const ui = await render(<TeamScreen />)

  await click(ui.byText('remove', { exact: true }))
  await click(ui.byText('Cancel', { exact: true }))

  assert.equal(ctx.net.to('/api/team/members/2', 'DELETE').length, 0)
  assert.match(ui.text(), /Priya Nair/)
})

test('a refused member action is explained rather than silently dropped', async (t) => {
  setup(t, { 'PUT /api/team/members/2/role': { status: 400, body: { error: 'Only the owner can change roles' } } })
  const ui = await render(<TeamScreen />)

  await click(ui.byText('↑ manager'))

  assert.match(ui.text(), /Only the owner can change roles/)
})

// --- Members: invitations ------------------------------------------------------

test('the invite button stays disabled until a number is typed', async (t) => {
  const ctx = setup(t, { 'POST /api/team/invites': { id: 5 } })
  const ui = await render(<TeamScreen />)

  const send = ui.byText('Send invite')
  assert.equal(send.props.disabled, true)

  await click(send)
  assert.equal(ctx.net.to('/api/team/invites', 'POST').length, 0, 'an empty invite reached the server')
})

test('an invite sends the trimmed number with the chosen role and clears the box', async (t) => {
  const ctx = setup(t, { 'POST /api/team/invites': { id: 5 } })
  const ui = await render(<TeamScreen />)

  await change(ui.byLabel(/WhatsApp number/), '  +91 98765 43210  ')
  await change(ui.byLabel(/Role for the new teammate/), 'manager')
  await click(ui.byText('Send invite'))

  assert.deepEqual(ctx.net.to('/api/team/invites', 'POST')[0].body, {
    phone: '+91 98765 43210',
    role: 'manager',
  })
  assert.equal(ui.byLabel(/WhatsApp number/).props.value, '', 'the number stayed in the box after sending')
})

test('a rejected invite keeps the number so it can be corrected', async (t) => {
  setup(t, { 'POST /api/team/invites': { status: 400, body: { error: 'That number is already on the team' } } })
  const ui = await render(<TeamScreen />)

  await change(ui.byLabel(/WhatsApp number/), '+919876543210')
  await click(ui.byText('Send invite'))

  assert.match(ui.text(), /already on the team/)
  assert.equal(ui.byLabel(/WhatsApp number/).props.value, '+919876543210', 'the rejected number was thrown away')
})

test('pending invites are listed and can be revoked', async (t) => {
  const ctx = setup(t, {
    'GET /api/team': ctxAs('owner', { invites: [{ id: 12, phone: '919876543210', role: 'agent' }] }),
    'DELETE /api/team/invites/12': { ok: true },
  })
  const ui = await render(<TeamScreen />)

  assert.match(ui.text(), /919876543210/)
  assert.match(ui.text(), /invited as agent/)

  await click(ui.byText('revoke'))
  assert.equal(ctx.net.to('/api/team/invites/12', 'DELETE').length, 1)
})

// --- No team yet: creating one, or accepting an invitation ---------------------

const SOLO = { team: null, incoming_invites: [] }

test('creating a team sends the trimmed name and reloads into the team', async (t) => {
  let calls = 0
  const ctx = setup(t, {
    'GET /api/team': () => (++calls === 1 ? SOLO : OWNER),
    'POST /api/team': { id: 7, name: 'Sharma Realty' },
  })
  const ui = await render(<TeamScreen />)

  await change(ui.byLabel('Team name'), '  Sharma Realty  ')
  await click(ui.byText('Create team'))

  assert.deepEqual(ctx.net.to('/api/team', 'POST')[0].body, { name: 'Sharma Realty' })
  assert.match(ui.text(), /Ravi Sharma/, 'the new team never replaced the create form')
})

test('a whitespace-only team name never reaches the server', async (t) => {
  const ctx = setup(t, { 'GET /api/team': SOLO, 'POST /api/team': { id: 7 } })
  const ui = await render(<TeamScreen />)

  await change(ui.byLabel('Team name'), '   ')
  await click(ui.byText('Create team'))

  assert.equal(ctx.net.to('/api/team', 'POST').length, 0)
})

test('a refused team creation is explained and the form survives', async (t) => {
  setup(t, {
    'GET /api/team': SOLO,
    'POST /api/team': { status: 400, body: { error: 'You are already in a team' } },
  })
  const ui = await render(<TeamScreen />)

  await change(ui.byLabel('Team name'), 'Second Shop')
  await click(ui.byText('Create team'))

  assert.match(ui.text(), /already in a team/)
  assert.equal(ui.byLabel('Team name').props.value, 'Second Shop')
})

test('a pending invitation is shown with who sent it, and accepting joins the team', async (t) => {
  let calls = 0
  const ctx = setup(t, {
    'GET /api/team': () =>
      ++calls === 1
        ? { team: null, incoming_invites: [{ id: 3, team_name: 'Sharma Realty', role: 'agent', invited_by_name: 'Ravi Sharma' }] }
        : ctxAs('agent'),
    'POST /api/team/invites/3/accept': { accepted: true },
  })
  const ui = await render(<TeamScreen />)

  assert.match(ui.text(), /You've been invited/)
  assert.match(ui.text(), /as agent · from Ravi Sharma/)

  await click(ui.byText('Accept'))

  assert.equal(ctx.net.to('/api/team/invites/3/accept', 'POST').length, 1)
  assert.match(ui.text(), /Sharma Realty/)
  assert.doesNotMatch(ui.text(), /You've been invited/, 'the invitation outlived being accepted')
})

test('declining an invitation calls decline, not accept', async (t) => {
  const ctx = setup(t, {
    'GET /api/team': { team: null, incoming_invites: [{ id: 3, team_name: 'Sharma Realty', role: 'agent' }] },
    'POST /api/team/invites/3/decline': { declined: true },
  })
  const ui = await render(<TeamScreen />)

  await click(ui.byText('Decline'))

  assert.equal(ctx.net.to('/api/team/invites/3/decline', 'POST').length, 1)
  assert.equal(ctx.net.to('/api/team/invites/3/accept', 'POST').length, 0)
})

test('an invitation that cannot be accepted says why instead of doing nothing', async (t) => {
  setup(t, {
    'GET /api/team': { team: null, incoming_invites: [{ id: 3, team_name: 'Sharma Realty', role: 'agent' }] },
    'POST /api/team/invites/3/accept': { status: 400, body: { error: 'Invite not found or already handled' } },
  })
  const ui = await render(<TeamScreen />)

  await click(ui.byText('Accept'))

  assert.match(ui.text(), /already handled/)
})

// --- Inbox: the shared team lead list -----------------------------------------
//
// This is the screen the server-side team stamp feeds. A lead that never got its
// team_id is absent here, which is what made the R25 bug invisible.

const POOLED = { id: 11, name: 'Anand Rao', wa_id: '919000000001', unassigned: true, last_msg: 'Is 2BHK available?' }
const OWNED = { id: 12, name: 'Meera Joshi', wa_id: '919000000002', unassigned: false, agent_name: 'Priya Nair' }

test('the inbox distinguishes a pooled lead from one already owned', async (t) => {
  setup(t, { 'GET /api/team/leads': [POOLED, OWNED] })
  const ui = await render(<TeamScreen />)
  await openTab(ui, 'Inbox')

  assert.match(ui.text(), /Anand Rao/)
  assert.match(ui.text(), /pool/, 'an unassigned lead was not marked as pooled')
  assert.match(ui.text(), /Priya Nair/, 'an owned lead does not say who owns it')
  assert.match(ui.text(), /Is 2BHK available\?/)
})

test('an empty inbox says so only once the request has answered', async (t) => {
  setup(t, { 'GET /api/team/leads': pending() })
  const ui = await render(<TeamScreen />)
  await openTab(ui, 'Inbox')

  // The bug this guards: `leads` is null both in flight and on failure, so an
  // in-flight list must not be read back as "no leads in the team yet" — the
  // answer a manager acts on by going to look for where the leads went.
  assert.doesNotMatch(ui.text(), /No leads in the team yet/)
  assert.equal(busy(ui), true, 'nothing told the manager the list was still loading')
})

test('an empty inbox says so once the server confirms it is empty', async (t) => {
  setup(t, { 'GET /api/team/leads': [] })
  const ui = await render(<TeamScreen />)
  await openTab(ui, 'Inbox')

  assert.match(ui.text(), /No leads in the team yet/)
  assert.equal(busy(ui), false)
})

test('an inbox that fails to load explains itself instead of looking empty', async (t) => {
  setup(t, { 'GET /api/team/leads': { status: 500, body: { error: 'Something went wrong' } } })
  const ui = await render(<TeamScreen />)
  await openTab(ui, 'Inbox')

  assert.doesNotMatch(ui.text(), /No leads in the team yet/, 'a failed request was reported as an empty team')
  assert.match(ui.text(), /Something went wrong/)
  assert.equal(busy(ui), false)
})

test('assigning a lead from the inbox names the lead and the teammate', async (t) => {
  const ctx = setup(t, {
    'GET /api/team/leads': [POOLED],
    'POST /api/team/leads/11/assign': { ok: true },
  })
  const ui = await render(<TeamScreen />)
  await openTab(ui, 'Inbox')

  await change(ui.byLabel(/Assign Anand Rao to a teammate/), '2')

  assert.deepEqual(ctx.net.to('/api/team/leads/11/assign', 'POST')[0].body, { agent_id: 2 })
  assert.equal(ctx.net.to('/api/team/leads', 'GET').length, 2, 'the inbox was not refreshed after the assignment')
})

test('the assign control offers only members who accept leads', async (t) => {
  setup(t, {
    'GET /api/team': ctxAs('owner', {
      members: [member({ agent_id: 2, name: 'Priya Nair' }), member({ agent_id: 3, name: 'Paused Person', accepts_leads: 0 })],
    }),
    'GET /api/team/leads': [POOLED],
  })
  const ui = await render(<TeamScreen />)
  await openTab(ui, 'Inbox')

  const options = ui.allByRole('option').map((o) => o.props.children)
  assert.ok(options.includes('Priya Nair'))
  assert.ok(!options.includes('Paused Person'), 'a member not receiving leads was offered one')
})

test('an already-owned lead offers reassignment, worded as such', async (t) => {
  setup(t, { 'GET /api/team/leads': [OWNED] })
  const ui = await render(<TeamScreen />)
  await openTab(ui, 'Inbox')

  assert.notEqual(ui.queryByLabel(/Reassign Meera Joshi to a teammate/), null)
  assert.match(ui.text(), /Reassign…/)
})

test('the distribute button appears only for a strategy that can place leads', async (t) => {
  for (const [strategy, offered] of [
    ['round_robin', true],
    ['locality', true],
    ['manual', false],
    ['pool', false],
  ]) {
    const t2 = { after: () => {} }
    const env = installBrowser()
    const net = mockFetch({
      ...BASE_ROUTES,
      'GET /api/team': ctxAs('owner', { team: { id: 7, name: 'Sharma Realty', assignment_strategy: strategy } }),
      'GET /api/team/leads': [POOLED],
    })
    const ui = await render(<TeamScreen />)
    await openTab(ui, 'Inbox')
    assert.equal(
      /Distribute 1 pooled lead/.test(ui.text()),
      offered,
      `${strategy}: distribute button ${offered ? 'missing' : 'offered when nothing can be placed'}`,
    )
    ui.unmount()
    net.restore()
    env.restore()
    void t2
  }
})

test('distribute is not offered when the pool is empty', async (t) => {
  setup(t, {
    'GET /api/team': ctxAs('owner', { team: { id: 7, name: 'Sharma Realty', assignment_strategy: 'round_robin' } }),
    'GET /api/team/leads': [OWNED],
  })
  const ui = await render(<TeamScreen />)
  await openTab(ui, 'Inbox')

  assert.doesNotMatch(ui.text(), /Distribute/)
})

test('distributing the pool posts once and refreshes the inbox', async (t) => {
  const ctx = setup(t, {
    'GET /api/team': ctxAs('owner', { team: { id: 7, name: 'Sharma Realty', assignment_strategy: 'round_robin' } }),
    'GET /api/team/leads': [POOLED, { ...POOLED, id: 13, name: 'Second' }],
    'POST /api/team/pool/distribute': { assigned: 2 },
  })
  const ui = await render(<TeamScreen />)
  await openTab(ui, 'Inbox')

  assert.match(ui.text(), /Distribute 2 pooled leads by round-robin/, 'the button does not say what it will do')
  await click(ui.byText(/Distribute 2 pooled leads/))

  assert.equal(ctx.net.to('/api/team/pool/distribute', 'POST').length, 1)
  assert.equal(ctx.net.to('/api/team/leads', 'GET').length, 2)
})

// --- Board: the leaderboard and the stale list --------------------------------
//
// Both loads used to `.catch(() => {})`, so a dropped request rendered as an empty
// leaderboard — which a manager reads as "nobody on this team has responded to
// anything" — and an empty stale list, which reads as "nothing needs chasing".

const LEADERBOARD = [
  { agent_id: 1, name: 'Ravi Sharma', total_leads: 9, hot_leads: 3, won_leads: 2, stale_leads: 1, avg_first_response_s: 45 },
  { agent_id: 2, name: 'Priya Nair', total_leads: 4, hot_leads: 1, won_leads: 0, stale_leads: 0, avg_first_response_s: 5400 },
]

test('the leaderboard ranks members and formats each response time', async (t) => {
  setup(t, { 'GET /api/team/leaderboard': LEADERBOARD })
  const ui = await render(<TeamScreen />)
  await openTab(ui, 'Board')

  assert.match(ui.text(), /Ravi Sharma/)
  assert.match(ui.text(), /9 leads · 3 hot · 2 won · 1 stale/)
  assert.match(ui.text(), /4 leads · 1 hot · 0 won/)
  assert.doesNotMatch(ui.text(), /0 stale/, 'a member with nothing stale was given a stale count')
  assert.match(ui.text(), /45s/, 'a sub-minute response time was not shown in seconds')
  assert.match(ui.text(), /1\.5h/, 'a 90-minute response time was not shown in hours')
})

test('a member who has never responded shows a dash, not a zero', async (t) => {
  setup(t, {
    'GET /api/team/leaderboard': [{ agent_id: 2, name: 'Priya Nair', total_leads: 0, hot_leads: 0, won_leads: 0, avg_first_response_s: null }],
  })
  const ui = await render(<TeamScreen />)
  await openTab(ui, 'Board')

  assert.match(ui.text(), /—/, 'a missing response time was rendered as an instant one')
})

test('a failed leaderboard is an error, not an empty team', async (t) => {
  setup(t, { 'GET /api/team/leaderboard': { status: 500, body: {} } })
  const ui = await render(<TeamScreen />)
  await openTab(ui, 'Board')

  // The bug: `.catch(() => {})` left the list null and rendered it as an empty
  // board, so a dropped request read back as a fact about the team's performance.
  assert.notEqual(ui.queryByRole('alert'), null, 'a failed leaderboard said nothing at all')
  assert.doesNotMatch(ui.text(), /No responses recorded yet/, 'a failure was reported as no activity')
  assert.equal(busy(ui), false)
})

test('a failed stale list is an error, not "nothing needs chasing"', async (t) => {
  setup(t, {
    'GET /api/team/leaderboard': LEADERBOARD,
    'GET /api/team/stale': { status: 500, body: {} },
  })
  const ui = await render(<TeamScreen />)
  await openTab(ui, 'Board')

  assert.notEqual(ui.queryByRole('alert'), null, 'a failed stale list was swallowed')
  assert.doesNotMatch(ui.text(), /Ravi Sharma/, 'half a board is not a board')
})

test('a board still loading is not an empty one', async (t) => {
  setup(t, { 'GET /api/team/leaderboard': pending() })
  const ui = await render(<TeamScreen />)
  await openTab(ui, 'Board')

  assert.equal(busy(ui), true)
  assert.equal(ui.queryByRole('alert'), null, 'a request in flight was reported as a failure')
  assert.doesNotMatch(ui.text(), /No responses recorded yet/)
})

test('a genuinely empty board says so', async (t) => {
  setup(t, { 'GET /api/team/leaderboard': [], 'GET /api/team/stale': [] })
  const ui = await render(<TeamScreen />)
  await openTab(ui, 'Board')

  assert.match(ui.text(), /No responses recorded yet/)
  assert.equal(ui.queryByRole('alert'), null)
  assert.equal(busy(ui), false)
})

test('stale leads are listed with who is sitting on them and for how long', async (t) => {
  setup(t, {
    'GET /api/team/leaderboard': LEADERBOARD,
    'GET /api/team/stale': [
      { id: 21, name: 'Anand Rao', wa_id: '919000000001', agent_name: 'Priya Nair', idle_s: 5 * 86400 + 3600 },
      { id: 22, name: null, wa_id: '919000000009', agent_name: null, idle_s: 3 * 86400 },
    ],
  })
  const ui = await render(<TeamScreen />)
  await openTab(ui, 'Board')

  assert.match(ui.text(), /Stale leads \(idle 3\+ days\)/)
  assert.match(ui.text(), /Priya Nair · idle 5d/, 'a part-day was rounded up into the idle count')
  assert.match(ui.text(), /919000000009/, 'an unnamed lead showed nothing at all')
  assert.match(ui.text(), /pool · idle 3d/, 'an unowned stale lead did not say it was in the pool')
})

test('the stale section is hidden when nothing is stale', async (t) => {
  setup(t, { 'GET /api/team/leaderboard': LEADERBOARD, 'GET /api/team/stale': [] })
  const ui = await render(<TeamScreen />)
  await openTab(ui, 'Board')

  assert.doesNotMatch(ui.text(), /Stale leads/)
})

// --- Settings: strategy, rename, disband --------------------------------------

test('the current assignment strategy is the one marked active', async (t) => {
  setup(t, {
    'GET /api/team': ctxAs('owner', { team: { id: 7, name: 'Sharma Realty', assignment_strategy: 'locality' } }),
  })
  const ui = await render(<TeamScreen />)
  await openTab(ui, 'Settings')

  const active = ui.all((f) => f.type === 'button' && /border-brand/.test(f.props?.className || ''))
  assert.equal(active.length, 1, 'exactly one strategy should read as the current one')
  assert.match(active[0].props.className, /bg-brand-wash/)
  assert.match(ui.text(), /By locality/)
})

test('choosing a strategy saves it and reloads', async (t) => {
  const ctx = setup(t, { 'PUT /api/team': { ok: true } })
  const ui = await render(<TeamScreen />)
  await openTab(ui, 'Settings')

  await click(ui.byText('Round-robin'))

  assert.deepEqual(ctx.net.to('/api/team', 'PUT')[0].body, { assignment_strategy: 'round_robin' })
  assert.equal(ctx.net.to('/api/team', 'GET').length, 2)
})

test('saving the name is refused until it actually changes', async (t) => {
  const ctx = setup(t, { 'PUT /api/team': { ok: true } })
  const ui = await render(<TeamScreen />)
  await openTab(ui, 'Settings')

  assert.equal(ui.byText('Save name').props.disabled, true, 'an unchanged name offered a pointless save')

  await change(ui.byLabel('Team name'), '  Sharma Realty  ')
  assert.equal(ui.byText('Save name').props.disabled, true, 'whitespace alone counted as a change')

  await change(ui.byLabel('Team name'), '')
  assert.equal(ui.byText('Save name').props.disabled, true, 'an empty name was savable')

  await change(ui.byLabel('Team name'), 'Sharma Realty & Co')
  assert.equal(ui.byText('Save name').props.disabled, false)
  await click(ui.byText('Save name'))
  assert.deepEqual(ctx.net.to('/api/team', 'PUT')[0].body, { name: 'Sharma Realty & Co' })
})

test('disbanding asks first, warns what it costs, and only then deletes', async (t) => {
  const ctx = setup(t, { 'DELETE /api/team': { ok: true } })
  const ui = await render(<TeamScreen />)
  await openTab(ui, 'Settings')

  await click(ui.byText('Disband team', { exact: true }))
  assert.match(ui.text(), /Disband this team\?/)
  assert.match(ui.text(), /cannot be undone/)
  assert.equal(ctx.net.to('/api/team', 'DELETE').length, 0, 'the team went before the owner confirmed')

  await click(confirmButton(ui, 'Disband team'))
  assert.equal(ctx.net.to('/api/team', 'DELETE').length, 1)
})

test('a refused disband is explained and the team stays', async (t) => {
  setup(t, { 'DELETE /api/team': { status: 400, body: { error: 'Remove the other members first' } } })
  const ui = await render(<TeamScreen />)
  await openTab(ui, 'Settings')

  await click(ui.byText('Disband team', { exact: true }))
  await click(confirmButton(ui, 'Disband team'))

  assert.match(ui.text(), /Remove the other members first/)
  assert.match(ui.text(), /Sharma Realty/, 'the team disappeared from the screen anyway')
})

// --- Tabs ----------------------------------------------------------------------

test('the screen opens on members and keeps the chosen tab', async (t) => {
  setup(t)
  const ui = await render(<TeamScreen />)

  assert.match(ui.text(), /Priya Nair/, 'the screen did not open on the roster')

  await openTab(ui, 'Board')
  assert.match(ui.text(), /Response-time leaderboard/)
  assert.doesNotMatch(ui.text(), /Invite a teammate/, 'the members view stayed mounted under the board')

  await openTab(ui, 'Members')
  assert.match(ui.text(), /Invite a teammate/)
})

test('the header names the team and the caller\'s own role', async (t) => {
  setup(t, { 'GET /api/team': ctxAs('manager') })
  const ui = await render(<TeamScreen />)

  assert.match(ui.text(), /manager/)
  assert.match(ui.text(), /Sharma Realty/)
})
