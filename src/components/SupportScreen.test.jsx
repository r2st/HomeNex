// The support screen: raise a request, read the thread, and check what the plan costs.
//
// This is the screen an agent opens when something is *already* wrong, which sets the
// bar for its own failure modes: a request that silently doesn't send, a thread that
// renders blank, or a plan panel that shows nothing at all are each worse here than
// anywhere else in the app. Both loads on this screen used to swallow their error into
// an empty catch and sit in a state indistinguishable from "still loading" — so the
// half of this file that matters most is the one pinning loading, empty and failed
// apart from each other.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, click, type, keyDown } from '../test/render.jsx'
import { installBrowser, mockFetch } from '../test/browserEnv.js'
import SupportScreen from './SupportScreen.jsx'

const TICKETS = [
  { id: 1, subject: 'WhatsApp number not verified', status: 'pending', category: 'whatsapp', updated_at: new Date(Date.now() - 3600_000).toISOString() },
  { id: 2, subject: 'Invoice for June', status: 'closed', category: 'billing', updated_at: new Date(Date.now() - 86_400_000).toISOString() },
]

const THREAD = {
  id: 1,
  subject: 'WhatsApp number not verified',
  status: 'pending',
  category: 'whatsapp',
  messages: [
    { id: 11, is_staff: 0, body: 'My number has been pending for two days.', created_at: new Date(Date.now() - 7200_000).toISOString() },
    { id: 12, is_staff: 1, body: 'Checking with Meta now — we will update you.', created_at: new Date(Date.now() - 3600_000).toISOString() },
  ],
}

const BILLING = {
  subscription: { plan_name: 'Growth', price_paise: 199_900, conversation_quota: 1000 },
  usage: { total_conversations: 342 },
  invoices: [
    { id: 501, number: 'INV-2026-001', status: 'paid', total_paise: 199_900 },
    { id: 502, number: 'INV-2026-002', status: 'issued', total_paise: 199_900 },
  ],
}

function setup(t, routes = {}) {
  const env = installBrowser()
  const net = mockFetch({
    '/api/support/tickets': TICKETS,
    '/api/billing': BILLING,
    '/api/support/tickets/1': THREAD,
    ...routes,
  })
  t.after(() => {
    net.restore()
    env.restore()
  })
  return net
}

const billingTab = (ui) => click(ui.byRole('button', { name: 'Plan & billing' }))

// --- The request list -------------------------------------------------------

test('each request is listed with its subject, status and category in plain words', async (t) => {
  setup(t)
  const ui = await render(<SupportScreen />)
  const text = ui.text()

  assert.match(text, /WhatsApp number not verified/)
  // Never a raw slug: 'pending' is "Waiting on us", 'whatsapp' is "WhatsApp number".
  assert.match(text, /Waiting on us/)
  assert.match(text, /WhatsApp number ·/)
  assert.match(text, /Invoice for June/)
  assert.match(text, /Closed/)
})

test('no requests yet is said only once the list has actually loaded', async (t) => {
  setup(t, { '/api/support/tickets': [] })
  const ui = await render(<SupportScreen />)

  assert.match(ui.text(), /No support requests yet/)
})

test('a list still loading says so rather than looking empty', async (t) => {
  setup(t, { '/api/support/tickets': () => new Promise(() => {}) })
  const ui = await render(<SupportScreen />)

  assert.match(ui.text(), /Loading your support requests…/)
  assert.doesNotMatch(ui.text(), /No support requests yet/)
})

