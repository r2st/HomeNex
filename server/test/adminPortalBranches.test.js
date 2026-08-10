// Branch coverage for adminPortal.js and the admin router's error arms (§7).
// adminPortal.test.js and adminBilling.test.js walk the happy paths; this file is
// about the refusals, the not-founds, the empty-filter shapes and the rollback —
// the code that only runs when staff get something wrong.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
const dbName = await createTestDb('adminportalbranches')

const { app } = await import('../index.js')
const { closePool, query, setAdmin } = await import('../db.js')
const portal = await import('../adminPortal.js')

let server, base
let staff, tenant, other
const MISSING = 987654 // an id no row will ever have

const req = (method, url, body, tok) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
const json = (r) => r.json()
const signup = async (name, phone) =>
  json(await req('POST', '/api/auth/signup', { name, phone, password: 'secret123' }))

const rejects = async (fn) => {
  try {
    await fn()
  } catch (err) {
    return err
  }
  throw new Error('expected the call to throw, but it resolved')
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  staff = await signup('Staff Sana', '+919760000001')
  tenant = await signup('Tenant Tarun', '+919760000002')
  other = await signup('Tenant Oviya', '+919760000003')
  await setAdmin(staff.agent.id, true)
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- §7.1 Onboarding checklist ------------------------------------------------

test('the onboarding checklist reflects each step independently', async () => {
  const stepsFor = async (id) => (await portal.onboardingQueue()).find((a) => a.id === id)?.steps

  // A fresh signup has nothing done.
  assert.deepEqual(await stepsFor(tenant.agent.id), { profile: false, rera: false, waba: false, kyc: false })

  // A RERA id alone is not enough — it has to be verified too.
  await query('UPDATE agents SET rera_id = $2, business_name = $3 WHERE id = $1', [
    tenant.agent.id,
    'A5210000000001',
    'Tarun Realty',
  ])
  let steps = await stepsFor(tenant.agent.id)
  assert.equal(steps.rera, false, 'an unverified RERA id does not tick the box')
  assert.equal(steps.profile, false, 'a business name without a city is an incomplete profile')

  await query('UPDATE agents SET city = $2, rera_verified = true, waba_status = $3 WHERE id = $1', [
    tenant.agent.id,
    'Pune',
    'active',
  ])
  steps = await stepsFor(tenant.agent.id)
  assert.deepEqual(steps, { profile: true, rera: true, waba: true, kyc: false })

  // Once every step is done the agent drops out of the backlog entirely.
  await portal.setAgentKyc(staff.agent.id, tenant.agent.id, { status: 'verified' })
  assert.equal(await stepsFor(tenant.agent.id), undefined, 'a fully verified agent leaves the queue')
})

test('KYC and RERA updates refuse a bad status or a missing agent', async () => {
  assert.match((await rejects(() => portal.setAgentKyc(staff.agent.id, tenant.agent.id, { status: 'maybe' }))).message, /Invalid KYC status/)
  assert.match((await rejects(() => portal.setAgentKyc(staff.agent.id, tenant.agent.id))).message, /Invalid KYC status/, 'no body at all')
  assert.equal((await rejects(() => portal.setAgentKyc(staff.agent.id, MISSING, { status: 'pending' }))).code, 'NOT_FOUND')
  assert.equal((await rejects(() => portal.setAgentReraVerified(MISSING, true))).code, 'NOT_FOUND')

  // Un-verifying clears the timestamp rather than leaving a stale one behind.
  const cleared = await portal.setAgentReraVerified(tenant.agent.id, false)
  assert.equal(cleared.rera_verified, false)
  assert.equal(cleared.rera_verified_at, null)
})

test('the admin routes map portal refusals onto 400 and 404', async () => {
  assert.equal((await req('PUT', `/api/admin/agents/${tenant.agent.id}/kyc`, { status: 'maybe' }, staff.token)).status, 400)
  assert.equal((await req('PUT', `/api/admin/agents/${MISSING}/kyc`, { status: 'pending' }, staff.token)).status, 404)
  assert.equal((await req('PUT', `/api/admin/agents/${MISSING}/rera-verify`, { verified: true }, staff.token)).status, 404)
  // No body at all must not crash the handler.
  assert.equal((await req('PUT', `/api/admin/agents/${tenant.agent.id}/kyc`, undefined, staff.token)).status, 400)
})

// --- §7.2 Template review -----------------------------------------------------

test('template review refuses an unknown action or a missing template', async () => {
  assert.match((await rejects(() => portal.reviewTemplate(staff.agent.id, MISSING, { action: 'shrug' }))).message, /approve, reject or submit/)
  assert.match((await rejects(() => portal.reviewTemplate(staff.agent.id, MISSING))).message, /approve, reject or submit/)
  assert.equal((await rejects(() => portal.reviewTemplate(staff.agent.id, MISSING, { action: 'approve' }))).code, 'NOT_FOUND')

  assert.equal((await req('PUT', `/api/admin/templates/${MISSING}/review`, { action: 'shrug' }, staff.token)).status, 400)
  assert.equal((await req('PUT', `/api/admin/templates/${MISSING}/review`, { action: 'approve' }, staff.token)).status, 404)
})

test('a rejected template can be resubmitted for review, but an approved one cannot', async () => {
  const tpl = await json(
    await req('POST', '/api/templates', { name: 'site_visit_ping', category: 'utility', body: 'Visiting?' }, tenant.token),
  )
  await req('POST', `/api/templates/${tpl.id}/request-review`, {}, tenant.token)

  const rejected = await portal.reviewTemplate(staff.agent.id, tpl.id, { action: 'reject', note: 'add an opt-out' })
  assert.equal(rejected.review_status, 'rejected')
  assert.equal(rejected.review_note, 'add an opt-out')

  // Rejected is a requestable state; approved is not.
  assert.equal((await portal.requestTemplateReview(tenant.agent.id, tpl.id)).review_status, 'pending_review')
  await portal.reviewTemplate(staff.agent.id, tpl.id, { action: 'approve' })
  assert.equal((await rejects(() => portal.requestTemplateReview(tenant.agent.id, tpl.id))).code, 'NOT_FOUND')

  // And another tenant cannot push someone else's template into the queue.
  assert.equal((await rejects(() => portal.requestTemplateReview(other.agent.id, tpl.id))).code, 'NOT_FOUND')
})

// --- §7.3 Plans, subscriptions, usage, invoices --------------------------------

test('a plan needs a code and a name; a duplicate code is a 409', async () => {
  assert.match((await rejects(() => portal.createPlan({ name: 'No Code' }))).message, /code and name/)
  assert.match((await rejects(() => portal.createPlan({ code: 'nameless' }))).message, /code and name/)
  assert.equal((await req('POST', '/api/admin/plans', { name: 'No Code' }, staff.token)).status, 400)

  const created = await json(await req('POST', '/api/admin/plans', { code: 'dupe', name: 'Dupe' }, staff.token))
  assert.equal(created.code, 'dupe')
  // Unset optionals fall back to the column defaults rather than to nulls.
  assert.equal(Number(created.price_paise), 0)
  assert.equal(created.conversation_quota, null)
  assert.deepEqual(created.features, [])
  assert.equal(created.is_active, true)

  assert.equal((await req('POST', '/api/admin/plans', { code: 'dupe', name: 'Dupe Again' }, staff.token)).status, 409)
})

test('listPlans can be narrowed to the plans still on sale', async () => {
  const retired = await portal.createPlan({ code: 'retired', name: 'Retired', is_active: false })
  const all = await portal.listPlans()
  const live = await portal.listPlans({ activeOnly: true })
  assert.ok(all.some((p) => p.id === retired.id), 'the retired plan is in the full catalogue')
  assert.ok(!live.some((p) => p.id === retired.id), 'but not in the sellable one')
})

test('updatePlan with no fields is a read, not a write', async () => {
  const plan = await portal.createPlan({ code: 'tweak', name: 'Tweak', price_paise: 100 })
  const untouched = await portal.updatePlan(plan.id, {})
  assert.equal(untouched.name, 'Tweak')
  assert.equal(Number(untouched.price_paise), 100)

  const changed = await portal.updatePlan(plan.id, {
    name: 'Tweaked',
    price_paise: 250,
    conversation_quota: 10,
    features: ['a'],
    is_active: false,
  })
  assert.equal(changed.name, 'Tweaked')
  assert.equal(changed.conversation_quota, 10)
  assert.deepEqual(changed.features, ['a'])
  assert.equal(changed.is_active, false)
  assert.equal((await req('PUT', `/api/admin/plans/${plan.id}`, { name: 'Via HTTP' }, staff.token)).status, 200)
})

test('an agent with no subscription reads as null, and an unknown plan is a 404', async () => {
  assert.equal(await portal.getSubscription(other.agent.id), null)
  assert.equal((await rejects(() => portal.setSubscription(other.agent.id, MISSING))).code, 'NOT_FOUND')
  assert.equal(
    (await req('PUT', `/api/admin/agents/${other.agent.id}/subscription`, { plan_id: MISSING }, staff.token)).status,
    404,
  )
})

test('usage bills festive greetings as marketing and defaults to the last 30 days', async () => {
  for (const kind of ['festive', 'festive', 'service', 'utility']) {
    await query(`INSERT INTO message_sends (agent_id, phone, kind) VALUES ($1, '+919812345678', $2)`, [other.agent.id, kind])
  }
  const usage = await portal.agentUsage(other.agent.id)
  const cat = (c) => usage.by_category.find((x) => x.category === c)
  assert.equal(cat('marketing').count, 2, 'festive sends are marketing conversations')
  assert.equal(cat('utility').count, 1)
  assert.equal(cat('service').rate_paise, 0, 'service conversations are free')
  assert.equal(usage.meta_cost_paise, cat('marketing').cost_paise + cat('utility').cost_paise)

  // With no plan there is no quota, so nothing can be over it.
  assert.equal(usage.quota, null)
  assert.equal(usage.over_quota, 0)
  // The default period is the trailing 30 days, ending today.
  assert.equal(usage.period_end, new Date().toISOString().slice(0, 10))
})

test('an invoice for an agent with no plan still bills the overage alone', async () => {
  const tiny = await portal.createPlan({ code: 'tiny', name: 'Tiny', price_paise: 0, conversation_quota: 1 })
  await portal.setSubscription(other.agent.id, tiny.id)

  const usage = await portal.agentUsage(other.agent.id)
  assert.ok(usage.over_quota > 0, 'four conversations against a quota of one')

  const invoice = await portal.generateInvoice(other.agent.id, { note: 'first bill' })
  const lines = invoice.line_items
  assert.equal(lines.length, 2, 'the zero-rupee plan line plus the overage line')
  assert.match(lines[1].description, /Conversation overage/)
  assert.equal(lines[1].amount_paise, usage.over_quota * 100)
  assert.equal(invoice.notes, 'first bill')

  // Invoice numbers are per-agent sequential.
  const second = await portal.generateInvoice(other.agent.id, {})
  assert.notEqual(second.number, invoice.number)
  assert.match(second.number, /-002$/)
})

test('an agent with neither plan nor overage gets an empty, zero-rupee invoice', async () => {
  const blank = await portal.generateInvoice(staff.agent.id, { periodStart: '2026-05-01', periodEnd: '2026-05-31' })
  assert.deepEqual(blank.line_items, [])
  assert.equal(Number(blank.subtotal_paise), 0)
  assert.equal(Number(blank.total_paise), 0)
  assert.match(blank.number, /^HNX-202605-/)
})

test('invoice lookup is tenant-scoped, and an unknown invoice is a 404', async () => {
  const invoice = await portal.generateInvoice(tenant.agent.id, {})
  assert.ok(await portal.getInvoice(invoice.id), 'staff read is unscoped')
  assert.ok(await portal.getInvoice(invoice.id, { agentId: tenant.agent.id }), 'the owner can read it')
  assert.equal(await portal.getInvoice(invoice.id, { agentId: other.agent.id }), null, 'another tenant cannot')
  assert.equal(await portal.getInvoice(MISSING), null)
  assert.equal((await req('GET', `/api/admin/invoices/${MISSING}`, undefined, staff.token)).status, 404)
  // Staff reading a real invoice over HTTP: unscoped, so any tenant's is readable.
  const fetched = await json(await req('GET', `/api/admin/invoices/${invoice.id}`, undefined, staff.token))
  assert.equal(fetched.id, invoice.id)
  assert.equal(fetched.agent_id, tenant.agent.id)
})

test('invoice status transitions validate, and paid_at follows the status', async () => {
  const invoice = await portal.generateInvoice(tenant.agent.id, {})
  assert.match((await rejects(() => portal.setInvoiceStatus(invoice.id, 'refunded'))).message, /Invalid invoice status/)
  assert.equal((await rejects(() => portal.setInvoiceStatus(MISSING, 'paid'))).code, 'NOT_FOUND')

  assert.ok((await portal.setInvoiceStatus(invoice.id, 'paid')).paid_at, 'paying stamps paid_at')
  assert.equal((await portal.setInvoiceStatus(invoice.id, 'issued')).paid_at, null, 're-issuing clears it')
  assert.equal((await portal.setInvoiceStatus(invoice.id, 'draft')).paid_at, null)
  // Voiding leaves paid_at alone — a voided invoice keeps its payment history.
  await portal.setInvoiceStatus(invoice.id, 'paid')
  assert.ok((await portal.setInvoiceStatus(invoice.id, 'void')).paid_at)

  assert.equal((await req('PUT', `/api/admin/invoices/${invoice.id}/status`, { status: 'nope' }, staff.token)).status, 400)
  assert.equal((await req('PUT', `/api/admin/invoices/${MISSING}/status`, { status: 'paid' }, staff.token)).status, 404)
})

test('billing and invoice routes 404 on an agent that does not exist', async () => {
  assert.equal((await req('GET', `/api/admin/agents/${MISSING}/billing`, undefined, staff.token)).status, 404)
  assert.equal((await req('POST', `/api/admin/agents/${MISSING}/invoices`, {}, staff.token)).status, 404)
})

test('a malformed billing period is a 400, not a 500', async () => {
  const realError = console.error
  console.error = () => {}
  try {
    const res = await req(
      'POST',
      `/api/admin/agents/${tenant.agent.id}/invoices`,
      { period_start: 'last tuesday', period_end: '2026-06-30' },
      staff.token,
    )
    assert.equal(res.status, 400)
  } finally {
    console.error = realError
  }
})

// --- §7.4 Support tickets ------------------------------------------------------

test('a ticket needs a non-blank subject and body', async () => {
  assert.match((await rejects(() => portal.createTicket(tenant.agent.id, { subject: '   ', body: 'x' }))).message, /subject is required/)
  assert.match((await rejects(() => portal.createTicket(tenant.agent.id, { subject: 'x', body: '   ' }))).message, /message is required/)
  assert.match((await rejects(() => portal.createTicket(tenant.agent.id))).message, /subject is required/, 'no body at all')
})

test('a ticket that fails mid-insert leaves nothing behind', async () => {
  // priority is CHECK-constrained, so the ticket INSERT succeeds and the message
  // INSERT never runs — the transaction must roll the ticket back with it.
  const before = (await query('SELECT COUNT(*)::int AS n FROM support_tickets')).rows[0].n
  const err = await rejects(() =>
    portal.createTicket(tenant.agent.id, { subject: 'Bad priority', body: 'x', priority: 'catastrophic' }),
  )
  assert.match(err.message, /support_tickets_priority_check|violates check constraint/)
  const after = (await query('SELECT COUNT(*)::int AS n FROM support_tickets')).rows[0].n
  assert.equal(after, before, 'no half-created ticket survived')
})

test('the ticket list filters by tenant, by status, by both, or by neither', async () => {
  const mine = await portal.createTicket(tenant.agent.id, { subject: 'Mine', body: 'hello' })
  const theirs = await portal.createTicket(other.agent.id, { subject: 'Theirs', body: 'hello' })
  await portal.updateTicket(theirs.id, { status: 'resolved' })

  const all = await portal.listTickets()
  assert.ok(all.some((t) => t.id === mine.id) && all.some((t) => t.id === theirs.id), 'the staff queue spans tenants')

  const scoped = await portal.listTickets({ agentId: tenant.agent.id })
  assert.ok(scoped.every((t) => t.agent_id === tenant.agent.id), 'a tenant only sees their own')
  assert.ok(scoped.some((t) => t.id === mine.id))

  const open = await portal.listTickets({ status: 'open' })
  assert.ok(open.every((t) => t.status === 'open'))
  assert.ok(!open.some((t) => t.id === theirs.id), 'the resolved ticket is filtered out')

  const both = await portal.listTickets({ agentId: other.agent.id, status: 'resolved' })
  assert.deepEqual(both.map((t) => t.id), [theirs.id])

  // The same two filters over HTTP, from each side of the wall.
  const staffQueue = await json(await req('GET', '/api/admin/tickets?status=open', undefined, staff.token))
  assert.ok(staffQueue.every((t) => t.status === 'open'))
  const tenantQueue = await json(await req('GET', '/api/support/tickets', undefined, tenant.token))
  assert.ok(tenantQueue.every((t) => t.agent_id === tenant.agent.id))
  assert.ok(!tenantQueue.some((t) => t.id === theirs.id), 'no cross-tenant leak through the list')
})

test('reading a ticket is tenant-scoped and 404s when it is gone', async () => {
  const ticket = await portal.createTicket(tenant.agent.id, { subject: 'Scoped', body: 'hello' })
  assert.ok(await portal.getTicket(ticket.id))
  assert.ok(await portal.getTicket(ticket.id, { agentId: tenant.agent.id }))
  assert.equal(await portal.getTicket(ticket.id, { agentId: other.agent.id }), null)
  assert.equal(await portal.getTicket(MISSING), null)
  assert.equal((await req('GET', `/api/admin/tickets/${MISSING}`, undefined, staff.token)).status, 404)
})

test('replies need a body and a ticket the author is allowed to touch', async () => {
  const ticket = await portal.createTicket(tenant.agent.id, { subject: 'Replies', body: 'hello' })
  assert.match((await rejects(() => portal.addTicketMessage(ticket.id, { body: '  ' }))).message, /message is required/)
  assert.equal((await rejects(() => portal.addTicketMessage(MISSING, { body: 'hi' }))).code, 'NOT_FOUND')
  assert.equal(
    (await rejects(() => portal.addTicketMessage(ticket.id, { body: 'hi' }, { agentId: other.agent.id }))).code,
    'NOT_FOUND',
    'scoped to the wrong tenant',
  )

  // An unattributed staff note is allowed; the author column is simply null.
  const note = await portal.addTicketMessage(ticket.id, { isStaff: true, body: 'internal note' })
  assert.equal(note.author_agent_id, null)
  assert.equal((await portal.getTicket(ticket.id)).status, 'pending', 'a staff reply parks the ticket')

  assert.equal((await req('POST', `/api/admin/tickets/${ticket.id}/reply`, {}, staff.token)).status, 400)
  assert.equal((await req('POST', `/api/admin/tickets/${MISSING}/reply`, { body: 'hi' }, staff.token)).status, 404)
})

test('a reply to a resolved ticket re-opens it', async () => {
  const ticket = await portal.createTicket(tenant.agent.id, { subject: 'Reopen', body: 'hello' })
  await portal.updateTicket(ticket.id, { status: 'resolved' })
  await portal.addTicketMessage(ticket.id, { authorAgentId: tenant.agent.id, isStaff: false, body: 'still broken' })
  assert.equal((await portal.getTicket(ticket.id)).status, 'open')
})

test('updateTicket validates status, clears resolved_at, and no-ops on an empty patch', async () => {
  const ticket = await portal.createTicket(tenant.agent.id, { subject: 'Patch', body: 'hello' })
  assert.match((await rejects(() => portal.updateTicket(ticket.id, { status: 'snoozed' }))).message, /Invalid ticket status/)
  assert.equal((await rejects(() => portal.updateTicket(MISSING, { status: 'open' }))).code, 'NOT_FOUND')

  const untouched = await portal.updateTicket(ticket.id, {})
  assert.equal(untouched.id, ticket.id)
  assert.equal(untouched.status, 'open')
  assert.equal(await portal.updateTicket(MISSING, {}), undefined, 'an empty patch on a ghost reads as nothing')

  assert.ok((await portal.updateTicket(ticket.id, { status: 'closed' })).resolved_at, 'closing stamps resolved_at')
  assert.equal((await portal.updateTicket(ticket.id, { status: 'open' })).resolved_at, null, 're-opening clears it')

  const assigned = await portal.updateTicket(ticket.id, { priority: 'urgent', assigned_to: staff.agent.id })
  assert.equal(assigned.priority, 'urgent')
  assert.equal(assigned.assigned_to, staff.agent.id)
  assert.equal((await portal.updateTicket(ticket.id, { assigned_to: 0 })).assigned_to, null, 'unassigning nulls the column')

  assert.equal((await req('PUT', `/api/admin/tickets/${ticket.id}`, { status: 'snoozed' }, staff.token)).status, 400)
  assert.equal((await req('PUT', `/api/admin/tickets/${MISSING}`, { status: 'open' }, staff.token)).status, 404)
})

// --- Agent administration routes ----------------------------------------------

test('the admin/active and admin/admin routes demand a real boolean', async () => {
  for (const [url, body] of [
    [`/api/admin/agents/${tenant.agent.id}/admin`, { is_admin: 'yes' }],
    [`/api/admin/agents/${tenant.agent.id}/admin`, {}],
    [`/api/admin/agents/${tenant.agent.id}/active`, { is_active: 1 }],
    [`/api/admin/agents/${tenant.agent.id}/active`, {}],
  ]) {
    assert.equal((await req('PUT', url, body, staff.token)).status, 400, url)
  }
  // Missing bodies take the `req.body ?? {}` arm rather than throwing.
  assert.equal((await req('PUT', `/api/admin/agents/${tenant.agent.id}/admin`, undefined, staff.token)).status, 400)
  assert.equal((await req('PUT', `/api/admin/agents/${tenant.agent.id}/active`, undefined, staff.token)).status, 400)
})

test('guard failures on agent administration are conflicts, and ghosts are 404s', async () => {
  // Demoting yourself is a 409 conflict, not a bad request.
  assert.equal((await req('PUT', `/api/admin/agents/${staff.agent.id}/admin`, { is_admin: false }, staff.token)).status, 409)
  assert.equal((await req('PUT', `/api/admin/agents/${staff.agent.id}/active`, { is_active: false }, staff.token)).status, 409)
  assert.equal((await req('PUT', `/api/admin/agents/${MISSING}/admin`, { is_admin: true }, staff.token)).status, 404)
  assert.equal((await req('PUT', `/api/admin/agents/${MISSING}/active`, { is_active: true }, staff.token)).status, 404)
  assert.equal((await req('GET', `/api/admin/agents/${MISSING}`, undefined, staff.token)).status, 404)
})

test('the WABA route needs a status and a real agent', async () => {
  assert.equal((await req('PUT', `/api/admin/agents/${tenant.agent.id}/waba`, {}, staff.token)).status, 400)
  assert.equal((await req('PUT', `/api/admin/agents/${tenant.agent.id}/waba`, undefined, staff.token)).status, 400)
  assert.equal((await req('PUT', `/api/admin/agents/${MISSING}/waba`, { status: 'active' }, staff.token)).status, 404)
  assert.equal(
    (await req('PUT', `/api/admin/agents/${tenant.agent.id}/waba`, { status: 'not-a-status' }, staff.token)).status,
    400,
    'an unknown status is rejected by the updater',
  )
})

test('impersonation refuses a ghost and a suspended agent', async () => {
  assert.equal((await req('POST', `/api/admin/agents/${MISSING}/impersonate`, {}, staff.token)).status, 404)
  const dead = await signup('Dead Devi', '+919760000009')
  await query('UPDATE agents SET is_active = 0, deactivated_at = now() WHERE id = $1', [dead.agent.id])
  assert.equal((await req('POST', `/api/admin/agents/${dead.agent.id}/impersonate`, {}, staff.token)).status, 409)
})

test('the agent list accepts every filter combination the admin UI can send', async () => {
  const page = await json(await req('GET', '/api/admin/agents', undefined, staff.token))
  assert.ok(Array.isArray(page.agents) && typeof page.total === 'number')
  const filtered = await json(
    await req('GET', '/api/admin/agents?search=Tarun&status=active&active=1&page=1&pageSize=5', undefined, staff.token),
  )
  assert.ok(filtered.agents.every((a) => /Tarun/i.test(a.name)))
  const inactive = await json(await req('GET', '/api/admin/agents?active=0', undefined, staff.token))
  assert.ok(inactive.agents.every((a) => a.is_active === 0))
})
