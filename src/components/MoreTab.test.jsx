// The "More" tab: the menu, and the two sub-screens that live nowhere else — the
// follow-up list and the site-visit list.
//
// Those two are the interesting half. Everything else behind this menu is a component
// with its own test file; follow-ups and site visits are defined inside MoreTab.jsx and
// were reachable only through it, so nothing had ever driven their filters, their
// toggles or — the part that costs money — the difference between "you have no
// follow-ups" and "we could not load your follow-ups".
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, click } from '../test/render.jsx'
import { installBrowser, mockFetch } from '../test/browserEnv.js'
import MoreTab from './MoreTab.jsx'

const AGENT = { id: 1, name: 'Alpha Sharma', phone: '+919812345678', is_admin: 0 }

const soon = (mins) => new Date(Date.now() + mins * 60_000).toISOString()
const ago = (mins) => new Date(Date.now() - mins * 60_000).toISOString()

const FOLLOWUPS = [
  { id: 1, lead_id: 11, lead_name: 'Anita Desai', note: 'Call about the 3BHK', due_at: ago(90), overdue: true, completed_at: null },
  { id: 2, lead_id: 12, lead_name: null, lead_wa_id: '919898989898', note: null, due_at: soon(60), overdue: false, completed_at: null },
  { id: 3, lead_id: 13, lead_name: 'Vikram Rao', note: 'Sent brochure', due_at: ago(500), overdue: false, completed_at: ago(10) },
]

const VISITS = [
  { id: 21, lead_id: 11, lead_name: 'Anita Desai', property_title: 'Skyline 3BHK', scheduled_at: soon(120), status: 'scheduled', pickup_required: true, pickup_location: 'Baner Road' },
  { id: 22, lead_id: 12, lead_name: null, lead_wa_id: '919898989898', property_title: null, scheduled_at: ago(60), status: 'completed', pickup_required: false },
  { id: 23, lead_id: 13, lead_name: 'Vikram Rao', property_title: 'Green Acres', scheduled_at: soon(30), status: 'confirmed', pickup_required: true, pickup_location: null },
]

function setup(t, routes = {}) {
  const env = installBrowser()
  const net = mockFetch({
    '/api/followups': FOLLOWUPS,
    '/api/site-visits': VISITS,
    ...routes,
  })
  t.after(() => {
    net.restore()
    env.restore()
  })
  return { net, env }
}

const mount = (props = {}) => render(<MoreTab agent={AGENT} {...props} />)
const open = (ui, label) => click(ui.byText(label, { selector: 'p' }))

// --- The menu ---------------------------------------------------------------

test('every destination in the toolkit is listed with what it is for', async (t) => {
  setup(t)
  const ui = await mount()
  const text = ui.text()

  for (const label of [
    'Follow-ups', 'Site visits', 'Team', 'Lead sources', 'Deals & commissions',
    'Contacts', 'Snippets & media', 'Festive greetings', 'Insights', 'Help & billing', 'Settings',
  ]) {
    assert.match(text, new RegExp(label.replace(/[&]/g, '&')), `${label} is on the menu`)
  }
  // The subtitle is what makes the menu usable for an agent who does not already know
  // the jargon — "Snippets & media" alone does not say "saved replies".
  assert.match(text, /Reminders to call leads back/)
  assert.match(text, /Saved replies, message templates/)
})

test('the follow-up badge is shown only when something is due', async (t) => {
  setup(t)
  const plain = await mount()
  assert.doesNotMatch(plain.text(), /Follow-ups7/)

  const badged = await mount({ followupBadge: 7 })
  assert.match(badged.text(), /Follow-ups7/, 'the count rides on the follow-ups row')
})

test('the admin entry is offered only to an admin, and navigates', async (t) => {
  const { env } = setup(t)

  const plain = await mount()
  assert.equal(plain.queryByText('Team & admin'), null)

  const ui = await mount({ agent: { ...AGENT, is_admin: 1 } })
  const navigated = []
  env.window.addEventListener('homenex-navigate', (e) => navigated.push(e.detail))
  await click(ui.byText('Team & admin'))
  assert.deepEqual(navigated, ['admin'])
})

