// Tests for admin team management exposed on the main site: promote/demote admins,
// deactivate/reactivate agents, and the platform-wide audit trail.
// Run with: npm test  (from server/) — needs a local PostgreSQL.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

// Isolate a throwaway database and skip listen() before importing the app.
process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
const dbName = await createTestDb('adminteam')

const { app } = await import('../index.js')
const {
  closePool,
  getAgent,
  setAdmin,
  setAgentAdmin,
  setAgentActive,
  countActiveAdmins,
  ensureAdminExists,
  listAgentsAdmin,
  listAllAuditLogs,
  findAgentByPhoneNumberId,
  updateAgentPhoneConfig,
  updateWabaStatus,
} = await import('../db.js')

let server
let base
let adminToken // agent #1, auto-promoted to admin
let balaToken
let chetToken
let adminAgent
let bala
let chet

const PASSWORD = 'secret123'

const req = (method, url, body, tok = adminToken) =>
  fetch(base + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

const signup = async (name, phone) => {
  const res = await req('POST', '/api/auth/signup', { name, phone, password: PASSWORD }, null)
  return res.json()
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  ;({ token: adminToken, agent: adminAgent } = await signup('Admin Anita', '+919700000001'))
  ;({ token: balaToken, agent: bala } = await signup('Broker Bala', '+919700000002'))
  ;({ token: chetToken, agent: chet } = await signup('Broker Chetan', '+919700000003'))
  // First admin-route hit auto-promotes agent #1.
  await req('GET', '/api/admin/dashboard')
})

// Each test starts from: Anita is the only admin, everyone is active.
beforeEach(async () => {
  await setAdmin(adminAgent.id, true)
  await setAdmin(bala.id, false)
  await setAdmin(chet.id, false)
  for (const id of [adminAgent.id, bala.id, chet.id]) await setAgentActive(adminAgent.id, id, true)
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- Access control ---

test('team routes reject a non-admin with 403', async () => {
  for (const [method, url, body] of [
    ['PUT', `/api/admin/agents/${chet.id}/admin`, { is_admin: true }],
    ['PUT', `/api/admin/agents/${chet.id}/active`, { is_active: false }],
    ['GET', '/api/admin/audit-logs', undefined],
  ]) {
    const res = await req(method, url, body, balaToken)
    assert.equal(res.status, 403, `${method} ${url}`)
    assert.match((await res.json()).error, /Admin access required/)
  }
  assert.equal((await getAgent(chet.id)).is_admin, 0, 'unchanged')
})

test('team routes reject unauthenticated requests with 401', async () => {
  const res = await req('PUT', `/api/admin/agents/${chet.id}/admin`, { is_admin: true }, null)
  assert.equal(res.status, 401)
})

// --- Promote / demote ---

test('PUT /api/admin/agents/:id/admin grants admin access', async () => {
  const res = await req('PUT', `/api/admin/agents/${bala.id}/admin`, { is_admin: true })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.is_admin, 1)
  assert.equal(body.password_hash, undefined, 'never leaks the hash')

  // The newly promoted agent can now reach the admin API.
  assert.equal((await req('GET', '/api/admin/dashboard', undefined, balaToken)).status, 200)
})

test('PUT /api/admin/agents/:id/admin revokes another admin', async () => {
  await req('PUT', `/api/admin/agents/${bala.id}/admin`, { is_admin: true })
  const res = await req('PUT', `/api/admin/agents/${bala.id}/admin`, { is_admin: false })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).is_admin, 0)
  assert.equal((await req('GET', '/api/admin/dashboard', undefined, balaToken)).status, 403, 'locked out again')
})

test('PUT /api/admin/agents/:id/admin is idempotent', async () => {
  await req('PUT', `/api/admin/agents/${bala.id}/admin`, { is_admin: true })
  const res = await req('PUT', `/api/admin/agents/${bala.id}/admin`, { is_admin: true })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).is_admin, 1)
})

test('an admin cannot revoke their own admin access', async () => {
  const res = await req('PUT', `/api/admin/agents/${adminAgent.id}/admin`, { is_admin: false })
  assert.equal(res.status, 409)
  assert.match((await res.json()).error, /cannot remove your own admin access/)
  assert.equal((await getAgent(adminAgent.id)).is_admin, 1, 'still admin')
})

