// The Contacts screen, now that /api/contacts returns one page instead of everything.
//
// The failure this guards against is quiet: the list stops at 100, the header reads
// "100 auto-captured", and an agent with 1,204 numbers is told — in the app's own
// voice — that they have 100. Nothing errors, nothing looks broken, the number is just
// wrong. So the assertions here are about the header and the footer note, not about
// whether rows render.
//
// Below the paging tests are the three things on this screen that only open when an
// agent taps something — the contact panel, the groups accordion and the blast sheet.
// None of them had ever been mounted by a test, which is how a screen ends up at 58%
// of its own functions while every assertion above it passes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, change, click } from '../test/render.jsx'
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

function setup(t, contacts, routes = {}) {
  const env = installBrowser()
  const net = mockFetch({
    'GET /api/contacts': servePage(contacts),
    'GET /api/contacts/count': serveCount(contacts),
    'GET /api/groups': [],
    ...routes,
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

// --- The contact panel ---------------------------------------------------------
// Opened by tapping a row. Everything below here is a screen an agent reaches in one
// tap from the list and that no test had ever mounted.

const detail = (over = {}) => ({
  id: 1,
  name: 'Client 1',
  phone: '+919876501001',
  source: 'portal',
  source_detail: '99acres',
  notes: null,
  first_message_at: '2026-08-01T09:00:00Z',
  last_message_at: '2026-08-12T09:00:00Z',
  created_at: '2026-07-01T09:00:00Z',
  leads: [],
  ...over,
})

const openFirstContact = (ui) => click(ui.byText('Client 1', { selector: 'p' }))

test('tapping a contact opens their panel with where they came from', async (t) => {
  setup(t, many(3), { 'GET /api/contacts/1': detail() })
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)

  await openFirstContact(ui)

  assert.match(ui.text(), /🌐 Portal · 99acres/, 'the capture source is the first thing this panel is for')
  assert.match(ui.text(), /No notes yet/)
  assert.match(ui.text(), /No leads yet/)

  await click(ui.byRole('button', { name: 'Back to contacts' }))
  assert.doesNotMatch(ui.text(), /No notes yet/, 'back closes the panel')
})

// The CONTACT block is a <dl>, so its label and value are adjacent nodes with no
// whitespace between them — reading them as pairs says more than a text match could.
const fiberText = (f) => (f.kind === 'text' ? f.text : (f.children || []).map(fiberText).join(''))
const detailRows = (ui) =>
  ui.all((f) => f.type === 'dt').map((dt) => [fiberText(dt), fiberText(dt.parent.children[1])])

test('a contact with no messages reads "never" rather than a blank row', async (t) => {
  setup(t, many(3), {
    'GET /api/contacts/1': detail({ first_message_at: null, last_message_at: null, source: 'something_new', source_detail: null }),
  })
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)

  await openFirstContact(ui)

  const rows = Object.fromEntries(detailRows(ui))
  assert.equal(rows['First message'], 'never')
  assert.equal(rows['Last message'], 'never')
  assert.equal(rows.Captured, 'something_new', 'an unmapped source is shown as it came, not dropped')
})

test('a contact who has messaged shows when, and where they were captured', async (t) => {
  setup(t, many(3), { 'GET /api/contacts/1': detail() })
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)

  await openFirstContact(ui)

  const rows = Object.fromEntries(detailRows(ui))
  assert.equal(rows.Captured, '🌐 Portal · 99acres')
  assert.match(rows['First message'], /ago$/)
  assert.match(rows['Last message'], /ago$/)
  assert.match(rows.Added, /ago$/)
})

test('a note is written on the panel and saved back to the contact', async (t) => {
  const { net } = setup(t, many(3), {
    'GET /api/contacts/1': detail(),
    'PUT /api/contacts/1': { ok: true },
  })
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)
  await openFirstContact(ui)

  await click(ui.byRole('button', { name: 'Edit' }))
  await change(ui.byLabel('Notes about this contact'), '  Wants a north-facing 3BHK  ')
  await click(ui.byRole('button', { name: 'Save' }))

  assert.deepEqual(net.to('/api/contacts/1', 'PUT')[0].body, { notes: 'Wants a north-facing 3BHK' })
  assert.equal(ui.queryByLabel('Notes about this contact'), null, 'saving leaves edit mode')
})

test('clearing a note to blank stores nothing rather than an empty string', async (t) => {
  const { net } = setup(t, many(3), {
    'GET /api/contacts/1': detail({ notes: 'Old note' }),
    'PUT /api/contacts/1': { ok: true },
  })
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)
  await openFirstContact(ui)

  assert.match(ui.text(), /Old note/)
  await click(ui.byRole('button', { name: 'Edit' }))
  assert.equal(ui.byLabel('Notes about this contact').props.value, 'Old note', 'editing starts from what is there')

  await change(ui.byLabel('Notes about this contact'), '   ')
  await click(ui.byRole('button', { name: 'Save' }))

  assert.equal(net.to('/api/contacts/1', 'PUT')[0].body.notes, null)
})

