// The team-management routes that team.test.js doesn't reach: editing team settings,
// managing a member's assignment profile, the invite lifecycle (list / revoke / decline),
// the manager assignment tools (manual, auto, pool distribute, claim), and disbanding.
// The recurring theme is the privacy wall — a plain agent must be refused everywhere a
// manager is required, and every "not in this team" id must be a 404 rather than a leak.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
const dbName = await createTestDb('teamadmin')

const { app } = await import('../index.js')
const { closePool } = await import('../db.js')

let server, base
let owner, manager, member, outsider

const req = (method, url, body, tok) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
const json = (r) => r.json()
const signup = async (name, phone) =>
  json(await req('POST', '/api/auth/signup', { name, phone, password: 'secret123' }))

// Invite `who` at `role` and have them accept.
async function join(who, role) {
  await req('POST', '/api/team/invites', { phone: who.agent.phone, role }, owner.token)
  const ctx = await json(await req('GET', '/api/team', undefined, who.token))
  await req('POST', `/api/team/invites/${ctx.incoming_invites[0].id}/accept`, {}, who.token)
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  owner = await signup('Owner Priya', '+919820000001')
  manager = await signup('Manager Bhavna', '+919820000002')
  member = await signup('Agent Amit', '+919820000003')
  outsider = await signup('Solo Ravi', '+919820000004')

  await req('POST', '/api/team', { name: 'Powai Desk' }, owner.token)
  await join(manager, 'manager')
  await join(member, 'agent')
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- Team settings ------------------------------------------------------------

test('the owner can rename the team and set an assignment strategy', async () => {
  const res = await req('PUT', '/api/team', { name: 'Powai & Hiranandani', assignment_strategy: 'round_robin' }, owner.token)
  assert.equal(res.status, 200)
  const team = await json(res)
  assert.equal(team.name, 'Powai & Hiranandani')
  assert.equal(team.assignment_strategy, 'round_robin')
})

test('an unknown assignment strategy is refused before it reaches the database', async () => {
  const res = await req('PUT', '/api/team', { assignment_strategy: 'coin_flip' }, owner.token)
  assert.equal(res.status, 400)
  assert.match((await json(res)).error, /Unknown assignment strategy/)
})

test('the shared line can be set and cleared', async () => {
  let team = await json(await req('PUT', '/api/team', { shared_wa_phone_number_id: 'pnid-shared' }, owner.token))
  assert.equal(team.shared_wa_phone_number_id, 'pnid-shared')
  team = await json(await req('PUT', '/api/team', { shared_wa_phone_number_id: '' }, owner.token))
  assert.equal(team.shared_wa_phone_number_id, null) // empty string clears, not stores ''
})

test('a manager cannot edit team settings — that is owner-only', async () => {
  const res = await req('PUT', '/api/team', { name: 'Hijacked' }, manager.token)
  assert.equal(res.status, 403)
  assert.equal((await json(res)).code, 'FORBIDDEN')
})

test('a solo agent gets NO_TEAM, not FORBIDDEN, on team-only routes', async () => {
  const res = await req('PUT', '/api/team', { name: 'Nope' }, outsider.token)
  assert.equal(res.status, 404)
  assert.equal((await json(res)).code, 'NO_TEAM')
})

// --- Member assignment profile ------------------------------------------------

test('a manager can set a member’s localities and lead intake', async () => {
  const res = await req('PUT', `/api/team/members/${member.agent.id}`,
    { localities: ['Powai', 'Chandivali'], accepts_leads: false }, manager.token)
  assert.equal(res.status, 200)
  const updated = await json(res)
  assert.deepEqual(updated.localities, ['Powai', 'Chandivali'])
  assert.equal(updated.accepts_leads, 0) // stored 0/1, like every other boolean column
  // Put it back so the assignment tests below have a taker.
  await req('PUT', `/api/team/members/${member.agent.id}`, { accepts_leads: true }, manager.token)
})

test('a plain agent cannot edit anyone’s member profile', async () => {
  const res = await req('PUT', `/api/team/members/${manager.agent.id}`, { accepts_leads: false }, member.token)
  assert.equal(res.status, 403)
})

test('editing a non-member is a 404', async () => {
  const res = await req('PUT', `/api/team/members/${outsider.agent.id}`, { accepts_leads: true }, owner.token)
  assert.equal(res.status, 404)
})

// --- Invitations --------------------------------------------------------------

test('a manager can list and revoke a pending invite', async () => {
  await req('POST', '/api/team/invites', { phone: '+919820000009' }, manager.token)
  const invites = await json(await req('GET', '/api/team/invites', undefined, manager.token))
  const pending = invites.find((i) => i.phone.endsWith('9820000009'))
  assert.ok(pending, 'the new invite should be listed')

  const revoked = await req('DELETE', `/api/team/invites/${pending.id}`, undefined, manager.token)
  assert.equal(revoked.status, 200)
  const again = await req('DELETE', `/api/team/invites/${pending.id}`, undefined, manager.token)
  assert.equal(again.status, 404, 'revoking twice must not silently succeed')
})

test('a plain agent can neither list nor send invites', async () => {
  assert.equal((await req('GET', '/api/team/invites', undefined, member.token)).status, 403)
  assert.equal((await req('POST', '/api/team/invites', { phone: '+919820000010' }, member.token)).status, 403)
})

test('an invitee can decline, and the invite is then spent', async () => {
  await req('POST', '/api/team/invites', { phone: outsider.agent.phone }, owner.token)
  const incoming = await json(await req('GET', '/api/team/invites/incoming', undefined, outsider.token))
  assert.equal(incoming.length, 1)

  const declined = await req('POST', `/api/team/invites/${incoming[0].id}/decline`, {}, outsider.token)
  assert.equal(declined.status, 200)
  assert.deepEqual(await json(await req('GET', '/api/team/invites/incoming', undefined, outsider.token)), [])
  // Declining is final — the same invite can't then be accepted.
  assert.equal((await req('POST', `/api/team/invites/${incoming[0].id}/accept`, {}, outsider.token)).status, 404)
})

test('an invite addressed to someone else cannot be accepted', async () => {
  await req('POST', '/api/team/invites', { phone: '+919820000011' }, owner.token)
  const invites = await json(await req('GET', '/api/team/invites', undefined, owner.token))
  const forSomeoneElse = invites.find((i) => i.phone.endsWith('9820000011') && i.status === 'pending')
  const res = await req('POST', `/api/team/invites/${forSomeoneElse.id}/accept`, {}, outsider.token)
  assert.equal(res.status, 403)
  assert.equal((await json(res)).code, 'WRONG_INVITEE')
})

// --- Assignment tools ---------------------------------------------------------

async function teamLead(text = 'Looking in Powai') {
  const sim = await json(await req('POST', '/api/simulate', { from: `9197${Date.now() % 100000000}`, text }, owner.token))
  return sim.lead
}

test('a manager can assign a team lead to a member by hand', async () => {
  const lead = await teamLead()
  const res = await req('POST', `/api/team/leads/${lead.id}/assign`, { agent_id: member.agent.id }, manager.token)
  assert.equal(res.status, 200)
  // A team assignment moves ownership outright (leads.agent_id), unlike the inbox's
  // assigned_agent_id hand-off, which leaves the owner in place.
  const assigned = await json(res)
  assert.equal(assigned.agent_id, member.agent.id)
  assert.ok(assigned.assigned_at)
})

test('assign requires an agent_id and a lead that is actually in this team', async () => {
  const lead = await teamLead()
  assert.equal((await req('POST', `/api/team/leads/${lead.id}/assign`, {}, manager.token)).status, 400)
  const missing = await req('POST', '/api/team/leads/999999/assign', { agent_id: member.agent.id }, manager.token)
  assert.equal(missing.status, 404)
})

test('a plain agent cannot assign leads around the team', async () => {
  const lead = await teamLead()
  assert.equal((await req('POST', `/api/team/leads/${lead.id}/assign`, { agent_id: member.agent.id }, member.token)).status, 403)
})

test('auto-assign follows the team strategy', async () => {
  const lead = await teamLead()
  const res = await req('POST', `/api/team/leads/${lead.id}/auto-assign`, {}, manager.token)
  assert.equal(res.status, 200)
  assert.ok((await json(res)).agent_id, 'round-robin should pick a member')
})

test('auto-assign refuses a lead outside the team', async () => {
  const res = await req('POST', '/api/team/leads/999999/auto-assign', {}, manager.token)
  assert.equal(res.status, 404)
})

test('auto-assign explains itself when the strategy cannot pick', async () => {
  await req('PUT', '/api/team', { assignment_strategy: 'manual' }, owner.token)
  const lead = await teamLead()
  const res = await req('POST', `/api/team/leads/${lead.id}/auto-assign`, {}, manager.token)
  assert.equal(res.status, 400)
  assert.equal((await json(res)).code, 'NO_AUTO_STRATEGY')
  await req('PUT', '/api/team', { assignment_strategy: 'round_robin' }, owner.token)
})

test('the pool can be distributed in one go, and reports what moved', async () => {
  await teamLead('2BHK please')
  await teamLead('3BHK please')
  const res = await req('POST', '/api/team/pool/distribute', {}, manager.token)
  assert.equal(res.status, 200)
  const result = await json(res)
  assert.equal(typeof result.assigned, 'number')
})

test('distributing the pool is manager-only', async () => {
  assert.equal((await req('POST', '/api/team/pool/distribute', {}, member.token)).status, 403)
})

test('claiming a lead that is already owned is a 409, not a silent steal', async () => {
  const lead = await teamLead()
  await req('POST', `/api/team/leads/${lead.id}/assign`, { agent_id: manager.agent.id }, owner.token)
  const res = await req('POST', `/api/team/leads/${lead.id}/claim`, {}, member.token)
  assert.equal(res.status, 409)
})

test('claiming requires team membership', async () => {
  const lead = await teamLead()
  assert.equal((await req('POST', `/api/team/leads/${lead.id}/claim`, {}, outsider.token)).status, 404)
})

// --- Manager views ------------------------------------------------------------

test('the pipeline view rejects an unknown pipeline type', async () => {
  assert.equal((await req('GET', '/api/team/pipeline?type=nonsense', undefined, manager.token)).status, 400)
  assert.equal((await req('GET', '/api/team/pipeline?type=rental', undefined, manager.token)).status, 200)
})

test('the stale-lead view accepts a custom window', async () => {
  const res = await req('GET', '/api/team/stale?days=14', undefined, manager.token)
  assert.equal(res.status, 200)
  assert.ok(Array.isArray(await json(res)))
})

test('manager views are closed to plain agents and outsiders', async () => {
  for (const path of ['/api/team/leads', '/api/team/pipeline', '/api/team/leaderboard', '/api/team/stale']) {
    assert.equal((await req('GET', path, undefined, member.token)).status, 403, `${path} leaked to an agent`)
    assert.equal((await req('GET', path, undefined, outsider.token)).status, 404, `${path} leaked to an outsider`)
  }
})

// --- Leaving and disbanding ---------------------------------------------------

test('a member can leave the team themselves', async () => {
  await req('POST', '/api/team/invites', { phone: '+919820000012' }, owner.token)
  const leaver = await signup('Temp Sunil', '+919820000012')
  const ctx = await json(await req('GET', '/api/team', undefined, leaver.token))
  await req('POST', `/api/team/invites/${ctx.incoming_invites[0].id}/accept`, {}, leaver.token)

  const res = await req('DELETE', `/api/team/members/${leaver.agent.id}`, undefined, leaver.token)
  assert.equal(res.status, 200)
  assert.equal((await json(await req('GET', '/api/team', undefined, leaver.token))).team, null)
})

test('a plain agent cannot remove someone else', async () => {
  const res = await req('DELETE', `/api/team/members/${manager.agent.id}`, undefined, member.token)
  assert.equal(res.status, 403)
})

test('the owner cannot be removed — the team is disbanded instead', async () => {
  const res = await req('DELETE', `/api/team/members/${owner.agent.id}`, undefined, owner.token)
  assert.equal(res.status, 409)
  assert.equal((await json(res)).code, 'OWNER_REMOVE')
})

// --- Team context view --------------------------------------------------------

// Pending invites are a manager's business: they name people who are not on the team
// yet, so a plain agent's context must come back with that list empty rather than
// simply hidden in the UI.
test('the team context shows invites to a manager and hides them from an agent', async () => {
  await req('POST', '/api/team/invites', { phone: '+919820000077', role: 'agent' }, owner.token)

  for (const who of [owner, manager]) {
    const ctx = await json(await req('GET', '/api/team', undefined, who.token))
    assert.ok(ctx.invites.some((i) => i.phone === '+919820000077'), `${ctx.role} sees the pending invite`)
  }

  const plain = await json(await req('GET', '/api/team', undefined, member.token))
  assert.equal(plain.role, 'agent')
  assert.deepEqual(plain.invites, [], 'a plain agent is told nothing about pending invites')
  assert.ok(plain.members.length >= 3, 'but still sees the roster')
})

// A request with no JSON content-type leaves req.body undefined. The settings editor
// has to read that as "nothing to change", not crash destructuring it.
test('a bodiless settings save changes nothing and keeps the team intact', async () => {
  const before = await json(await req('GET', '/api/team', undefined, owner.token))
  const res = await fetch(`${base}/api/team`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${owner.token}` },
  })
  assert.equal(res.status, 200)
  const after = await json(res)
  assert.equal(after.name, before.team.name)
  assert.equal(after.assignment_strategy, before.team.assignment_strategy)
})

// --- Manager report filters ---------------------------------------------------

test('the shared inbox filters down to one member', async () => {
  const lead = await teamLead('Powai 3BHK, filter me')
  await req('POST', `/api/team/leads/${lead.id}/assign`, { agent_id: manager.agent.id }, manager.token)

  const all = await json(await req('GET', '/api/team/leads', undefined, manager.token))
  const mine = await json(await req('GET', `/api/team/leads?member=${manager.agent.id}`, undefined, manager.token))

  assert.ok(mine.some((l) => l.id === lead.id), 'the freshly assigned lead is in the filtered view')
  assert.ok(mine.every((l) => l.agent_id === manager.agent.id), 'and nobody else’s leads are')
  assert.ok(mine.length < all.length, 'the unfiltered view is strictly wider')
})

// The stale window defaults to 3 days; a manager can widen or narrow it.
test('the stale list honours an explicit day window', async () => {
  const wide = await req('GET', '/api/team/stale?days=90', undefined, manager.token)
  assert.equal(wide.status, 200)
  const narrow = await req('GET', '/api/team/stale?days=1', undefined, manager.token)
  assert.equal(narrow.status, 200)
  assert.ok((await json(wide)).length >= (await json(narrow)).length, 'a wider window cannot return fewer leads')

  const dflt = await req('GET', '/api/team/stale', undefined, manager.token)
  assert.equal(dflt.status, 200)
})

test('the owner disbands the team, and everyone becomes solo again', async () => {
  const res = await req('DELETE', '/api/team', undefined, owner.token)
  assert.equal(res.status, 200)
  assert.deepEqual(await json(res), { ok: true })
  for (const who of [owner, manager, member]) {
    assert.equal((await json(await req('GET', '/api/team', undefined, who.token))).team, null)
  }
})
