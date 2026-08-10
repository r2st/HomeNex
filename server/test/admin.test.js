// Tests for the admin API used by the standalone admin website (adminRoutes.js):
// dashboard stats, paginated/searchable agent list, agent detail, profile edit, WABA update.
// Run with: npm test  (from server/)  — needs a local PostgreSQL (docker compose up -d).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

// Isolate a throwaway database and skip listen() before importing the app.
process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
const dbName = await createTestDb('admin')

const { app } = await import('../index.js')
const { closePool, upsertLead, addMessage, setAdmin } = await import('../db.js')

let server
let base
let adminToken // agent #1, auto-promoted to admin
let userToken // plain agent
let adminAgent
let plainAgent

const req = (method, url, body, tok = adminToken) =>
  fetch(base + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  // First signup becomes admin via auto-promote on first admin hit.
  let res = await req('POST', '/api/auth/signup', {
    name: 'Admin Anita',
    phone: '+919700000001',
    email: 'anita@homenex.in',
    password: 'secret123',
  }, null)
  ;({ token: adminToken, agent: adminAgent } = await res.json())

  res = await req('POST', '/api/auth/signup', {
    name: 'Broker Bala',
    phone: '+919700000002',
    email: 'bala@homenex.in',
    password: 'secret123',
    wa_phone_number: '+919700000099',
  }, null)
  ;({ token: userToken, agent: plainAgent } = await res.json())

  // A few more agents so pagination is meaningful.
  for (let i = 3; i <= 7; i++) {
    await req('POST', '/api/auth/signup', {
      name: `Agent ${i}`,
      phone: `+91970000000${i}`,
      password: 'secret123',
    }, null)
  }
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// === Auth guards ===

test('admin routes require auth', async () => {
  for (const [method, url] of [
    ['GET', '/api/admin/dashboard'],
    ['GET', '/api/admin/agents'],
    ['GET', '/api/admin/agents/1'],
    ['PUT', '/api/admin/agents/1'],
    ['PUT', '/api/admin/agents/1/waba'],
  ]) {
    const res = await req(method, url, method === 'PUT' ? {} : undefined, null)
    assert.equal(res.status, 401, `${method} ${url} should 401 without token`)
  }
})

test('first agent is auto-promoted, non-admin gets 403 on every admin route', async () => {
  // Trigger auto-promote with the admin's first hit.
  const ok = await req('GET', '/api/admin/dashboard')
  assert.equal(ok.status, 200)

  for (const [method, url] of [
    ['GET', '/api/admin/dashboard'],
    ['GET', '/api/admin/agents'],
    ['GET', `/api/admin/agents/${adminAgent.id}`],
    ['PUT', `/api/admin/agents/${adminAgent.id}`],
    ['PUT', `/api/admin/agents/${adminAgent.id}/waba`],
  ]) {
    const res = await req(method, url, method === 'PUT' ? { status: 'pending' } : undefined, userToken)
    assert.equal(res.status, 403, `${method} ${url} should 403 for non-admin`)
  }
})

// === GET /api/admin/dashboard ===

test('dashboard returns platform stats with signup and WABA breakdowns', async () => {
  // Seed one active conversation.
  const lead = await upsertLead(plainAgent.id, '919888800001', 'Test Buyer')
  await addMessage(lead.id, 'buyer', 'Looking for a 2BHK in Baner')

  const res = await req('GET', '/api/admin/dashboard')
  assert.equal(res.status, 200)
  const s = await res.json()
  assert.equal(s.totalAgents, 7)
  assert.equal(s.newAgents7d, 7) // all created just now
  assert.equal(s.newAgents30d, 7)
  // Single-number model: every signup's WA Business number defaults to the login
  // number (see auth.js signup), so every agent starts 'pending', none stay 'none'.
  assert.equal(s.pendingWaba, 7)
  assert.equal(s.noneWaba, 0)
  assert.equal(s.registeredWaba, 0)
  assert.equal(s.activeWaba, 0)
  assert.ok(s.activeConversations >= 1)
  assert.ok(typeof s.totalLeads === 'number')
  assert.ok(typeof s.totalContacts === 'number')
})

// === GET /api/admin/agents (pagination, search, filter) ===

test('agents list is paginated with metadata', async () => {
  const res = await req('GET', '/api/admin/agents?page=1&pageSize=3')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.agents.length, 3)
  assert.equal(body.total, 7)
  assert.equal(body.page, 1)
  assert.equal(body.pageSize, 3)
  assert.equal(body.totalPages, 3)

  const page3 = await (await req('GET', '/api/admin/agents?page=3&pageSize=3')).json()
  assert.equal(page3.agents.length, 1)
  // No overlap between pages
  const ids1 = body.agents.map((a) => a.id)
  assert.ok(!ids1.includes(page3.agents[0].id))
})

