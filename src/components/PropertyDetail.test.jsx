// The property panel — the largest component in the app, and the one with the
// broadest reach: it edits inventory, deletes it, publishes a public page, exports
// listings to four portals, and sends a property into a buyer's WhatsApp thread.
//
// propertyLinks.test.jsx covers what it does with a hostile stored URL, and a11ySweep
// covers naming. Neither touches the four cards behind "Share & promote", the delete
// path, or the send sheet — which is where this panel's failures are expensive,
// because every one of them ends in something the agent believes and acts on:
//
//   * "No leads to send this to yet" when the search merely failed, on the one sheet
//     whose whole purpose is picking a lead;
//   * "✓ Copied" when nothing reached the clipboard, so the next paste into a broker
//     group is whatever was there before;
//   * an export that silently didn't happen, after which the agent goes to 99acres
//     expecting content that was never sent;
//   * a card that vanishes on a dropped request, which reads as a property that does
//     not have a public page.
//
// Everything is asserted through what the agent sees and what the network received.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, act, click, change, submit } from '../test/render.jsx'
import { installBrowser, mockFetch } from '../test/browserEnv.js'
import PropertyDetail from './PropertyDetail.jsx'

const pending = () => () => new Promise(() => {})
const busy = (ui) => ui.query((f) => f.props?.['aria-busy'] === 'true') !== null

const PROPERTY = {
  id: 11,
  title: 'Prestige Lakeside 3BHK',
  property_type: 'apartment',
  status: 'available',
  bhk: 3,
  size_sqft: 1450,
  price_paise: 9500000000,
  locality: 'Baner',
  city: 'Pune',
  created_at: new Date().toISOString(),
  photos: [],
  notes: '',
}

const MICROPAGE = { url: 'https://homenex.app/p/abc123', page_views: 12, stats: { total: 12, last_7d: 4 } }

const ANALYTICS = {
  total: 12,
  last_24h: 3,
  distinct_leads: 2,
  daily: [{ day: '2026-08-13', views: 5 }, { day: '2026-08-14', views: 7 }],
  viewers: [
    { lead_id: 501, lead_name: 'Anand Rao', wa_id: '919000000001', views: 4 },
    { lead_id: 502, lead_name: null, wa_id: '919000000002', views: 1 },
  ],
}

const SYNDICATIONS = {
  portals: ['99acres', 'magicbricks'],
  preview: [
    { portal: '99acres', price_display: '₹95 L', spec: '3 BHK · 1450 sqft', whatsapp_text: 'Lakeside 3BHK, ₹95L', description: 'A lakeside apartment in Baner.' },
    { portal: 'magicbricks', price_display: '₹95 L', spec: '3 BHK', whatsapp_text: 'MB text', description: 'MB description.' },
  ],
  saved: [],
}

const LEADS = [
  { id: 501, contact_name: 'Anand Rao', wa_id: '919000000001', unassigned: false },
  { id: 502, contact_name: 'Meera Joshi', wa_id: '919000000002', unassigned: false },
  { id: 503, contact_name: 'Pool Person', wa_id: '919000000003', unassigned: true },
]

const BASE_ROUTES = {
  'GET /api/properties/11': PROPERTY,
  'POST /api/properties/11/micro-page': MICROPAGE,
  'GET /api/properties/11/analytics': ANALYTICS,
  'GET /api/properties/11/syndications': SYNDICATIONS,
  'GET /api/leads': LEADS,
}

function setup(t, routes = {}, browser = {}) {
  const env = installBrowser(browser)
  const net = mockFetch({ ...BASE_ROUTES, ...routes })
  t.after(() => {
    net.restore()
    env.restore()
  })
  return { env, net }
}

const panel = (props = {}) => (
  <PropertyDetail propertyId={11} onClose={() => {}} onChanged={() => {}} onOpenLead={() => {}} {...props} />
)

/** Open the collapsed "Share & promote" section, where three of the four cards live. */
const openPromote = async (ui) => click(ui.byText('SHARE & PROMOTE'))

// The send sheet debounces its lead search through setTimeout, which act()'s
// microtask draining does not advance. Give the macrotask queue a turn.
const settle = (ms = 0) => act(() => new Promise((r) => setTimeout(r, ms)))

/** Open the send sheet and let its first lead search land. */
const openSendSheet = async (ui) => {
  await click(ui.byText(/Send to chat/))
  await settle()
}

