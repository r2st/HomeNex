// Sign-in & security: the login number and the password.
//
// This is the one card where getting it wrong locks the agent out of their own
// business. Two behaviours carry that risk and are pinned hard here.
//
// The first is the token swap on a password change. The server rotates the agent's
// token version — which is what signs out their other devices — and hands this one a
// token signed with the new version. If the card forgets to store it, the very next
// poll 401s and the agent who just changed their password is thrown out too.
//
// The second is the country code. The number is assembled here, and an agent who
// clears the prefix must not end up registered as a bare 10-digit login they can
// never type again.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, click, change, submit } from '../test/render.jsx'
import { installBrowser, mockFetch } from '../test/browserEnv.js'
import { getToken } from '../api.js'
import SecurityCard from './SecurityCard.jsx'

const AGENT = { id: 1, name: 'Rohit Sharma', phone: '+919876543210' }

function setup(t, routes = {}) {
  const env = installBrowser()
  const net = mockFetch({
    'PUT /api/agent/phone': (call) => ({ ...AGENT, phone: call.body.phone }),
    'PUT /api/agent/password': { token: 'fresh.token.value' },
    ...routes,
  })
  t.after(() => {
    net.restore()
    env.restore()
  })
  return { env, net }
}

// The two "Change" buttons are identical in text, so index them by the section they
// sit in: phone first, password second.
const changeButtons = (ui) => ui.allByText('Change', { exact: true, selector: 'button' })
const openPhone = async (ui) => click(changeButtons(ui)[0])
const openPassword = async (ui) => click(changeButtons(ui)[1])
const formOf = (ui) => ui.get((f) => f.type === 'form', 'an open form')

// --- The card at rest -------------------------------------------------------

test('the card shows the login number and masks the password', async (t) => {
  setup(t)
  const ui = await render(<SecurityCard agent={AGENT} onSaved={() => {}} />)

  assert.match(ui.text(), /\+919876543210/)
  assert.match(ui.text(), /••••/, 'the password placeholder is missing')
  assert.doesNotMatch(ui.text(), /secret|password123/i)
  assert.equal(changeButtons(ui).length, 2, 'both sections should offer a Change')
})

test('neither form is open until asked for', async (t) => {
  setup(t)
  const ui = await render(<SecurityCard agent={AGENT} onSaved={() => {}} />)

  assert.equal(ui.query((f) => f.type === 'form'), null)
})

// --- Changing the WhatsApp number -------------------------------------------

test('the number form will not submit until there is a number and a password', async (t) => {
  const { net } = setup(t)
  const ui = await render(<SecurityCard agent={AGENT} onSaved={() => {}} />)
  await openPhone(ui)

  const update = ui.byText(/Update number|Saving/, { selector: 'button' })
  assert.equal(update.props.disabled, true, 'an empty form offered to submit')

  // A number alone is not enough — the change is password-gated server-side, and a
  // form that submits without one just earns a 400.
  await change(ui.byLabel('New WhatsApp number'), '9812345678')
  assert.equal(ui.byText(/Update number/, { selector: 'button' }).props.disabled, true)

  await change(ui.byLabel('Current password'), 'secret123')
  assert.equal(ui.byText(/Update number/, { selector: 'button' }).props.disabled, false)

  await submit(formOf(ui))
  assert.equal(net.to('/api/agent/phone', 'PUT').length, 1)
})

test('a number shorter than an international minimum is refused before it is sent', async (t) => {
  const { net } = setup(t)
  const ui = await render(<SecurityCard agent={AGENT} onSaved={() => {}} />)
  await openPhone(ui)

  await change(ui.byLabel('New WhatsApp number'), '12345')
  await change(ui.byLabel('Current password'), 'secret123')
  await submit(formOf(ui))

  assert.equal(net.to('/api/agent/phone', 'PUT').length, 0, 'a five-digit login was sent')
})

test('the country code is prepended, and non-digits in it are dropped', async (t) => {
  const { net } = setup(t)
  const ui = await render(<SecurityCard agent={AGENT} onSaved={() => {}} />)
  await openPhone(ui)

  await change(ui.byLabel('Country code'), '+971abc')
  await change(ui.byLabel('New WhatsApp number'), '501234567')
  await change(ui.byLabel('Current password'), 'secret123')
  await submit(formOf(ui))

  assert.equal(net.to('/api/agent/phone', 'PUT')[0].body.phone, '+971501234567')
})