test("a contact's leads open the lead, and close the panel on the way", async (t) => {
  const opened = []
  setup(t, many(3), {
    'GET /api/contacts/1': detail({
      leads: [{ id: 42, stage: 'Qualified', pipeline_type: 'buy', temp: 'hot', updated_at: '2026-08-13T09:00:00Z' }],
    }),
  })
  const ui = await render(<ContactsTab onOpenLead={(id) => opened.push(id)} />)
  await openFirstContact(ui)

  assert.match(ui.text(), /Qualified/)
  await click(ui.byText('Qualified'))

  assert.deepEqual(opened, [42])
  assert.doesNotMatch(ui.text(), /Qualified/, 'the panel closed so the lead is not opened behind it')
})

test('a contact panel that cannot load offers a retry instead of an empty panel', async (t) => {
  let attempts = 0
  setup(t, many(3), {
    'GET /api/contacts/1': () => {
      attempts++
      return attempts === 1 ? { status: 500, body: { error: 'Contact unavailable' } } : detail()
    },
  })
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)
  await openFirstContact(ui)

  assert.match(ui.text(), /Contact unavailable/)
  await click(ui.byRole('button', { name: /Try again|Retry/ }))
  assert.match(ui.text(), /🌐 Portal · 99acres/, 'the retry actually re-fetched')
})

// --- Groups & segments ---------------------------------------------------------

const group = (over = {}) => ({ id: 1, name: 'Whitefield', color: '#2563eb', member_count: 12, ...over })

const openGroups = (ui) => click(ui.byRole('button', { name: /GROUPS & SEGMENTS/ }))

test('the groups panel is collapsed until asked for, and says so to a screen reader', async (t) => {
  const { net } = setup(t, many(2), { 'GET /api/groups': [group()] })
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)

  const toggle = ui.byRole('button', { name: /GROUPS & SEGMENTS/ })
  assert.equal(toggle.props['aria-expanded'], false)
  assert.equal(net.to('/api/groups').length, 0, 'a collapsed panel does not fetch')

  await openGroups(ui)
  assert.equal(ui.byRole('button', { name: /GROUPS & SEGMENTS/ }).props['aria-expanded'], true)
  assert.match(ui.text(), /Whitefield/)
  assert.equal(net.to('/api/groups').length, 1)

  await openGroups(ui)
  assert.doesNotMatch(ui.text(), /Whitefield/, 'closing hides the list')

  await openGroups(ui)
  assert.equal(net.to('/api/groups').length, 1, 'reopening reuses what it already loaded')
})

test('auto-grouping reports what it grouped by, and reloads the list', async (t) => {
  let groups = []
  const { net } = setup(t, many(2), {
    'GET /api/groups': () => groups,
    'POST /api/groups/auto': () => {
      groups = [group({ name: 'Wakad' })]
      return { created: 1 }
    },
  })
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)
  await openGroups(ui)
  assert.match(ui.text(), /No groups yet/)

  await click(ui.byRole('button', { name: /Locality/ }))

  assert.deepEqual(net.to('/api/groups/auto', 'POST')[0].body, { by: 'locality' })
  assert.match(ui.text(), /Grouped by locality/)
  assert.match(ui.text(), /Wakad/)
})

test('auto-grouping that fails technically is reported in the agent\'s words', async (t) => {
  // friendlyMessage passes a human server sentence straight through and hides only
  // the technical kind. A driver stack trace is the technical kind, and this button
  // is one tap from a contact list — it must not be where one surfaces.
  setup(t, many(2), {
    'GET /api/groups': [],
    'POST /api/groups/auto': { status: 500, body: { error: 'TypeError: cannot read properties of undefined' } },
  })
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)
  await openGroups(ui)

  await click(ui.byRole('button', { name: /Intent/ }))

  assert.doesNotMatch(ui.text(), /TypeError/, 'a raw stack trace is not a message for an agent')
  assert.match(ui.text(), /Something went wrong on our side/)
})

test('a refusal an agent can act on is passed through as written', async (t) => {
  setup(t, many(2), {
    'GET /api/groups': [],
    'POST /api/groups/auto': { status: 400, body: { error: 'Add a locality to your leads first' } },
  })
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)
  await openGroups(ui)

  await click(ui.byRole('button', { name: /Interest level/ }))

  assert.match(ui.text(), /Add a locality to your leads first/)
})