test('a promoted admin can demote the agent who promoted them', async () => {
  // Two admins exist, so the invariant holds and this is allowed.
  await req('PUT', `/api/admin/agents/${bala.id}/admin`, { is_admin: true })
  const res = await req('PUT', `/api/admin/agents/${adminAgent.id}/admin`, { is_admin: false }, balaToken)
  assert.equal(res.status, 200)
  assert.equal((await getAgent(adminAgent.id)).is_admin, 0)
  assert.equal(await countActiveAdmins(), 1)
})

test('the last active admin can never be demoted', async () => {
  // Not reachable through the route (the only active admin demoting themselves is
  // caught as a self-demote first), so the invariant is asserted at the DB layer.
  assert.equal(await countActiveAdmins(), 1)
  await assert.rejects(
    () => setAgentAdmin(bala.id, adminAgent.id, false),
    (err) => err.code === 'LAST_ADMIN' && /At least one admin must remain/.test(err.message),
  )
  assert.equal((await getAgent(adminAgent.id)).is_admin, 1)
})

test('an admin who is already deactivated can be demoted', async () => {
  await req('PUT', `/api/admin/agents/${bala.id}/admin`, { is_admin: true })
  await req('PUT', `/api/admin/agents/${bala.id}/active`, { is_active: false })
  // Anita is now the only *active* admin, but demoting inactive Bala costs nothing.
  const res = await req('PUT', `/api/admin/agents/${bala.id}/admin`, { is_admin: false })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).is_admin, 0)
})

test('a deactivated agent cannot be promoted to admin', async () => {
  await req('PUT', `/api/admin/agents/${chet.id}/active`, { is_active: false })
  const res = await req('PUT', `/api/admin/agents/${chet.id}/admin`, { is_admin: true })
  assert.equal(res.status, 409)
  assert.match((await res.json()).error, /Reactivate this agent/)
  assert.equal((await getAgent(chet.id)).is_admin, 0)
})

test('PUT /api/admin/agents/:id/admin requires a boolean', async () => {
  for (const is_admin of ['yes', 1, null, undefined]) {
    const res = await req('PUT', `/api/admin/agents/${bala.id}/admin`, { is_admin })
    assert.equal(res.status, 400, `${JSON.stringify(is_admin)} should be rejected`)
    assert.match((await res.json()).error, /must be true or false/)
  }
})

test('PUT /api/admin/agents/:id/admin 404s on an unknown agent', async () => {
  const res = await req('PUT', '/api/admin/agents/999999/admin', { is_admin: true })
  assert.equal(res.status, 404)
})

test('the legacy profile route cannot bypass the admin guards', async () => {
  // PUT /agents/:id also accepts is_admin; it must honour the self-demote guard.
  const res = await req('PUT', `/api/admin/agents/${adminAgent.id}`, { is_admin: false })
  assert.equal(res.status, 409)
  assert.equal((await getAgent(adminAgent.id)).is_admin, 1, 'still admin')
})

test('the legacy profile route still promotes and edits in one call', async () => {
  const res = await req('PUT', `/api/admin/agents/${bala.id}`, { is_admin: true, name: 'Bala Reddy' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.is_admin, 1)
  assert.equal(body.name, 'Bala Reddy')
  // beforeEach resets roles and activation, not names.
  await req('PUT', `/api/admin/agents/${bala.id}`, { name: 'Broker Bala' })
})

// --- Deactivate / reactivate ---

test('PUT /api/admin/agents/:id/active deactivates an agent', async () => {
  const res = await req('PUT', `/api/admin/agents/${bala.id}/active`, { is_active: false })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.is_active, 0)
  assert.ok(body.deactivated_at, 'deactivated_at is stamped')
})

test('deactivation revokes the agent existing session immediately', async () => {
  assert.equal((await req('GET', '/api/auth/me', undefined, balaToken)).status, 200)
  await req('PUT', `/api/admin/agents/${bala.id}/active`, { is_active: false })
  assert.equal((await req('GET', '/api/auth/me', undefined, balaToken)).status, 401, 'token rejected')
  assert.equal((await req('GET', '/api/leads', undefined, balaToken)).status, 401, 'API closed')
})

test('a deactivated agent cannot log in, even with the right password', async () => {
  await req('PUT', `/api/admin/agents/${bala.id}/active`, { is_active: false })
  const res = await req('POST', '/api/auth/login', { phone: bala.phone, password: PASSWORD }, null)
  assert.equal(res.status, 403, 'not 401 — the credentials were right')
  assert.match((await res.json()).error, /deactivated/i)
})