test('clearing the country code falls back to +91 rather than sending a bare number', async (t) => {
  // An agent who selects the prefix and hits backspace must not end up with a login
  // they can never type again.
  const { net } = setup(t)
  const ui = await render(<SecurityCard agent={AGENT} onSaved={() => {}} />)
  await openPhone(ui)

  await change(ui.byLabel('Country code'), '')
  await change(ui.byLabel('New WhatsApp number'), '9812345678')
  await change(ui.byLabel('Current password'), 'secret123')
  await submit(formOf(ui))

  assert.equal(net.to('/api/agent/phone', 'PUT')[0].body.phone, '+919812345678')
})

test('letters typed into the number are dropped, not sent', async (t) => {
  const { net } = setup(t)
  const ui = await render(<SecurityCard agent={AGENT} onSaved={() => {}} />)
  await openPhone(ui)

  await change(ui.byLabel('New WhatsApp number'), '98-1234 5678')
  await change(ui.byLabel('Current password'), 'secret123')
  await submit(formOf(ui))

  assert.equal(net.to('/api/agent/phone', 'PUT')[0].body.phone, '+919812345678')
})

test('a changed number closes the form and says which number to log in with', async (t) => {
  const { net } = setup(t)
  const saved = []
  const ui = await render(<SecurityCard agent={AGENT} onSaved={(a) => saved.push(a)} />)
  await openPhone(ui)

  await change(ui.byLabel('New WhatsApp number'), '9812345678')
  await change(ui.byLabel('Current password'), 'secret123')
  await submit(formOf(ui))

  assert.equal(saved.length, 1, 'the parent was not handed the updated agent')
  assert.equal(saved[0].phone, '+919812345678')
  assert.equal(ui.query((f) => f.type === 'form'), null, 'the form stayed open after a success')
  assert.match(ui.text(), /\+919812345678/)
  assert.match(ui.text(), /log in/i, 'the agent was not told the number is now their login')
  assert.equal(net.to('/api/agent/phone', 'PUT')[0].body.password, 'secret123')
})

test('a rejected number change stays open with the reason and the typed number', async (t) => {
  setup(t, { 'PUT /api/agent/phone': { status: 403, body: { error: 'That password is not right' } } })
  const ui = await render(<SecurityCard agent={AGENT} onSaved={() => {}} />)
  await openPhone(ui)

  await change(ui.byLabel('New WhatsApp number'), '9812345678')
  await change(ui.byLabel('Current password'), 'wrongpass')
  await submit(formOf(ui))

  assert.match(ui.text(), /That password is not right/)
  assert.ok(ui.query((f) => f.type === 'form'), 'the form closed and lost what was typed')
  assert.equal(ui.byLabel('New WhatsApp number').props.value, '9812345678')
})

test('cancelling wipes the number form, including the password', async (t) => {
  setup(t)
  const ui = await render(<SecurityCard agent={AGENT} onSaved={() => {}} />)
  await openPhone(ui)

  await change(ui.byLabel('Country code'), '+44')
  await change(ui.byLabel('New WhatsApp number'), '9812345678')
  await change(ui.byLabel('Current password'), 'secret123')
  await click(ui.byText('Cancel', { selector: 'button' }))

  await openPhone(ui)
  assert.equal(ui.byLabel('New WhatsApp number').props.value, '')
  assert.equal(ui.byLabel('Current password').props.value, '')
  assert.equal(ui.byLabel('Country code').props.value, '+91', 'the country code was not reset')
})

// --- Changing the password --------------------------------------------------

