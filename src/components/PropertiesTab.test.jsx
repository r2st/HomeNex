// The Properties screen, now that /api/properties returns one page instead of the whole
// inventory.
//
// The failure this guards against is quiet: the list stops at 100, the header reads
// "100 in your inventory", and an agent with 1,204 listings is told — in the app's own
// voice — that they have 100. Nothing errors, nothing looks broken, the number is just
// wrong. So the assertions here are about the header, the footer note and the filter
// sheet's button, not about whether cards render.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, change, click, submit } from '../test/render.jsx'
import { installBrowser, mockFetch } from '../test/browserEnv.js'
import PropertiesTab from './PropertiesTab.jsx'
import DashboardTab from './DashboardTab.jsx'

const property = (i, over = {}) => ({
  id: i,
  title: `Tower ${i} Residences`,
  property_type: 'apartment',
  bhk: '3',
  locality: 'Whitefield',
  city: 'Bengaluru',
  status: 'available',
  price_paise: 5_00_00_000,
  photos: [],
  ...over,
})

// The server filters, orders and pages this route, so the mock has to as well — one that
// ignored ?q, ?status and ?limit would pass whether or not the component asked correctly.
const matches = (properties, query) =>
  properties.filter(
    (p) =>
      (!query.q || p.title.toLowerCase().includes(String(query.q).toLowerCase())) &&
      (!query.status || p.status === query.status) &&
      (!query.type || p.property_type === query.type) &&
      (!query.bhk || p.bhk === query.bhk),
  )

const servePage = (properties) => ({ query }) => {
  const offset = Number(query.offset) || 0
  const limit = Math.min(Number(query.limit) || 100, 500)
  return matches(properties, query).slice(offset, offset + limit)
}

// The real /api/properties/count is a COUNT(*) over the same WHERE, unaffected by paging.
const serveCount = (properties) => ({ query }) => ({ total: matches(properties, query).length })

function setup(t, properties) {
  const env = installBrowser()
  const net = mockFetch({
    'GET /api/properties': servePage(properties),
    'GET /api/properties/count': serveCount(properties),
  })
  t.after(() => {
    net.restore()
    env.restore()
  })
  return { env, net }
}

const many = (n) => Array.from({ length: n }, (_, i) => property(i + 1))

test('the header total is the count, not the length of the page', async (t) => {
  setup(t, many(1204))
  const ui = await render(<PropertiesTab onOpenLead={() => {}} />)

  assert.match(ui.text(), /1,204 in your inventory/,
    'the agent has 1,204 properties and must be told 1,204, not the 100 that fit on the page')
  assert.doesNotMatch(ui.text(), /100 in your inventory/)
})

test('a truncated list says so instead of looking like the whole inventory', async (t) => {
  setup(t, many(1204))
  const ui = await render(<PropertiesTab onOpenLead={() => {}} />)

  assert.match(ui.text(), /Showing the 100 most recently updated of 1,204/,
    'without this the list just stops at 100 and reads as the end of the inventory')
})

test('an inventory that fits on one page gets no truncation note', async (t) => {
  setup(t, many(6))
  const ui = await render(<PropertiesTab onOpenLead={() => {}} />)

  assert.match(ui.text(), /6 in your inventory/)
  assert.doesNotMatch(ui.text(), /Showing the/,
    'the note is for a truncated list — on a complete one it is a lie')
})

test('the filter sheet offers to show the total, not the page size', async (t) => {
  setup(t, many(1204))
  const ui = await render(<PropertiesTab onOpenLead={() => {}} />)

  await click(ui.byText('Filters'))
  assert.match(ui.text(), /Show 1,204 results/,
    '"Show 100 results" would be the sheet quoting its own page size back at the agent')
})

test('one match is a result, not results', async (t) => {
  setup(t, [property(1, { title: 'Solitaire Villa' })])
  const ui = await render(<PropertiesTab onOpenLead={() => {}} />)

  await click(ui.byText('Filters'))
  assert.match(ui.text(), /Show 1 result\b/)
})

