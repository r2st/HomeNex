// The 10-second walk-in capture. This is the first thing an agent touches when a
// buyer walks into the office, so the failure modes that matter are: losing the
// lead to a silent error, and opening WhatsApp without having saved anything.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, click, change } from '../test/render.jsx'
import { installBrowser, mockFetch } from '../test/browserEnv.js'
import QuickAddLead from './QuickAddLead.jsx'

const LEAD = { id: 7, name: 'Priya Sharma', phone: '+919876543210' }
const OK = { lead: LEAD, wa_deeplink: 'https://wa.me/919876543210' }

function setup(t, routes = { 'POST /api/leads/quick-add': OK }) {
  const env = installBrowser()
  const net = mockFetch(routes)
  const added = []
  let closed = 0
  t.after(() => {
    net.restore()
    env.restore()
  })
  return { env, net, added, closed: () => closed, props: { onAdded: (l) => added.push(l), onClose: () => closed++ } }
}

test('an empty phone number is refused before any request goes out', async (t) => {
  const { net, props } = setup(t)
  const ui = await render(<QuickAddLead {...props} />)

  await click(ui.byText('Save', { exact: true }))

  assert.match(ui.text(), /Enter the buyer’s phone number/)
  assert.equal(net.calls.length, 0, 'no lead should be created without a phone number')
})

test('whitespace-only phone is refused too', async (t) => {
  const { net, props } = setup(t)
  const ui = await render(<QuickAddLead {...props} />)

  await change(ui.byPlaceholder('98765 43210'), '   ')
  await click(ui.byText('Save', { exact: true }))

  assert.match(ui.text(), /Enter the buyer’s phone number/)
  assert.equal(net.calls.length, 0)
})

test('Save creates the lead, reports it upward and closes the sheet', async (t) => {
  const ctx = setup(t)
  const ui = await render(<QuickAddLead {...ctx.props} />)

  await change(ui.byPlaceholder('98765 43210'), ' 9876543210 ')
  await change(ui.byPlaceholder('Buyer name'), ' Priya Sharma ')
  await click(ui.byText('Save', { exact: true }))

  const [call] = ctx.net.to('/api/leads/quick-add', 'POST')
  assert.deepEqual(call.body, { phone: '9876543210', name: 'Priya Sharma', channel: 'walk_in', tags: [] })
  assert.deepEqual(ctx.added, [LEAD])
  assert.equal(ctx.closed(), 1)
})

test('a blank name is sent as null rather than an empty string', async (t) => {
  const ctx = setup(t)
  const ui = await render(<QuickAddLead {...ctx.props} />)

  await change(ui.byPlaceholder('98765 43210'), '9876543210')
  await click(ui.byText('Save', { exact: true }))

  assert.equal(ctx.net.to('/api/leads/quick-add')[0].body.name, null)
})

test('quick tags toggle on and off and travel with the lead', async (t) => {
  const ctx = setup(t)
  const ui = await render(<QuickAddLead {...ctx.props} />)

  await change(ui.byPlaceholder('98765 43210'), '9876543210')
  await click(ui.byText('Hot', { exact: true }))
  await click(ui.byText('3 BHK', { exact: true }))
  await click(ui.byText('Investor', { exact: true }))
  await click(ui.byText('Investor', { exact: true })) // tapped by mistake, tapped again
  await click(ui.byText('Save', { exact: true }))

  assert.deepEqual(ctx.net.to('/api/leads/quick-add')[0].body.tags, ['Hot', '3 BHK'])
})

test('the channel chip switches the lead between walk-in and phone', async (t) => {
  const ctx = setup(t)
  const ui = await render(<QuickAddLead {...ctx.props} />)

  await change(ui.byPlaceholder('98765 43210'), '9876543210')
  await click(ui.byText('📞 Phone'))
  await click(ui.byText('Save', { exact: true }))

  assert.equal(ctx.net.to('/api/leads/quick-add')[0].body.channel, 'phone')
})

test('Save & open WhatsApp opens the thread returned by the server', async (t) => {
  const ctx = setup(t)
  const ui = await render(<QuickAddLead {...ctx.props} />)

  await change(ui.byPlaceholder('98765 43210'), '9876543210')
  await click(ui.byText('Save & open WhatsApp'))

  assert.deepEqual(ctx.env.opened, [{ url: 'https://wa.me/919876543210', name: '_blank', features: 'noopener' }])
  assert.equal(ctx.closed(), 1)
})

test('plain Save never opens WhatsApp', async (t) => {
  const ctx = setup(t)
  const ui = await render(<QuickAddLead {...ctx.props} />)

  await change(ui.byPlaceholder('98765 43210'), '9876543210')
  await click(ui.byText('Save', { exact: true }))

  assert.deepEqual(ctx.env.opened, [])
})

test('a lead saved without a deeplink does not open a blank window', async (t) => {
  const ctx = setup(t, { 'POST /api/leads/quick-add': { lead: LEAD, wa_deeplink: null } })
  const ui = await render(<QuickAddLead {...ctx.props} />)

  await change(ui.byPlaceholder('98765 43210'), '9876543210')
  await click(ui.byText('Save & open WhatsApp'))

  assert.deepEqual(ctx.env.opened, [], 'window.open(null) would show the agent a blank tab')
  assert.equal(ctx.closed(), 1, 'the lead was still saved, so the sheet should close')
})

test('a server error is shown in plain language and the sheet stays open', async (t) => {
  const ctx = setup(t, {
    'POST /api/leads/quick-add': { status: 409, body: { error: 'This lead already exists' } },
  })
  const ui = await render(<QuickAddLead {...ctx.props} />)

  await change(ui.byPlaceholder('98765 43210'), '9876543210')
  await click(ui.byText('Save', { exact: true }))

  assert.match(ui.text(), /already exists/)
  assert.equal(ctx.closed(), 0, 'closing on failure would silently drop the lead')
  assert.deepEqual(ctx.added, [])
})

test('after a failed save the buttons are usable again for a retry', async (t) => {
  const ctx = setup(t, {
    'POST /api/leads/quick-add': ({ body }) =>
      body.phone === '9876543210' ? { status: 500, body: {} } : OK,
  })
  const ui = await render(<QuickAddLead {...ctx.props} />)

  await change(ui.byPlaceholder('98765 43210'), '9876543210')
  await click(ui.byText('Save', { exact: true }))
  assert.equal(ui.byText('Save', { exact: true }).props.disabled, false)

  await change(ui.byPlaceholder('98765 43210'), '9000000000')
  await click(ui.byText('Save', { exact: true }))
  assert.equal(ctx.closed(), 1, 'the retry should go through')
})

test('the sheet backdrop closes the form', async (t) => {
  const ctx = setup(t)
  const ui = await render(<QuickAddLead {...ctx.props} />)

  // The backdrop is the only element in the sheet wired to close on click.
  const backdrop = ui.get((f) => f.type === 'div' && String(f.props.className).includes('absolute inset-0'), 'backdrop')
  await click(backdrop)

  assert.equal(ctx.closed(), 1)
})
