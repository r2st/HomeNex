// The money screen: receivables ageing, deals, commissions, GST invoices.
//
// This is the only screen in the app where the numbers are the product. Everything on
// it is money stored in paise and rendered in rupees, so the failures worth catching
// are the quiet arithmetic ones — a builder's ageing buckets attached to the wrong
// column, a total that is the sum of the wrong rows, a zero rendered as an em dash so
// a real ₹0 looks like missing data.
//
// The two actions here are also the two that cost the agent something if they silently
// fail: raising a GST invoice against a commission, and marking one paid. Both go out
// over the network and both must say so when the request is refused, rather than
// leaving a button that looks like it worked.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, click } from '../test/render.jsx'
import { installBrowser, mockFetch } from '../test/browserEnv.js'
import CommissionsScreen from './CommissionsScreen.jsx'

const L = 10_000_000 // one lakh, in paise

const RECEIVABLES = {
  totals: { total_paise: 25 * L, count: 3 },
  received_paise: 12 * L,
  builders: [
    {
      builder_name: 'Godrej Properties',
      total_paise: 15 * L,
      b_0_30: 5 * L,
      b_31_60: 4 * L,
      b_61_90: 3 * L,
      b_90_plus: 3 * L,
    },
    { builder_name: 'Kolte Patil', total_paise: 10 * L, b_0_30: 10 * L, b_31_60: 0, b_61_90: 0, b_90_plus: 0 },
  ],
}

const DEALS = [
  {
    id: 1,
    lead_id: 11,
    lead_name: 'Anita Desai',
    lead_wa_id: '919812345678',
    property_title: 'Skyline 3BHK',
    deal_type: 'sale',
    deal_value_paise: 950 * L,
    builder_name: 'Godrej Properties',
    status: 'open',
    created_at: new Date(Date.now() - 3600_000).toISOString(),
  },
  {
    id: 2,
    lead_id: 12,
    lead_name: null,
    lead_wa_id: '919898989898',
    property_title: null,
    deal_type: 'rental',
    monthly_rent_paise: 45_000_00,
    deal_value_paise: null,
    builder_name: null,
    status: 'won',
    created_at: new Date(Date.now() - 86_400_000).toISOString(),
  },
]

const COMMISSIONS = [
  {
    id: 101,
    amount_paise: 5 * L,
    status: 'expected',
    payer_type: 'builder',
    builder_name: 'Godrej Properties',
    commission_pct: 2,
    expected_payout_date: '2026-09-01',
  },
  { id: 102, amount_paise: 3 * L, status: 'overdue', payer_type: 'buyer', commission_pct: null },
  { id: 103, amount_paise: 2 * L, status: 'received', payer_type: 'seller' },
  { id: 104, amount_paise: 0, status: 'expected', payer_type: 'builder' },
]

const INVOICES = [
  {
    id: 501,
    invoice_number: 'INV-2026-001',
    status: 'issued',
    lead_name: 'Anita Desai',
    lead_wa_id: '919812345678',
    subtotal_paise: 5 * L,
    gst_rate: 18,
    total_paise: 5.9 * L,
  },
  {
    id: 502,
    invoice_number: 'INV-2026-002',
    status: 'paid',
    lead_name: null,
    lead_wa_id: '919898989898',
    subtotal_paise: 2 * L,
    gst_rate: 18,
    total_paise: 2.36 * L,
  },
]

function setup(t, routes = {}) {
  const env = installBrowser()
  const net = mockFetch({
    '/api/commissions/receivables': RECEIVABLES,
    '/api/deals': DEALS,
    '/api/commissions': COMMISSIONS,
    '/api/commission-invoices': INVOICES,
    ...routes,
  })
  t.after(() => {
    net.restore()
    env.restore()
  })
  return net
}

const open = async (ui, tab) => click(ui.byRole('button', { name: tab }))

// --- Receivables ------------------------------------------------------------

test('the screen opens on receivables, with the outstanding total and what has landed', async (t) => {
  setup(t)
  const ui = await render(<CommissionsScreen />)

  assert.match(ui.text(), /₹ 25L/, 'the outstanding total is the headline number')
  assert.match(ui.text(), /3 receivables/)
  assert.match(ui.text(), /₹ 12L received/)
})

test('one receivable is not "1 receivables"', async (t) => {
  setup(t, {
    '/api/commissions/receivables': {
      ...RECEIVABLES,
      totals: { total_paise: 5 * L, count: 1 },
    },
  })
  const ui = await render(<CommissionsScreen />)

  assert.match(ui.text(), /1 receivable ·/)
})

