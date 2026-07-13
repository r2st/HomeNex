// Tests for the Admin Portal (§7): onboarding + KYC/RERA verification, WABA health,
// impersonation, template approval workflow, billing/GST invoices, support tickets,
// and platform analytics. Run with: npm test (from server/) — needs local PostgreSQL.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
const dbName = await createTestDb('adminportal')

const { app } = await import('../index.js')
const { closePool, query, setAdmin } = await import('../db.js')

let server
let base
let adminTok, admin, agentTok, agent, otherTok, other
const PASSWORD = 'secret123'

const req = (method, url, body, tok = adminTok) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

const signup = async (name, phone) =>
  (await req('POST', '/api/auth/signup', { name, phone, password: PASSWORD }, null)).json()

before(async () => {
  await new Promise((r) => (server = app.listen(0, () => (r((base = `http://127.0.0.1:${server.address().port}`))))))
  ;({ token: adminTok, agent: admin } = await signup('Admin Anita', '+919900000001'))
  ;({ token: agentTok, agent } = await signup('Broker Bharat', '+919900000002'))
  ;({ token: otherTok, agent: other } = await signup('Broker Charu', '+919900000003'))
  await req('GET', '/api/admin/dashboard') // auto-promotes agent #1 (Anita) to admin
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- Access control ---

test('the admin portal rejects a non-admin', async () => {
  for (const url of ['/api/admin/onboarding', '/api/admin/tickets', '/api/admin/analytics', '/api/admin/plans']) {
    assert.equal((await req('GET', url, undefined, agentTok)).status, 403, url)
  }
})

// --- §7.1 Onboarding + KYC/RERA + WABA health + impersonation ---

test('onboarding queue lists unverified agents with a checklist', async () => {
  const queue = await (await req('GET', '/api/admin/onboarding')).json()
  const row = queue.find((a) => a.id === agent.id)
  assert.ok(row, 'the new agent is in the queue')
  assert.equal(row.steps.kyc, false)
  assert.equal(row.steps.waba, false)
})

test('KYC verification stamps status and reviewer', async () => {
  const res = await req('PUT', `/api/admin/agents/${agent.id}/kyc`, { status: 'verified', note: 'PAN + Aadhaar OK' })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).kyc_status, 'verified')
  const audit = await (await req('GET', '/api/admin/audit-logs')).json()
  assert.ok(audit.some((l) => l.action === 'kyc_reviewed' && l.entity_id === agent.id))
})

test('RERA verification toggles the verified flag', async () => {
  const res = await req('PUT', `/api/admin/agents/${agent.id}/rera-verify`, { verified: true })
  assert.equal((await res.json()).rera_verified, true)
})

test('the WABA health board reports every agent', async () => {
  const board = await (await req('GET', '/api/admin/waba-health')).json()
  assert.ok(board.length >= 3)
  assert.ok('sends_7d' in board[0] && 'waba_status' in board[0])
})

test('impersonation mints a working session for the target and audits it', async () => {
  const res = await req('POST', `/api/admin/agents/${agent.id}/impersonate`)
  assert.equal(res.status, 200)
  const { token } = await res.json()
  const me = await (await req('GET', '/api/auth/me', undefined, token)).json()
  assert.equal(me.id, agent.id, 'the minted token acts as the target agent')
  const audit = await (await req('GET', '/api/admin/audit-logs')).json()
  assert.ok(audit.some((l) => l.action === 'impersonation_started' && l.entity_id === agent.id))
})

// --- §7.2 Template approval workflow ---

test('agent requests review → staff approves', async () => {
  const tpl = await (
    await req('POST', '/api/templates', { name: 'diwali_offer', category: 'marketing', body: 'Happy Diwali!' }, agentTok)
  ).json()
  assert.equal((await req('POST', `/api/templates/${tpl.id}/request-review`, {}, agentTok)).status, 200)

  const pending = await (await req('GET', '/api/admin/templates/pending')).json()
  assert.ok(pending.some((t) => t.id === tpl.id && t.agent_name === 'Broker Bharat'))

  const reviewed = await (
    await req('PUT', `/api/admin/templates/${tpl.id}/review`, { action: 'approve', note: 'looks good' })
  ).json()
  assert.equal(reviewed.review_status, 'approved')

  // Submitting to Meta flips meta_status back to pending.
  const submitted = await (await req('PUT', `/api/admin/templates/${tpl.id}/review`, { action: 'submit' })).json()
  assert.equal(submitted.review_status, 'submitted')
  assert.equal(submitted.meta_status, 'pending')
})

// --- §7.3 Billing, usage metering, GST invoices ---