test('a deactivated agent with a wrong password still gets a plain 401', async () => {
  // The suspension must not be discoverable by someone without the credentials.
  await req('PUT', `/api/admin/agents/${bala.id}/active`, { is_active: false })
  const res = await req('POST', '/api/auth/login', { phone: bala.phone, password: 'wrong' }, null)
  assert.equal(res.status, 401)
  assert.match((await res.json()).error, /Wrong WhatsApp number or password/)
})

test('reactivation restores login and clears deactivated_at', async () => {
  await req('PUT', `/api/admin/agents/${bala.id}/active`, { is_active: false })
  const res = await req('PUT', `/api/admin/agents/${bala.id}/active`, { is_active: true })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.is_active, 1)
  assert.equal(body.deactivated_at, null)

  const login = await req('POST', '/api/auth/login', { phone: bala.phone, password: PASSWORD }, null)
  assert.equal(login.status, 200)
  // The old token works again: it is an HMAC of the agent id, not a stored session.
  assert.equal((await req('GET', '/api/auth/me', undefined, balaToken)).status, 200)
})

test('deactivation keeps the agent data intact', async () => {
  await req('PUT', `/api/admin/agents/${bala.id}/active`, { is_active: false })
  const detail = await (await req('GET', `/api/admin/agents/${bala.id}`)).json()
  assert.equal(detail.is_active, 0)
  assert.equal(detail.name, 'Broker Bala')
  assert.equal(typeof detail.lead_count, 'number')
  assert.equal(typeof detail.contact_count, 'number')
})

test('an admin cannot deactivate their own account', async () => {
  const res = await req('PUT', `/api/admin/agents/${adminAgent.id}/active`, { is_active: false })
  assert.equal(res.status, 409)
  assert.match((await res.json()).error, /cannot deactivate your own account/)
  assert.equal((await getAgent(adminAgent.id)).is_active, 1)
})

test('the last active admin can never be deactivated', async () => {
  assert.equal(await countActiveAdmins(), 1)
  await assert.rejects(
    () => setAgentActive(bala.id, adminAgent.id, false),
    (err) => err.code === 'LAST_ADMIN' && /At least one active admin must remain/.test(err.message),
  )
  assert.equal((await getAgent(adminAgent.id)).is_active, 1)
})

test('an admin can be deactivated while another active admin remains', async () => {
  await req('PUT', `/api/admin/agents/${bala.id}/admin`, { is_admin: true })
  const res = await req('PUT', `/api/admin/agents/${bala.id}/active`, { is_active: false }, adminToken)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).is_active, 0)
})

test('PUT /api/admin/agents/:id/active is idempotent', async () => {
  const first = await req('PUT', `/api/admin/agents/${bala.id}/active`, { is_active: true })
  assert.equal(first.status, 200)
  assert.equal((await first.json()).is_active, 1)
})

test('PUT /api/admin/agents/:id/active requires a boolean', async () => {
  const res = await req('PUT', `/api/admin/agents/${bala.id}/active`, { is_active: 'no' })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /must be true or false/)
})

test('PUT /api/admin/agents/:id/active 404s on an unknown agent', async () => {
  const res = await req('PUT', '/api/admin/agents/999999/active', { is_active: false })
  assert.equal(res.status, 404)
})

// --- Deactivation and the rest of the system ---

test('a deactivated agent stops receiving inbound WhatsApp messages', async () => {
  await updateAgentPhoneConfig(chet.id, '+919700009999', 'pnid_chetan_team_test')
  await updateWabaStatus(chet.id, { status: 'active' })
  assert.equal((await findAgentByPhoneNumberId('pnid_chetan_team_test'))?.id, chet.id)

  await setAgentActive(adminAgent.id, chet.id, false)
  assert.equal(await findAgentByPhoneNumberId('pnid_chetan_team_test'), null, 'line stops capturing leads')

  await setAgentActive(adminAgent.id, chet.id, true)
  assert.equal((await findAgentByPhoneNumberId('pnid_chetan_team_test'))?.id, chet.id)
  await updateAgentPhoneConfig(chet.id, null, null)
})

