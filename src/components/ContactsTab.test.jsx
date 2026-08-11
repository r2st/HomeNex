// The Contacts screen, now that /api/contacts returns one page instead of everything.
//
// The failure this guards against is quiet: the list stops at 100, the header reads
// "100 auto-captured", and an agent with 1,204 numbers is told — in the app's own
// voice — that they have 100. Nothing errors, nothing looks broken, the number is just
// wrong. So the assertions here are about the header and the footer note, not about
// whether rows render.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, change } from '../test/render.jsx'
import { installBrowser, mockFetch } from '../test/browserEnv.js'
import ContactsTab from './ContactsTab.jsx'

const contact = (i, over = {}) => ({
  id: i,
  name: `Client ${i}`,
  phone: `+91987650${String(1000 + i)}`,
  source: 'whatsapp_inbound',
  msg_count: 0,
  last_message_at: null,
  ...over,
})

// The server filters, orders and pages this route, so the mock has to as well — one
// that ignored ?q and ?limit would pass whether or not the component asked correctly.
const servePage = (contacts) => ({ query }) => {
  const matching = matches(contacts, query.q)
  const offset = Number(query.offset) || 0
  const limit = Math.min(Number(query.limit) || 100, 500)
  return matching.slice(offset, offset + limit)
}

// The real /api/contacts/count is a COUNT(*) over the same WHERE, unaffected by paging.
const serveCount = (contacts) => ({ query }) => ({ total: matches(contacts, query.q).length })

const matches = (contacts, q) =>
  !q ? contacts : contacts.filter((c) => c.name.toLowerCase().includes(String(q).toLowerCase()))

function setup(t, contacts) {
  const env = installBrowser()
  const net = mockFetch({
    'GET /api/contacts': servePage(contacts),
    'GET /api/contacts/count': serveCount(contacts),
    'GET /api/groups': [],
  })
  t.after(() => {
    net.restore()
    env.restore()
  })
  return { env, net }
}

const many = (n) => Array.from({ length: n }, (_, i) => contact(i + 1))

test('the header total is the count, not the length of the page', async (t) => {
  setup(t, many(1204))
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)

  assert.match(ui.text(), /1,204 auto-captured from WhatsApp/,
    'the agent has 1,204 contacts and must be told 1,204, not the 100 that fit on the page')
  assert.doesNotMatch(ui.text(), /100 auto-captured/)
})

test('a truncated list says so instead of just stopping', async (t) => {
  setup(t, many(1204))
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)

  assert.match(ui.text(), /Showing the 100 most recent of 1,204/,
    'a list that silently ends at 100 reads as the whole list')
})

test('a list that fits on one page carries no truncation note', async (t) => {
  setup(t, many(8))
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)

  assert.match(ui.text(), /8 auto-captured from WhatsApp/)
  assert.doesNotMatch(ui.text(), /Showing the/, 'nothing is being withheld, so say nothing')
})

test('the list asks the server to search rather than filtering the page it holds', async (t) => {
  // The distinction matters precisely because the list is paged: a client that filters
  // the 100 rows it already has can never find contact number 900.
  const { net } = setup(t, [
    ...many(120),
    contact(900, { name: 'Zubin Faraway' }),
  ])
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)

  assert.doesNotMatch(ui.text(), /Zubin Faraway/, 'contact 900 is past the first page')

  await change(ui.get((f) => f.props['aria-label'] === 'Search contacts', 'search box'), 'Zubin')

  assert.ok(
    net.to('/api/contacts').some((r) => r.url.includes('q=Zubin')),
    'the search term went to the server',
  )
  assert.match(ui.text(), /Zubin Faraway/, 'and the far-off contact came back')
})

test('the header follows the search, so it describes the list underneath it', async (t) => {
  setup(t, [...many(120), contact(900, { name: 'Zubin Faraway' })])
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)

  assert.match(ui.text(), /121 auto-captured/)

  await change(ui.get((f) => f.props['aria-label'] === 'Search contacts', 'search box'), 'Zubin')

  assert.match(ui.text(), /1 matching/, 'one match, counted server-side')
  assert.doesNotMatch(ui.text(), /Showing the/, 'a single result is not a truncated list')
})
