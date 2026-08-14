// The lead-source hub: the portal ingest email, the captured-leads feed, and the
// "Advanced" drawer holding the portal connection keys, the ad form mapping and the
// one destructive action on the screen.
//
// This screen is where a broker's leads come from, so the failures that matter are the
// ones that quietly cost a lead: an ingest address the agent thinks they copied but
// didn't, a feed that says "no captured leads yet" when the request actually failed
// (that sentence is a claim about their portal setup, and a wrong one sends them to
// support), and a regenerate button that swaps the address without the agent
// understanding that every portal now points at a dead one.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, click, type } from '../test/render.jsx'
import { installBrowser, mockFetch } from '../test/browserEnv.js'
import LeadSourcesScreen from './LeadSourcesScreen.jsx'

const SOURCES = {
  ingest_email: 'lead-a1b2c3@homenex.in',
  events: [
    {
      id: 1,
      channel: 'portal_email',
      portal: '99acres',
      lead_name: 'Anita Desai',
      status: 'lead_created',
      auto_reply_status: 'sent',
      created_at: new Date(Date.now() - 3600_000).toISOString(),
    },
    {
      id: 2,
      channel: 'meta_lead_ad',
      portal: null,
      lead_name: null,
      contact_name: 'Rahul Verma',
      status: 'received',
      auto_reply_status: null,
      created_at: new Date(Date.now() - 7200_000).toISOString(),
    },
    {
      id: 3,
      channel: 'walk_in',
      portal: null,
      lead_name: null,
      contact_name: null,
      contact_phone: '+919812345678',
      status: 'failed',
      created_at: new Date(Date.now() - 86_400_000).toISOString(),
    },
  ],
}

const PORTALS = [
  { portal: '99acres', enabled: true, has_api_key: true },
  { portal: 'magicbricks', enabled: false, has_api_key: false },
]

function setup(t, routes = {}) {
  const env = installBrowser()
  const net = mockFetch({
    '/api/lead-sources': SOURCES,
    '/api/portal-integrations': PORTALS,
    ...routes,
  })
  t.after(() => {
    net.restore()
    env.restore()
  })
  return { net, env }
}

const openAdvanced = async (ui) => click(ui.byText('ADVANCED SETTINGS'))

// --- The ingest email -------------------------------------------------------

test('the ingest address is shown, and copying it puts that exact string on the clipboard', async (t) => {
  const { env } = setup(t)
  const ui = await render(<LeadSourcesScreen />)

  assert.match(ui.text(), /lead-a1b2c3@homenex\.in/)

  await click(ui.byRole('button', { name: 'Copy' }))
  // The whole feature is "paste this into 99acres". Copying anything other than the
  // address verbatim — a truncated render, a label, the placeholder — silently sends
  // the agent's portal leads nowhere.
  assert.deepEqual(env.copied, ['lead-a1b2c3@homenex.in'])
})

test('the copy button confirms it worked, because nothing else on screen changes', async (t) => {
  setup(t)
  const ui = await render(<LeadSourcesScreen />)

  await click(ui.byRole('button', { name: 'Copy' }))
  assert.match(ui.text(), /✓ Copied/)
})

test('a blocked clipboard does not claim the address was copied', async (t) => {
  const { env } = setup(t)
  env.navigator.clipboard.writeText = async () => {
    throw new Error('clipboard permission denied')
  }
  const ui = await render(<LeadSourcesScreen />)

  await click(ui.byRole('button', { name: 'Copy' }))
  // A "✓ Copied" over an empty clipboard is worse than no feedback: the agent pastes
  // whatever was there before into their portal settings and never checks again.
  assert.doesNotMatch(ui.text(), /✓ Copied/)
  assert.match(ui.text(), /Copy/)
})

test('the address placeholder is shown while the first request is still in flight', async (t) => {
  setup(t, { '/api/lead-sources': () => new Promise(() => {}) })
  const ui = await render(<LeadSourcesScreen />)

  assert.match(ui.text(), /…/, 'an ellipsis, not an empty code block or the word undefined')
})

// --- The captured-leads feed ------------------------------------------------

test('each captured lead names its channel, its status and who it was', async (t) => {
  setup(t)
  const ui = await render(<LeadSourcesScreen />)
  const text = ui.text()

  assert.match(text, /Anita Desai/)
  assert.match(text, /99acres/)
  assert.match(text, /Portal email/)
  // The ad lead has no lead_name, so the contact name is the fallback...
  assert.match(text, /Rahul Verma/)
  assert.match(text, /Facebook \/ Instagram ad/)
  // ...and the walk-in has neither, so the phone number is what identifies the row.
  assert.match(text, /\+919812345678/)
  assert.match(text, /Walk-in/)
})

