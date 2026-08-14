// The in-app admin panel: every agent on the account, their WABA wiring, and the
// two switches that decide who can do what.
//
// The risk here is not rendering — it is that every action on this screen affects
// somebody else's livelihood. Deactivating an agent signs them out everywhere and
// stops their WhatsApp line capturing leads; granting admin hands over the whole
// account. So the tests that matter are about the confirm step, about the panel
// never offering an admin the buttons that would lock them out of their own account,
// and about a failed action being visible instead of looking like it worked.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, click, change } from '../test/render.jsx'
import { installBrowser, mockFetch } from '../test/browserEnv.js'
import AdminPanel from './AdminPanel.jsx'

const ME = { id: 1, name: 'Rohit Sharma', phone: '+919876543210', is_admin: 1, is_active: 1 }

const AGENTS = [
  { ...ME, waba_status: 'active', wa_phone_number: '+919000000001', business_name: 'Sharma Realty' },
  {
    id: 2,
    name: 'Priya Nair',
    phone: '+919876543211',
    is_admin: 0,
    is_active: 1,
    waba_status: 'pending',
    business_name: 'Nair Properties',
    email: 'priya@example.com',
  },
  {
    id: 3,
    name: 'Amit Verma',
    phone: '+919876543212',
    is_admin: 1,
    is_active: 1,
    waba_status: 'registered',
    wa_phone_number: '+919000000003',
    wa_phone_number_id: '123456789012345',
    meta_waba_id: '987654321098765',
  },
  {
    id: 4,
    name: 'Sunil Rao',
    phone: '+919876543213',
    is_admin: 0,
    is_active: 0,
    waba_status: 'none',
    deactivated_at: new Date(Date.now() - 3 * 86400_000).toISOString(),
  },
]

const DASH = { totalAgents: 4, pendingWaba: 1, registeredWaba: 1, activeWaba: 1 }

function setup(t, routes = {}) {
  const env = installBrowser()
  const net = mockFetch({
    'GET /api/admin/dashboard': DASH,
    'GET /api/admin/agents': AGENTS,
    'GET /api/admin/audit-logs': [],
    ...routes,
  })
  t.after(() => {
    net.restore()
    env.restore()
  })
  return { env, net }
}

const mount = (props = {}) => render(<AdminPanel agent={ME} onBack={() => {}} {...props} />)
// "Agents" also appears inside the "Total Agents" card, so the tabs are addressed by
// their exact button text.
const tab = (ui, label) => ui.byText(label, { exact: true, selector: 'button' })
// The card for one agent, found by the name it shows.
const cardFor = (ui, name) => {
  let node = ui.byText(name, { exact: true })
  while (node && !(node.type === 'div' && /rounded-2xl p-4/.test(node.props.className || ''))) node = node.parent
  return node || ui.byText(name).parent
}
const withinText = (node) => {
  let out = ''
  const walk = (f) => {
    if (f.kind === 'text') out += f.text + ' '
    for (const c of f.children || []) walk(c)
  }
  walk(node)
  return out.replace(/\s+/g, ' ').trim()
}
const buttonIn = (node, label) => {
  const found = []
  const walk = (f) => {
    if (f.type === 'button' && new RegExp(label).test(withinText(f))) found.push(f)
    for (const c of f.children || []) walk(c)
  }
  walk(node)
  // Innermost wins, same rule the view's byText uses.
  return found[found.length - 1] || null
}

// --- Loading and the headline numbers ---------------------------------------

test('the dashboard cards show the counts the server sent', async (t) => {
  setup(t)
  const ui = await mount()

  for (const [label, value] of [
    ['Total Agents', 4],
    ['Pending WABA', 1],
    ['Registered', 1],
    ['Active WABA', 1],
  ]) {
    assert.match(ui.text(), new RegExp(`${value}\\s*${label}`), `${label} is missing or wrong`)
  }
})

