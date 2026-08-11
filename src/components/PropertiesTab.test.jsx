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
import { render, change, click } from '../test/render.jsx'
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
