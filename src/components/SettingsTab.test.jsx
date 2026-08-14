// The settings tab. Mostly a composition of cards that have their own tests, so what
// is asserted here is the part only this file owns: the WhatsApp Business number panel,
// the two ways out of the app (log out, and the admin jump), and the fact that the tab
// re-reads the agent rather than trusting the prop it was mounted with.
//
// The WABA panel is worth its own attention because it is the screen an agent stares at
// while they are waiting. Each status means a different thing is (or isn't) happening,
// and the difference between "we are registering it" and "you need to contact support"
// is whether they sit and wait or pick up the phone.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, click } from '../test/render.jsx'
import { installBrowser, mockFetch } from '../test/browserEnv.js'
import SettingsTab from './SettingsTab.jsx'

const AGENT = {
  id: 1,
  name: 'Alpha Sharma',
  phone: '+919812345678',
  email: 'alpha@homenex.in',
  wa_phone_number: '+919812345678',
  waba_status: 'active',
  waba_registered_at: '2026-06-01T00:00:00.000Z',
  is_admin: 0,
  timezone: 'Asia/Kolkata',
  language: 'en',
}

function setup(t, agent = AGENT, routes = {}) {
  const env = installBrowser()
  const net = mockFetch({ '/api/auth/me': agent, ...routes })
  t.after(() => {
    net.restore()
    env.restore()
  })
  return { net, env }
}

const mount = (agent) => render(<SettingsTab agent={agent} />)

// --- The WhatsApp Business panel --------------------------------------------

test('the registered number is shown with its status in words, not a slug', async (t) => {
  setup(t)
  const ui = await mount(AGENT)

  assert.match(ui.text(), /\+919812345678/)
  assert.match(ui.text(), /Active/)
  assert.match(ui.text(), /All incoming messages are automatically\s+tracked/)
})

test('each WABA status explains what is happening and who has to act', async (t) => {
  // The status is the only thing on the screen telling an agent whether to wait or to
  // chase, so each one has to say which — a coloured pill alone does not.
  const cases = [
    ['pending', /Pending registration/, /support team is registering/],
    ['registered', /awaiting activation/, /completing the final setup/],
    ['none', /Not submitted/, /Contact support to begin registration/],
    ['active', /Active/, /automatically\s+tracked/],
  ]
  for (const [status, pill, explanation] of cases) {
    const env = installBrowser()
    const net = mockFetch({ '/api/auth/me': { ...AGENT, waba_status: status } })
    const ui = await mount({ ...AGENT, waba_status: status })
    assert.match(ui.text(), pill, `${status} pill`)
    assert.match(ui.text(), explanation, `${status} explanation`)
    net.restore()
    env.restore()
  }
})

test('a missing status is treated as not submitted rather than rendering an empty pill', async (t) => {
  setup(t, { ...AGENT, waba_status: null })
  const ui = await mount({ ...AGENT, waba_status: null })

  assert.match(ui.text(), /Not submitted/)
})

test('the registration date is shown when there is one', async (t) => {
  setup(t)
  const ui = await mount(AGENT)

  assert.match(ui.text(), /Registered on/)
})

test('an agent with no number yet is told it is coming, not shown a blank card', async (t) => {
  const agent = { ...AGENT, wa_phone_number: null }
  setup(t, agent)
  const ui = await mount(agent)

  assert.match(ui.text(), /will appear here once your account finishes setting up/)
  // None of the status explanations apply to a number that does not exist yet.
  assert.doesNotMatch(ui.text(), /Contact support to begin registration/)
})

// --- The tab itself ---------------------------------------------------------

test('the tab re-reads the agent on mount instead of trusting the prop', async (t) => {
  // The prop comes from the app shell, which may have been holding it since login —
  // by the time an agent opens Settings their WABA number may well have gone active.
  const { net } = setup(t, { ...AGENT, name: 'Alpha Sharma (fresh)', waba_status: 'pending' })
  const ui = await mount(AGENT)

  assert.equal(net.to('/api/auth/me').length, 1)
  assert.match(ui.text(), /Pending registration/, 'the freshly-read status wins over the prop')
})

test('a tab mounted with no agent at all shows a loading state', async (t) => {
  setup(t, undefined, { '/api/auth/me': () => new Promise(() => {}) })
  const ui = await mount(undefined)

  assert.match(ui.text(), /Loading…/)
})

test('a failed re-read leaves the agent that was passed in on screen', async (t) => {
  setup(t, AGENT, { '/api/auth/me': { status: 500, body: { error: 'nope' } } })
  const ui = await mount(AGENT)

  // Blanking a working settings screen because a refresh failed would be a worse
  // outcome than showing a slightly stale one.
  assert.doesNotMatch(ui.text(), /Loading…/)
  assert.equal(ui.byLabel('Full name').props.value, 'Alpha Sharma', 'the passed-in agent still fills the form')
  assert.match(ui.text(), /\+919812345678/, 'and the WABA panel still has its number')
})

test('logging out clears the token and tells the app shell', async (t) => {
  const { env } = setup(t)
  const ui = await mount(AGENT)

  const events = []
  env.window.addEventListener('homenex-logout', () => events.push('logout'))

  await click(ui.byRole('button', { name: 'Log out' }))

  assert.deepEqual(events, ['logout'], 'the shell is told, so it can show the login screen')
  assert.equal(env.window.localStorage.getItem('homenex_token'), null, 'and the token is gone')
})

test('the admin jump is only offered to an admin', async (t) => {
  setup(t)
  const ui = await mount(AGENT)
  assert.equal(ui.queryByRole('button', { name: 'Team & admin' }), null)
})

test('an admin gets the jump, and it navigates rather than reloading', async (t) => {
  const admin = { ...AGENT, is_admin: 1 }
  const { env } = setup(t, admin)
  const ui = await mount(admin)

  const navigated = []
  env.window.addEventListener('homenex-navigate', (e) => navigated.push(e.detail))

  await click(ui.byRole('button', { name: 'Team & admin' }))
  assert.deepEqual(navigated, ['admin'])
})

test('the setup guide opens in a new tab, safely', async (t) => {
  setup(t)
  const ui = await mount(AGENT)

  // target=_blank without rel=noopener hands the opened page a handle back to ours.
  const links = ui.all((f) => f.type === 'a' && f.props?.href === '/setup-guide')
  assert.equal(links.length, 2, 'the card and the inline link')
  for (const link of links) {
    assert.equal(link.props.target, '_blank')
    assert.match(link.props.rel, /noopener/)
    assert.match(link.props.rel, /noreferrer/)
  }
})