test('search narrows on the server, and the header follows it', async (t) => {
  const { net } = setup(t, [
    ...many(300),
    property(9001, { title: 'Solitaire Villa' }),
  ])
  const ui = await render(<PropertiesTab onOpenLead={() => {}} />)
  assert.match(ui.text(), /301 in your inventory/)

  await change(ui.byLabel('Search properties'), 'Solitaire')

  // The count request must carry the search too, or the header describes a different
  // set of rows than the list beneath it.
  const counts = net.to('/api/properties/count', 'GET')
  assert.ok(counts.some((c) => c.url.includes('q=Solitaire')),
    'the count was asked without the search that produced the list')
  assert.match(ui.text(), /1 matching/,
    'a filtered header says how many match, not how many the agent owns')
})

test('a search matching nothing shows the empty state, not a stale total', async (t) => {
  setup(t, many(12))
  const ui = await render(<PropertiesTab onOpenLead={() => {}} />)

  await change(ui.byLabel('Search properties'), 'nothing matches this')

  assert.match(ui.text(), /0 matching/)
  assert.match(ui.text(), /No properties match these filters/)
  assert.doesNotMatch(ui.text(), /Showing the/)
})

test('the list request asks for a page and the count request does not', async (t) => {
  const { net } = setup(t, many(12))
  await render(<PropertiesTab onOpenLead={() => {}} />)

  const lists = net.to('/api/properties', 'GET')
  assert.ok(lists.length > 0, 'the list was never requested')
  // The component leaves limit/offset unset and takes the server default, which is the
  // whole point of the default existing — but it must not be asking for everything.
  assert.ok(lists.every((r) => !/limit=(0|all|Infinity)/.test(r.url)),
    'the list must not opt out of paging')
})

// --- Home's inventory count ---------------------------------------------------

// Home needs one integer — whether the agent has added any properties yet — and used to
// get it by polling the whole property list every 30 seconds and calling .length on it.
// That is the single most wasteful request in the app: the widest rows there are, JSONB
// photos and all, fetched to be counted and thrown away.
test('Home asks for the inventory count and never downloads the inventory', async (t) => {
  const env = installBrowser()
  const net = mockFetch({
    'GET /api/dashboard': {
      unanswered: [],
      hotLeads: [],
      followupsToday: [],
      siteVisitsToday: [],
      overdueFollowups: [],
      activity: [],
    },
    'GET /api/stats': { total: 0 },
    'GET /api/worklist': { items: [], counts: { total: 0 } },
    'GET /api/notifications': { notifications: [], unread: 0 },
    'GET /api/properties': () => {
      throw new Error('Home must not fetch the property list to count it')
    },
    'GET /api/properties/count': { total: 0 },
    'GET /api/agent/phone-config': {},
  })
  t.after(() => {
    net.restore()
    env.restore()
  })

  await render(
    <DashboardTab
      agent={{ name: 'Ravi Sharma', wa_phone_number: '+919876500000' }}
      onGoTo={() => {}}
      onOpenConversation={() => {}}
      onOpenLead={() => {}}
      onSignOut={() => {}}
    />,
  )

  assert.equal(net.to('/api/properties', 'GET').length, 0, 'the property list was fetched')
  assert.ok(net.to('/api/properties/count', 'GET').length > 0, 'the count was never asked for')
})

// --- The filter sheet ----------------------------------------------------------
//
// Everything below is reached by tapping something, which is why none of it had run:
// the four chip rows in the sheet, both ways of clearing them, the two empty-state
// buttons, the add form and the detail panel a card opens.

const openFilters = (ui) => click(ui.byText('Filters', { exact: true }))

// A chip's label is a substring of what the cards behind the sheet say — "Villa" is in
// "Villa One", "4 BHK" is in a card's "4 BHK · villa · …" line — and the cards render
// first, so a loose byText would tap the list instead of the filter.
const chip = (ui, label) => ui.byText(label, { exact: true })