// The form's save is a real submit, not a click handler on the button.
const saveForm = (ui) => submit(ui.get((f) => f.type === 'form', 'the property form'))

const isInside = (node, ancestor) => {
  for (let cur = node.parent; cur; cur = cur.parent) if (cur === ancestor) return true
  return false
}

const confirmButton = (ui, label) => {
  const dialog = ui.byRole('alertdialog')
  return ui.get(
    (f) => f.type === 'button' && isInside(f, dialog) && (f.props?.children === label || f.props?.children === 'Please wait…'),
    `confirm button "${label}"`,
  )
}

// --- The panel itself ----------------------------------------------------------

test('the panel shows the price, the specs and the status', async (t) => {
  setup(t)
  const ui = await render(panel())

  assert.match(ui.text(), /Prestige Lakeside 3BHK/)
  assert.match(ui.text(), /Available/)
  assert.match(ui.text(), /3 BHK/)
  assert.match(ui.text(), /1450 sqft/)
  assert.match(ui.text(), /Baner, Pune/)
})

test('a property that fails to load offers a retry rather than an empty panel', async (t) => {
  let calls = 0
  const ctx = setup(t, { 'GET /api/properties/11': () => (++calls === 1 ? { status: 500, body: {} } : PROPERTY) })
  const ui = await render(panel())

  assert.notEqual(ui.queryByRole('alert'), null, 'a failed load said nothing')
  await click(ui.byText('Try again', { exact: true, selector: 'button' }))
  assert.equal(ctx.net.to('/api/properties/11', 'GET').length, 2)
  assert.match(ui.text(), /Prestige Lakeside 3BHK/)
})

test('a price that was never set reads as on request, not as zero', async (t) => {
  setup(t, { 'GET /api/properties/11': { ...PROPERTY, price_paise: null } })
  const ui = await render(panel())

  assert.match(ui.text(), /Price on request/)
  assert.doesNotMatch(ui.text(), /₹0/)
})

test('an empty spec is left out rather than rendered blank', async (t) => {
  setup(t, { 'GET /api/properties/11': { ...PROPERTY, bhk: null, rera_project_number: null, builder_name: null } })
  const ui = await render(panel())

  assert.doesNotMatch(ui.text(), /RERA/)
  assert.doesNotMatch(ui.text(), /Builder/)
  assert.match(ui.text(), /Locality/, 'the specs that DO have a value must still be shown')
})

// --- Deleting ------------------------------------------------------------------

test('deleting asks first and only then removes the property', async (t) => {
  let closed = 0
  let changed = 0
  const ctx = setup(t, { 'DELETE /api/properties/11': { ok: true } })
  const ui = await render(panel({ onClose: () => closed++, onChanged: () => changed++ }))

  await click(ui.byText('Delete property', { exact: true }))
  assert.match(ui.text(), /Delete "Prestige Lakeside 3BHK"\?/)
  assert.match(ui.text(), /cannot be undone/)
  assert.equal(ctx.net.to('/api/properties/11', 'DELETE').length, 0, 'deleted before the agent confirmed')

  await click(confirmButton(ui, 'Delete property'))
  assert.equal(ctx.net.to('/api/properties/11', 'DELETE').length, 1)
  assert.equal(changed, 1, 'the inventory list was never told to refresh')
  assert.equal(closed, 1, 'the panel stayed open over a property that no longer exists')
})

test('cancelling the delete dialog keeps the property', async (t) => {
  const ctx = setup(t, { 'DELETE /api/properties/11': { ok: true } })
  const ui = await render(panel())

  await click(ui.byText('Delete property', { exact: true }))
  await click(ui.byText('Cancel', { exact: true }))

  assert.equal(ctx.net.to('/api/properties/11', 'DELETE').length, 0)
  assert.match(ui.text(), /Prestige Lakeside 3BHK/)
})

test('a refused delete says why instead of leaving a dead dialog', async (t) => {
  let closed = 0
  setup(t, { 'DELETE /api/properties/11': { status: 400, body: { error: 'This property is on an open deal' } } })
  const ui = await render(panel({ onClose: () => closed++ }))

  await click(ui.byText('Delete property', { exact: true }))
  await click(confirmButton(ui, 'Delete property'))

  // useConfirm keeps the dialog open when onConfirm rejects, on the understanding
  // that the calling screen explains it. This one used to explain nothing at all.
  assert.match(ui.text(), /This property is on an open deal/)
  assert.equal(closed, 0, 'the panel closed over a property that was never deleted')
})