test('each builder’s ageing buckets are labelled and carry their own column', async (t) => {
  setup(t)
  const ui = await render(<CommissionsScreen />)

  // The buckets are what turn a number into an instruction — "owed" is a fact,
  // "owed for more than ninety days" is a phone call — so each one has to be named
  // rather than left as four figures in a row.
  const text = ui.text()
  for (const label of ['On time', 'A bit late', 'Overdue', 'Very overdue']) assert.match(text, new RegExp(label))
  // Godrej's four buckets, in the order the component lays them out, ahead of the
  // second builder's. A bucket wired to the wrong column reorders this.
  assert.match(text, /Godrej Properties.*₹ 5L.*₹ 4L.*₹ 3L.*₹ 3L.*Kolte Patil/s)
})

test('an empty bucket shows ₹ 0 rather than nothing at all', async (t) => {
  setup(t)
  const ui = await render(<CommissionsScreen />)

  // Kolte Patil is owed only inside 30 days: the other three buckets are real zeroes,
  // and a blank there reads as "no data" instead of "nothing overdue".
  assert.equal((ui.text().match(/₹ 0/g) || []).length, 3)
})

test('a broker with no builder receivables is told how they appear', async (t) => {
  setup(t, { '/api/commissions/receivables': { totals: { total_paise: 0, count: 0 }, received_paise: 0, builders: [] } })
  const ui = await render(<CommissionsScreen />)

  assert.match(ui.text(), /No builder receivables yet/)
  assert.match(ui.text(), /builder-paid commission/)
})