test('a list that failed to load says why, and does not claim there are none', async (t) => {
  setup(t, { '/api/support/tickets': { status: 500, body: { error: 'support is down' } } })
  const ui = await render(<SupportScreen />)

  assert.match(ui.text(), /Can't load your support requests/)
  assert.doesNotMatch(ui.text(), /No support requests yet/)
  assert.doesNotMatch(ui.text(), /Loading your support requests…/)
})

// --- Raising a request ------------------------------------------------------

test('the new-request form is behind a button, and opens on demand', async (t) => {
  setup(t)
  const ui = await render(<SupportScreen />)

  assert.equal(ui.queryByLabel('Subject'), null)
  await click(ui.byRole('button', { name: '+ New support request' }))
  assert.ok(ui.byLabel('Subject'))
})

test('sending a request posts what was typed and reloads the list', async (t) => {
  const net = setup(t, { 'POST /api/support/tickets': { id: 3 } })
  const ui = await render(<SupportScreen />)
  await click(ui.byRole('button', { name: '+ New support request' }))

  await type(ui.byLabel('Subject'), 'Cannot send templates')
  await type(ui.byLabel('How can we help?'), 'Every template send returns an error.')
  await click(ui.byRole('button', { name: 'Send' }))

  const [call] = net.to('/api/support/tickets', 'POST')
  assert.deepEqual(call.body, {
    subject: 'Cannot send templates',
    body: 'Every template send returns an error.',
    category: 'general',
  })
  assert.ok(net.to('/api/support/tickets', 'GET').length >= 2, 'the list is re-read so the new request appears')
  assert.equal(ui.queryByLabel('Subject'), null, 'and the form closes')
})

test('the category picker is sent as its slug, not its label', async (t) => {
  const net = setup(t, { 'POST /api/support/tickets': { id: 3 } })
  const ui = await render(<SupportScreen />)
  await click(ui.byRole('button', { name: '+ New support request' }))

  await type(ui.byLabel('Subject'), 'Billing question')
  await type(ui.byLabel('How can we help?'), 'Please explain this invoice.')
  await type(ui.byLabel('Category'), 'billing')
  await click(ui.byRole('button', { name: 'Send' }))

  assert.equal(net.to('/api/support/tickets', 'POST')[0].body.category, 'billing')
})

test('Send stays disabled until both the subject and the body are filled in', async (t) => {
  const net = setup(t, { 'POST /api/support/tickets': { id: 3 } })
  const ui = await render(<SupportScreen />)
  await click(ui.byRole('button', { name: '+ New support request' }))

  const send = () => ui.byRole('button', { name: 'Send' })
  assert.equal(send().props.disabled, true, 'empty')

  await type(ui.byLabel('Subject'), 'Only a subject')
  assert.equal(send().props.disabled, true, 'a subject with no body is not a request')

  // Whitespace is not a body — a request with nothing in it wastes a support round trip.
  await type(ui.byLabel('How can we help?'), '   ')
  assert.equal(send().props.disabled, true)

  await click(send())
  assert.deepEqual(net.to('/api/support/tickets', 'POST'), [])
})

test('a request that fails to send says so and keeps what was typed', async (t) => {
  setup(t, { 'POST /api/support/tickets': { status: 500, body: { error: 'could not reach support' } } })
  const ui = await render(<SupportScreen />)
  await click(ui.byRole('button', { name: '+ New support request' }))

  await type(ui.byLabel('Subject'), 'Cannot send templates')
  await type(ui.byLabel('How can we help?'), 'Every template send returns an error.')
  await click(ui.byRole('button', { name: 'Send' }))

  assert.match(ui.text(), /could not reach support/)
  // Losing the typed body on a failed send is the worst outcome here: the agent has
  // to write the whole thing again on the screen they came to because of a problem.
  assert.equal(ui.byLabel('Subject').props.value, 'Cannot send templates')
  assert.equal(ui.byLabel('How can we help?').props.value, 'Every template send returns an error.')
})

test('cancelling closes the form', async (t) => {
  setup(t)
  const ui = await render(<SupportScreen />)
  await click(ui.byRole('button', { name: '+ New support request' }))
  await click(ui.byRole('button', { name: 'Cancel' }))

  assert.equal(ui.queryByLabel('Subject'), null)
  assert.ok(ui.byRole('button', { name: '+ New support request' }))
})

// --- The thread -------------------------------------------------------------

test('opening a request shows the conversation, with each side attributed', async (t) => {
  setup(t)
  const ui = await render(<SupportScreen />)

  await click(ui.byText('WhatsApp number not verified'))

  const text = ui.text()
  assert.match(text, /My number has been pending for two days/)
  assert.match(text, /Checking with Meta now/)
  // Who said what is the whole point of a thread view.
  assert.match(text, /You ·/)
  assert.match(text, /HomeNex support ·/)
})

test('replying posts the trimmed text and re-reads the thread', async (t) => {
  const net = setup(t, { 'POST /api/support/tickets/1/reply': { ok: true } })
  const ui = await render(<SupportScreen />)
  await click(ui.byText('WhatsApp number not verified'))

  await type(ui.byLabel('Reply to HomeNex support'), '  any update?  ')
  await click(ui.byRole('button', { name: 'Send' }))

  assert.deepEqual(net.to('/api/support/tickets/1/reply', 'POST')[0].body, { body: 'any update?' })
  assert.equal(ui.byLabel('Reply to HomeNex support').props.value, '', 'the box is cleared')
  assert.ok(net.to('/api/support/tickets/1', 'GET').length >= 2, 'the reply appears without a manual refresh')
})

test('Enter sends the reply', async (t) => {
  const net = setup(t, { 'POST /api/support/tickets/1/reply': { ok: true } })
  const ui = await render(<SupportScreen />)
  await click(ui.byText('WhatsApp number not verified'))

  await type(ui.byLabel('Reply to HomeNex support'), 'any update?')
  await keyDown(ui.byLabel('Reply to HomeNex support'), 'Enter')

  assert.equal(net.to('/api/support/tickets/1/reply', 'POST').length, 1)
})

test('an empty reply is not sent', async (t) => {
  const net = setup(t, { 'POST /api/support/tickets/1/reply': { ok: true } })
  const ui = await render(<SupportScreen />)
  await click(ui.byText('WhatsApp number not verified'))

  await click(ui.byRole('button', { name: 'Send' }))
  await type(ui.byLabel('Reply to HomeNex support'), '   ')
  await keyDown(ui.byLabel('Reply to HomeNex support'), 'Enter')

  assert.deepEqual(net.to('/api/support/tickets/1/reply', 'POST'), [])
})

test('a closed request cannot be replied to', async (t) => {
  setup(t, { '/api/support/tickets/1': { ...THREAD, status: 'closed' } })
  const ui = await render(<SupportScreen />)
  await click(ui.byText('WhatsApp number not verified'))

  assert.match(ui.text(), /Closed/)
  assert.equal(ui.queryByLabel('Reply to HomeNex support'), null, 'no reply box on a closed thread')
})

test('going back returns to the list and refreshes it', async (t) => {
  const net = setup(t)
  const ui = await render(<SupportScreen />)
  await click(ui.byText('WhatsApp number not verified'))

  await click(ui.byText('← All requests'))

  assert.match(ui.text(), /Invoice for June/, 'the list is back')
  assert.ok(net.to('/api/support/tickets', 'GET').length >= 2, 'and re-read, so a new reply updates its row')
})

test('a thread that fails to load leaves the screen rather than rendering a blank one', async (t) => {
  setup(t, { '/api/support/tickets/1': { status: 500, body: { error: 'gone' } } })
  const ui = await render(<SupportScreen />)

  await click(ui.byText('WhatsApp number not verified'))
  assert.equal(ui.text(), '', 'nothing is asserted to be true about a ticket that could not be read')
})

// --- Plan & billing ---------------------------------------------------------

test('the billing tab names the plan, its price and the quota', async (t) => {
  setup(t)
  const ui = await render(<SupportScreen />)
  await billingTab(ui)

  const text = ui.text()
  assert.match(text, /Growth/)
  assert.match(text, /₹1,999\/mo/, 'paise are rendered as rupees, grouped Indian-style')
  assert.match(text, /1000 conversations/)
  assert.match(text, /342 conversations used of 1000/)
})

test('one conversation is not "1 conversations"', async (t) => {
  setup(t, { '/api/billing': { ...BILLING, usage: { total_conversations: 1 } } })
  const ui = await render(<SupportScreen />)
  await billingTab(ui)

  assert.match(ui.text(), /1 conversation used/)
})

test('an agent with no plan is told that, not shown a blank card', async (t) => {
  setup(t, { '/api/billing': { subscription: null, usage: { total_conversations: 12 }, invoices: [] } })
  const ui = await render(<SupportScreen />)
  await billingTab(ui)

  assert.match(ui.text(), /No plan assigned/)
  assert.match(ui.text(), /12 conversations used/)
  assert.doesNotMatch(ui.text(), / of /, 'no quota to measure against, so none is implied')
})

test('an unlimited plan says unlimited rather than showing nothing', async (t) => {
  setup(t, {
    '/api/billing': { ...BILLING, subscription: { ...BILLING.subscription, conversation_quota: null } },
  })
  const ui = await render(<SupportScreen />)
  await billingTab(ui)

  assert.match(ui.text(), /unlimited conversations/)
})

test('invoices are listed with their number and total', async (t) => {
  setup(t)
  const ui = await render(<SupportScreen />)
  await billingTab(ui)

  assert.match(ui.text(), /INV-2026-001/)
  assert.match(ui.text(), /INV-2026-002/)
  assert.equal(ui.text().match(/₹1,999/g).length, 3, 'the plan price plus both invoice totals')
})

test('a billing panel still loading says so', async (t) => {
  setup(t, { '/api/billing': () => new Promise(() => {}) })
  const ui = await render(<SupportScreen />)
  await billingTab(ui)

  assert.match(ui.text(), /Loading your plan…/)
})

test('a billing panel that failed says why instead of rendering nothing at all', async (t) => {
  setup(t, { '/api/billing': { status: 500, body: { error: 'billing is away' } } })
  const ui = await render(<SupportScreen />)
  await billingTab(ui)

  // The whole panel is gated on `billing &&`, so before this the tab was simply blank
  // — on the screen an agent opens precisely because something is already wrong.
  assert.match(ui.text(), /Can't load your plan right now: billing is away/)
  assert.doesNotMatch(ui.text(), /Loading your plan…/)
})