// --- Editing -------------------------------------------------------------------

test('saving an edit sends only what the form holds and leaves edit mode', async (t) => {
  const ctx = setup(t, { 'PUT /api/properties/11': { ok: true } })
  const ui = await render(panel())

  await click(ui.byText('Edit', { exact: true }))
  await change(ui.byLabel('Title *'), 'Prestige Lakeside 3BHK (corner)')
  await saveForm(ui)

  const [call] = ctx.net.to('/api/properties/11', 'PUT')
  assert.ok(call, 'the edit never reached the server')
  assert.equal(call.body.title, 'Prestige Lakeside 3BHK (corner)')
  assert.doesNotMatch(ui.text(), /EDIT PROPERTY/, 'the form stayed open after a successful save')
})

test('a refused edit keeps the form open with the typed value and the reason', async (t) => {
  setup(t, { 'PUT /api/properties/11': { status: 400, body: { error: 'Title is too long' } } })
  const ui = await render(panel())

  await click(ui.byText('Edit', { exact: true }))
  await change(ui.byLabel('Title *'), 'A new title')
  await saveForm(ui)

  assert.match(ui.text(), /Title is too long/)
  assert.match(ui.text(), /EDIT PROPERTY/, 'the form closed over an edit that was never saved')
  assert.equal(ui.byLabel('Title *').props.value, 'A new title', 'the typed title was thrown away')
})

// --- Micro-page card -----------------------------------------------------------

test('the micro-page card shows the public link and its view count', async (t) => {
  setup(t)
  const ui = await render(panel())
  await openPromote(ui)

  assert.match(ui.text(), /12 views/)
  assert.match(ui.text(), /4 this week/)
  const link = ui.get((f) => f.type === 'a' && f.props.href === MICROPAGE.url, 'the micro-page link')
  assert.match(link.props.rel, /noopener/)
})

test('a failed micro-page load is an error, not a property without a public page', async (t) => {
  setup(t, { 'POST /api/properties/11/micro-page': { status: 500, body: {} } })
  const ui = await render(panel())
  await openPromote(ui)

  // The card used to `.catch(() => {})` and then `return null`, so the whole public
  // page section disappeared — indistinguishable from a feature this property lacks.
  assert.notEqual(ui.queryByRole('alert'), null, 'a failed micro-page load vanished silently')
})

test('sharing the micro-page uses the native share sheet when there is one', async (t) => {
  const ctx = setup(t)
  const ui = await render(panel())
  await openPromote(ui)

  await click(ui.byText(/Share micro-page/))

  assert.deepEqual(ctx.env.shared, [{ url: MICROPAGE.url }])
  assert.equal(ctx.env.copied.length, 0, 'it both shared and copied')
})

test('with no share sheet the link is copied and the copy is confirmed', async (t) => {
  const ctx = setup(t)
  delete globalThis.navigator.share
  const ui = await render(panel())
  await openPromote(ui)

  await click(ui.byText(/Share micro-page/))

  assert.deepEqual(ctx.env.copied, [MICROPAGE.url])
  assert.match(ui.text(), /Link copied/)
})

test('a clipboard that refuses does not claim the link was copied', async (t) => {
  const ctx = setup(t)
  delete globalThis.navigator.share
  globalThis.navigator.clipboard = {
    writeText: async () => {
      throw new Error('Denied')
    },
  }
  const ui = await render(panel())
  await openPromote(ui)

  await click(ui.byText(/Share micro-page/))

  // Telling an agent the link is on their clipboard when it is not means the next
  // paste into a broker group is whatever was there before.
  assert.doesNotMatch(ui.text(), /Link copied/, 'a failed copy was reported as a success')
  assert.match(ui.text(), /Copy failed/)
  void ctx
})

test('a browser with no clipboard at all does not claim the link was copied', async (t) => {
  setup(t)
  delete globalThis.navigator.share
  delete globalThis.navigator.clipboard
  const ui = await render(panel())
  await openPromote(ui)

  await click(ui.byText(/Share micro-page/))

  assert.doesNotMatch(ui.text(), /Link copied/)
  assert.match(ui.text(), /Copy failed/)
})

// --- Analytics card ------------------------------------------------------------