test('each chip row narrows the request the list makes', async (t) => {
  const { net } = setup(t, [
    property(1, { title: 'Villa One', property_type: 'villa', bhk: '4', status: 'sold' }),
    property(2, { title: 'Flat Two', property_type: 'apartment', bhk: '2', status: 'available' }),
  ])
  const ui = await render(<PropertiesTab onOpenLead={() => {}} />)
  const lastList = () => net.to('/api/properties', 'GET').at(-1).query

  await openFilters(ui)
  await click(chip(ui, 'Villa'))
  assert.equal(lastList().type, 'villa')

  await click(chip(ui, '4 BHK'))
  assert.equal(lastList().bhk, '4')

  await click(chip(ui, 'Sold'))
  assert.equal(lastList().status, 'sold')

  assert.match(ui.text(), /Villa One/)
  assert.doesNotMatch(ui.text(), /Flat Two/, 'the list is the server\'s answer, not a client-side guess')
})

test('a price band is sent as the paise range the server filters on', async (t) => {
  const { net } = setup(t, many(3))
  const ui = await render(<PropertiesTab onOpenLead={() => {}} />)
  await openFilters(ui)

  await click(ui.byText('₹50L–1Cr'))
  const q = net.to('/api/properties', 'GET').at(-1).query
  assert.equal(q.min_price, String(50 * 1_00_000 * 100), '₹50L in paise')
  assert.equal(q.max_price, String(100 * 1_00_000 * 100), '₹1Cr in paise')

  // The open-ended top band has a floor and no ceiling — an empty max, not a zero,
  // or every property above ₹2.5Cr would be filtered out by the band meant to find them.
  await click(ui.byText('> ₹2.5Cr'))
  const top = net.to('/api/properties', 'GET').at(-1).query
  assert.equal(top.min_price, String(250 * 1_00_000 * 100))
  assert.equal(top.max_price ?? '', '')
})

test('the Filters button counts what is active, and clearing empties it', async (t) => {
  setup(t, many(4))
  const ui = await render(<PropertiesTab onOpenLead={() => {}} />)

  assert.equal(ui.queryByText('Clear all filters'), null, 'nothing to clear yet')

  // The badge is a separate <span> inside the button, so the button reads "Filters2"
  // with no space — assert on the button, not on a phrase in the whole screen's text.
  const filtersButton = () => ui.byText(/^Filters\d*$/)

  await openFilters(ui)
  await click(ui.byText('Apartment', { exact: true }))
  await click(ui.byText('2 BHK', { exact: true }))
  await click(ui.byText(/^Show \d+ results?$/))

  assert.match(ui.text(filtersButton()), /^Filters2$/, 'two filters are on and the button says so')

  await click(ui.byText('Clear all filters'))
  assert.match(ui.text(filtersButton()), /^Filters$/, 'the count went with the filters')
  assert.equal(ui.queryByText('Clear all filters'), null)
})

test('Clear all inside the sheet leaves the sheet open with nothing selected', async (t) => {
  const { net } = setup(t, many(4))
  const ui = await render(<PropertiesTab onOpenLead={() => {}} />)

  await openFilters(ui)
  await click(ui.byText('Villa'))
  await click(ui.byText('Clear all'))

  assert.match(ui.text(), /Filter properties/, 'the sheet is still open to pick again')
  assert.equal(net.to('/api/properties', 'GET').at(-1).query.type ?? '', '')
})

test('a search keeps the band the sheet set, rather than dropping it', async (t) => {
  // clearedFilters exists because the two clears mean different things — the header
  // one wipes the search too. This is the pairing that would break silently.
  const { net } = setup(t, many(4))
  const ui = await render(<PropertiesTab onOpenLead={() => {}} />)

  await openFilters(ui)
  await click(ui.byText('< ₹50L'))
  await click(ui.byText('Show'))
  await change(ui.byLabel('Search properties'), 'Tower')

  const q = net.to('/api/properties', 'GET').at(-1).query
  assert.equal(q.q, 'Tower')
  assert.equal(q.max_price, String(50 * 1_00_000 * 100), 'the band survived the search')
})

// --- Empty states ---------------------------------------------------------------