test('a failed load says what went wrong instead of showing an empty account', async (t) => {
  // An admin panel that renders "0 agents" on a 500 is telling the owner their
  // brokerage is empty.
  setup(t, { 'GET /api/admin/agents': { status: 500, body: { error: 'Database is unreachable' } } })
  const ui = await mount()

  assert.match(ui.text(), /Database is unreachable/)
  assert.doesNotMatch(ui.text(), /No agents match/)
})

test('the error screen still offers the way back to Settings', async (t) => {
  setup(t, { 'GET /api/admin/dashboard': { status: 500, body: { error: 'Nope' } } })
  const back = []
  const ui = await render(<AdminPanel agent={ME} onBack={() => back.push(1)} />)

  await click(ui.byText(/Back to Settings/))
  assert.deepEqual(back, [1])
})

test('every agent on the account is listed with their number and WABA state', async (t) => {
  setup(t)
  const ui = await mount()

  for (const a of AGENTS) assert.match(ui.text(), new RegExp(a.name))
  assert.match(withinText(cardFor(ui, 'Priya Nair')), /PENDING/)
  assert.match(withinText(cardFor(ui, 'Amit Verma')), /REGISTERED/)
  assert.match(withinText(cardFor(ui, 'Sunil Rao')), /DEACTIVATED/)
  assert.match(withinText(cardFor(ui, 'Amit Verma')), /ADMIN/)
})

test('an agent with no business number is told so, not left blank', async (t) => {
  setup(t)
  const ui = await mount()

  assert.match(withinText(cardFor(ui, 'Priya Nair')), /No business number provided/)
  assert.match(withinText(cardFor(ui, 'Amit Verma')), /\+919000000003/)
})

// --- Filtering and search ---------------------------------------------------

test('the filter chips count what they would show, before they are tapped', async (t) => {
  setup(t)
  const ui = await mount()

  assert.match(ui.text(), /All \(4\)/)
  assert.match(ui.text(), /Admins \(2\)/)
  assert.match(ui.text(), /Deactivated \(1\)/)
  assert.match(ui.text(), /Pending \(1\)/)
})

test('filtering to admins hides everyone else', async (t) => {
  setup(t)
  const ui = await mount()

  await click(ui.byText(/^Admins/))

  assert.match(ui.text(), /Rohit Sharma/)
  assert.match(ui.text(), /Amit Verma/)
  assert.doesNotMatch(ui.text(), /Priya Nair/)
})

test('searching matches name, phone, email and business name', async (t) => {
  setup(t)
  const ui = await mount()
  const box = ui.byLabel('Search agents')

  for (const [needle, expected] of [
    ['priya', 'Priya Nair'],
    ['9876543212', 'Amit Verma'],
    ['priya@example.com', 'Priya Nair'],
    ['nair properties', 'Priya Nair'],
  ]) {
    await change(box, needle)
    assert.match(ui.text(), new RegExp(expected), `searching "${needle}" lost ${expected}`)
  }
})

test('a search that matches nobody says so rather than showing a blank page', async (t) => {
  setup(t)
  const ui = await mount()

  await change(ui.byLabel('Search agents'), 'nobody by that name')

  assert.match(ui.text(), /No agents match/)
})

test('search and filter compose instead of overriding each other', async (t) => {
  setup(t)
  const ui = await mount()

  await click(ui.byText(/^Admins/))
  await change(ui.byLabel('Search agents'), 'priya')

  // Priya matches the search but is not an admin — the intersection is empty.
  assert.match(ui.text(), /No agents match/)
})

// --- Guarding the admin against locking themselves out ----------------------

test('an admin is never offered the two buttons that would lock them out', async (t) => {
  // The server rejects self-demotion and self-deactivation too. Offering the button
  // and then failing is a worse way to say the same thing.
  setup(t)
  const ui = await mount()
  const mine = cardFor(ui, 'Rohit Sharma')

  assert.match(withinText(mine), /\(you\)/)
  assert.equal(buttonIn(mine, 'Remove admin'), null, 'an admin could demote themselves')
  assert.equal(buttonIn(mine, 'Deactivate'), null, 'an admin could deactivate themselves')
  assert.ok(buttonIn(mine, 'Edit WABA Config'), 'an admin cannot edit their own WABA wiring')
})