test('the analytics card counts views and names who is looking', async (t) => {
  setup(t)
  const ui = await render(panel())
  await openPromote(ui)

  assert.match(ui.text(), /WHO'S LOOKING/)
  assert.match(ui.text(), /Anand Rao/)
  assert.match(ui.text(), /919000000002/, 'an unnamed viewer showed nothing at all')
})

test('a viewer who keeps coming back is marked as hot', async (t) => {
  setup(t)
  const ui = await render(panel())
  await openPromote(ui)

  // 4 views clears the >= 3 threshold; 1 view does not. The flame is the signal an
  // agent acts on, so it must not appear next to a single visit.
  const hot = ui.allByText(/🔥/)
  assert.equal(hot.length, 1, 'the repeat-viewer flame appeared on the wrong number of viewers')
})

test('clicking a viewer opens that lead', async (t) => {
  const opened = []
  setup(t)
  const ui = await render(panel({ onOpenLead: (id) => opened.push(id) }))
  await openPromote(ui)

  await click(ui.byText('Anand Rao'))
  assert.deepEqual(opened, [501])
})

test('a property nobody has opened shows no analytics card rather than zeroes', async (t) => {
  setup(t, { 'GET /api/properties/11/analytics': { total: 0, last_24h: 0, distinct_leads: 0, daily: [], viewers: [] } })
  const ui = await render(panel())
  await openPromote(ui)

  assert.doesNotMatch(ui.text(), /WHO'S LOOKING AT THIS PROPERTY/)
  assert.equal(ui.queryByRole('alert'), null, 'no views is not an error')
})

test('a failed analytics load is an error, not a property nobody has looked at', async (t) => {
  setup(t, { 'GET /api/properties/11/analytics': { status: 500, body: {} } })
  const ui = await render(panel())
  await openPromote(ui)

  // "Nobody has opened this listing" is a real answer an agent acts on — re-share it,
  // drop the price. A dropped request rendered identically to it.
  assert.notEqual(ui.queryByRole('alert'), null, 'a failed analytics load was swallowed')
})

// --- Syndication card ----------------------------------------------------------

test('the syndication card previews the selected portal and switches between them', async (t) => {
  setup(t)
  const ui = await render(panel())
  await openPromote(ui)

  assert.match(ui.text(), /Lakeside 3BHK, ₹95L/)
  assert.match(ui.text(), /A lakeside apartment in Baner/)

  await click(ui.byText('MagicBricks', { exact: true, selector: 'button' }))
  assert.match(ui.text(), /MB description/)
  assert.doesNotMatch(ui.text(), /A lakeside apartment in Baner/, 'the previous portal\'s copy stayed on screen')
})

test('exporting posts for the selected portal and reloads the saved state', async (t) => {
  let calls = 0
  const ctx = setup(t, {
    'POST /api/properties/11/syndicate': { ok: true },
    'GET /api/properties/11/syndications': () =>
      ++calls === 1
        ? SYNDICATIONS
        : { ...SYNDICATIONS, saved: [{ portal: '99acres', exported_at: new Date().toISOString() }] },
  })
  const ui = await render(panel())
  await openPromote(ui)

  await click(ui.byText(/Export to 99acres/))

  assert.deepEqual(ctx.net.to('/api/properties/11/syndicate', 'POST')[0].body, { portal: '99acres' })
  assert.match(ui.text(), /Exported to 99acres/, 'the card never reflected the export')
})

test('a failed export says so instead of quietly doing nothing', async (t) => {
  setup(t, { 'POST /api/properties/11/syndicate': { status: 500, body: { error: 'Portal export is down' } } })
  const ui = await render(panel())
  await openPromote(ui)

  await click(ui.byText(/Export to 99acres/))

  // This handler had no catch arm at all: the rejection escaped an onClick as an
  // unhandled promise rejection, and all the agent saw was the button stop spinning.
  // They then go to the portal expecting content that was never exported.
  assert.match(ui.text(), /Portal export is down/)
  assert.doesNotMatch(ui.text(), /Exporting…/, 'the button was left mid-export')
})

test('copying the portal text puts exactly that text on the clipboard', async (t) => {
  const ctx = setup(t)
  const ui = await render(panel())
  await openPromote(ui)

  await click(ui.allByText('Copy', { exact: true })[0])

  assert.deepEqual(ctx.env.copied, ['Lakeside 3BHK, ₹95L'])
  assert.match(ui.text(), /✓ Copied/)
})

test('a failed portal copy is not reported as copied', async (t) => {
  setup(t)
  globalThis.navigator.clipboard = {
    writeText: async () => {
      throw new Error('Denied')
    },
  }
  const ui = await render(panel())
  await openPromote(ui)

  await click(ui.allByText('Copy', { exact: true })[0])

  assert.doesNotMatch(ui.text(), /✓ Copied/)
  assert.match(ui.text(), /Copy failed/)
})

test('a failed syndication load is an error, not a card that never existed', async (t) => {
  setup(t, { 'GET /api/properties/11/syndications': { status: 500, body: {} } })
  const ui = await render(panel())
  await openPromote(ui)

  assert.notEqual(ui.queryByRole('alert'), null)
})

// --- Send to chat --------------------------------------------------------------

test('the send sheet lists owned leads and leaves the shared pool out', async (t) => {
  setup(t)
  const ui = await render(panel())

  await openSendSheet(ui)

  assert.match(ui.text(), /Anand Rao/)
  assert.match(ui.text(), /Meera Joshi/)
  assert.doesNotMatch(ui.text(), /Pool Person/, 'an unclaimed pool lead was offered as a send target')
})

test('sending marks that row sent and posts once for that lead', async (t) => {
  const ctx = setup(t, { 'POST /api/properties/11/send-to-chat': { ok: true } })
  const ui = await render(panel())
  await openSendSheet(ui)

  await click(ui.allByText('Send', { exact: true })[0])

  const sends = ctx.net.to('/api/properties/11/send-to-chat', 'POST')
  assert.equal(sends.length, 1)
  assert.equal(sends[0].body.lead_id, 501)
  assert.match(ui.text(), /✓ Sent/)
})

test('a refused send names the reason on that row and leaves the others alone', async (t) => {
  setup(t, { 'POST /api/properties/11/send-to-chat': { status: 400, body: { error: 'Outside the 24h window' } } })
  const ui = await render(panel())
  await openSendSheet(ui)

  await click(ui.allByText('Send', { exact: true })[0])

  assert.match(ui.text(), /Outside the 24h window/)
  assert.doesNotMatch(ui.text(), /✓ Sent/, 'a refused send was reported as delivered')
  // Both rows are still offerable: the refused one goes back to "Send" so it can be
  // retried once the window reopens, and the untouched one is unaffected.
  assert.equal(ui.allByText('Send', { exact: true }).length, 2, 'a refused send left a row stuck')
})

test('the search asks the server rather than filtering the page it already has', async (t) => {
  const ctx = setup(t)
  const ui = await render(panel())
  await openSendSheet(ui)

  await change(ui.byLabel(/Search contacts/), 'Meera')
  await settle(300)

  // Filtering client-side stopped being correct the moment the list took a LIMIT: an
  // agent with 400 leads would be searching the 50 most recent.
  const searched = ctx.net.to('/api/leads', 'GET').some((c) => c.query.q === 'Meera')
  assert.ok(searched, 'the search never reached the server')
})

test('a failed lead search is an error, not "you have no leads"', async (t) => {
  setup(t, { 'GET /api/leads': { status: 500, body: {} } })
  const ui = await render(panel())
  await openSendSheet(ui)

  // The catch used to land in `[]`, which this sheet renders as "No leads to send
  // this to yet." — on the one screen whose entire purpose is picking a lead.
  assert.doesNotMatch(ui.text(), /No leads to send this to yet/, 'a dropped request was reported as an empty CRM')
  assert.notEqual(ui.queryByRole('alert'), null)
  assert.equal(busy(ui), false, 'it kept claiming to load after the request failed')
})

test('a lead list still in flight is not an empty one', async (t) => {
  setup(t, { 'GET /api/leads': pending() })
  const ui = await render(panel())
  await openSendSheet(ui)

  assert.match(ui.text(), /Loading your leads…/)
  assert.doesNotMatch(ui.text(), /No leads to send this to yet/)
  assert.equal(ui.queryByRole('alert'), null)
})

test('a genuinely empty CRM says so', async (t) => {
  setup(t, { 'GET /api/leads': [] })
  const ui = await render(panel())
  await openSendSheet(ui)

  assert.match(ui.text(), /No leads to send this to yet/)
  assert.equal(ui.queryByRole('alert'), null)
})

test('a search that matches nothing says so in the searched term', async (t) => {
  setup(t, { 'GET /api/leads': ({ query }) => (query.q ? [] : LEADS) })
  const ui = await render(panel())
  await openSendSheet(ui)

  await change(ui.byLabel(/Search contacts/), 'Zzzz')
  await settle(300)

  assert.match(ui.text(), /No leads matching "Zzzz"/)
})