test('a lead that got its instant reply says so', async (t) => {
  setup(t)
  const ui = await render(<LeadSourcesScreen />)

  // "replied" is the whole promise of portal ingestion — the buyer heard back within
  // seconds. Only the first event was actually replied to.
  assert.equal(ui.text().match(/· replied/g).length, 1)
})

test('an unknown channel falls back to its raw name rather than rendering nothing', async (t) => {
  setup(t, {
    '/api/lead-sources': {
      ingest_email: 'lead-x@homenex.in',
      events: [{ id: 9, channel: 'carrier_pigeon', status: 'received', created_at: new Date().toISOString() }],
    },
  })
  const ui = await render(<LeadSourcesScreen />)

  assert.match(ui.text(), /carrier_pigeon/, 'a channel added server-side must not render as a blank row')
})

test('"no captured leads yet" is only said when the request actually succeeded', async (t) => {
  setup(t, { '/api/lead-sources': { ingest_email: 'lead-x@homenex.in', events: [] } })
  const ui = await render(<LeadSourcesScreen />)

  assert.match(ui.text(), /No captured leads yet/)
})

test('a failed load says so instead of claiming there are no leads', async (t) => {
  setup(t, { '/api/lead-sources': { status: 500, body: { error: 'database is away' } } })
  const ui = await render(<LeadSourcesScreen />)

  assert.match(ui.text(), /Can't load your captured leads/)
  // The dangerous confusion: an agent who reads "no captured leads yet" during an
  // outage concludes their portal setup is broken and starts changing it.
  assert.doesNotMatch(ui.text(), /No captured leads yet/)
})

test('a load still in flight says loading, not empty', async (t) => {
  setup(t, { '/api/lead-sources': () => new Promise(() => {}) })
  const ui = await render(<LeadSourcesScreen />)

  assert.match(ui.text(), /Loading captured leads…/)
  assert.doesNotMatch(ui.text(), /No captured leads yet/)
  assert.equal(ui.byText('Loading captured leads…').props['aria-busy'], 'true')
})

// --- Advanced: the ad form mapping ------------------------------------------

test('the advanced drawer is closed until it is asked for', async (t) => {
  setup(t)
  const ui = await render(<LeadSourcesScreen />)

  // Most agents have no API key and no form id; the default screen stays layman-simple.
  assert.equal(ui.queryByLabel('Facebook or Instagram ad form id'), null)

  await openAdvanced(ui)
  assert.ok(ui.byLabel('Facebook or Instagram ad form id'))
})

test('connecting an ad form posts the id and confirms in plain language', async (t) => {
  const { net } = setup(t, { 'POST /api/lead-sources/leadgen-form': { ok: true } })
  const ui = await render(<LeadSourcesScreen />)
  await openAdvanced(ui)

  await type(ui.byLabel('Facebook or Instagram ad form id'), '  1234567890  ')
  await click(ui.byRole('button', { name: 'Connect' }))

  const [call] = net.to('/api/lead-sources/leadgen-form', 'POST')
  assert.equal(call.body.form_id, '1234567890', 'the id is trimmed before it is sent')
  assert.match(ui.text(), /now sends leads to you/)
})

test('the Connect button stays disabled until there is something to connect', async (t) => {
  const { net } = setup(t, { 'POST /api/lead-sources/leadgen-form': { ok: true } })
  const ui = await render(<LeadSourcesScreen />)
  await openAdvanced(ui)

  const connect = ui.byRole('button', { name: 'Connect' })
  assert.equal(connect.props.disabled, true)
  await click(connect)
  assert.deepEqual(net.to('/api/lead-sources/leadgen-form', 'POST'), [], 'nothing was sent')

  // Whitespace is not a form id either.
  await type(ui.byLabel('Facebook or Instagram ad form id'), '   ')
  assert.equal(ui.byRole('button', { name: 'Connect' }).props.disabled, true)
})

// --- Advanced: portal connections -------------------------------------------

test('each portal row reflects whether it is switched on and whether a key is saved', async (t) => {
  setup(t)
  const ui = await render(<LeadSourcesScreen />)
  await openAdvanced(ui)

  // on/off is otherwise conveyed only by the knob position and track colour.
  assert.equal(ui.byLabel('Receive leads from 99acres').props['aria-checked'], true)
  assert.equal(ui.byLabel('Receive leads from MagicBricks').props['aria-checked'], false)
  // A portal with no integration row at all is off, not undefined.
  assert.equal(ui.byLabel('Receive leads from NoBroker').props['aria-checked'], false)

  assert.match(ui.text(), /🔑 Connection key saved/)
})

test('toggling a portal sends the opposite of what it currently is, and refreshes', async (t) => {
  const { net } = setup(t, { 'PUT /api/portal-integrations/magicbricks': { ok: true } })
  const ui = await render(<LeadSourcesScreen />)
  await openAdvanced(ui)

  await click(ui.byLabel('Receive leads from MagicBricks'))

  const [call] = net.to('/api/portal-integrations/magicbricks', 'PUT')
  assert.deepEqual(call.body, { enabled: true }, 'an off portal is switched on')
  // The row renders from the polled list, so the screen has to re-read it or the
  // switch snaps back to its old position on the next poll.
  assert.ok(net.to('/api/portal-integrations').length >= 2, 'the integration list was re-read')
})

test('saving a connection key sends it, enables the portal, and clears the field', async (t) => {
  const { net } = setup(t, { 'PUT /api/portal-integrations/99acres': { ok: true } })
  const ui = await render(<LeadSourcesScreen />)
  await openAdvanced(ui)

  await type(ui.byLabel('Connection key for 99acres'), '  secret-key-99  ')
  await click(ui.allByRole('button', { name: 'Save' })[0])

  const [call] = net.to('/api/portal-integrations/99acres', 'PUT')
  assert.deepEqual(call.body, { api_key: 'secret-key-99', enabled: true })
  // The key must not stay legible on screen after it is saved.
  assert.equal(ui.byLabel('Connection key for 99acres').props.value, '')
})

test('an empty connection key is not saved', async (t) => {
  const { net } = setup(t, { 'PUT /api/portal-integrations/99acres': { ok: true } })
  const ui = await render(<LeadSourcesScreen />)
  await openAdvanced(ui)

  const save = ui.allByRole('button', { name: 'Save' })[0]
  assert.equal(save.props.disabled, true)
  await click(save)
  assert.deepEqual(net.to('/api/portal-integrations/99acres', 'PUT'), [])
})

// --- Advanced: regenerating the address -------------------------------------

test('making a new lead email asks first, and says what it will break', async (t) => {
  const { net } = setup(t, { 'POST /api/lead-sources/regenerate': { ok: true } })
  const ui = await render(<LeadSourcesScreen />)
  await openAdvanced(ui)

  await click(ui.byText('↻ Make a new lead email'))

  // The cost is not obvious from the button: every portal the agent pasted the old
  // address into stops delivering, silently, until they go and update each one.
  assert.match(ui.text(), /stops the old one working/)
  assert.deepEqual(net.to('/api/lead-sources/regenerate', 'POST'), [], 'nothing happened on the ask alone')
})

test('confirming regenerates the address and re-reads the screen', async (t) => {
  const { net } = setup(t, { 'POST /api/lead-sources/regenerate': { ok: true } })
  const ui = await render(<LeadSourcesScreen />)
  await openAdvanced(ui)

  await click(ui.byText('↻ Make a new lead email'))
  await click(ui.byRole('button', { name: 'Make new email' }))

  assert.equal(net.to('/api/lead-sources/regenerate', 'POST').length, 1)
  assert.ok(net.to('/api/lead-sources').length >= 2, 'the new address is fetched, not left stale on screen')
  assert.equal(ui.queryByRole('alertdialog'), null, 'the dialog closes once it succeeds')
})

test('cancelling leaves the address alone', async (t) => {
  const { net } = setup(t, { 'POST /api/lead-sources/regenerate': { ok: true } })
  const ui = await render(<LeadSourcesScreen />)
  await openAdvanced(ui)

  await click(ui.byText('↻ Make a new lead email'))
  await click(ui.byRole('button', { name: 'Cancel' }))

  assert.deepEqual(net.to('/api/lead-sources/regenerate', 'POST'), [])
  assert.equal(ui.queryByRole('alertdialog'), null)
})

test('a regenerate that fails leaves the dialog up rather than pretending it worked', async (t) => {
  setup(t, { 'POST /api/lead-sources/regenerate': { status: 500, body: { error: 'nope' } } })
  const ui = await render(<LeadSourcesScreen />)
  await openAdvanced(ui)

  await click(ui.byText('↻ Make a new lead email'))
  await click(ui.byRole('button', { name: 'Make new email' }))

  // Closing on failure would tell the agent their address changed when it did not —
  // and they would go and update every portal to an address that still works.
  assert.ok(ui.queryByRole('alertdialog'), 'the confirm stays open')
})

test('the advanced drawer closes again', async (t) => {
  setup(t)
  const ui = await render(<LeadSourcesScreen />)

  await openAdvanced(ui)
  assert.ok(ui.queryByLabel('Facebook or Instagram ad form id'))
  await openAdvanced(ui)
  assert.equal(ui.queryByLabel('Facebook or Instagram ad form id'), null)
})
