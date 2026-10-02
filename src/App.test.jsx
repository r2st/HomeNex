// The app shell: who gets in, what the connectivity/WhatsApp banners say, and
// which tab is mounted. A shell bug locks every agent out of everything, so the
// auth gate and the 401 handling are the parts worth pinning down.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, click, act } from './test/render.jsx'
import { installBrowser, mockFetch } from './test/browserEnv.js'
import { setToken } from './api.js'
import App from './App.jsx'

const AGENT = { id: 1, name: 'Rajesh Kumar', wa_phone_number: '919876543210', is_admin: 0 }

const DASHBOARD = {
  unanswered: [],
  hotLeads: [],
  followupsToday: [],
  siteVisitsToday: [],
  overdueFollowups: [],
  activity: [],
}

function setup(t, { token = 'tok', routes = {}, online = true } = {}) {
  const env = installBrowser({ online })
  const net = mockFetch({
    'GET /api/auth/me': AGENT,
    'GET /api/health': { whatsapp: true, whatsapp_send: true },
    'GET /api/followups': [],
    'GET /api/dashboard': DASHBOARD,
    'GET /api/stats': { total: 0, newToday: 0, active24h: 0 },
    'GET /api/worklist': { items: [] },
    'GET /api/notifications': { notifications: [], unread: 0 },
    'GET /api/properties': [],
    'GET /api/leads': [],
    'GET /api/pipeline-stages': [],
    ...routes,
  })
  if (token) setToken(token)
  t.after(() => {
    net.restore()
    env.restore()
  })
  return { env, net }
}

// --- Auth gate -------------------------------------------------------------

test('with no token the agent sees the landing page', async (t) => {
  const ctx = setup(t, { token: null })
  const ui = await render(<App />)

  assert.match(ui.text(), /AI-powered WhatsApp CRM/)
  assert.equal(ctx.net.to('/api/auth/me').length, 0, 'no point asking who we are without a token')
})

test('a stored token loads the agent and lands on Home', async (t) => {
  setup(t)
  const ui = await render(<App />)

  assert.match(ui.text(), /Rajesh/)
  assert.match(ui.text(), /Home/)
})

test('a token the server rejects falls back to the landing page', async (t) => {
  setup(t, { routes: { 'GET /api/auth/me': { status: 401, body: {} } } })
  const ui = await render(<App />)

  assert.match(ui.text(), /AI-powered WhatsApp CRM/)
})

test('a 401 mid-session signs the agent out', async (t) => {
  const ctx = setup(t)
  const ui = await render(<App />)
  assert.match(ui.text(), /Rajesh/)

  // api.js dispatches this whenever any call comes back 401.
  await act(() => ctx.env.window.dispatchEvent(new Event('homenex-logout')))

  assert.match(ui.text(), /AI-powered WhatsApp CRM/)
})

test('signing out clears the token and returns to the landing page', async (t) => {
  const ctx = setup(t)
  const ui = await render(<App />)

  await click(ui.byText('Sign out'))

  assert.match(ui.text(), /AI-powered WhatsApp CRM/)
  assert.equal(ctx.env.localStorage.getItem('homenex-token'), null)
})

// --- Offline banner --------------------------------------------------------

test('going offline tells the agent they are on cached data', async (t) => {
  const ctx = setup(t)
  const ui = await render(<App />)
  assert.doesNotMatch(ui.text(), /Offline/)

  ctx.env.setOnline(false)
  await act(() => ctx.env.window.dispatchEvent(new Event('offline')))

  assert.match(ui.text(), /Offline — viewing cached data/)
})

test('queued offline writes are counted in the banner', async (t) => {
  const ctx = setup(t)
  ctx.env.localStorage.setItem(
    'homenex-offline-queue',
    JSON.stringify([{ method: 'PUT', url: '/api/leads/1/stage', body: {} }]),
  )
  ctx.env.setOnline(false)
  const ui = await render(<App />)

  await act(() => ctx.env.window.dispatchEvent(new Event('offline')))
  assert.match(ui.text(), /1 queued/)
})

// --- WhatsApp health banner ------------------------------------------------

test('an expired WhatsApp token is called out by name', async (t) => {
  setup(t, {
    routes: {
      'GET /api/health': { whatsapp: true, whatsapp_send: false, whatsapp_reason: 'token_expired' },
    },
  })
  const ui = await render(<App />)

  assert.match(ui.text(), /WhatsApp token expired/)
})