test('every menu entry opens the screen it names, and every one comes back', async (t) => {
  // Eleven rows, each a one-line render arm. They are trivial individually and the
  // failure they permit is not: a row wired to the neighbouring screen sends an agent
  // to Contacts when they asked for Commissions, and nothing about the destination
  // says it was the wrong one — both are plausible screens to be looking at.
  setup(t, {
    '/api/auth/me': AGENT,
    '/api/contacts': [],
    '/api/contacts/count': { total: 0 },
    '/api/groups': [],
    '/api/lead-sources': { ingest_email: 'lead-x@homenex.in', events: [] },
    '/api/portal-integrations': [],
    '/api/support/tickets': [],
    '/api/billing': { subscription: null, usage: { total_conversations: 0 }, invoices: [] },
    '/api/commissions/receivables': { totals: { total_paise: 0, count: 0 }, received_paise: 0, builders: [] },
    '/api/deals': [],
    '/api/commissions': [],
    '/api/commission-invoices': [],
    '/api/quick-replies': [],
    '/api/templates': [],
    '/api/media': [],
    '/api/templates/festive': { festivals: [], scheduled: [] },
    '/api/stats': { avgFirstResponseS: 42, qualifiedPct: 60, afterHours: 3, total: 12, daily: [], sources: [] },
  })
  const ui = await mount()

  // label on the menu -> the heading only that destination renders, and how to get
  // back. For most it is the SubScreen title; the three that render their own header
  // are matched on the heading they own.
  const DESTINATIONS = [
    ['Follow-ups', /Follow-ups/, 'Back'],
    ['Site visits', /Site visits/, 'Back'],
    ['Team', /Team/, 'Back'],
    ['Lead sources', /YOUR LEAD EMAIL/, 'Back'],
    ['Deals & commissions', /Deals & commissions/, 'Back'],
    ['Contacts', /Contacts/, '← More'],
    ['Snippets & media', /Snippets & media/, 'Back'],
    ['Festive greetings', /Festive greetings/, 'Back'],
    ['Insights', /Your numbers with HomeNex/, '← More'],
    ['Help & billing', /Help & billing/, 'Back'],
    ['Settings', /Settings/, '← More'],
  ]

  for (const [label, marker, back] of DESTINATIONS) {
    await open(ui, label)
    assert.match(ui.text(), marker, `${label} opened the wrong screen`)
    assert.doesNotMatch(ui.text(), /Everything else in your HomeNex toolkit/, `${label} never left the menu`)

    if (back === 'Back') await click(ui.byLabel('Back'))
    else await click(ui.byText(back))
    assert.match(ui.text(), /Everything else in your HomeNex toolkit/, `${label} could not be backed out of`)
  }
})

// --- Follow-ups -------------------------------------------------------------

test('the follow-up list opens on pending, and asks the server for pending only', async (t) => {
  const { net } = setup(t)
  const ui = await mount()
  await open(ui, 'Follow-ups')

  assert.match(ui.text(), /Anita Desai/)
  assert.deepEqual(net.to('/api/followups')[0].query, { pending: '1' })
})

test('an overdue follow-up says so, and a done one is struck through', async (t) => {
  setup(t)
  const ui = await mount()
  await open(ui, 'Follow-ups')

  // "overdue" is the difference between a task and a lost deal; it cannot be carried
  // by colour alone.
  assert.match(ui.text(), /Anita Desai · overdue/)
  assert.match(ui.byText('Vikram Rao').props.className, /line-through/)
})

test('a follow-up with no lead name falls back to the number rather than a blank row', async (t) => {
  setup(t)
  const ui = await mount()
  await open(ui, 'Follow-ups')

  assert.match(ui.text(), /919898989898/)
})

