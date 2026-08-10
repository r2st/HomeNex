// §7.3 billing: plan catalogue CRUD, subscriptions, quota overage on an invoice, and
// invoice status transitions — plus the tenant wall around all of it. adminPortal.test.js
// covers the seeded-plan happy path; this covers the staff-authored plans, the overage
// line item, and the "an agent must never read another agent's invoice" boundary.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
const dbName = await createTestDb('adminbilling')

const { app } = await import('../index.js')
const { closePool, query, setAdmin } = await import('../db.js')

let server, base
let staff, tenant, other
let planId

const req = (method, url, body, tok) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
const json = (r) => r.json()
const signup = async (name, phone) =>
  json(await req('POST', '/api/auth/signup', { name, phone, password: 'secret123' }))

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  staff = await signup('Staff Neha', '+919830000001')
  tenant = await signup('Tenant Priya', '+919830000002')
  other = await signup('Tenant Ravi', '+919830000003')
  await setAdmin(staff.agent.id, true)
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- Plan catalogue -----------------------------------------------------------

test('staff can author a plan, and its defaults are sensible', async () => {
  const res = await req('POST', '/api/admin/plans', {
    code: 'scale', name: 'Scale', price_paise: 199_900, conversation_quota: 500,
    features: ['team', 'bulk send'],
  }, staff.token)
  assert.equal(res.status, 200)
  const plan = await json(res)
  planId = plan.id
  assert.equal(plan.code, 'scale')
  assert.equal(Number(plan.price_paise), 199_900)
  assert.equal(plan.is_active, true) // defaults to active when not stated
  assert.deepEqual(plan.features, ['team', 'bulk send'])
})

test('a plan without a code or a name is refused', async () => {
  for (const body of [{}, { code: 'x' }, { name: 'X' }]) {
    const res = await req('POST', '/api/admin/plans', body, staff.token)
    assert.equal(res.status, 400, JSON.stringify(body))
  }
})

test('a duplicate plan code is a 409, not a 500', async () => {
  const res = await req('POST', '/api/admin/plans', { code: 'scale', name: 'Scale Again' }, staff.token)
  assert.equal(res.status, 409)
})

test('a plan can be repriced, renamed and retired', async () => {
  const res = await req('PUT', `/api/admin/plans/${planId}`, {
    name: 'Scale (2026)', price_paise: 249_900, conversation_quota: 750,
    features: ['team'], is_active: false,
  }, staff.token)
  assert.equal(res.status, 200)
  const plan = await json(res)
  assert.equal(plan.name, 'Scale (2026)')
  assert.equal(Number(plan.price_paise), 249_900)
  assert.equal(plan.conversation_quota, 750)
  assert.equal(plan.is_active, false)
  // Reactivate for the subscription tests below.
  await req('PUT', `/api/admin/plans/${planId}`, { is_active: true }, staff.token)
})

test('an empty plan update is a no-op that still returns the plan', async () => {
  const res = await req('PUT', `/api/admin/plans/${planId}`, {}, staff.token)
  assert.equal(res.status, 200)
  assert.equal((await json(res)).id, planId)
})

test('the plan catalogue is staff-only', async () => {
  for (const [method, url, body] of [
    ['GET', '/api/admin/plans', undefined],
    ['POST', '/api/admin/plans', { code: 'sneaky', name: 'Sneaky' }],
    ['PUT', `/api/admin/plans/${planId}`, { price_paise: 0 }],
  ]) {
    assert.equal((await req(method, url, body, tenant.token)).status, 403, `${method} ${url}`)
  }
})

// --- Subscriptions and invoices ----------------------------------------------

test('staff assign a subscription, and the agent sees it on their own billing page', async () => {
  const res = await req('PUT', `/api/admin/agents/${tenant.agent.id}/subscription`, { plan_id: planId }, staff.token)
  assert.equal(res.status, 200)
  assert.equal((await json(res)).plan_id, planId)

  const mine = await json(await req('GET', '/api/billing', undefined, tenant.token))
  assert.equal(mine.subscription.plan_id, planId)
  assert.equal(mine.subscription.plan_name, 'Scale (2026)')
  assert.ok(Array.isArray(mine.invoices))
})

test('billing for an unknown agent is a 404', async () => {
  assert.equal((await req('GET', '/api/admin/agents/999999/billing', undefined, staff.token)).status, 404)
  assert.equal((await req('POST', '/api/admin/agents/999999/invoices', {}, staff.token)).status, 404)
})

test('an invoice carries the plan line and an exact 18% GST split', async () => {
  const res = await req('POST', `/api/admin/agents/${tenant.agent.id}/invoices`, { note: 'First month' }, staff.token)
  assert.equal(res.status, 200)
  const invoice = await json(res)
  assert.match(invoice.number, /^HNX-\d{6}-\d{3}-\d{3}$/)
  assert.equal(invoice.notes, 'First month')
  assert.equal(Number(invoice.subtotal_paise), 249_900)
  assert.equal(Number(invoice.gst_paise), Math.round(249_900 * 0.18))
  assert.equal(
    Number(invoice.subtotal_paise) + Number(invoice.gst_paise),
    Number(invoice.total_paise),
    'an invoice whose parts do not sum to its total is a compliance problem',
  )
  assert.equal(invoice.line_items.length, 1)
})

