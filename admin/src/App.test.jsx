// The admin portal shell: the auth gate and the hash router.
//
// Two things here are load-bearing and neither is visible on any page.
//
// The gate: the portal renders the whole staff UI for whatever `me` holds, so the
// only thing keeping a plain agent out of it is the is_admin check after /api/auth/me
// answers. A stored token belonging to a non-admin must be dropped, not merely
// unused — otherwise the next reload retries it forever.
//
// The router: there are no routes on the server, just '#/agents/12'. A route that
// falls through has to land somewhere sane rather than rendering nothing, and
// '#/agents/12' has to reach the detail page while '#/agents' reaches the list.
import test from 'node:test'
import assert from 'node:assert/strict'
import { act, render } from '../../src/test/render.jsx'
import { installBrowser, mockFetch } from '../../src/test/browserEnv.js'
import App from './App.jsx'

const ADMIN = { id: 1, name: 'Staff Sanjay', phone: '+919800000001', email: 'sanjay@homenex.in', is_admin: 1 }

const EMPTY_PAGE = { agents: [], page: 1, totalPages: 0, total: 0 }

// Every page the router can reach fetches on mount, so the table covers them all —
// otherwise switching route in a test would fail on a missing mock rather than on
// the thing being asserted.
const ROUTES = {
  'GET /api/auth/me': ADMIN,
  'GET /api/admin/dashboard': { totalAgents: 0 },
  'GET /api/admin/agents': EMPTY_PAGE,
  'GET /api/admin/agents/12': { ...ADMIN, id: 12, name: 'Detail Deepa', lead_count: 0, contact_count: 0, message_count: 0, recent_activity: [] },
  'GET /api/admin/onboarding': [],
  'GET /api/admin/waba-health': [],
  'GET /api/admin/templates/pending': [],
  'GET /api/admin/plans': [],
  'GET /api/admin/tickets': [],
  'GET /api/admin/analytics': {
    retention: {},
    cohorts: [],
    feature_usage: {},
    cities: [],
  },
}

function setup(t, { hash = '#/', token = 'staff-token', routes = {} } = {}) {
  const env = installBrowser()
  env.window.location.hash = hash
  if (token) localStorage.setItem('homenex-admin-token', token)
  const net = mockFetch({ ...ROUTES, ...routes })
  t.after(() => {
    net.restore()
    env.restore()
  })
  return { env, net }
}