test('the tick control carries its state and says which follow-up it belongs to', async (t) => {
  setup(t)
  const ui = await mount()
  await open(ui, 'Follow-ups')

  // The tick is text-transparent until done, so its visible content is invisible half
  // the time — aria-pressed and the label are the only things a screen reader has.
  const anita = ui.byLabel('Mark the follow-up for Anita Desai done')
  assert.equal(anita.props['aria-pressed'], false)
  assert.ok(ui.byLabel('Mark the follow-up for Vikram Rao not done').props['aria-pressed'])
})

test('ticking a follow-up sends the opposite of what it is and re-reads the list', async (t) => {
  const { net } = setup(t, { 'PUT /api/followups/1': { ok: true } })
  const ui = await mount()
  await open(ui, 'Follow-ups')

  await click(ui.byLabel('Mark the follow-up for Anita Desai done'))
  assert.deepEqual(net.to('/api/followups/1', 'PUT')[0].body, { completed: true })
  assert.ok(net.to('/api/followups', 'GET').length >= 2, 'the list is re-read, not left stale')
})

test('unticking a completed follow-up sends completed:false', async (t) => {
  const { net } = setup(t, { 'PUT /api/followups/3': { ok: true } })
  const ui = await mount()
  await open(ui, 'Follow-ups')

  await click(ui.byLabel('Mark the follow-up for Vikram Rao not done'))
  assert.deepEqual(net.to('/api/followups/3', 'PUT')[0].body, { completed: false })
})

test('each follow-up filter asks the server for a different thing', async (t) => {
  const { net } = setup(t)
  const ui = await mount()
  await open(ui, 'Follow-ups')

  await click(ui.byRole('button', { name: 'Due today' }))
  assert.deepEqual(net.to('/api/followups').at(-1).query, { pending: '1', today: '1' })

  await click(ui.byRole('button', { name: 'All' }))
  assert.deepEqual(net.to('/api/followups').at(-1).query, {}, 'All means no filter at all')
})

test('opening a follow-up opens the lead behind it, not some other lead', async (t) => {
  const { net } = setup(t, { '/api/leads/11': { status: 500, body: { error: 'stop here' } } })
  const ui = await mount()
  await open(ui, 'Follow-ups')

  await click(ui.byText('Anita Desai · overdue'))

  // What the panel then renders is LeadDetail's own business and has its own tests.
  // What MoreTab owns is which lead id it hands over — a follow-up row wired to the
  // wrong id opens a different buyer's conversation, which is the one mistake on this
  // screen an agent cannot undo.
  assert.equal(net.to('/api/leads/11').length, 1, 'lead 11 was opened')
  assert.deepEqual(net.to('/api/leads/12'), [], 'and no other lead was')
})

