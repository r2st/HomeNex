// §5.4 Deal & Commission tracking: deal capture at the booking stage, the rental
// 1-month-rent auto-suggest, the builder receivables ledger + aging report, and
// GST-aware commission invoices.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('commissions')

const { app } = await import('../index.js')
const { closePool, query, upsertLead, commissionAmountPaise, suggestRentalCommissionPaise } = await import('../db.js')
const { gstBreakdown } = await import('../money.js')

let server
let base
let token
let agentId

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
const jreq = async (...a) => (await req(...a)).json()

// Backdate a commission's expected payout so it lands in a known aging bucket.
const backdateCommission = (id, days) =>
  query(`UPDATE commissions SET expected_payout_date = CURRENT_DATE - $2::int WHERE id = $1`, [id, days])

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const out = await jreq('POST', '/api/auth/signup', { name: 'Comm Agent', phone: '+919800000042', password: 'secret123' })
  token = out.token
  agentId = out.agent.id
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// A buy lead with a site visit to a builder property, moved to Token/Booking, captures
// a sale deal carrying the property's builder + value.
test('moving a buy lead to Token/Booking auto-captures a sale deal', async () => {
  const lead = await upsertLead(agentId, '919000000001', 'Buyer Bhavna')
  const prop = await jreq('POST', '/api/properties', {
    title: 'Kolte Patil Life Republic', builder_name: 'Kolte Patil', price_paise: 9_00_00_000, property_type: 'apartment',
  })
  await req('POST', '/api/site-visits', { lead_id: lead.id, property_id: prop.id, scheduled_at: new Date(Date.now() + 3600_000).toISOString() })

  const moved = await req('PUT', `/api/leads/${lead.id}/stage`, { stage: 'Token/Booking' })
  assert.equal(moved.status, 200)

  const deals = await jreq('GET', '/api/deals')
  const deal = deals.find((d) => d.lead_id === lead.id)
  assert.ok(deal, 'a deal was captured')
  assert.equal(deal.deal_type, 'sale')
  assert.equal(deal.builder_name, 'Kolte Patil')
  assert.equal(Number(deal.deal_value_paise), 9_00_00_000)
  assert.equal(deal.stage_captured, 'Token/Booking')

  // Capture is idempotent — bouncing stages must not spawn a second deal.
  await req('PUT', `/api/leads/${lead.id}/stage`, { stage: 'Agreement' })
  await req('PUT', `/api/leads/${lead.id}/stage`, { stage: 'Token/Booking' })
  const after2 = (await jreq('GET', '/api/deals')).filter((d) => d.lead_id === lead.id)
  assert.equal(after2.length, 1, 'still exactly one deal for the lead')
})

// A rental lead reaching Deposit/Token captures a rental deal AND an auto commission
// equal to one month's rent.
test('a rental deal auto-suggests a 1-month-rent commission', async () => {
  const lead = await upsertLead(agentId, '919000000002', 'Renter Rahul')
  await req('PUT', `/api/leads/${lead.id}`, { pipeline_type: 'rental' })
  const prop = await jreq('POST', '/api/properties', {
    title: '2BHK Wakad Rental', price_paise: 35_000_00, property_type: 'apartment',
  })
  await req('POST', '/api/site-visits', { lead_id: lead.id, property_id: prop.id, scheduled_at: new Date(Date.now() + 3600_000).toISOString() })

  await req('PUT', `/api/leads/${lead.id}/stage`, { stage: 'Deposit/Token' })

  const deal = (await jreq('GET', '/api/deals')).find((d) => d.lead_id === lead.id)
  assert.ok(deal)
  assert.equal(deal.deal_type, 'rental')
  assert.equal(Number(deal.monthly_rent_paise), 35_000_00)

  const detail = await jreq('GET', `/api/deals/${deal.id}`)
  assert.equal(Number(detail.suggested_rental_commission_paise), 35_000_00)

  const commissions = await jreq('GET', '/api/commissions')
  const c = commissions.find((x) => x.lead_id === lead.id)
  assert.ok(c, 'auto commission created')
  assert.equal(Number(c.commission_flat_paise), 35_000_00, 'commission is one month rent')
  assert.equal(Number(c.amount_paise), 35_000_00)
  assert.equal(c.payer_type, 'buyer')
})

// commissionAmountPaise / suggestRentalCommissionPaise pure helpers.
test('amount helpers: flat wins, else pct of deal value; rental suggestion', () => {
  assert.equal(commissionAmountPaise({ commission_flat_paise: 50000 }), 50000)
  assert.equal(commissionAmountPaise({ deal_value_paise: 1_00_00_000, commission_pct: 2 }), 2_00_000)
  assert.equal(commissionAmountPaise({}), 0)
  assert.equal(suggestRentalCommissionPaise({ deal_type: 'rental', monthly_rent_paise: 40000 }), 40000)
  assert.equal(suggestRentalCommissionPaise({ deal_type: 'sale', deal_value_paise: 5 }), null)
})