test('invoice numbers increment per agent rather than colliding', async () => {
  const second = await json(await req('POST', `/api/admin/agents/${tenant.agent.id}/invoices`, {}, staff.token))
  assert.match(second.number, /-002$/)
  const otherFirst = await json(await req('POST', `/api/admin/agents/${other.agent.id}/invoices`, {}, staff.token))
  assert.match(otherFirst.number, /-001$/)
  assert.notEqual(second.number, otherFirst.number)
})

test('going over the conversation quota adds a metered overage line', async () => {
  // Quota is 750; bill 752 marketing sends so the overage line has to appear.
  await query(
    `INSERT INTO message_sends (agent_id, phone, kind, sent_at)
     SELECT $1, '+919700000001', 'marketing', now() FROM generate_series(1, 752)`,
    [tenant.agent.id],
  )
  const invoice = await json(await req('POST', `/api/admin/agents/${tenant.agent.id}/invoices`, {}, staff.token))
  const overage = invoice.line_items.find((li) => /overage/i.test(li.description))
  assert.ok(overage, 'expected an overage line once past the quota')
  assert.equal(overage.qty, 2)
  assert.equal(overage.unit_paise, 100)
  assert.equal(overage.amount_paise, 200)
  assert.equal(Number(invoice.subtotal_paise), 249_900 + 200)
})

test('an agent with no subscription still gets a zero invoice, not a crash', async () => {
  const zero = await json(await req('POST', `/api/admin/agents/${other.agent.id}/invoices`, {}, staff.token))
  assert.deepEqual(zero.line_items, [])
  assert.equal(Number(zero.subtotal_paise), 0)
  assert.equal(Number(zero.total_paise), 0)
})

test('assigning an unknown plan is a client error, not a 500', async () => {
  const res = await req('PUT', `/api/admin/agents/${tenant.agent.id}/subscription`, { plan_id: 999999 }, staff.token)
  assert.ok(res.status >= 400 && res.status < 500, `got ${res.status}`)
})

// --- Invoice status -----------------------------------------------------------

test('staff move an invoice through its statuses, and paid_at tracks the status', async () => {
  const invoice = await json(await req('POST', `/api/admin/agents/${tenant.agent.id}/invoices`, {}, staff.token))
  const setStatus = async (status) => {
    const res = await req('PUT', `/api/admin/invoices/${invoice.id}/status`, { status }, staff.token)
    assert.equal(res.status, 200, `could not move the invoice to ${status}`)
    return json(res)
  }
  assert.equal((await setStatus('issued')).status, 'issued')
  const paid = await setStatus('paid')
  assert.equal(paid.status, 'paid')
  assert.ok(paid.paid_at, 'marking an invoice paid must stamp when')
  // Reopening clears the payment stamp — a "paid" date on an unpaid invoice would
  // quietly corrupt the receivables view.
  assert.equal((await setStatus('issued')).paid_at, null)
  assert.equal((await setStatus('void')).status, 'void')
})

test('an unknown invoice status is rejected', async () => {
  const invoice = await json(await req('POST', `/api/admin/agents/${tenant.agent.id}/invoices`, {}, staff.token))
  const res = await req('PUT', `/api/admin/invoices/${invoice.id}/status`, { status: 'forgiven' }, staff.token)
  assert.ok(res.status >= 400 && res.status < 500)
})

test('an unknown invoice id is a 404 on both the staff and the tenant route', async () => {
  assert.equal((await req('GET', '/api/admin/invoices/999999', undefined, staff.token)).status, 404)
  assert.equal((await req('GET', '/api/billing/invoices/999999', undefined, tenant.token)).status, 404)
})

// --- The tenant wall ----------------------------------------------------------

test('an agent can open their own invoice', async () => {
  const mine = await json(await req('GET', '/api/billing', undefined, tenant.token))
  const res = await req('GET', `/api/billing/invoices/${mine.invoices[0].id}`, undefined, tenant.token)
  assert.equal(res.status, 200)
  assert.equal((await json(res)).agent_id, tenant.agent.id)
})

test('an agent cannot open another agent’s invoice', async () => {
  const mine = await json(await req('GET', '/api/billing', undefined, tenant.token))
  const res = await req('GET', `/api/billing/invoices/${mine.invoices[0].id}`, undefined, other.token)
  assert.equal(res.status, 404, 'another tenant’s invoice must not be readable')
})

test('an agent’s billing page only ever shows their own invoices', async () => {
  const theirs = await json(await req('GET', '/api/billing', undefined, other.token))
  assert.ok(theirs.invoices.every((i) => i.agent_id === other.agent.id))
})
