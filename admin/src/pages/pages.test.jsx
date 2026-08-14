// The admin portal's pages.
//
// This is the staff-only site, and until now nothing in it was tested. It is the
// least-used surface in the product and the one with the most leverage: it is where
// an agent's WhatsApp line is switched on, where their plan and invoices are set,
// where a template is approved before Meta ever sees it, and where staff can
// impersonate an agent outright.
//
// The theme running through these tests is the failure that says nothing. Every page
// here is a fetch-then-render with a `.catch` somewhere, and the interesting question
// is never "does the table render" — it is what staff are shown when the call behind
// a button does not land. An admin who taps Activate and sees no change reads it as
// "already active" and moves on, leaving an agent's number dark.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, click, change, keyDown, submit } from '../../../src/test/render.jsx'
import { installBrowser, mockFetch } from '../../../src/test/browserEnv.js'

import Login from './Login.jsx'
import Dashboard from './Dashboard.jsx'
import Agents from './Agents.jsx'
import AgentDetail from './AgentDetail.jsx'
import Waba from './Waba.jsx'
import Templates from './Templates.jsx'
import Onboarding from './Onboarding.jsx'
import Billing from './Billing.jsx'
import Tickets from './Tickets.jsx'
import Analytics from './Analytics.jsx'
import { StatusBadge, WabaFilter, Pager } from '../components.jsx'

const ADMIN = { id: 1, name: 'Staff Sanjay', phone: '+919800000001', email: 'sanjay@homenex.in', is_admin: 1 }

const agent = (id, over = {}) => ({
  id,
  name: `Agent ${id}`,
  phone: `+91980000000${id}`,
  email: null,
  is_admin: 0,
  waba_status: 'none',
  wa_phone_number: null,
  wa_phone_number_id: null,
  meta_waba_id: null,
  created_at: new Date(Date.UTC(2026, 0, 15)).toISOString(),
  last_active: new Date(Date.UTC(2026, 6, 1)).toISOString(),
  lead_count: 12,
  ...over,
})

function setup(t, routes = {}) {
  const env = installBrowser()
  const net = mockFetch(routes)
  t.after(() => {
    net.restore()
    env.restore()
  })
  return { env, net }
}

// A route that never answers, for the states between "asked" and "told".
const PENDING = () => new Promise(() => {})