test('agents list rows include admin columns (last_active, lead_count, waba fields)', async () => {
  const body = await (await req('GET', '/api/admin/agents')).json()
  const bala = body.agents.find((a) => a.id === plainAgent.id)
  assert.ok(bala)
  assert.equal(bala.lead_count, 1)
  assert.ok('last_active' in bala)
  assert.ok('waba_status' in bala)
  assert.ok('wa_phone_number' in bala)
  assert.ok('is_admin' in bala)
})

test('agents list supports search by name, email and phone', async () => {
  const byName = await (await req('GET', '/api/admin/agents?search=Bala')).json()
  assert.equal(byName.total, 1)
  assert.equal(byName.agents[0].id, plainAgent.id)

  const byEmail = await (await req('GET', '/api/admin/agents?search=anita@')).json()
  assert.equal(byEmail.total, 1)
  assert.equal(byEmail.agents[0].id, adminAgent.id)

  const byPhone = await (await req('GET', '/api/admin/agents?search=9700000002')).json()
  assert.equal(byPhone.total, 1)
  assert.equal(byPhone.agents[0].id, plainAgent.id)

  const none = await (await req('GET', '/api/admin/agents?search=zzz-no-match')).json()
  assert.equal(none.total, 0)
  assert.equal(none.agents.length, 0)
})

test('agents list filters by waba_status', async () => {
  // Single-number model: every agent defaults to 'pending' (see comment above); none
  // are 'none'.
  const pending = await (await req('GET', '/api/admin/agents?status=pending')).json()
  assert.equal(pending.total, 7)

  const noneStatus = await (await req('GET', '/api/admin/agents?status=none')).json()
  assert.equal(noneStatus.total, 0)

  // Search and filter combine.
  const combo = await (await req('GET', '/api/admin/agents?status=pending&search=Anita')).json()
  assert.equal(combo.total, 1)
  assert.equal(combo.agents[0].id, adminAgent.id)
})

// === GET /api/admin/agents/:id ===

test('agent detail returns profile, counts and recent activity', async () => {
  const res = await req('GET', `/api/admin/agents/${plainAgent.id}`)
  assert.equal(res.status, 200)
  const a = await res.json()
  assert.equal(a.id, plainAgent.id)
  assert.equal(a.name, 'Broker Bala')
  assert.equal(a.email, 'bala@homenex.in')
  assert.equal(a.waba_status, 'pending')
  assert.equal(a.lead_count, 1)
  assert.equal(a.message_count, 1)
  assert.ok(Array.isArray(a.recent_activity))
})

test('agent detail 404s on unknown id', async () => {
  const res = await req('GET', '/api/admin/agents/99999')
  assert.equal(res.status, 404)
})

// === PUT /api/admin/agents/:id ===

test('admin can edit agent profile fields', async () => {
  const res = await req('PUT', `/api/admin/agents/${plainAgent.id}`, {
    name: 'Bala Krishnan',
    email: 'bala.k@homenex.in',
  })
  assert.equal(res.status, 200)
  const a = await res.json()
  assert.equal(a.name, 'Bala Krishnan')
  assert.equal(a.email, 'bala.k@homenex.in')
  // Untouched fields survive.
  assert.equal(a.phone, '+919700000002')
  assert.equal(a.waba_status, 'pending')
})

test('profile edit validates input', async () => {
  assert.equal((await req('PUT', `/api/admin/agents/${plainAgent.id}`, { name: '  ' })).status, 400)
  assert.equal((await req('PUT', `/api/admin/agents/${plainAgent.id}`, { email: 'not-an-email' })).status, 400)
  assert.equal((await req('PUT', `/api/admin/agents/${plainAgent.id}`, { phone: '12' })).status, 400)
})

test('profile edit rejects duplicate email/phone with 409', async () => {
  const dupEmail = await req('PUT', `/api/admin/agents/${plainAgent.id}`, { email: 'anita@homenex.in' })
  assert.equal(dupEmail.status, 409)
  const dupPhone = await req('PUT', `/api/admin/agents/${plainAgent.id}`, { phone: '+919700000001' })
  assert.equal(dupPhone.status, 409)
})

