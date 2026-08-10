// Signup/login. The number typed here is both the login identity and the WhatsApp
// Business number buyers message, so the country-code handling and the exact phone
// string sent to the server are load-bearing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, click, change, submit } from '../test/render.jsx'
import { installBrowser, mockFetch } from '../test/browserEnv.js'
import { getToken } from '../api.js'
import AuthScreen from './AuthScreen.jsx'

const AGENT = { id: 1, name: 'Rajesh Kumar', phone: '+919876543210' }

function setup(t, routes) {
  const env = installBrowser()
  const net = mockFetch(routes)
  const authed = []
  t.after(() => {
    net.restore()
    env.restore()
  })
  return { env, net, authed, props: { onAuthed: (a) => authed.push(a) } }
}

const form = (ui) => ui.get((f) => f.type === 'form', 'form')
const phoneInput = (ui) => ui.byPlaceholder('98xxx xxxxx')
const ccInput = (ui) => ui.byLabel('Country code')
const passwordInput = (ui) => ui.get((f) => f.type === 'input' && (f.props.type === 'password' || f.props.autoComplete?.includes('password')), 'password input')

test('signup posts the country code joined to the local number', async (t) => {
  const ctx = setup(t, { 'POST /api/auth/signup': { token: 'tok-1', agent: AGENT } })
  const ui = await render(<AuthScreen {...ctx.props} />)

  await change(ui.byPlaceholder('Rajesh Kumar'), 'Rajesh Kumar')
  await change(phoneInput(ui), '9876543210')
  await change(passwordInput(ui), 'secret123')
  await submit(form(ui))

  assert.deepEqual(ctx.net.to('/api/auth/signup')[0].body, {
    phone: '+919876543210',
    password: 'secret123',
    name: 'Rajesh Kumar',
  })
  assert.deepEqual(ctx.authed, [AGENT])
  assert.equal(getToken(), 'tok-1', 'the session token should be stored on success')
})

test('the country code accepts an international dial code and keeps one +', async (t) => {
  const ctx = setup(t, { 'POST /api/auth/signup': { token: 't', agent: AGENT } })
  const ui = await render(<AuthScreen {...ctx.props} />)

  await change(ccInput(ui), '+971')
  await change(phoneInput(ui), '501234567')
  await change(passwordInput(ui), 'secret123')
  await submit(form(ui))

  assert.equal(ctx.net.to('/api/auth/signup')[0].body.phone, '+971501234567')
})

test('junk typed into the country code is stripped to digits, capped at four', async (t) => {
  const ctx = setup(t, {})
  const ui = await render(<AuthScreen {...ctx.props} />)

  await change(ccInput(ui), '++9 1abc')
  assert.equal(ccInput(ui).props.value, '+91')

  await change(ccInput(ui), '1234567')
  assert.equal(ccInput(ui).props.value, '+1234')
})

test('the phone field ignores spaces and dashes agents habitually type', async (t) => {
  const ctx = setup(t, {})
  const ui = await render(<AuthScreen {...ctx.props} />)

  await change(phoneInput(ui), '98765-43210')
  assert.equal(phoneInput(ui).props.value, '9876543210')

  await change(phoneInput(ui), '9876543210999999')
  assert.equal(phoneInput(ui).props.value, '987654321099', 'capped at 12 digits')
})

test('an emptied country code still sends the +91 default', async (t) => {
  const ctx = setup(t, { 'POST /api/auth/signup': { token: 't', agent: AGENT } })
  const ui = await render(<AuthScreen {...ctx.props} />)

  await change(ccInput(ui), '')
  await change(phoneInput(ui), '9876543210')
  await change(passwordInput(ui), 'secret123')
  await submit(form(ui))

  // "+" alone is falsy-ish only as a string; the component falls back to +91.
  assert.match(ctx.net.to('/api/auth/signup')[0].body.phone, /^\+\d/)
})

test('switching to log in drops the name field and posts to the login route', async (t) => {
  const ctx = setup(t, { 'POST /api/auth/login': { token: 'tok-2', agent: AGENT } })
  const ui = await render(<AuthScreen {...ctx.props} />)

  await click(ui.byText('Already have an account? Log in'))
  assert.equal(ui.queryByPlaceholder('Rajesh Kumar'), null, 'login should not ask for a name')
  assert.match(ui.text(), /Welcome back/)

  await change(phoneInput(ui), '9876543210')
  await change(passwordInput(ui), 'secret123')
  await submit(form(ui))

  assert.equal(ctx.net.to('/api/auth/signup').length, 0)
  assert.deepEqual(ctx.net.to('/api/auth/login')[0].body, { phone: '+919876543210', password: 'secret123' })
})

test('a rejected login shows the server message and keeps no token', async (t) => {
  const ctx = setup(t, { 'POST /api/auth/login': { status: 401, body: { error: 'Wrong phone number or password' } } })
  const ui = await render(<AuthScreen {...ctx.props} />)

  await click(ui.byText('Already have an account? Log in'))
  await change(phoneInput(ui), '9876543210')
  await change(passwordInput(ui), 'nope')
  await submit(form(ui))

  assert.match(ui.text(), /Wrong phone number or password/)
  assert.deepEqual(ctx.authed, [])
  assert.equal(getToken(), null)
})

test('the submit button is re-enabled after a failure so the agent can retry', async (t) => {
  const ctx = setup(t, { 'POST /api/auth/signup': { status: 500, body: {} } })
  const ui = await render(<AuthScreen {...ctx.props} />)

  await change(phoneInput(ui), '9876543210')
  await change(passwordInput(ui), 'secret123')
  await submit(form(ui))

  assert.equal(ui.byRole('button', { name: 'Create my dashboard' }).props.disabled, false)
})

test('toggling modes clears a stale error message', async (t) => {
  const ctx = setup(t, { 'POST /api/auth/signup': { status: 400, body: { error: 'Password too short' } } })
  const ui = await render(<AuthScreen {...ctx.props} />)

  await change(phoneInput(ui), '9876543210')
  await change(passwordInput(ui), 'abc')
  await submit(form(ui))
  assert.match(ui.text(), /Password too short/)

  await click(ui.byText('Already have an account? Log in'))
  assert.doesNotMatch(ui.text(), /Password too short/)
})

test('the eye toggle reveals and re-hides the password', async (t) => {
  const ctx = setup(t, {})
  const ui = await render(<AuthScreen {...ctx.props} />)

  assert.equal(passwordInput(ui).props.type, 'password')
  await click(ui.byLabel('Show password'))
  assert.equal(passwordInput(ui).props.type, 'text')
  await click(ui.byLabel('Hide password'))
  assert.equal(passwordInput(ui).props.type, 'password')
})

test('a double submit does not fire two signups', async (t) => {
  let resolveSignup
  const pending = new Promise((resolve) => {
    resolveSignup = resolve
  })
  const ctx = setup(t, { 'POST /api/auth/signup': () => pending.then(() => ({ token: 't', agent: AGENT })) })
  const ui = await render(<AuthScreen {...ctx.props} />)

  await change(phoneInput(ui), '9876543210')
  await change(passwordInput(ui), 'secret123')
  await submit(form(ui))
  await submit(form(ui))
  resolveSignup()

  assert.equal(ctx.net.to('/api/auth/signup').length, 1, 'an impatient double-tap must not create two accounts')
})