test('a generic WhatsApp outage gets the generic warning', async (t) => {
  setup(t, {
    routes: { 'GET /api/health': { whatsapp: true, whatsapp_send: false, whatsapp_reason: 'rate_limited' } },
  })
  const ui = await render(<App />)

  assert.match(ui.text(), /WhatsApp sending is unavailable right now/)
})

test('no banner while WhatsApp is healthy', async (t) => {
  setup(t)
  const ui = await render(<App />)

  assert.doesNotMatch(ui.text(), /WhatsApp token expired|sending is unavailable/)
})

test('no banner before WhatsApp has ever been configured', async (t) => {
  setup(t, { routes: { 'GET /api/health': { whatsapp: false, whatsapp_send: false } } })
  const ui = await render(<App />)

  assert.doesNotMatch(ui.text(), /WhatsApp token expired|sending is unavailable/)
})

test('a failing health check is silent rather than alarming', async (t) => {
  setup(t, { routes: { 'GET /api/health': { status: 500, body: {} } } })
  const ui = await render(<App />)

  assert.doesNotMatch(ui.text(), /unavailable/)
})

// --- Navigation ------------------------------------------------------------

test('the bottom nav switches tabs', async (t) => {
  setup(t)
  const ui = await render(<App />)

  await click(ui.byText('Leads'))
  assert.match(ui.text(), /open in this pipeline|No leads yet/)

  await click(ui.byText('Inbox'))
  assert.match(ui.text(), /Real WhatsApp conversations/)
})

test('an internal navigate event moves tabs', async (t) => {
  const ctx = setup(t)
  const ui = await render(<App />)

  await act(() => {
    const event = new Event('homenex-navigate')
    event.detail = 'leads'
    ctx.env.window.dispatchEvent(event)
  })

  assert.match(ui.text(), /open in this pipeline|No leads yet/)
})

test('the admin tab is refused to a non-admin agent', async (t) => {
  const ctx = setup(t)
  const ui = await render(<App />)

  await act(() => {
    const event = new Event('homenex-navigate')
    event.detail = 'admin'
    ctx.env.window.dispatchEvent(event)
  })

  assert.doesNotMatch(ui.text(), /Admin/i)
})

test('the bottom nav is hidden on the admin screen', async (t) => {
  const ctx = setup(t, {
    routes: { 'GET /api/auth/me': { ...AGENT, is_admin: 1 }, 'GET /api/admin/overview': {} },
  })
  const ui = await render(<App />)

  await act(() => {
    const event = new Event('homenex-navigate')
    event.detail = 'admin'
    ctx.env.window.dispatchEvent(event)
  })

  assert.equal(ui.queryByText('Properties'), null, 'the admin panel takes over the whole screen')
})

// --- Follow-up badge -------------------------------------------------------

test('actionable follow-ups raise a badge on the More tab', async (t) => {
  const overdue = [
    { id: 1, due_at: new Date(Date.now() - 86400_000).toISOString(), overdue: true },
    { id: 2, due_at: new Date(Date.now() - 3600_000).toISOString(), overdue: true },
  ]
  setup(t, { routes: { 'GET /api/followups': overdue } })
  const ui = await render(<App />)

  assert.equal(ui.allByText('2', { exact: true }).length, 1)
})

test('completed follow-ups do not raise a badge', async (t) => {
  setup(t, {
    routes: {
      'GET /api/followups': [
        { id: 1, due_at: new Date(Date.now() - 86400_000).toISOString(), overdue: true, completed_at: new Date().toISOString() },
      ],
    },
  })
  const ui = await render(<App />)

  assert.equal(ui.queryByText('1', { exact: true }), null)
})

test('the follow-up poll is not run while logged out', async (t) => {
  const ctx = setup(t, { token: null })
  await render(<App />)

  assert.equal(ctx.net.to('/api/followups').length, 0, 'an anonymous poll would just 401 in a loop')
})

test('every poll is torn down when the app unmounts', async (t) => {
  const ctx = setup(t)
  const ui = await render(<App />)

  assert.ok(ctx.env.liveIntervals > 0)
  ui.unmount()
  assert.equal(ctx.env.liveIntervals, 0)
})