test('ensureAdminExists promotes the first active agent, never a deactivated one', async () => {
  await setAgentActive(adminAgent.id, bala.id, false)
  await setAdmin(adminAgent.id, false) // no admins at all now
  await setAgentActive(bala.id, adminAgent.id, false) // and agent #1 is deactivated too

  await ensureAdminExists()
  assert.equal((await getAgent(adminAgent.id)).is_admin, 0, 'deactivated agent #1 not promoted')
  assert.equal((await getAgent(bala.id)).is_admin, 0, 'deactivated agent #2 not promoted')
  assert.equal((await getAgent(chet.id)).is_admin, 1, 'first *active* agent promoted')

  await setAdmin(chet.id, false)
})

// --- Agent listing ---

test('GET /api/admin/agents exposes activation state', async () => {
  await req('PUT', `/api/admin/agents/${bala.id}/active`, { is_active: false })
  const { agents } = await (await req('GET', '/api/admin/agents')).json()
  const listed = agents.find((a) => a.id === bala.id)
  assert.equal(listed.is_active, 0)
  assert.ok(listed.deactivated_at)
  assert.equal(listed.password_hash, undefined, 'never leaks the hash')
})

test('GET /api/admin/agents?active= filters on activation state', async () => {
  await req('PUT', `/api/admin/agents/${bala.id}/active`, { is_active: false })

  const inactive = await (await req('GET', '/api/admin/agents?active=0')).json()
  assert.deepEqual(inactive.agents.map((a) => a.id), [bala.id])
  assert.equal(inactive.total, 1)

  const active = await (await req('GET', '/api/admin/agents?active=1')).json()
  assert.equal(active.total, 2)
  assert.ok(!active.agents.some((a) => a.id === bala.id))

  const all = await (await req('GET', '/api/admin/agents')).json()
  assert.equal(all.total, 3, 'no filter returns everyone')
})

test('listAgentsAdmin combines the active filter with search', async () => {
  await setAgentActive(adminAgent.id, bala.id, false)
  const res = await listAgentsAdmin({ search: 'Bala', active: '0' })
  assert.equal(res.total, 1)
  assert.equal(res.agents[0].id, bala.id)

  const none = await listAgentsAdmin({ search: 'Bala', active: '1' })
  assert.equal(none.total, 0)
})

// --- Audit trail ---

test('GET /api/admin/audit-logs returns the platform-wide trail newest first', async () => {
  await req('PUT', `/api/admin/agents/${bala.id}/admin`, { is_admin: true })
  await req('PUT', `/api/admin/agents/${chet.id}/active`, { is_active: false })

  const logs = await (await req('GET', '/api/admin/audit-logs')).json()
  assert.ok(Array.isArray(logs))
  assert.equal(logs[0].action, 'agent_deactivated', 'newest first')
  assert.equal(logs[0].entity_id, chet.id)
  assert.equal(logs[0].agent_name, 'Admin Anita', 'attributed to the acting admin')

  const granted = logs.find((l) => l.action === 'admin_granted')
  assert.ok(granted, 'admin_granted recorded')
  assert.equal(granted.entity_id, bala.id)
  assert.equal(granted.details.target, 'Broker Bala')
})

test('reactivating and revoking write their own audit actions', async () => {
  await req('PUT', `/api/admin/agents/${chet.id}/active`, { is_active: false })
  await req('PUT', `/api/admin/agents/${chet.id}/active`, { is_active: true })
  await req('PUT', `/api/admin/agents/${chet.id}/admin`, { is_admin: true })
  await req('PUT', `/api/admin/agents/${chet.id}/admin`, { is_admin: false })

  const actions = (await listAllAuditLogs(20)).map((l) => l.action)
  for (const expected of ['agent_deactivated', 'agent_reactivated', 'admin_granted', 'admin_revoked']) {
    assert.ok(actions.includes(expected), `${expected} recorded`)
  }
})

test('GET /api/admin/audit-logs caps the limit', async () => {
  const logs = await (await req('GET', '/api/admin/audit-logs?limit=1')).json()
  assert.equal(logs.length, 1)
  const capped = await listAllAuditLogs(99999)
  assert.ok(capped.length <= 500)
})

test('countActiveAdmins ignores deactivated admins', async () => {
  await setAdmin(bala.id, true)
  assert.equal(await countActiveAdmins(), 2)
  await setAgentActive(adminAgent.id, bala.id, false)
  assert.equal(await countActiveAdmins(), 1)
})