test('an empty follow-up list, a failed one and a loading one are three different screens', async (t) => {
  // A missed follow-up is money, so "we couldn't load them" must never read as
  // "you have none".
  const empty = setup(t, { '/api/followups': [] })
  const a = await mount()
  await open(a, 'Follow-ups')
  assert.match(a.text(), /Nothing here\. Schedule follow-ups from any lead/)
  empty.net.restore()

  const failed = mockFetch({ '/api/followups': { status: 500, body: { error: 'db is away' } }, '/api/site-visits': VISITS })
  const b = await mount()
  await open(b, 'Follow-ups')
  assert.match(b.text(), /Can't load your follow-ups: db is away/)
  assert.doesNotMatch(b.text(), /Nothing here/)
  failed.restore()

  const pending = mockFetch({ '/api/followups': () => new Promise(() => {}), '/api/site-visits': VISITS })
  const c = await mount()
  await open(c, 'Follow-ups')
  assert.match(c.text(), /Loading your follow-ups…/)
  assert.doesNotMatch(c.text(), /Nothing here/)
  pending.restore()
})

test('back returns to the menu', async (t) => {
  setup(t)
  const ui = await mount()
  await open(ui, 'Follow-ups')
  await click(ui.byLabel('Back'))

  assert.match(ui.text(), /Everything else in your HomeNex toolkit/)
})

// --- Site visits ------------------------------------------------------------

test('the site-visit list opens on upcoming and hides what is already finished', async (t) => {
  setup(t)
  const ui = await mount()
  await open(ui, 'Site visits')

  assert.match(ui.text(), /Anita Desai/)
  assert.match(ui.text(), /Vikram Rao/)
  // The completed visit is filtered out client-side on the "upcoming" chip.
  assert.doesNotMatch(ui.text(), /919898989898/)
})

test('a visit shows where it is, when it is, and whether a pickup is needed', async (t) => {
  setup(t)
  const ui = await mount()
  await open(ui, 'Site visits')

  assert.match(ui.text(), /Anita Desai → Skyline 3BHK/)
  assert.match(ui.text(), /🚗 Baner Road/)
  // A pickup with no address still has to say a pickup is required.
  assert.match(ui.text(), /🚗 pickup/)
})

test('the All filter shows the finished visits too', async (t) => {
  setup(t)
  const ui = await mount()
  await open(ui, 'Site visits')

  await click(ui.byRole('button', { name: 'All' }))
  assert.match(ui.text(), /919898989898/)
})

test('the Today filter asks the server rather than filtering on the client', async (t) => {
  const { net } = setup(t)
  const ui = await mount()
  await open(ui, 'Site visits')

  await click(ui.byRole('button', { name: 'Today' }))
  assert.deepEqual(net.to('/api/site-visits').at(-1).query, { today: '1' })
})

test('advancing a visit sends the new status and re-reads', async (t) => {
  const { net } = setup(t, { 'PUT /api/site-visits/21': { ok: true } })
  const ui = await mount()
  await open(ui, 'Site visits')

  await click(ui.allByRole('button', { name: 'Confirmed' })[0])
  assert.deepEqual(net.to('/api/site-visits/21', 'PUT')[0].body, { status: 'confirmed' })
  assert.ok(net.to('/api/site-visits', 'GET').length >= 2)
})

test('clicking the status a visit already has does nothing', async (t) => {
  const { net } = setup(t, { 'PUT /api/site-visits/21': { ok: true } })
  const ui = await mount()
  await open(ui, 'Site visits')

  await click(ui.allByRole('button', { name: 'Scheduled' })[0])
  assert.deepEqual(net.to('/api/site-visits/21', 'PUT'), [], 'no pointless write, no pointless refetch')
})

test('statuses are offered in words, never as raw slugs', async (t) => {
  setup(t)
  const ui = await mount()
  await open(ui, 'Site visits')

  assert.match(ui.text(), /No-show/)
  assert.doesNotMatch(ui.text(), /no_show/)
})

test('an empty visit list, a failed one and a loading one are three different screens', async (t) => {
  const empty = setup(t, { '/api/site-visits': [] })
  const a = await mount()
  await open(a, 'Site visits')
  assert.match(a.text(), /No site visits\. Schedule one from any lead/)
  empty.net.restore()

  const failed = mockFetch({ '/api/site-visits': { status: 500, body: { error: 'db is away' } }, '/api/followups': FOLLOWUPS })
  const b = await mount()
  await open(b, 'Site visits')
  assert.match(b.text(), /Can't load your site visits: db is away/)
  assert.doesNotMatch(b.text(), /No site visits\./)
  failed.restore()

  const pending = mockFetch({ '/api/site-visits': () => new Promise(() => {}), '/api/followups': FOLLOWUPS })
  const c = await mount()
  await open(c, 'Site visits')
  assert.match(c.text(), /Loading your site visits…/)
  pending.restore()
})

test('a list that loads but is entirely filtered out still says there is nothing', async (t) => {
  // Every visit is completed, so "upcoming" shows none of them — that is an empty
  // screen the agent needs explained, not a silently blank card.
  setup(t, { '/api/site-visits': [{ ...VISITS[1] }] })
  const ui = await mount()
  await open(ui, 'Site visits')

  assert.match(ui.text(), /No site visits/)
})