test('the password form catches a typo in the confirmation before the server does', async (t) => {
  const { net } = setup(t)
  const ui = await render(<SecurityCard agent={AGENT} onSaved={() => {}} />)
  await openPassword(ui)

  await change(ui.byLabel('Current password'), 'oldsecret')
  await change(ui.byLabel('New password'), 'newsecret')
  await change(ui.byLabel('Confirm new password'), 'newsecrey')

  assert.match(ui.text(), /Passwords don't match/)
  assert.equal(ui.byText(/Update password/, { selector: 'button' }).props.disabled, true)

  await submit(formOf(ui))
  assert.equal(net.to('/api/agent/password', 'PUT').length, 0, 'a mistyped password was sent')
})

test('a password under the minimum length is named as too short, not just refused', async (t) => {
  setup(t)
  const ui = await render(<SecurityCard agent={AGENT} onSaved={() => {}} />)
  await openPassword(ui)

  await change(ui.byLabel('New password'), 'abc')
  assert.match(ui.text(), /At least 6 characters/)

  await change(ui.byLabel('New password'), 'abcdef')
  assert.doesNotMatch(ui.text(), /At least 6 characters/)
})

test('the mismatch warning is silent until the confirmation has been started', async (t) => {
  setup(t)
  const ui = await render(<SecurityCard agent={AGENT} onSaved={() => {}} />)
  await openPassword(ui)

  await change(ui.byLabel('New password'), 'newsecret')
  assert.doesNotMatch(ui.text(), /Passwords don't match/, 'scolded the agent for not having typed yet')
})

test('a password change stores the new token, or the agent signs themselves out', async (t) => {
  // The server rotates the token version to sign out every other device. This session
  // is handed a token signed with the new version; dropping it 401s the very next poll.
  const { net } = setup(t)
  const ui = await render(<SecurityCard agent={AGENT} onSaved={() => {}} />)
  await openPassword(ui)

  await change(ui.byLabel('Current password'), 'oldsecret')
  await change(ui.byLabel('New password'), 'newsecret')
  await change(ui.byLabel('Confirm new password'), 'newsecret')
  await submit(formOf(ui))

  assert.equal(getToken(), 'fresh.token.value', 'the rotated token was thrown away')
  assert.deepEqual(net.to('/api/agent/password', 'PUT')[0].body, {
    current_password: 'oldsecret',
    new_password: 'newsecret',
  })
  assert.match(ui.text(), /signed out everywhere else/i)
  assert.equal(ui.query((f) => f.type === 'form'), null, 'the form stayed open after a success')
})

test('a server that returns no token leaves the current one alone', async (t) => {
  // Older builds of the endpoint answered `{ ok: true }`. Clearing the token on that
  // answer would log the agent out for successfully changing their password.
  setup(t, { 'PUT /api/agent/password': { ok: true } })
  const { setToken } = await import('../api.js')
  setToken('existing.token')

  const ui = await render(<SecurityCard agent={AGENT} onSaved={() => {}} />)
  await openPassword(ui)
  await change(ui.byLabel('Current password'), 'oldsecret')
  await change(ui.byLabel('New password'), 'newsecret')
  await change(ui.byLabel('Confirm new password'), 'newsecret')
  await submit(formOf(ui))

  assert.equal(getToken(), 'existing.token')
  assert.match(ui.text(), /signed out everywhere else/i)
})

test('a wrong current password is reported, and does not end the session', async (t) => {
  // The server answers BAD_PASSWORD with 403, not 401, precisely because api.js treats
  // a 401 as "this session is over" — it drops the token and fires homenex-logout. If
  // this route ever returned 401, mistyping your old password would sign you out of
  // the app, which is why the status is asserted here and not just the message.
  setup(t, { 'PUT /api/agent/password': { status: 403, body: { error: 'Your current password is wrong' } } })
  const { setToken } = await import('../api.js')
  setToken('existing.token')
  const loggedOut = []
  globalThis.window.addEventListener('homenex-logout', () => loggedOut.push(1))

  const ui = await render(<SecurityCard agent={AGENT} onSaved={() => {}} />)
  await openPassword(ui)
  await change(ui.byLabel('Current password'), 'notmypassword')
  await change(ui.byLabel('New password'), 'newsecret')
  await change(ui.byLabel('Confirm new password'), 'newsecret')
  await submit(formOf(ui))

  assert.match(ui.text(), /Your current password is wrong/)
  assert.equal(getToken(), 'existing.token', 'a failed change swapped the token anyway')
  assert.deepEqual(loggedOut, [], 'a mistyped old password signed the agent out')
  assert.ok(ui.query((f) => f.type === 'form'), 'the form closed on a failure')
})

test('cancelling wipes all three password boxes', async (t) => {
  setup(t)
  const ui = await render(<SecurityCard agent={AGENT} onSaved={() => {}} />)
  await openPassword(ui)

  await change(ui.byLabel('Current password'), 'oldsecret')
  await change(ui.byLabel('New password'), 'newsecret')
  await change(ui.byLabel('Confirm new password'), 'newsecret')
  await click(ui.byText('Cancel', { selector: 'button' }))

  await openPassword(ui)
  for (const label of ['Current password', 'New password', 'Confirm new password']) {
    assert.equal(ui.byLabel(label).props.value, '', `${label} survived a cancel`)
  }
})

test('every secret box is a password field, so nothing is shoulder-readable', async (t) => {
  setup(t)
  const ui = await render(<SecurityCard agent={AGENT} onSaved={() => {}} />)
  await openPassword(ui)

  const boxes = ui.all((f) => f.type === 'input' && /password/i.test(f.props['aria-label'] ?? ''))
  assert.equal(boxes.length, 0, 'aria-labels are on the Field labels, not the inputs')
  const typed = ui.all((f) => f.type === 'input')
  assert.ok(typed.length >= 3)
  assert.ok(
    typed.every((f) => f.props.type === 'password'),
    'a secret was rendered as plain text',
  )
})