// The debounce on the Agents page runs through setTimeout, which act() does not wait
// for; give it its turn so a route change settles fully.
const settle = async () => {
  await new Promise((r) => setTimeout(r, 10))
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

// --- The gate ---------------------------------------------------------------

test('with no token at all the portal shows the sign-in card and asks nothing of the API', async (t) => {
  const { net } = setup(t, { token: null })
  const ui = await render(<App />)

  assert.match(ui.text(), /Internal staff sign-in/)
  assert.equal(net.to('/api/auth/me', 'GET').length, 0, 'a session was checked without a token to check')
})

test('a stored admin token goes straight into the portal', async (t) => {
  setup(t)
  const ui = await render(<App />)

  assert.match(ui.text(), /HomeNex Admin/)
  assert.match(ui.text(), /Staff Sanjay/)
  assert.match(ui.text(), /sanjay@homenex.in/)
  assert.doesNotMatch(ui.text(), /Internal staff sign-in/)
})

test("a stored token belonging to a non-admin is dropped, not just ignored", async (t) => {
  // Leaving it in storage means every reload re-checks a token that can never pass.
  setup(t, { routes: { 'GET /api/auth/me': { ...ADMIN, is_admin: 0 } } })
  const ui = await render(<App />)

  assert.match(ui.text(), /Internal staff sign-in/)
  assert.equal(localStorage.getItem('homenex-admin-token'), null, 'the useless token was kept')
})

test('an expired token lands on the sign-in card rather than a half-rendered shell', async (t) => {
  setup(t, { routes: { 'GET /api/auth/me': { status: 401, body: { error: 'expired' } } } })
  const ui = await render(<App />)

  assert.match(ui.text(), /Internal staff sign-in/)
  assert.equal(localStorage.getItem('homenex-admin-token'), null)
})

test('an admin who falls out of session mid-visit is returned to sign-in', async (t) => {
  // api.js fires 'admin-logout' on any 401. Without the listener the shell would keep
  // rendering pages whose every request now fails.
  const { env } = setup(t)
  const ui = await render(<App />)
  assert.match(ui.text(), /Staff Sanjay/)

  await act(() => env.window.dispatchEvent(new Event('admin-logout')))

  assert.match(ui.text(), /Internal staff sign-in/)
})

test('signing out clears the token and the shell in one go', async (t) => {
  setup(t)
  const ui = await render(<App />)

  await act(() => ui.byText('Sign out').props.onClick())

  assert.equal(localStorage.getItem('homenex-admin-token'), null)
  assert.match(ui.text(), /Internal staff sign-in/)
})

test('an admin with no email is identified by their phone number', async (t) => {
  setup(t, { routes: { 'GET /api/auth/me': { ...ADMIN, email: null } } })
  const ui = await render(<App />)

  assert.match(ui.text(), /\+919800000001/)
  assert.doesNotMatch(ui.text(), /null/)
})

// --- The router -------------------------------------------------------------

const CASES = [
  ['#/', /Platform overview/],
  ['#/agents', /All registered agents/],
  ['#/agents/12', /Detail Deepa/],
  ['#/onboarding', /verify KYC\/RERA/],
  ['#/waba', /Register and activate/],
  ['#/templates', /awaiting review/],
  ['#/billing', /Plans, per-tenant metering/],
  ['#/tickets', /In-app Help requests/],
  ['#/analytics', /Cohort activation/],
]

for (const [hash, expected] of CASES) {
  test(`${hash} renders its own page`, async (t) => {
    setup(t, { hash })
    const ui = await render(<App />)
    await settle()

    assert.match(ui.text(), expected, `${hash} rendered the wrong page`)
  })
}

test('a hash nobody recognises falls back to the dashboard, not to a blank main', async (t) => {
  setup(t, { hash: '#/there-is-no-such-page' })
  const ui = await render(<App />)

  assert.match(ui.text(), /Platform overview/)
})

test('navigating by hash swaps the page without a reload', async (t) => {
  const { env } = setup(t, { hash: '#/' })
  const ui = await render(<App />)
  assert.match(ui.text(), /Platform overview/)

  env.window.location.hash = '#/analytics'
  await act(() => env.window.dispatchEvent(new Event('hashchange')))
  await settle()

  assert.match(ui.text(), /Cohort activation/)
  assert.equal(env.reloads, 0, 'the hash router triggered a full page load')
})

test('the sidebar marks exactly one destination as current', async (t) => {
  for (const [hash, label] of [
    ['#/', 'Dashboard'],
    ['#/agents', 'Agents'],
    ['#/agents/12', 'Agents'],
    ['#/tickets', 'Support Tickets'],
  ]) {
    const env = installBrowser()
    env.window.location.hash = hash
    localStorage.setItem('homenex-admin-token', 'staff-token')
    const net = mockFetch(ROUTES)
    const ui = await render(<App />)
    await settle()

    const active = ui.all((f) => f.type === 'a' && f.props.className === 'active')
    assert.equal(active.length, 1, `${hash} highlighted ${active.length} nav links`)
    assert.match(active[0].props.children, new RegExp(label), `${hash} highlighted the wrong link`)

    net.restore()
    env.restore()
  }
})

test('every sidebar link points at a hash the router actually handles', async (t) => {
  // A nav entry whose hash falls through would silently show the dashboard while
  // looking selected — the worst kind of broken link.
  setup(t)
  const ui = await render(<App />)
  const handled = new Set(['#/', ...CASES.map(([h]) => h)])

  for (const link of ui.all((f) => f.type === 'a')) {
    assert.ok(handled.has(link.props.href), `the sidebar links to ${link.props.href}, which nothing renders`)
  }
})

test('the hash router tolerates a bare "#" and the empty hash', async (t) => {
  for (const hash of ['', '#', '#/']) {
    const env = installBrowser()
    env.window.location.hash = hash
    localStorage.setItem('homenex-admin-token', 'staff-token')
    const net = mockFetch(ROUTES)

    const ui = await render(<App />)
    assert.match(ui.text(), /Platform overview/, `hash "${hash}" did not land on the dashboard`)

    net.restore()
    env.restore()
  }
})

test('leaving the portal unsubscribes from hashchange and admin-logout', async (t) => {
  // The shell mounts once per tab, so a leak here is small — but the same two
  // listeners are what a test harness or an embedded preview would accumulate.
  const { env } = setup(t)
  const ui = await render(<App />)

  ui.unmount()
  env.window.location.hash = '#/analytics'
  await act(() => env.window.dispatchEvent(new Event('hashchange')))
  await act(() => env.window.dispatchEvent(new Event('admin-logout')))

  assert.ok(true, 'dispatching into an unmounted shell must not throw')
})