test('deleting a group asks first and says the contacts survive it', async (t) => {
  let groups = [group()]
  const { net } = setup(t, many(2), {
    'GET /api/groups': () => groups,
    'DELETE /api/groups/1': () => {
      groups = []
      return { ok: true }
    },
  })
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)
  await openGroups(ui)

  await click(ui.byRole('button', { name: 'Delete the group Whitefield' }))
  assert.match(ui.text(), /Delete group "Whitefield"\?/)
  assert.match(ui.text(), /The contacts in it are not deleted/)

  await click(ui.byRole('button', { name: /^Delete$/ }))
  assert.equal(net.to('/api/groups/1', 'DELETE').length, 1)
  assert.match(ui.text(), /No groups yet/)
})

// --- The blast sheet -----------------------------------------------------------

const openBlast = (ui) => click(ui.byRole('button', { name: 'Send a message to Whitefield' }))

test('a blast names its recipient count before anything is typed', async (t) => {
  setup(t, many(2), { 'GET /api/groups': [group()] })
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)
  await openGroups(ui)
  await openBlast(ui)

  assert.match(ui.text(), /Goes to 12 contacts who have agreed to your messages/)
  assert.equal(ui.byRole('button', { name: /Review & send/ }).props.disabled, true,
    'there is nothing to review yet')
})

test('a group of one is one contact, in the sheet and in the confirmation', async (t) => {
  setup(t, many(2), { 'GET /api/groups': [group({ member_count: 1 })] })
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)
  await openGroups(ui)
  await openBlast(ui)

  assert.match(ui.text(), /Goes to 1 contact who have agreed/)
  await change(ui.byLabel('Message to send to the "Whitefield" group'), 'Site visit Sunday?')
  await click(ui.byRole('button', { name: /Review & send/ }))
  assert.match(ui.text(), /Send to 1 contact\?/)
})

test('a blast is confirmed before it goes, and reports what the limiter skipped', async (t) => {
  const { net } = setup(t, many(2), {
    'GET /api/groups': [group()],
    'POST /api/groups/1/send': { sent: 9, skipped: 3 },
  })
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)
  await openGroups(ui)
  await openBlast(ui)

  await change(ui.byLabel('Message to send to the "Whitefield" group'), '  New 3BHK in Whitefield  ')
  await click(ui.byRole('button', { name: /Review & send/ }))

  assert.match(ui.text(), /Send to 12 contacts\?/)
  assert.equal(net.to('/api/groups/1/send', 'POST').length, 0, 'nothing is sent from the review step alone')

  await click(ui.byRole('button', { name: 'Send now' }))

  assert.deepEqual(net.to('/api/groups/1/send', 'POST')[0].body, { message: 'New 3BHK in Whitefield' })
  assert.match(ui.text(), /Sent to 9\./)
  assert.match(ui.text(), /3 skipped — they haven't agreed to messages yet/)
  assert.equal(ui.queryByLabel('Message to send to the "Whitefield" group'), null, 'the sheet closed')
})

test('a blast that sends to everyone mentions no skips', async (t) => {
  setup(t, many(2), {
    'GET /api/groups': [group()],
    'POST /api/groups/1/send': { sent: 12, skipped: 0 },
  })
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)
  await openGroups(ui)
  await openBlast(ui)

  await change(ui.byLabel('Message to send to the "Whitefield" group'), 'Hello')
  await click(ui.byRole('button', { name: /Review & send/ }))
  await click(ui.byRole('button', { name: 'Send now' }))

  assert.match(ui.text(), /Sent to 12\./)
  assert.doesNotMatch(ui.text(), /skipped/)
})

test('a blast that is refused keeps the sheet, the message and the dialog', async (t) => {
  // The one failure an agent must not be left guessing about: the message is still
  // unsent and still in the box, so nothing is lost and it is obvious it did not go.
  setup(t, many(2), {
    'GET /api/groups': [group()],
    'POST /api/groups/1/send': { status: 503, body: { error: 'WhatsApp is not configured', code: 'WA_NOT_CONFIGURED' } },
  })
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)
  await openGroups(ui)
  await openBlast(ui)

  await change(ui.byLabel('Message to send to the "Whitefield" group'), 'Open house Saturday')
  await click(ui.byRole('button', { name: /Review & send/ }))
  await click(ui.byRole('button', { name: 'Send now' }))

  assert.ok(ui.queryByRole('alertdialog'), 'the dialog stays up on a failure')
  assert.equal(ui.byLabel('Message to send to the "Whitefield" group').props.value, 'Open house Saturday',
    'the message an agent typed is still there')
  assert.doesNotMatch(ui.text(), /Sent to/)
})