// Builder receivables ledger buckets outstanding builder commissions by age.
test('builder receivables ledger ages outstanding commissions into buckets', async () => {
  const lead = await upsertLead(agentId, '919000000003', 'Ledger Lead')
  // Four builder-owed commissions for "Godrej", one per aging bucket.
  const mk = async (paise, days) => {
    const c = await jreq('POST', '/api/commissions', {
      lead_id: lead.id, commission_flat_paise: paise, payer_type: 'builder', builder_name: 'Godrej',
    })
    await backdateCommission(c.id, days)
    return c
  }
  await mk(10_000_00, 10) // 0-30
  await mk(20_000_00, 45) // 31-60
  await mk(30_000_00, 75) // 61-90
  await mk(40_000_00, 120) // 90+
  // A received one must NOT count as outstanding.
  const paid = await jreq('POST', '/api/commissions', {
    lead_id: lead.id, commission_flat_paise: 99_000_00, payer_type: 'builder', builder_name: 'Godrej', status: 'received',
  })
  assert.ok(paid.id)

  const ledger = await jreq('GET', '/api/commissions/receivables')
  const godrej = ledger.builders.find((b) => b.builder_name === 'Godrej')
  assert.ok(godrej, 'Godrej appears in the ledger')
  assert.equal(Number(godrej.b_0_30), 10_000_00)
  assert.equal(Number(godrej.b_31_60), 20_000_00)
  assert.equal(Number(godrej.b_61_90), 30_000_00)
  assert.equal(Number(godrej.b_90_plus), 40_000_00)
  assert.equal(Number(godrej.total_paise), 100_000_00)
  assert.equal(Number(godrej.count), 4, 'received commission excluded')
  assert.equal(Number(ledger.received_paise) >= 99_000_00, true)
})

// GST invoice: 18% split in paise, subtotal + gst = total exactly; paying settles it.
test('GST commission invoice splits 18% in paise and settles on payment', async () => {
  const lead = await upsertLead(agentId, '919000000004', 'Invoice Ivan')
  const c = await jreq('POST', '/api/commissions', {
    lead_id: lead.id, commission_flat_paise: 2_00_000, payer_type: 'builder', builder_name: 'Lodha',
  })

  const inv = await jreq('POST', `/api/commissions/${c.id}/invoice`, {})
  const expected = gstBreakdown(2_00_000, 18)
  assert.equal(Number(inv.subtotal_paise), 2_00_000)
  assert.equal(Number(inv.gst_paise), expected.gst_paise)
  assert.equal(Number(inv.total_paise), expected.total_paise)
  assert.equal(Number(inv.subtotal_paise) + Number(inv.gst_paise), Number(inv.total_paise), 'split is exact')
  assert.equal(Number(inv.gst_rate), 18)
  assert.ok(/^INV-/.test(inv.invoice_number))

  // The commission advanced to 'invoiced'.
  const afterInvoice = (await jreq('GET', '/api/commissions')).find((x) => x.id === c.id)
  assert.equal(afterInvoice.status, 'invoiced')

  // Listing + marking paid settles the underlying commission.
  const list = await jreq('GET', `/api/commission-invoices?commission_id=${c.id}`)
  assert.equal(list.length, 1)
  await req('PUT', `/api/commission-invoices/${inv.id}`, { status: 'paid' })
  const settled = (await jreq('GET', '/api/commissions')).find((x) => x.id === c.id)
  assert.equal(settled.status, 'received')
  assert.ok(settled.actual_payout_date, 'payout date stamped')
})

// A commission with no amount cannot be invoiced.
test('invoicing a zero-amount commission is rejected', async () => {
  const lead = await upsertLead(agentId, '919000000005', 'Empty Emma')
  const c = await jreq('POST', '/api/commissions', { lead_id: lead.id, payer_type: 'builder' })
  const res = await req('POST', `/api/commissions/${c.id}/invoice`, {})
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.match(body.error, /no amount/)
})

// --- Invoice numbering. These use a private agent so the sequence is predictable.
// Signed up on first use rather than in a before() hook: the tests in this file run
// in order, and a second top-level hook would race the one that boots the server.
let billingToken
let billingAgentId
let billingSeq = 0

async function ensureBillingAgent() {
  if (!billingToken) {
    const out = await jreq('POST', '/api/auth/signup', { name: 'Billing Agent', phone: '+919800000043', password: 'secret123' })
    billingToken = out.token
    billingAgentId = out.agent.id
  }
  return billingAgentId
}