test('profile edit 404s on unknown id', async () => {
  const res = await req('PUT', '/api/admin/agents/99999', { name: 'Ghost' })
  assert.equal(res.status, 404)
})

test('admin can grant and revoke admin rights', async () => {
  let a = await (await req('PUT', `/api/admin/agents/${plainAgent.id}`, { is_admin: true })).json()
  assert.equal(a.is_admin, 1)
  // Bala can now hit admin routes...
  assert.equal((await req('GET', '/api/admin/dashboard', undefined, userToken)).status, 200)
  // ...until revoked.
  a = await (await req('PUT', `/api/admin/agents/${plainAgent.id}`, { is_admin: false })).json()
  assert.equal(a.is_admin, 0)
  assert.equal((await req('GET', '/api/admin/dashboard', undefined, userToken)).status, 403)
})

// === PUT /api/admin/agents/:id/waba ===

test('WABA workflow: pending -> registered with Meta IDs -> active', async () => {
  let res = await req('PUT', `/api/admin/agents/${plainAgent.id}/waba`, {
    status: 'registered',
    meta_waba_id: 'waba_777',
    wa_phone_number_id: 'pnid_777',
  })
  assert.equal(res.status, 200)
  let a = await res.json()
  assert.equal(a.waba_status, 'registered')
  assert.equal(a.meta_waba_id, 'waba_777')
  assert.equal(a.wa_phone_number_id, 'pnid_777')
  assert.ok(a.waba_registered_at)

  res = await req('PUT', `/api/admin/agents/${plainAgent.id}/waba`, { status: 'active' })
  a = await res.json()
  assert.equal(a.waba_status, 'active')

  // Dashboard reflects the change. The other 6 agents stay 'pending' — only Bala moved.
  const s = await (await req('GET', '/api/admin/dashboard')).json()
  assert.equal(s.activeWaba, 1)
  assert.equal(s.pendingWaba, 6)
})

test('WABA update validates status and id', async () => {
  assert.equal((await req('PUT', `/api/admin/agents/${plainAgent.id}/waba`, {})).status, 400)
  assert.equal((await req('PUT', `/api/admin/agents/${plainAgent.id}/waba`, { status: 'bogus' })).status, 400)
  assert.equal((await req('PUT', '/api/admin/agents/99999/waba', { status: 'pending' })).status, 404)
})

// setAdmin is exercised indirectly via is_admin edits; keep the export honest.
test('setAdmin db helper toggles the flag', async () => {
  assert.equal((await setAdmin(plainAgent.id, true)).is_admin, 1)
  assert.equal((await setAdmin(plainAgent.id, false)).is_admin, 0)
})

// Body-parser leaves req.body undefined when a request carries no JSON content-type.
// The admin routes read `req.body ?? {}`; that fallback has to hold, because these
// routes flip admin rights and suspend accounts and must fail closed, not 500.
test('no admin write route 500s on a request with no body', async () => {
  const bare = (method, url) =>
    fetch(base + url, { method, headers: { authorization: `Bearer ${adminToken}` } })

  const routes = [
    ['PUT', `/api/admin/agents/${plainAgent.id}`],
    ['PUT', `/api/admin/agents/${plainAgent.id}/admin`],
    ['PUT', `/api/admin/agents/${plainAgent.id}/active`],
    ['PUT', `/api/admin/agents/${plainAgent.id}/waba`],
    ['POST', '/api/admin/plans'],
    ['PUT', '/api/admin/plans/999999'],
  ]
  const broken = []
  for (const [method, url] of routes) {
    const res = await bare(method, url)
    if (res.status >= 500) broken.push(`${method} ${url} -> ${res.status}`)
  }
  assert.deepEqual(broken, [], 'admin routes that mishandled an absent body')

  // The two boolean toggles must specifically refuse, not read undefined as false and
  // quietly revoke admin or suspend the account.
  assert.equal((await bare('PUT', `/api/admin/agents/${plainAgent.id}/admin`)).status, 400)
  assert.equal((await bare('PUT', `/api/admin/agents/${plainAgent.id}/active`)).status, 400)
  const untouched = await (await req('GET', `/api/admin/agents/${plainAgent.id}`)).json()
  assert.equal(untouched.is_active, 1, 'the account was not suspended by an empty request')
})