test('a deactivated non-admin cannot be made admin until they are back', async (t) => {
  setup(t)
  const ui = await mount()
  const sunil = cardFor(ui, 'Sunil Rao')

  const makeAdmin = buttonIn(sunil, 'Make admin')
  assert.equal(makeAdmin.props.disabled, true)
  assert.match(makeAdmin.props.title, /Reactivate/)
})

// --- The confirm step -------------------------------------------------------

test('granting admin asks first, and names both the agent and the consequence', async (t) => {
  const { net } = setup(t, {
    'PUT /api/admin/agents/2/admin': (call) => ({ ...AGENTS[1], is_admin: call.body.is_admin ? 1 : 0 }),
  })
  const ui = await mount()

  await click(buttonIn(cardFor(ui, 'Priya Nair'), 'Make admin'))

  const prompt = withinText(cardFor(ui, 'Priya Nair'))
  assert.match(prompt, /Make Priya Nair an admin/)
  assert.match(prompt, /every agent/, 'the prompt did not say what admin actually grants')
  assert.equal(net.to('/api/admin/agents/2/admin', 'PUT').length, 0, 'the grant fired before the confirm')
})

test('cancelling a grant leaves the agent exactly as they were', async (t) => {
  const { net } = setup(t)
  const ui = await mount()

  await click(buttonIn(cardFor(ui, 'Priya Nair'), 'Make admin'))
  await click(buttonIn(cardFor(ui, 'Priya Nair'), 'Cancel'))

  assert.equal(net.to('/api/admin/agents/2/admin', 'PUT').length, 0)
  assert.doesNotMatch(withinText(cardFor(ui, 'Priya Nair')), /Make Priya Nair an admin/)
})

test('confirming a grant sends it and updates the card in place', async (t) => {
  const { net } = setup(t, {
    'PUT /api/admin/agents/2/admin': (call) => ({ ...AGENTS[1], is_admin: call.body.is_admin ? 1 : 0 }),
  })
  const ui = await mount()

  await click(buttonIn(cardFor(ui, 'Priya Nair'), 'Make admin'))
  await click(buttonIn(cardFor(ui, 'Priya Nair'), '^Make admin$'))

  const [put] = net.to('/api/admin/agents/2/admin', 'PUT')
  assert.ok(put, 'the grant was never sent')
  assert.equal(put.body.is_admin, true)
  assert.match(withinText(cardFor(ui, 'Priya Nair')), /ADMIN/, 'the card did not reflect the change')
  assert.ok(buttonIn(cardFor(ui, 'Priya Nair'), 'Remove admin'), 'the button did not flip to the inverse')
})

test('revoking admin sends the inverse, not another grant', async (t) => {
  const { net } = setup(t, {
    'PUT /api/admin/agents/3/admin': (call) => ({ ...AGENTS[2], is_admin: call.body.is_admin ? 1 : 0 }),
  })
  const ui = await mount()

  await click(buttonIn(cardFor(ui, 'Amit Verma'), 'Remove admin'))
  assert.match(withinText(cardFor(ui, 'Amit Verma')), /keep their leads/, 'the prompt overstated the damage')
  await click(buttonIn(cardFor(ui, 'Amit Verma'), '^Remove admin$'))

  assert.equal(net.to('/api/admin/agents/3/admin', 'PUT')[0].body.is_admin, false)
})

