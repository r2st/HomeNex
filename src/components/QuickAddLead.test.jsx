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

test('a save error is announced and tied to the field it is about', async (t) => {
  const ctx = setup(t, { 'POST /api/leads/quick-add': { status: 500, body: { error: 'Server exploded' } } })
  const ui = await render(<QuickAddLead {...ctx.props} />)

  const phone = ui.byPlaceholder('98765 43210')
  assert.equal(phone.props['aria-invalid'], undefined, 'a clean form must not read as invalid')
  assert.equal(phone.props['aria-describedby'], undefined)

  await change(phone, '9876543210')
  await click(ui.byText('Save', { exact: true }))

  // role="alert" is what makes the message reach a screen reader at all — without it
  // the agent hears nothing and the tap looks like it did nothing.
  const alert = ui.byRole('alert')
  assert.match(String(alert.props.children), /Server exploded/)
  assert.equal(ui.byPlaceholder('98765 43210').props['aria-invalid'], true)
  assert.equal(ui.byPlaceholder('98765 43210').props['aria-describedby'], alert.props.id)
  assert.ok(alert.props.id, 'the error needs an id for the field to point at')
})

test('the validation error is announced too, not just the network one', async (t) => {
  const ctx = setup(t)
  const ui = await render(<QuickAddLead {...ctx.props} />)

  await click(ui.byText('Save', { exact: true }))

  assert.match(String(ui.byRole('alert').props.children), /Enter the buyer’s phone number/)
})

test('both buttons show progress while the save is in flight', async (t) => {
  let release
  const ctx = setup(t, { 'POST /api/leads/quick-add': () => new Promise((r) => { release = () => r(OK) }) })
  const ui = await render(<QuickAddLead {...ctx.props} />)

  await change(ui.byPlaceholder('98765 43210'), '9876543210')
  const pending = click(ui.byText('Save', { exact: true }))

  // The plain Save button used to keep saying "Save" while disabled, which reads as
  // an unresponsive button rather than one that is working.
  assert.match(ui.text(), /Saving…/)
  assert.equal(ui.byText('Saving…', { exact: true }).props.disabled, true)

  release()
  await pending
})

test('a popup blocked by the browser still saves and closes the sheet', async (t) => {
  const ctx = setup(t)
  ctx.env.window.open = () => { throw new Error('popup blocked') }
  const ui = await render(<QuickAddLead {...ctx.props} />)

  await change(ui.byPlaceholder('98765 43210'), '9876543210')
  await click(ui.byText('💬 Save & open WhatsApp', { exact: true }))

  assert.deepEqual(ctx.added, [LEAD], 'the lead was created; a blocked popup must not hide it')
  assert.equal(ctx.closed(), 1)
})