test('a failed receivables load says so instead of loading for ever', async (t) => {
  setup(t, { '/api/commissions/receivables': { status: 500, body: { error: 'nope' } } })
  const ui = await render(<CommissionsScreen />)

  const alert = ui.byRole('alert')
  assert.match(alert ? ui.text() : '', /Couldn't load receivables/)
  assert.doesNotMatch(ui.text(), /Loading…/)
})

// --- Deals ------------------------------------------------------------------

test('a sale deal shows its value and a rental shows a monthly rent', async (t) => {
  setup(t)
  const ui = await render(<CommissionsScreen />)
  await open(ui, 'Deals')

  assert.match(ui.text(), /Anita Desai · Skyline 3BHK/)
  assert.match(ui.text(), /₹ 9\.5Cr/, 'the sale carries its deal value')
  assert.match(ui.text(), /₹ 45,000\/mo/, 'the rental is priced per month, not as a lump sum')
})

test('a deal for an unnamed lead falls back to the number rather than rendering blank', async (t) => {
  setup(t)
  const ui = await render(<CommissionsScreen />)
  await open(ui, 'Deals')

  assert.match(ui.text(), /919898989898/)
})

test('the deal filter asks the server for that status, and "all" asks for none', async (t) => {
  const net = setup(t)
  const ui = await render(<CommissionsScreen />)
  await open(ui, 'Deals')

  assert.equal(net.to('/api/deals').at(-1).query.status, 'open', 'the tab opens on open deals')

  await click(ui.byRole('button', { name: 'Won' }))
  assert.equal(net.to('/api/deals').at(-1).query.status, 'won')

  await click(ui.byRole('button', { name: 'All' }))
  assert.equal(net.to('/api/deals').at(-1).query.status, undefined, '"all" must not filter by a status called "all"')
})

test('tapping a deal opens its lead', async (t) => {
  setup(t)
  const opened = []
  const ui = await render(<CommissionsScreen onOpenLead={(id) => opened.push(id)} />)
  await open(ui, 'Deals')

  await click(ui.byText('Anita Desai · Skyline 3BHK'))
  assert.deepEqual(opened, [11])
})

test('an empty deal list explains where deals come from', async (t) => {
  setup(t, { '/api/deals': [] })
  const ui = await render(<CommissionsScreen />)
  await open(ui, 'Deals')

  assert.match(ui.text(), /captured automatically when a lead reaches Token\/Booking/)
})

// --- Commissions ------------------------------------------------------------

test('the commission list shows the amount, who pays, and the due date', async (t) => {
  setup(t)
  const ui = await render(<CommissionsScreen />)
  await open(ui, 'Commissions')

  assert.match(ui.text(), /₹ 5L/)
  assert.match(ui.text(), /2%/)
  assert.match(ui.text(), /due 2026-09-01/)
  assert.match(ui.text(), /Godrej Properties/)
})

test('the status filter is sent to the server, and All sends nothing', async (t) => {
  const net = setup(t)
  const ui = await render(<CommissionsScreen />)
  await open(ui, 'Commissions')

  assert.equal(net.to('/api/commissions').at(-1).query.status, undefined, 'the list opens unfiltered')

  await click(ui.byRole('button', { name: 'Overdue' }))
  assert.equal(net.to('/api/commissions').at(-1).query.status, 'overdue')
})

test('only money that is still owed offers a GST invoice', async (t) => {
  setup(t)
  const ui = await render(<CommissionsScreen />)
  await open(ui, 'Commissions')

  // expected + overdue with an amount = 2 buttons. A received commission has nothing
  // to invoice, and a zero-rupee one would raise an invoice for nothing.
  assert.equal(ui.allByRole('button', { name: 'Raise GST invoice' }).length, 2)
})

test('raising an invoice posts against that commission and reloads the list', async (t) => {
  const net = setup(t, { 'POST /api/commissions/101/invoice': { id: 900, invoice_number: 'INV-2026-003' } })
  const ui = await render(<CommissionsScreen />)
  await open(ui, 'Commissions')

  const before = net.to('/api/commissions').length
  await click(ui.allByRole('button', { name: 'Raise GST invoice' })[0])

  assert.equal(net.to('/api/commissions/101/invoice', 'POST').length, 1)
  assert.ok(net.to('/api/commissions').length > before, 'the list should refresh so the status moves to Invoiced')
})

test('a refused invoice says why, in words, and leaves the button usable', async (t) => {
  setup(t, { 'POST /api/commissions/101/invoice': { status: 400, body: { error: 'GSTIN missing on your profile' } } })
  const ui = await render(<CommissionsScreen />)
  await open(ui, 'Commissions')
  await click(ui.allByRole('button', { name: 'Raise GST invoice' })[0])

  assert.match(ui.text(), /GSTIN missing on your profile/)
  const button = ui.allByRole('button', { name: 'Raise GST invoice' })[0]
  assert.ok(!button.props.disabled, 'the agent has to be able to try again once they have fixed it')
})

test('an empty commission list says so', async (t) => {
  setup(t, { '/api/commissions': [] })
  const ui = await render(<CommissionsScreen />)
  await open(ui, 'Commissions')

  assert.match(ui.text(), /No commissions yet/)
})

// --- Invoices ---------------------------------------------------------------

test('an invoice shows the GST arithmetic that produced its total', async (t) => {
  setup(t)
  const ui = await render(<CommissionsScreen />)
  await open(ui, 'Invoices')

  assert.match(ui.text(), /INV-2026-001/)
  assert.match(ui.text(), /₹ 5L \+ 18% GST = ₹ 5\.9L/)
})

test('only an issued invoice can be marked paid', async (t) => {
  setup(t)
  const ui = await render(<CommissionsScreen />)
  await open(ui, 'Invoices')

  assert.equal(ui.allByRole('button', { name: 'Mark paid' }).length, 1, 'a paid invoice must not offer to be paid again')
})

test('marking an invoice paid sends the status and reloads the ledger', async (t) => {
  const net = setup(t, { 'PUT /api/commission-invoices/501': { id: 501, status: 'paid' } })
  const ui = await render(<CommissionsScreen />)
  await open(ui, 'Invoices')

  const before = net.to('/api/commission-invoices').length
  await click(ui.byRole('button', { name: 'Mark paid' }))

  assert.deepEqual(net.to('/api/commission-invoices/501', 'PUT')[0].body, { status: 'paid' })
  assert.ok(net.to('/api/commission-invoices').length > before)
})

test('an empty invoice ledger points back at the commissions tab', async (t) => {
  setup(t, { '/api/commission-invoices': [] })
  const ui = await render(<CommissionsScreen />)
  await open(ui, 'Invoices')

  assert.match(ui.text(), /Raise one from a commission/)
})

// --- The tabs themselves ----------------------------------------------------

test('each tab shows its own view and only its own', async (t) => {
  setup(t)
  const ui = await render(<CommissionsScreen />)

  await open(ui, 'Deals')
  assert.doesNotMatch(ui.text(), /Total outstanding/, 'the receivables ledger is still mounted under the deals tab')

  await open(ui, 'Invoices')
  assert.doesNotMatch(ui.text(), /Skyline 3BHK/)
  assert.match(ui.text(), /INV-2026-001/)

  await open(ui, 'Receivables')
  assert.match(ui.text(), /Total outstanding/)
})
