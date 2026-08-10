// Loading, error and empty states across the list and detail screens.
//
// These three states are easy to get wrong in the same way: a screen branches on
// `!data`, which is true both while the first request is in flight AND for ever
// after it fails. The result is a skeleton that never resolves, or an empty-state
// card ("No contacts yet") shown to an agent whose contacts simply haven't arrived
// — the most alarming possible misreading of a slow network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, click } from '../test/render.jsx'
import { installBrowser, mockFetch } from '../test/browserEnv.js'
import ContactsTab from './ContactsTab.jsx'
import PropertiesTab from './PropertiesTab.jsx'
import CommissionsScreen from './CommissionsScreen.jsx'

const pending = () => () => new Promise(() => {}) // a request that never settles
const busy = (ui) => ui.query((f) => f.props?.['aria-busy'] === 'true') !== null

function setup(t, routes = {}) {
  const env = installBrowser()
  const net = mockFetch(routes)
  t.after(() => {
    net.restore()
    env.restore()
  })
  return { env, net }
}

// --- Contacts -----------------------------------------------------------------

const CONTACT_ROUTES = {
  'GET /api/contacts': [],
  'GET /api/groups': [],
}

test('the contacts list shows skeletons while the first request is in flight', async (t) => {
  setup(t, { ...CONTACT_ROUTES, 'GET /api/contacts': pending() })
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)

  assert.equal(busy(ui), true, 'no loading affordance while contacts load')
  assert.doesNotMatch(ui.text(), /No contacts yet/, 'an empty state was shown before the data arrived')
})

test('a failed contacts request stops the skeletons and explains itself', async (t) => {
  setup(t, { ...CONTACT_ROUTES, 'GET /api/contacts': { status: 500, body: {} } })
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)

  // The skeletons used to keep pulsing under the error banner, which reads as
  // "the list is still on its way" when in fact nothing more is coming.
  assert.equal(busy(ui), false, 'skeletons kept pulsing after the request failed')
  assert.match(ui.text(), /Can't reach the HomeNex server/)
})

test('an empty contacts list is only called empty once it has actually loaded', async (t) => {
  setup(t, CONTACT_ROUTES)
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)

  assert.match(ui.text(), /No contacts yet/)
  assert.equal(busy(ui), false)
})

test('a contact whose detail fails to load offers a retry', async (t) => {
  const ctx = setup(t, {
    ...CONTACT_ROUTES,
    'GET /api/contacts': [{ id: 7, name: 'Anil Kumar', phone: '+919876500007', source: 'walk_in' }],
    'GET /api/contacts/7': { status: 500, body: {} },
  })
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)

  await click(ui.byText('Anil Kumar'))
  assert.match(ui.text(), /Couldn't load this/)

  await click(ui.byText('Try again'))
  assert.equal(ctx.net.to('/api/contacts/7', 'GET').length, 2)
})

// --- Properties ---------------------------------------------------------------

test('the properties list shows skeletons while loading and drops them on failure', async (t) => {
  const slow = setup(t, { 'GET /api/properties': pending() })
  const loadingUi = await render(<PropertiesTab onOpenLead={() => {}} />)
  assert.equal(busy(loadingUi), true)
  slow.net.restore()
  slow.env.restore()

  setup(t, { 'GET /api/properties': { status: 500, body: {} } })
  const failedUi = await render(<PropertiesTab onOpenLead={() => {}} />)
  assert.equal(busy(failedUi), false, 'skeletons outlived a failed properties request')
  assert.match(failedUi.text(), /Can't reach the HomeNex server/)
})

// --- Commissions: receivables -------------------------------------------------

test('receivables that fail to load say so instead of loading for ever', async (t) => {
  setup(t, { 'GET /api/commissions/receivables': { status: 500, body: {} } })
  const ui = await render(<CommissionsScreen onBack={() => {}} />)

  assert.match(ui.text(), /Couldn't load receivables/)
  assert.doesNotMatch(ui.text(), /Loading…/, 'the screen was still claiming to load')
})

test('receivables show a loading line only while the request is genuinely in flight', async (t) => {
  setup(t, { 'GET /api/commissions/receivables': pending() })
  const ui = await render(<CommissionsScreen onBack={() => {}} />)

  assert.match(ui.text(), /Loading…/)
  assert.doesNotMatch(ui.text(), /Couldn't load receivables/)
})