test('an empty inventory invites a first property; an empty filter offers to clear', async (t) => {
  setup(t, [])
  const ui = await render(<PropertiesTab onOpenLead={() => {}} />)

  assert.match(ui.text(), /No properties yet/)
  await click(ui.byText('Add your first property'))
  assert.match(ui.text(), /Add property/, 'the add sheet opened')
})

test('the empty-filter state clears the filters it is complaining about', async (t) => {
  setup(t, many(5))
  const ui = await render(<PropertiesTab onOpenLead={() => {}} />)

  await change(ui.byLabel('Search properties'), 'nothing matches this')
  assert.match(ui.text(), /No properties match these filters/)

  await click(ui.byText('Clear filters'))

  assert.equal(ui.byLabel('Search properties').props.value, '', 'the search that produced nothing is gone')
  assert.match(ui.text(), /5 in your inventory/)
})

// --- Adding ---------------------------------------------------------------------

test('a new property is posted with price converted from lakhs to paise', async (t) => {
  const { net } = setup(t, many(2))
  net.set('POST /api/properties', { id: 99 })
  const ui = await render(<PropertiesTab onOpenLead={() => {}} />)

  await click(ui.byText('+ Add'))
  await change(ui.byLabel('Title *'), '  Kolte Patil 24K  ')
  await change(ui.byLabel('Locality'), 'Pimple Nilakh')
  await change(ui.byLabel(/Price/), '85')
  await submit(ui.get((f) => f.type === 'form', 'the add form'))

  const [sent] = net.to('/api/properties', 'POST')
  assert.equal(sent.body.title, 'Kolte Patil 24K', 'the title is trimmed')
  assert.equal(sent.body.locality, 'Pimple Nilakh')
  assert.equal(sent.body.price_paise, 85 * 1_00_000 * 100, '₹85L stored as paise')
  assert.doesNotMatch(ui.text(), /Add property/, 'the sheet closes on success')
})

test('a refused create keeps the form open with the reason on it', async (t) => {
  const { net } = setup(t, many(2))
  net.set('POST /api/properties', { status: 400, body: { error: 'title must be 120 characters or fewer.' } })
  const ui = await render(<PropertiesTab onOpenLead={() => {}} />)

  await click(ui.byText('+ Add'))
  await change(ui.byLabel('Title *'), 'A very long title')
  await submit(ui.get((f) => f.type === 'form', 'the add form'))

  assert.equal(net.to('/api/properties', 'POST').length, 1)
  assert.match(ui.text(), /title must be 120 characters or fewer/)
  assert.match(ui.text(), /Add property/, 'the sheet is still open so nothing typed is lost')
})

// --- Opening a card --------------------------------------------------------------

test('tapping a card opens that property, and closing returns to the list', async (t) => {
  const { net } = setup(t, [property(1, { title: 'Solitaire Villa', rera_project_number: 'P52100012345' })])
  net.set('GET /api/properties/1', property(1, {
    title: 'Solitaire Villa',
    rera_project_number: 'P52100012345',
    size_sqft: 1450,
    builder_name: 'Solitaire Group',
  }))
  const ui = await render(<PropertiesTab onOpenLead={() => {}} />)

  assert.match(ui.text(), /RERA ✓/, 'the card flags a RERA-registered listing')

  await click(ui.byText('Solitaire Villa', { selector: 'p' }))
  assert.ok(net.to('/api/properties/1', 'GET').length > 0, 'the detail fetched the full row')
  assert.match(ui.text(), /Solitaire Group/, 'and shows what the card had no room for')
})

test('a card with no price and an unknown status still renders as a row', async (t) => {
  // Both are nullable columns, and the card is the only place either is read without
  // a fallback nearby — an em dash and the raw status beat a blank line.
  setup(t, [property(1, { price_paise: null, status: 'under_offer', bhk: null, locality: null, photos: ['/uploads/a.jpg'] })])
  const ui = await render(<PropertiesTab onOpenLead={() => {}} />)

  assert.match(ui.text(), /—/)
  assert.match(ui.text(), /under_offer/)
})