// A commission with an amount, ready to invoice, owned by the numbering agent.
async function billableCommission() {
  await ensureBillingAgent()
  const lead = await upsertLead(billingAgentId, `9192000000${String(++billingSeq).padStart(2, '0')}`, `Seq ${billingSeq}`)
  return jreq(
    'POST', '/api/commissions',
    { lead_id: lead.id, commission_flat_paise: 1_00_000, payer_type: 'builder', builder_name: 'Godrej' },
    billingToken,
  )
}

// The regression: numbering used to come from COUNT(*)+1, so an agent who typed a
// number above the count made every later auto-numbered invoice collide with it —
// and since a rejected INSERT leaves the count untouched, it collided forever.
test('a hand-typed invoice number does not jam auto-numbering', async () => {
  const first = await jreq('POST', `/api/commissions/${(await billableCommission()).id}/invoice`, {}, billingToken)
  assert.equal(first.invoice_number, `INV-${billingAgentId}-0001`)

  // The agent types their own number, skipping ahead of the sequence.
  const typed = await jreq(
    'POST', `/api/commissions/${(await billableCommission()).id}/invoice`,
    { invoice_number: `INV-${billingAgentId}-0003` }, billingToken,
  )
  assert.equal(typed.invoice_number, `INV-${billingAgentId}-0003`)

  // Auto-numbering must step past it, not land on it. Under COUNT(*)+1 this asked
  // for 0003 — a permanent 409, repeated for every invoice after it.
  const next = await req('POST', `/api/commissions/${(await billableCommission()).id}/invoice`, {}, billingToken)
  assert.equal(next.status, 200)
  assert.equal((await next.json()).invoice_number, `INV-${billingAgentId}-0004`)
})

// A number the caller supplied is theirs to fix — it must surface as a 409 rather
// than being silently retried onto some other number.
test('a duplicate caller-supplied invoice number is a 409, not a silent renumber', async () => {
  const number = `INV-${billingAgentId}-9999`
  const ok = await req('POST', `/api/commissions/${(await billableCommission()).id}/invoice`, { invoice_number: number }, billingToken)
  assert.equal(ok.status, 200)

  const clash = await req('POST', `/api/commissions/${(await billableCommission()).id}/invoice`, { invoice_number: number }, billingToken)
  assert.equal(clash.status, 409)
  assert.match((await clash.json()).error, /already exists/)
})

// Reading the next number and inserting it is not atomic. Two invoices raised at
// once pick the same number; the loser must retry, not fail the request.
test('invoices raised concurrently each get their own number', async () => {
  const commissions = await Promise.all([billableCommission(), billableCommission(), billableCommission()])
  const results = await Promise.all(
    commissions.map((c) => req('POST', `/api/commissions/${c.id}/invoice`, {}, billingToken)),
  )
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200], 'no request lost the race')

  const numbers = (await Promise.all(results.map((r) => r.json()))).map((i) => i.invoice_number)
  assert.equal(new Set(numbers).size, 3, `three distinct numbers, got ${numbers.join(', ')}`)
})

// Numbering is per-agent: a busy neighbour must not push this agent's sequence along.
test('invoice numbering is scoped to the agent', async () => {
  const out = await jreq('POST', '/api/auth/signup', { name: 'Quiet Agent', phone: '+919800000044', password: 'secret123' })
  const lead = await upsertLead(out.agent.id, '919300000001', 'Quiet Lead')
  const c = await jreq(
    'POST', '/api/commissions',
    { lead_id: lead.id, commission_flat_paise: 50_000, payer_type: 'builder' }, out.token,
  )
  const inv = await jreq('POST', `/api/commissions/${c.id}/invoice`, {}, out.token)
  assert.equal(inv.invoice_number, `INV-${out.agent.id}-0001`, 'a fresh agent starts at 0001')
})

// Manual deal create + edit, and the one-deal-per-lead guard.
test('manual deal create is one-per-lead and editable', async () => {
  const lead = await upsertLead(agentId, '919000000006', 'Manual Manoj')
  const deal = await jreq('POST', '/api/deals', {
    lead_id: lead.id, deal_type: 'sale', builder_name: 'Puravankara', deal_value_paise: 1_50_00_000,
  })
  assert.ok(deal.id)

  const dup = await req('POST', '/api/deals', { lead_id: lead.id, deal_type: 'sale' })
  assert.equal(dup.status, 400)

  const updated = await jreq('PUT', `/api/deals/${deal.id}`, { status: 'won', builder_name: 'Puravankara Ltd' })
  assert.equal(updated.status, 'won')
  assert.equal(updated.builder_name, 'Puravankara Ltd')
})