test('deactivating spells out that they are signed out and nothing is deleted', async (t) => {
  const { net } = setup(t, {
    'PUT /api/admin/agents/2/active': (call) => ({ ...AGENTS[1], is_active: call.body.is_active ? 1 : 0 }),
  })
  const ui = await mount()

  await click(buttonIn(cardFor(ui, 'Priya Nair'), 'Deactivate'))
  const prompt = withinText(cardFor(ui, 'Priya Nair'))
  assert.match(prompt, /signed out everywhere/)
  assert.match(prompt, /Nothing is deleted/)

  await click(buttonIn(cardFor(ui, 'Priya Nair'), '^Deactivate$'))
  assert.equal(net.to('/api/admin/agents/2/active', 'PUT')[0].body.is_active, false)
  assert.match(withinText(cardFor(ui, 'Priya Nair')), /DEACTIVATED/)
})

test('reactivating a deactivated agent sends true, and says their line resumes', async (t) => {
  const { net } = setup(t, {
    'PUT /api/admin/agents/4/active': (call) => ({ ...AGENTS[3], is_active: call.body.is_active ? 1 : 0 }),
  })
  const ui = await mount()

  await click(buttonIn(cardFor(ui, 'Sunil Rao'), 'Reactivate'))
  assert.match(withinText(cardFor(ui, 'Sunil Rao')), /resumes capturing leads/)
  await click(buttonIn(cardFor(ui, 'Sunil Rao'), '^Reactivate$'))

  assert.equal(net.to('/api/admin/agents/4/active', 'PUT')[0].body.is_active, true)
})

test('a refused action is shown on the card, and the agent is not redrawn as changed', async (t) => {
  setup(t, {
    'PUT /api/admin/agents/2/active': { status: 403, body: { error: 'Only the account owner can do that' } },
  })
  const ui = await mount()

  await click(buttonIn(cardFor(ui, 'Priya Nair'), 'Deactivate'))
  await click(buttonIn(cardFor(ui, 'Priya Nair'), '^Deactivate$'))

  const card = withinText(cardFor(ui, 'Priya Nair'))
  assert.match(card, /Only the account owner can do that/)
  assert.doesNotMatch(card, /DEACTIVATED/, 'the card showed a change the server refused')
})

// --- WABA wiring ------------------------------------------------------------

test('the WABA editor opens with what is already wired up', async (t) => {
  setup(t)
  const ui = await mount()

  await click(buttonIn(cardFor(ui, 'Amit Verma'), 'Edit WABA Config'))

  assert.equal(ui.byLabel('WABA Status').props.value, 'registered')
  assert.equal(ui.byLabel('WA Business Phone').props.value, '+919000000003')
  assert.equal(ui.byLabel('Meta phone_number_id').props.value, '123456789012345')
  assert.equal(ui.byLabel('Meta WABA ID').props.value, '987654321098765')
})

test('saving WABA config sends every field, with blanks as null', async (t) => {
  // '' and null are different to the server: one is "an empty string is the
  // phone_number_id", the other is "there is no phone_number_id".
  const { net } = setup(t, {
    'PUT /api/admin/agents/2/waba': (call) => ({ ...AGENTS[1], ...call.body }),
  })
  const ui = await mount()

  await click(buttonIn(cardFor(ui, 'Priya Nair'), 'Edit WABA Config'))
  await change(ui.byLabel('WABA Status'), 'active')
  await change(ui.byLabel('WA Business Phone'), '+919000000002')
  await click(ui.byText(/Save WABA Config|Saving/))

  assert.deepEqual(net.to('/api/admin/agents/2/waba', 'PUT')[0].body, {
    status: 'active',
    meta_waba_id: null,
    wa_phone_number_id: null,
    wa_phone_number: '+919000000002',
  })
})

test('a rejected WABA save is shown in the editor', async (t) => {
  setup(t, {
    'PUT /api/admin/agents/2/waba': { status: 409, body: { error: 'That phone_number_id is already in use' } },
  })
  const ui = await mount()

  await click(buttonIn(cardFor(ui, 'Priya Nair'), 'Edit WABA Config'))
  await click(ui.byText(/Save WABA Config|Saving/))

  assert.match(ui.text(), /already in use/)
})