test('plans are seeded and a subscription can be assigned', async () => {
  const plans = await (await req('GET', '/api/admin/plans')).json()
  assert.ok(plans.length >= 4)
  const growth = plans.find((p) => p.code === 'growth')
  assert.equal(growth.price_paise, 299900)

  const sub = await (
    await req('PUT', `/api/admin/agents/${agent.id}/subscription`, { plan_id: growth.id })
  ).json()
  assert.equal(sub.plan_code, 'growth')
})

test('usage metering counts conversations by category', async () => {
  // Seed a few outbound sends of different categories.
  for (const kind of ['marketing', 'marketing', 'utility']) {
    await query(
      `INSERT INTO message_sends (agent_id, phone, kind, sent_at) VALUES ($1, '+919812345678', $2, now())`,
      [agent.id, kind],
    )
  }
  const billing = await (await req('GET', `/api/admin/agents/${agent.id}/billing`)).json()
  const marketing = billing.usage.by_category.find((c) => c.category === 'marketing')
  assert.equal(marketing.count, 2)
  assert.equal(marketing.cost_paise, 2 * marketing.rate_paise)
  assert.equal(billing.subscription.plan_code, 'growth')
})

test('invoice generation splits GST 18% exactly, in paise', async () => {
  const res = await req('POST', `/api/admin/agents/${agent.id}/invoices`, {
    period_start: '2026-06-01',
    period_end: '2026-06-30',
  })
  assert.equal(res.status, 200)
  const inv = await res.json()
  // Growth plan is 299900 paise; GST 18% = 53982; total 353882.
  assert.equal(inv.subtotal_paise, 299900)
  assert.equal(inv.gst_paise, 53982)
  assert.equal(inv.total_paise, 353882)
  assert.equal(inv.subtotal_paise + inv.gst_paise, inv.total_paise)
  assert.match(inv.number, /^HNX-202606-/)

  const paid = await (await req('PUT', `/api/admin/invoices/${inv.id}/status`, { status: 'paid' })).json()
  assert.equal(paid.status, 'paid')

  // The agent can see their own invoice but not another agent's.
  assert.equal((await req('GET', `/api/billing/invoices/${inv.id}`, undefined, agentTok)).status, 200)
  assert.equal((await req('GET', `/api/billing/invoices/${inv.id}`, undefined, otherTok)).status, 404)
})

// --- §7.4 Support tickets ---

test('agent opens a ticket, staff and agent exchange replies', async () => {
  const ticket = await (
    await req(
      'POST',
      '/api/support/tickets',
      { subject: 'Number not sending', body: 'My WhatsApp stopped delivering.', category: 'whatsapp' },
      agentTok,
    )
  ).json()
  assert.equal(ticket.status, 'open')

  // Staff sees it in the queue with tenant context.
  const queue = await (await req('GET', '/api/admin/tickets')).json()
  const staffView = queue.find((t) => t.id === ticket.id)
  assert.equal(staffView.agent_name, 'Broker Bharat')
  assert.equal(staffView.message_count, 1)

  // Staff replies → pending; full thread is visible.
  await req('POST', `/api/admin/tickets/${ticket.id}/reply`, { body: 'Please refresh your token.' })
  const detail = await (await req('GET', `/api/admin/tickets/${ticket.id}`)).json()
  assert.equal(detail.status, 'pending')
  assert.equal(detail.messages.length, 2)
  assert.equal(detail.messages[1].is_staff, true)

  // Agent replies → back to open.
  await req('POST', `/api/support/tickets/${ticket.id}/reply`, { body: 'Done, still failing.' }, agentTok)
  const reopened = await (await req('GET', `/api/admin/tickets/${ticket.id}`)).json()
  assert.equal(reopened.status, 'open')

  // A different agent cannot read this ticket.
  assert.equal((await req('GET', `/api/support/tickets/${ticket.id}`, undefined, otherTok)).status, 404)

  // Staff resolves it.
  const resolved = await (await req('PUT', `/api/admin/tickets/${ticket.id}`, { status: 'resolved' })).json()
  assert.equal(resolved.status, 'resolved')
  assert.ok(resolved.resolved_at)
})

test('a ticket requires a subject and a body', async () => {
  assert.equal((await req('POST', '/api/support/tickets', { subject: '', body: 'x' }, agentTok)).status, 400)
  assert.equal((await req('POST', '/api/support/tickets', { subject: 'x', body: '' }, agentTok)).status, 400)
})

// --- §7.5 Platform analytics ---

test('platform analytics returns cohorts, retention, feature usage and cities', async () => {
  const a = await (await req('GET', '/api/admin/analytics')).json()
  assert.ok(Array.isArray(a.cohorts))
  assert.ok('active_7d' in a.retention)
  assert.ok('teams' in a.feature_usage)
  assert.ok(Array.isArray(a.cities))
})