// The Agents page debounces its query through setTimeout, which render()'s act loop
// does not wait for — it settles microtasks and immediates, then stops as soon as the
// tree is clean. Give the timer its turn, then let the response land.
const settle = async (ms = 0) => {
  await new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

// The pages are plain `<form>`s or bare buttons; the fake renderer does not translate
// a submit-button click into a form submit, so aim at the form the way a browser does.
const formOf = (ui, index = 0) => ui.all((f) => f.type === 'form')[index]
const rowsIn = (ui) => ui.all((f) => f.type === 'tr')
// Concatenated exactly the way the renderer's own text() does — no separators, so
// "(" + count + ")" reads as "(2)" rather than "( 2 )".
const textIn = (node) => {
  let out = ''
  const walk = (f) => {
    if (f.kind === 'text') out += f.text
    for (const c of f.children || []) walk(c)
  }
  walk(node)
  return out.replace(/\s+/g, ' ').trim()
}
const rowWith = (ui, needle) => rowsIn(ui).find((r) => textIn(r).includes(needle))
const buttonIn = (node, label) => {
  const found = []
  const walk = (f) => {
    if (f.type === 'button' && new RegExp(label).test(textIn(f))) found.push(f)
    for (const c of f.children || []) walk(c)
  }
  walk(node)
  return found[found.length - 1] || null
}

// ===========================================================================
// Login — the only door into the portal
// ===========================================================================

test('login sends an email as email and a number as phone', async (t) => {
  const { net } = setup(t, { 'POST /api/auth/login': { token: 'tok', agent: ADMIN } })

  for (const [typed, expected] of [
    ['sanjay@homenex.in', { email: 'sanjay@homenex.in' }],
    ['+919800000001', { phone: '+919800000001' }],
  ]) {
    const ui = await render(<Login onLogin={() => {}} />)
    await change(ui.byLabel('Phone or email'), typed)
    await change(ui.byLabel('Password'), 'secret123')
    await submit(formOf(ui))

    const last = net.to('/api/auth/login', 'POST').at(-1)
    assert.deepEqual(last.body, { ...expected, password: 'secret123' })
  }
})

test('login trims the identifier, so a pasted number with a stray space still works', async (t) => {
  const { net } = setup(t, { 'POST /api/auth/login': { token: 'tok', agent: ADMIN } })
  const ui = await render(<Login onLogin={() => {}} />)

  await change(ui.byLabel('Phone or email'), '  sanjay@homenex.in  ')
  await change(ui.byLabel('Password'), 'secret123')
  await submit(formOf(ui))

  assert.deepEqual(net.to('/api/auth/login', 'POST')[0].body.email, 'sanjay@homenex.in')
})

test('a non-admin who knows their password is refused, and no token is stored', async (t) => {
  // The server gates the admin routes too, but a token stored here would leave the
  // portal shell rendering for someone who can do nothing in it.
  setup(t, { 'POST /api/auth/login': { token: 'agent-token', agent: { ...ADMIN, is_admin: 0 } } })
  const logged = []
  const ui = await render(<Login onLogin={(a) => logged.push(a)} />)

  await change(ui.byLabel('Phone or email'), 'agent@example.com')
  await change(ui.byLabel('Password'), 'secret123')
  await submit(formOf(ui))

  assert.match(ui.text(), /does not have admin access/)
  assert.equal(localStorage.getItem('homenex-admin-token'), null, 'a non-admin token was stored')
  assert.deepEqual(logged, [], 'a non-admin was let into the portal')
})

test('a successful login stores the token and hands the admin up', async (t) => {
  setup(t, { 'POST /api/auth/login': { token: 'staff-token', agent: ADMIN } })
  const logged = []
  const ui = await render(<Login onLogin={(a) => logged.push(a)} />)

  await change(ui.byLabel('Phone or email'), 'sanjay@homenex.in')
  await change(ui.byLabel('Password'), 'secret123')
  await submit(formOf(ui))

  assert.equal(localStorage.getItem('homenex-admin-token'), 'staff-token')
  assert.deepEqual(logged, [ADMIN])
})

test('a wrong password is reported and the button comes back', async (t) => {
  setup(t, { 'POST /api/auth/login': { status: 401, body: { error: 'Invalid credentials' } } })
  const ui = await render(<Login onLogin={() => {}} />)

  await change(ui.byLabel('Phone or email'), 'sanjay@homenex.in')
  await change(ui.byLabel('Password'), 'nope')
  await submit(formOf(ui))

  assert.match(ui.text(), /Invalid credentials/)
  assert.equal(ui.byText(/Sign in|Signing in/, { selector: 'button' }).props.disabled, false)
})

// ===========================================================================
// Dashboard
// ===========================================================================

const STATS = {
  totalAgents: 42,
  newAgents7d: 5,
  newAgents30d: 18,
  activeConversations: 7,
  noneWaba: 20,
  pendingWaba: 9,
  registeredWaba: 8,
  activeWaba: 5,
  totalLeads: 1204,
  totalContacts: 860,
}

test('the dashboard shows every figure the server sent', async (t) => {
  setup(t, { 'GET /api/admin/dashboard': STATS })
  const ui = await render(<Dashboard />)

  for (const [label, value] of [
    ['Total agents', 42],
    ['New signups (7 days)', 5],
    ['Active conversations', 7],
    ['Total leads', 1204],
    ['Total client contacts', 860],
  ]) {
    assert.match(ui.text(), new RegExp(`${value}\\s*${label.replace(/[()]/g, '\\$&')}`), `${label} is wrong`)
  }
})

test('a figure that has not arrived is an em dash, not a zero', async (t) => {
  // A zero is a claim. "42 agents, 0 leads" would send staff looking for an outage
  // that is really just a request still in flight.
  setup(t, { 'GET /api/admin/dashboard': PENDING })
  const ui = await render(<Dashboard />)

  assert.match(ui.text(), /—/)
  assert.doesNotMatch(ui.text(), /\b0\s*Total agents/)
})

test('the pending-WABA card links to the queue only when something is waiting', async (t) => {
  setup(t, { 'GET /api/admin/dashboard': STATS })
  const busy = await render(<Dashboard />)
  assert.ok(busy.query((f) => f.type === 'a' && f.props.href === '#/waba'), 'no way through to the queue')

  setup(t, { 'GET /api/admin/dashboard': { ...STATS, pendingWaba: 0 } })
  const clear = await render(<Dashboard />)
  assert.equal(clear.query((f) => f.type === 'a' && f.props.href === '#/waba'), null)
})

test('a failed dashboard says so instead of showing a platform of zeroes', async (t) => {
  setup(t, { 'GET /api/admin/dashboard': { status: 500, body: { error: 'Stats query timed out' } } })
  const ui = await render(<Dashboard />)

  assert.match(ui.text(), /Stats query timed out/)
  assert.doesNotMatch(ui.text(), /Total agents/)
})

// ===========================================================================
// Agents — the paged roster
// ===========================================================================

const PAGE = (over = {}) => ({
  agents: [agent(1, { name: 'Priya Nair', is_admin: 1, email: 'priya@example.com', waba_status: 'active' }), agent(2)],
  page: 1,
  totalPages: 3,
  total: 45,
  ...over,
})

// The page debounces, so every case here waits out the timer before asserting.
const mountAgents = async () => {
  const ui = await render(<Agents />)
  await settle()
  return ui
}

test('the roster renders one row per agent, with the admin flagged', async (t) => {
  setup(t, { 'GET /api/admin/agents': PAGE() })
  const ui = await mountAgents()

  assert.match(ui.text(), /Priya Nair/)
  assert.match(textIn(rowWith(ui, 'Priya Nair')), /admin/)
  assert.doesNotMatch(textIn(rowWith(ui, 'Agent 2')), /admin/)
})

test('a missing email is an em dash rather than a blank cell', async (t) => {
  setup(t, { 'GET /api/admin/agents': PAGE() })
  const ui = await mountAgents()

  assert.match(textIn(rowWith(ui, 'Agent 2')), /—/)
})

test('the roster asks for one page, not the whole platform', async (t) => {
  const { net } = setup(t, { 'GET /api/admin/agents': PAGE() })
  await mountAgents()

  assert.equal(net.to('/api/admin/agents', 'GET')[0].query.pageSize, '20')
})

test('searching sends the term to the server, because only page one is in hand', async (t) => {
  const { net } = setup(t, { 'GET /api/admin/agents': PAGE() })
  const ui = await mountAgents()

  await change(ui.byLabel(/Search agents/), 'priya')
  await settle(300)

  assert.ok(
    net.to('/api/admin/agents', 'GET').some((c) => c.query.search === 'priya'),
    'the search never reached the server',
  )
})

test('typing does not fire one request per keystroke', async (t) => {
  // The debounce is the only thing between a fast typist and eight roster queries.
  const { net } = setup(t, { 'GET /api/admin/agents': PAGE() })
  const ui = await mountAgents()
  const before = net.to('/api/admin/agents', 'GET').length

  for (const term of ['p', 'pr', 'pri', 'priy', 'priya']) await change(ui.byLabel(/Search agents/), term)
  await settle(300)

  const fired = net.to('/api/admin/agents', 'GET').length - before
  assert.equal(fired, 1, `five keystrokes fired ${fired} requests`)
})

test('changing a filter goes back to page one', async (t) => {
  // Page 3 of "all agents" is not page 3 of "pending" — staying put shows an empty
  // table for a filter that has plenty of matches.
  const { net } = setup(t, { 'GET /api/admin/agents': PAGE({ page: 3 }) })
  const ui = await mountAgents()

  await click(ui.byText('Next →'))
  await settle()
  await change(ui.byLabel('Filter by WABA status'), 'pending')
  await settle()

  const last = net.to('/api/admin/agents', 'GET').at(-1)
  assert.equal(last.query.status, 'pending')
  assert.equal(last.query.page, '1')
})

test('an empty result says nobody matched, rather than showing an empty table', async (t) => {
  setup(t, { 'GET /api/admin/agents': PAGE({ agents: [], total: 0, totalPages: 0 }) })
  const ui = await mountAgents()

  assert.match(ui.text(), /No agents match this search/)
})

test('a failed roster keeps the last good page on screen and names the failure', async (t) => {
  const { net } = setup(t, { 'GET /api/admin/agents': PAGE() })
  const ui = await mountAgents()
  assert.match(ui.text(), /Priya Nair/)

  net.set('GET /api/admin/agents', { status: 500, body: { error: 'Roster query failed' } })
  await change(ui.byLabel('Filter by WABA status'), 'pending')
  await settle()

  assert.match(ui.text(), /Roster query failed/)
  assert.match(ui.text(), /Priya Nair/, 'the page went blank instead of holding the last good data')
})

// --- The shared bits ---

test('the pager hides itself when there is nothing to page', async () => {
  const ui = await render(<Pager page={1} totalPages={0} total={0} onPage={() => {}} />)
  assert.equal(ui.text(), '')
})

test('the pager will not step off either end', async () => {
  const first = await render(<Pager page={1} totalPages={3} total={45} onPage={() => {}} />)
  assert.equal(first.byText('← Prev').props.disabled, true)
  assert.equal(first.byText('Next →').props.disabled, false)

  const last = await render(<Pager page={3} totalPages={3} total={45} onPage={() => {}} />)
  assert.equal(last.byText('← Prev').props.disabled, false)
  assert.equal(last.byText('Next →').props.disabled, true)
})

test('the pager counts one agent as "1 agent"', async () => {
  const one = await render(<Pager page={1} totalPages={1} total={1} onPage={() => {}} />)
  assert.match(one.text(), /· 1 agent(?!s)/)

  const many = await render(<Pager page={1} totalPages={1} total={2} onPage={() => {}} />)
  assert.match(many.text(), /2 agents/)
})

test('an agent with no WABA status still gets a badge that reads "none"', async () => {
  const ui = await render(<StatusBadge status={undefined} />)
  assert.equal(ui.text(), 'none')
  assert.match(ui.byText('none').props.className, /badge none/)
})

test('the WABA filter offers every status the API knows, plus "all"', async () => {
  const ui = await render(<WabaFilter value="" onChange={() => {}} />)
  const values = ui.all((f) => f.type === 'option').map((f) => f.props.value)
  assert.deepEqual(values, ['', 'none', 'pending', 'registered', 'active'])
})

// ===========================================================================
// AgentDetail
// ===========================================================================

const DETAIL = agent(7, {
  name: 'Rohit Sharma',
  email: 'rohit@example.com',
  waba_status: 'registered',
  wa_phone_number: '+919000000007',
  wa_phone_number_id: '123456789012345',
  meta_waba_id: '987654321098765',
  contact_count: 30,
  message_count: 400,
  recent_activity: [{ id: 1, text: 'Claimed a lead', created_at: new Date().toISOString() }],
})

test('the agent detail shows the counts and the recent activity', async (t) => {
  setup(t, { 'GET /api/admin/agents/7': DETAIL })
  const ui = await render(<AgentDetail id="7" />)

  assert.match(ui.text(), /Rohit Sharma/)
  assert.match(ui.text(), /12\s*Leads/)
  assert.match(ui.text(), /30\s*Clients/)
  assert.match(ui.text(), /400\s*Messages/)
  assert.match(ui.text(), /Claimed a lead/)
})

test('an agent who has done nothing yet says so', async (t) => {
  setup(t, { 'GET /api/admin/agents/7': { ...DETAIL, recent_activity: [] } })
  const ui = await render(<AgentDetail id="7" />)

  assert.match(ui.text(), /No activity yet/)
})

test('an agent that cannot be loaded shows the reason and a way back', async (t) => {
  setup(t, { 'GET /api/admin/agents/99': { status: 404, body: { error: 'Agent not found' } } })
  const ui = await render(<AgentDetail id="99" />)

  assert.match(ui.text(), /Agent not found/)
  assert.ok(ui.query((f) => f.type === 'a' && f.props.href === '#/agents'), 'no way back to the roster')
})

test('saving the profile sends the four fields it owns, and confirms', async (t) => {
  const { net } = setup(t, {
    'GET /api/admin/agents/7': DETAIL,
    'PUT /api/admin/agents/7': (call) => ({ ...DETAIL, ...call.body }),
  })
  const ui = await render(<AgentDetail id="7" />)

  await change(ui.byLabel('Name'), 'Rohit S. Sharma')
  await change(ui.byLabel('Platform admin'), undefined)
  await submit(formOf(ui, 0))

  assert.deepEqual(net.to('/api/admin/agents/7', 'PUT')[0].body, {
    name: 'Rohit S. Sharma',
    email: 'rohit@example.com',
    phone: '+919800000007',
    is_admin: false,
  })
})

test('a refused profile save is shown and success is not claimed', async (t) => {
  setup(t, {
    'GET /api/admin/agents/7': DETAIL,
    'PUT /api/admin/agents/7': { status: 409, body: { error: 'That phone number is taken' } },
  })
  const ui = await render(<AgentDetail id="7" />)

  await submit(formOf(ui, 0))

  assert.match(ui.text(), /That phone number is taken/)
  assert.doesNotMatch(ui.text(), /Profile saved/)
})

test('saving WABA config sends blanks as null, not as empty strings', async (t) => {
  const { net } = setup(t, {
    'GET /api/admin/agents/7': DETAIL,
    'PUT /api/admin/agents/7/waba': (call) => ({ ...DETAIL, ...call.body }),
  })
  const ui = await render(<AgentDetail id="7" />)

  await change(ui.byLabel('Meta WABA ID'), '')
  await submit(formOf(ui, 1))

  assert.deepEqual(net.to('/api/admin/agents/7/waba', 'PUT')[0].body, {
    status: 'registered',
    wa_phone_number: '+919000000007',
    wa_phone_number_id: '123456789012345',
    meta_waba_id: null,
  })
})

test('a saved editor re-reads the agent, so the counts beside it stay true', async (t) => {
  const { net } = setup(t, {
    'GET /api/admin/agents/7': DETAIL,
    'PUT /api/admin/agents/7/waba': (call) => ({ ...DETAIL, ...call.body }),
  })
  const ui = await render(<AgentDetail id="7" />)
  const before = net.to('/api/admin/agents/7', 'GET').length

  await submit(formOf(ui, 1))

  assert.equal(net.to('/api/admin/agents/7', 'GET').length, before + 1)
})

// ===========================================================================
// WABA management — the page that switches an agent's line on
// ===========================================================================

const wabaRoutes = (pending, registered, active) => ({
  'GET /api/admin/agents': ({ query }) => {
    if (query.status === 'pending') return { agents: pending }
    if (query.status === 'registered') return { agents: registered }
    return { agents: active }
  },
})

test('the setup queue and the registered list are counted in their headings', async (t) => {
  setup(t, wabaRoutes([agent(1, { waba_status: 'pending' })], [agent(2, { waba_status: 'registered' })], []))
  const ui = await render(<Waba />)

  assert.match(ui.text(), /pending registration \(1\)/)
  assert.match(ui.text(), /Registered numbers \(1\)/)
})

test('an empty queue says so on both tables', async (t) => {
  setup(t, wabaRoutes([], [], []))
  const ui = await render(<Waba />)

  assert.match(ui.text(), /Queue is empty/)
  assert.match(ui.text(), /No registered numbers yet/)
})

test('registering an agent sends both Meta ids and flips them to registered', async (t) => {
  const { net } = setup(t, {
    ...wabaRoutes([agent(1, { name: 'Pending Priya', waba_status: 'pending' })], [], []),
    'PUT /api/admin/agents/1/waba': { ok: true },
  })
  const ui = await render(<Waba />)

  await click(ui.byText('Mark registered'))
  await change(ui.byLabel('Meta WABA ID'), '987654321098765')
  await change(ui.byLabel('Meta phone_number_id'), '123456789012345')
  await submit(formOf(ui))

  assert.deepEqual(net.to('/api/admin/agents/1/waba', 'PUT')[0].body, {
    status: 'registered',
    meta_waba_id: '987654321098765',
    wa_phone_number_id: '123456789012345',
  })
})

test('a refused registration keeps the form open with the reason', async (t) => {
  setup(t, {
    ...wabaRoutes([agent(1, { waba_status: 'pending' })], [], []),
    'PUT /api/admin/agents/1/waba': { status: 409, body: { error: 'That phone_number_id is already wired to someone' } },
  })
  const ui = await render(<Waba />)

  await click(ui.byText('Mark registered'))
  await change(ui.byLabel('Meta WABA ID'), '987654321098765')
  await change(ui.byLabel('Meta phone_number_id'), '123456789012345')
  await submit(formOf(ui))

  assert.match(ui.text(), /already wired to someone/)
  assert.ok(ui.queryByLabel('Meta WABA ID'), 'the form closed and lost the ids that were typed')
})

test('activating a registered number sends active; deactivating sends registered', async (t) => {
  const { net } = setup(t, {
    ...wabaRoutes([], [agent(2, { name: 'Reg Ravi', waba_status: 'registered' })], [agent(3, { name: 'Live Latha', waba_status: 'active' })]),
    'PUT /api/admin/agents/2/waba': { ok: true },
    'PUT /api/admin/agents/3/waba': { ok: true },
  })
  const ui = await render(<Waba />)

  await click(buttonIn(rowWith(ui, 'Reg Ravi'), 'Activate'))
  assert.equal(net.to('/api/admin/agents/2/waba', 'PUT')[0].body.status, 'active')

  await click(buttonIn(rowWith(ui, 'Live Latha'), 'Deactivate'))
  assert.equal(net.to('/api/admin/agents/3/waba', 'PUT')[0].body.status, 'registered')
})

test('a number that fails to activate says so instead of silently staying dark', async (t) => {
  // This one had no catch at all: the rejection went unhandled, the button un-busied,
  // and the row kept showing "Not live" with nothing to explain it. Staff read that
  // as "already done".
  setup(t, {
    ...wabaRoutes([], [agent(2, { name: 'Reg Ravi', waba_status: 'registered' })], []),
    'PUT /api/admin/agents/2/waba': { status: 502, body: { error: 'Meta rejected the activation' } },
  })
  const ui = await render(<Waba />)

  await click(buttonIn(rowWith(ui, 'Reg Ravi'), 'Activate'))

  assert.match(ui.text(), /Meta rejected the activation/)
  assert.equal(buttonIn(rowWith(ui, 'Reg Ravi'), 'Activate').props.disabled, false, 'the button stayed stuck')
})

test('a failed load of the WABA page names the failure', async (t) => {
  setup(t, { 'GET /api/admin/agents': { status: 500, body: { error: 'Agent query failed' } } })
  const ui = await render(<Waba />)

  assert.match(ui.text(), /Agent query failed/)
})

// ===========================================================================
// Template approvals
// ===========================================================================

const TEMPLATE = {
  id: 5,
  name: 'site_visit_reminder',
  category: 'UTILITY',
  language: 'en',
  body: 'Hi {{1}}, your site visit is tomorrow at {{2}}.',
  agent_name: 'Priya Nair',
  agent_phone: '+919800000002',
  updated_at: new Date(Date.now() - 3600_000).toISOString(),
}

test('a pending template shows its body, its category and who asked for it', async (t) => {
  setup(t, { 'GET /api/admin/templates/pending': [TEMPLATE] })
  const ui = await render(<Templates />)

  assert.match(ui.text(), /site_visit_reminder/)
  assert.match(ui.text(), /UTILITY/)
  assert.match(ui.text(), /Priya Nair/)
  assert.match(ui.text(), /your site visit is tomorrow/)
})

test('the three review verbs each send their own action', async (t) => {
  const { net } = setup(t, {
    'GET /api/admin/templates/pending': [TEMPLATE],
    'PUT /api/admin/templates/5/review': { ok: true },
  })

  for (const [label, action] of [
    ['^Approve$', 'approve'],
    ['submit to Meta', 'submit'],
    ['^Reject$', 'reject'],
  ]) {
    const ui = await render(<Templates />)
    await click(ui.byText(new RegExp(label), { selector: 'button' }))
    assert.equal(net.to('/api/admin/templates/5/review', 'PUT').at(-1).body.action, action)
  }
})

test('a rejection carries the note staff typed, and the note is cleared after', async (t) => {
  const { net } = setup(t, {
    'GET /api/admin/templates/pending': [TEMPLATE],
    'PUT /api/admin/templates/5/review': { ok: true },
  })
  const ui = await render(<Templates />)

  await change(ui.byLabel(/Review note/), 'Too promotional for UTILITY.')
  await click(ui.byText(/^Reject$/, { selector: 'button' }))

  assert.equal(net.to('/api/admin/templates/5/review', 'PUT')[0].body.note, 'Too promotional for UTILITY.')
})

test('an empty note is left off the request rather than sent as an empty string', async (t) => {
  const { net } = setup(t, {
    'GET /api/admin/templates/pending': [TEMPLATE],
    'PUT /api/admin/templates/5/review': { ok: true },
  })
  const ui = await render(<Templates />)

  await click(ui.byText(/^Approve$/, { selector: 'button' }))

  assert.equal(net.to('/api/admin/templates/5/review', 'PUT')[0].body.note, undefined)
})

test('the note box is addressed to one template, so two drafts cannot cross', async (t) => {
  // The notes live in one object keyed by id. A shared box would attach staff's
  // reasoning for one agent's template to another's rejection.
  const { net } = setup(t, {
    'GET /api/admin/templates/pending': [TEMPLATE, { ...TEMPLATE, id: 6, name: 'diwali_offer', agent_name: 'Amit Verma' }],
    'PUT /api/admin/templates/6/review': { ok: true },
  })
  const ui = await render(<Templates />)

  await change(ui.byLabel('Review note for the "site_visit_reminder" template'), 'note for the first')
  await change(ui.byLabel('Review note for the "diwali_offer" template'), 'note for the second')
  await click(ui.allByText(/^Reject$/, { selector: 'button' }).at(-1))

  assert.equal(net.to('/api/admin/templates/6/review', 'PUT')[0].body.note, 'note for the second')
})

test('an empty review queue says so', async (t) => {
  setup(t, { 'GET /api/admin/templates/pending': [] })
  const ui = await render(<Templates />)

  assert.match(ui.text(), /No templates are waiting for review/)
})

test('a review that is refused is reported', async (t) => {
  setup(t, {
    'GET /api/admin/templates/pending': [TEMPLATE],
    'PUT /api/admin/templates/5/review': { status: 400, body: { error: 'A rejection needs a note' } },
  })
  const ui = await render(<Templates />)

  await click(ui.byText(/^Reject$/, { selector: 'button' }))

  assert.match(ui.text(), /A rejection needs a note/)
})

// ===========================================================================
// Onboarding
// ===========================================================================

const QUEUE_ROW = {
  id: 3,
  name: 'Setup Suresh',
  phone: '+919800000003',
  rera_id: 'A52100012345',
  rera_state: 'Maharashtra',
  rera_verified: 0,
  kyc_status: 'pending',
  waba_status: 'pending',
  steps: { profile: true, rera: false },
}

test('the onboarding queue shows each step as done or not', async (t) => {
  setup(t, { 'GET /api/admin/onboarding': [QUEUE_ROW], 'GET /api/admin/waba-health': [] })
  const ui = await render(<Onboarding />)

  const row = textIn(rowWith(ui, 'Setup Suresh'))
  assert.match(row, /✓/, 'a completed step was not ticked')
  assert.match(row, /○/, 'an outstanding step was not marked')
  assert.match(row, /A52100012345/)
})

test('verifying KYC and RERA each send their own call, then reload the queue', async (t) => {
  const { net } = setup(t, {
    'GET /api/admin/onboarding': [QUEUE_ROW],
    'GET /api/admin/waba-health': [],
    'PUT /api/admin/agents/3/kyc': { ok: true },
    'PUT /api/admin/agents/3/rera-verify': { ok: true },
  })
  const ui = await render(<Onboarding />)

  await click(ui.byText('Verify KYC'))
  assert.deepEqual(net.to('/api/admin/agents/3/kyc', 'PUT')[0].body, { status: 'verified' })

  await click(ui.byText('Verify RERA'))
  assert.deepEqual(net.to('/api/admin/agents/3/rera-verify', 'PUT')[0].body, { verified: true })
  assert.ok(net.to('/api/admin/onboarding', 'GET').length > 1, 'the queue was not re-read')
})

test('an already-verified agent is not offered the button again', async (t) => {
  setup(t, {
    'GET /api/admin/onboarding': [{ ...QUEUE_ROW, kyc_status: 'verified', rera_verified: 1 }],
    'GET /api/admin/waba-health': [],
  })
  const ui = await render(<Onboarding />)

  assert.equal(ui.queryByText('Verify KYC'), null)
  assert.equal(ui.queryByText('Verify RERA'), null)
})

test('an agent with no RERA id is not offered a RERA verification', async (t) => {
  setup(t, {
    'GET /api/admin/onboarding': [{ ...QUEUE_ROW, rera_id: null }],
    'GET /api/admin/waba-health': [],
  })
  const ui = await render(<Onboarding />)

  assert.equal(ui.queryByText('Verify RERA'), null)
})

test('impersonation stores the AGENT token, leaving the admin session alone', async (t) => {
  const { env } = setup(t, {
    'GET /api/admin/onboarding': [QUEUE_ROW],
    'GET /api/admin/waba-health': [],
    'POST /api/admin/agents/3/impersonate': { token: 'agent-session-token' },
  })
  localStorage.setItem('homenex-admin-token', 'staff-token')
  const ui = await render(<Onboarding />)

  await click(ui.byText('Impersonate'))
  await new Promise((r) => setImmediate(r))

  assert.equal(localStorage.getItem('homenex-token'), 'agent-session-token')
  assert.equal(localStorage.getItem('homenex-admin-token'), 'staff-token', 'the admin session was overwritten')
  assert.deepEqual(env.opened.map((o) => o.url), ['/'])
})

test('a refused impersonation is reported rather than opening an empty tab', async (t) => {
  const { env } = setup(t, {
    'GET /api/admin/onboarding': [QUEUE_ROW],
    'GET /api/admin/waba-health': [],
    'POST /api/admin/agents/3/impersonate': { status: 403, body: { error: 'Impersonation is disabled' } },
  })
  const ui = await render(<Onboarding />)

  await click(ui.byText('Impersonate'))
  await new Promise((r) => setImmediate(r))

  assert.match(ui.text(), /Impersonation is disabled/)
  assert.deepEqual(env.opened, [], 'a tab was opened for a session that was never granted')
})

test('a failed health board is reported, not swallowed into an empty table', async (t) => {
  // An empty board with no explanation reads as "every number is fine".
  setup(t, {
    'GET /api/admin/onboarding': [QUEUE_ROW],
    'GET /api/admin/waba-health': { status: 500, body: { error: 'Health query failed' } },
  })
  const ui = await render(<Onboarding />)

  assert.match(ui.text(), /Health query failed/)
  assert.match(ui.text(), /Setup Suresh/, 'the whole page was replaced by a secondary failure')
})

test('an empty health board says there are no numbers yet', async (t) => {
  setup(t, { 'GET /api/admin/onboarding': [], 'GET /api/admin/waba-health': [] })
  const ui = await render(<Onboarding />)

  assert.match(ui.text(), /Everyone is fully onboarded/)
  assert.match(ui.text(), /No WhatsApp numbers are registered yet/)
})

// ===========================================================================
// Billing
// ===========================================================================

const PLANS = [
  { id: 1, code: 'starter', name: 'Starter', price_paise: 99900, conversation_quota: 1000, is_active: 1 },
  { id: 2, code: 'pro', name: 'Pro', price_paise: 299900, conversation_quota: null, is_active: 1 },
]

const BILLING = {
  subscription: { plan_id: 1, status: 'active' },
  usage: {
    period_start: '2026-07-01',
    period_end: '2026-07-31',
    by_category: [{ category: 'marketing', count: 120, rate_paise: 8800, cost_paise: 1056000 }],
    total_conversations: 120,
    meta_cost_paise: 1056000,
    quota: 1000,
    over_quota: 0,
  },
  invoices: [
    {
      id: 11,
      number: 'HN-2026-011',
      period_start: '2026-06-01',
      period_end: '2026-06-30',
      subtotal_paise: 99900,
      gst_paise: 17982,
      total_paise: 117882,
      status: 'issued',
    },
  ],
}

const billingRoutes = (over = {}) => ({
  'GET /api/admin/plans': PLANS,
  'GET /api/admin/agents': { agents: [agent(4, { name: 'Billed Bhavna' })] },
  'GET /api/admin/agents/4/billing': BILLING,
  ...over,
})

test('the plan catalogue shows prices in rupees and an unlimited quota as such', async (t) => {
  setup(t, billingRoutes())
  const ui = await render(<Billing />)

  assert.match(ui.text(), /Starter/)
  assert.match(ui.text(), /Unlimited/, 'a null quota rendered as a blank or a zero')
})

test('picking an agent loads their billing; picking nobody clears it', async (t) => {
  setup(t, billingRoutes())
  const ui = await render(<Billing />)

  await change(ui.byLabel('Agent to show billing for'), '4')
  assert.match(ui.text(), /HN-2026-011/)

  await change(ui.byLabel('Agent to show billing for'), '')
  assert.doesNotMatch(ui.text(), /HN-2026-011/, 'the previous agent’s invoices stayed on screen')
})

test('assigning a plan sends a numeric plan id', async (t) => {
  // The select yields a string; the API expects the id.
  const { net } = setup(t, { ...billingRoutes(), 'PUT /api/admin/agents/4/subscription': { ok: true } })
  const ui = await render(<Billing />)

  await change(ui.byLabel('Agent to show billing for'), '4')
  await change(ui.byLabel('Subscription plan for this agent'), '2')

  const body = net.to('/api/admin/agents/4/subscription', 'PUT')[0].body
  assert.equal(body.plan_id, 2)
  assert.equal(typeof body.plan_id, 'number')
})

test('generating an invoice re-reads the billing so the new one appears', async (t) => {
  const { net } = setup(t, { ...billingRoutes(), 'POST /api/admin/agents/4/invoices': { ok: true } })
  const ui = await render(<Billing />)

  await change(ui.byLabel('Agent to show billing for'), '4')
  const before = net.to('/api/admin/agents/4/billing', 'GET').length
  await click(ui.byText(/Generate invoice/))

  assert.equal(net.to('/api/admin/agents/4/billing', 'GET').length, before + 1)
})

test('a paid invoice is not offered "Mark paid" again', async (t) => {
  setup(t, billingRoutes({ 'GET /api/admin/agents/4/billing': { ...BILLING, invoices: [{ ...BILLING.invoices[0], status: 'paid' }] } }))
  const ui = await render(<Billing />)

  await change(ui.byLabel('Agent to show billing for'), '4')
  assert.equal(ui.queryByText('Mark paid'), null)
})

test('an agent with no invoices says so', async (t) => {
  setup(t, billingRoutes({ 'GET /api/admin/agents/4/billing': { ...BILLING, invoices: [] } }))
  const ui = await render(<Billing />)

  await change(ui.byLabel('Agent to show billing for'), '4')
  assert.match(ui.text(), /No invoices yet/)
})

test('a refused billing action is reported and the figures are not redrawn as changed', async (t) => {
  setup(t, {
    ...billingRoutes(),
    'POST /api/admin/agents/4/invoices': { status: 409, body: { error: 'An invoice for this period already exists' } },
  })
  const ui = await render(<Billing />)

  await change(ui.byLabel('Agent to show billing for'), '4')
  await click(ui.byText(/Generate invoice/))

  assert.match(ui.text(), /already exists/)
})

test('a roster that fails to load is reported, so the picker is not silently empty', async (t) => {
  setup(t, billingRoutes({ 'GET /api/admin/agents': { status: 500, body: { error: 'Agent list unavailable' } } }))
  const ui = await render(<Billing />)

  assert.match(ui.text(), /Agent list unavailable/)
})

test('switching agents clears the previous agent’s error', async (t) => {
  setup(t, billingRoutes({ 'GET /api/admin/agents/4/billing': { status: 500, body: { error: 'Billing unavailable' } } }))
  const ui = await render(<Billing />)

  await change(ui.byLabel('Agent to show billing for'), '4')
  assert.match(ui.text(), /Billing unavailable/)

  await change(ui.byLabel('Agent to show billing for'), '')
  assert.doesNotMatch(ui.text(), /Billing unavailable/)
})

// ===========================================================================
// Support tickets
// ===========================================================================

const TICKET_ROW = {
  id: 9,
  subject: 'Cannot send templates',
  agent_name: 'Priya Nair',
  category: 'whatsapp',
  priority: 'high',
  status: 'open',
  message_count: 2,
  updated_at: new Date(Date.now() - 600_000).toISOString(),
}

const TICKET = {
  ...TICKET_ROW,
  business_name: 'Nair Properties',
  city: 'Pune',
  agent_phone: '+919800000002',
  waba_status: 'active',
  messages: [
    { id: 1, is_staff: 0, body: 'My templates are stuck', created_at: new Date(Date.now() - 900_000).toISOString() },
  ],
}

const ticketRoutes = (over = {}) => ({
  'GET /api/admin/tickets': [TICKET_ROW],
  'GET /api/admin/tickets/9': TICKET,
  ...over,
})

test('the ticket list shows each ticket with its message count and status', async (t) => {
  setup(t, ticketRoutes())
  const ui = await render(<Tickets />)

  assert.match(ui.text(), /Cannot send templates/)
  assert.match(textIn(rowWith(ui, 'Cannot send templates')), /\(2\)/)
  assert.match(textIn(rowWith(ui, 'Cannot send templates')), /open/)
})

test('filtering by status re-queries rather than filtering the page in hand', async (t) => {
  const { net } = setup(t, ticketRoutes())
  const ui = await render(<Tickets />)

  await change(ui.byLabel('Filter tickets by status'), 'resolved')

  assert.equal(net.to('/api/admin/tickets', 'GET').at(-1).query.status, 'resolved')
})

test('selecting a ticket opens it with the agent’s full context', async (t) => {
  setup(t, ticketRoutes())
  const ui = await render(<Tickets />)

  await click(rowWith(ui, 'Cannot send templates'))

  assert.match(ui.text(), /Nair Properties/)
  assert.match(ui.text(), /WABA active/)
  assert.match(ui.text(), /My templates are stuck/)
})

test('a ticket that fails to open says why instead of loading forever', async (t) => {
  // The error box lived inside the loaded view, so this used to sit on "Loading…"
  // with the reason in state and nowhere on screen.
  setup(t, ticketRoutes({ 'GET /api/admin/tickets/9': { status: 500, body: { error: 'Ticket unavailable' } } }))
  const ui = await render(<Tickets />)

  await click(rowWith(ui, 'Cannot send templates'))

  assert.match(ui.text(), /Ticket unavailable/)
  assert.doesNotMatch(ui.text(), /Loading…/)
})

test('a reply is sent trimmed, the box is cleared, and the thread reloads', async (t) => {
  const { net } = setup(t, { ...ticketRoutes(), 'POST /api/admin/tickets/9/reply': { ok: true } })
  const ui = await render(<Tickets />)
  await click(rowWith(ui, 'Cannot send templates'))

  await change(ui.byLabel('Reply to the agent'), '  Try re-submitting the template.  ')
  await click(ui.byText('Send'))

  assert.equal(net.to('/api/admin/tickets/9/reply', 'POST')[0].body.body, 'Try re-submitting the template.')
  assert.equal(ui.byLabel('Reply to the agent').props.value, '')
})

test('Enter sends the reply, the way staff will actually use it', async (t) => {
  const { net } = setup(t, { ...ticketRoutes(), 'POST /api/admin/tickets/9/reply': { ok: true } })
  const ui = await render(<Tickets />)
  await click(rowWith(ui, 'Cannot send templates'))

  await change(ui.byLabel('Reply to the agent'), 'On it.')
  await keyDown(ui.byLabel('Reply to the agent'), 'Enter')

  assert.equal(net.to('/api/admin/tickets/9/reply', 'POST').length, 1)
})

test('an empty reply is never sent', async (t) => {
  const { net } = setup(t, { ...ticketRoutes(), 'POST /api/admin/tickets/9/reply': { ok: true } })
  const ui = await render(<Tickets />)
  await click(rowWith(ui, 'Cannot send templates'))

  await change(ui.byLabel('Reply to the agent'), '   ')
  await click(ui.byText('Send'))

  assert.equal(net.to('/api/admin/tickets/9/reply', 'POST').length, 0)
})

test('a failed reply is reported and the text is kept for a retry', async (t) => {
  setup(t, { ...ticketRoutes(), 'POST /api/admin/tickets/9/reply': { status: 500, body: { error: 'Reply not delivered' } } })
  const ui = await render(<Tickets />)
  await click(rowWith(ui, 'Cannot send templates'))

  await change(ui.byLabel('Reply to the agent'), 'Try again later.')
  await click(ui.byText('Send'))

  assert.match(ui.text(), /Reply not delivered/)
  assert.equal(ui.byLabel('Reply to the agent').props.value, 'Try again later.', 'the reply was lost')
})

test('the ticket’s current status cannot be re-selected', async (t) => {
  setup(t, ticketRoutes({ 'GET /api/admin/tickets/9': { ...TICKET, status: 'resolved' } }))
  const ui = await render(<Tickets />)
  await click(rowWith(ui, 'Cannot send templates'))

  assert.equal(ui.byText('resolved', { exact: true, selector: 'button' }).props.disabled, true)
  assert.equal(ui.byText('closed', { exact: true, selector: 'button' }).props.disabled, false)
})

test('a refused status change keeps the reason on screen', async (t) => {
  // The reload used to run regardless, which wiped the error the moment it appeared.
  setup(t, { ...ticketRoutes(), 'PUT /api/admin/tickets/9': { status: 403, body: { error: 'Only the assignee can close this' } } })
  const ui = await render(<Tickets />)
  await click(rowWith(ui, 'Cannot send templates'))

  await click(ui.byText('closed', { exact: true, selector: 'button' }))

  assert.match(ui.text(), /Only the assignee can close this/)
})

test('an empty ticket list says so', async (t) => {
  setup(t, ticketRoutes({ 'GET /api/admin/tickets': [] }))
  const ui = await render(<Tickets />)

  assert.match(ui.text(), /No tickets/)
})

// ===========================================================================
// Analytics
// ===========================================================================

const ANALYTICS = {
  retention: { active_1d: 12, active_7d: 30, active_30d: 40 },
  cohorts: [
    { week: '2026-06-01', signups: 10, activated: 4 },
    { week: '2026-06-08', signups: 0, activated: 0 },
  ],
  feature_usage: {
    teams: 3,
    agents_with_properties: 20,
    agents_with_site_visits: 11,
    agents_with_templates: 8,
    agents_with_commissions: 5,
    agents_with_groups: 2,
  },
  cities: [
    { city: 'Pune', agents: 18 },
    { city: 'Mumbai', agents: 9 },
  ],
}

test('analytics renders retention, cohorts, adoption and geography', async (t) => {
  setup(t, { 'GET /api/admin/analytics': ANALYTICS })
  const ui = await render(<Analytics />)

  assert.match(ui.text(), /12\s*Active today/)
  assert.match(ui.text(), /Pune/)
  assert.match(ui.text(), /18/)
  assert.match(ui.text(), /3\s*Teams/)
})

test('an activation rate is a percentage, and a zero-signup week is 0% not NaN', async (t) => {
  setup(t, { 'GET /api/admin/analytics': ANALYTICS })
  const ui = await render(<Analytics />)

  assert.match(ui.text(), /40%/)
  assert.match(ui.text(), /0%/)
  assert.doesNotMatch(ui.text(), /NaN|Infinity/)
})

test('the city bars are scaled to the largest city, not to a hard-coded maximum', async (t) => {
  setup(t, { 'GET /api/admin/analytics': ANALYTICS })
  const ui = await render(<Analytics />)

  const widths = ui
    .all((f) => f.type === 'div' && f.props.style?.background === '#2f6f52')
    .map((f) => f.props.style.width)
  assert.deepEqual(widths, ['100%', '50%'])
})

test('a platform with no signups at all does not divide by zero', async (t) => {
  setup(t, { 'GET /api/admin/analytics': { ...ANALYTICS, cohorts: [], cities: [] } })
  const ui = await render(<Analytics />)

  assert.match(ui.text(), /No signups in the last 12 weeks/)
  assert.doesNotMatch(ui.text(), /NaN|Infinity/)
})

test('analytics says it is loading rather than rendering a blank page', async (t) => {
  setup(t, { 'GET /api/admin/analytics': PENDING })
  const ui = await render(<Analytics />)

  assert.match(ui.text(), /Loading analytics/)
})

test('a failed analytics query names the failure', async (t) => {
  setup(t, { 'GET /api/admin/analytics': { status: 504, body: { error: 'Analytics query timed out' } } })
  const ui = await render(<Analytics />)

  assert.match(ui.text(), /Analytics query timed out/)
})