test('the WABA editor toggles closed again', async (t) => {
  setup(t)
  const ui = await mount()

  await click(buttonIn(cardFor(ui, 'Priya Nair'), 'Edit WABA Config'))
  assert.ok(ui.queryByLabel('Meta WABA ID'))

  await click(buttonIn(cardFor(ui, 'Priya Nair'), 'Close'))
  assert.equal(ui.queryByLabel('Meta WABA ID'), null)
})

test('a successful action re-reads the dashboard so the counts stay honest', async (t) => {
  // Deactivating an agent changes the WABA tallies above the list. Leaving them stale
  // makes the panel disagree with itself.
  const { net } = setup(t, {
    'PUT /api/admin/agents/2/active': (call) => ({ ...AGENTS[1], is_active: call.body.is_active ? 1 : 0 }),
  })
  const ui = await mount()
  const before = net.to('/api/admin/dashboard', 'GET').length

  await click(buttonIn(cardFor(ui, 'Priya Nair'), 'Deactivate'))
  await click(buttonIn(cardFor(ui, 'Priya Nair'), '^Deactivate$'))

  assert.ok(net.to('/api/admin/dashboard', 'GET').length > before, 'the headline counts were left stale')
})

// --- The activity tab -------------------------------------------------------

test('the activity tab renders each audit line as a sentence, not a raw action code', async (t) => {
  setup(t, {
    'GET /api/admin/audit-logs': [
      {
        id: 1,
        agent_name: 'Rohit Sharma',
        action: 'admin_granted',
        details: { target: 'Priya Nair' },
        created_at: new Date(Date.now() - 3600_000).toISOString(),
      },
      { id: 2, agent_name: 'Priya Nair', action: 'password_changed', details: {}, created_at: new Date().toISOString() },
    ],
  })
  const ui = await mount()

  await click(tab(ui, 'Activity'))

  assert.match(ui.text(), /Rohit Sharma granted admin to Priya Nair/)
  assert.match(ui.text(), /Priya Nair changed their password/)
  assert.doesNotMatch(ui.text(), /admin_granted|password_changed/, 'a raw action code leaked to the screen')
})

test('an action the panel has no wording for degrades to readable words', async (t) => {
  setup(t, {
    'GET /api/admin/audit-logs': [
      { id: 1, agent_name: 'Rohit Sharma', action: 'something_new_happened', details: {}, created_at: new Date().toISOString() },
    ],
  })
  const ui = await mount()

  await click(tab(ui, 'Activity'))

  assert.match(ui.text(), /something new happened/)
})

test('an audit line with no actor still reads as a sentence', async (t) => {
  setup(t, {
    'GET /api/admin/audit-logs': [
      { id: 1, agent_name: null, action: 'agent_deactivated', details: { target: 'Sunil Rao' }, created_at: new Date().toISOString() },
    ],
  })
  const ui = await mount()

  await click(tab(ui, 'Activity'))

  assert.match(ui.text(), /Someone deactivated Sunil Rao/)
  assert.doesNotMatch(ui.text(), /null/)
})

test('an empty activity log says so rather than sitting on "Loading"', async (t) => {
  setup(t)
  const ui = await mount()

  await click(tab(ui, 'Activity'))

  assert.match(ui.text(), /No activity yet/)
})

test('a failed activity load reports the reason', async (t) => {
  setup(t, { 'GET /api/admin/audit-logs': { status: 500, body: { error: 'Audit log unavailable' } } })
  const ui = await mount()

  await click(tab(ui, 'Activity'))

  assert.match(ui.text(), /Audit log unavailable/)
})

test('switching back to Agents does not re-request the whole roster', async (t) => {
  // The tab is a view over data already in hand; refetching on every tap is a poll
  // the admin never asked for.
  const { net } = setup(t)
  const ui = await mount()
  const before = net.to('/api/admin/agents', 'GET').length

  await click(tab(ui, 'Activity'))
  await click(tab(ui, 'Agents'))

  assert.equal(net.to('/api/admin/agents', 'GET').length, before)
  assert.match(ui.text(), /Priya Nair/)
})
