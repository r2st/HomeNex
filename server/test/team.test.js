// Tests for Team Management (§5.3): teams, roles, invitations, lead assignment
// (round-robin / locality / manual / claim-from-pool), manager views, and the
// privacy wall that keeps a plain agent from seeing anyone else's leads.
// Run with: npm test  (from server/) — needs a local PostgreSQL.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
const dbName = await createTestDb('team')

const { app } = await import('../index.js')
const {
  closePool,
  query,
  createTeam,
  updateTeam,
  getAgentTeam,
  pickRoundRobin,
  autoAssignTeamLead,
  distributeTeamPool,
  updateMember,
} = await import('../db.js')

let server
let base
// Priya owns the team; Amit and Bhavna are members; Solo is never on a team;
// Deepak gets invited later.
let owner, ownerTok, amit, amitTok, bhavna, bhavnaTok, solo, soloTok, deepak, deepakTok
const PASSWORD = 'secret123'

const req = (method, url, body, tok) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

const signup = async (name, phone) =>
  (await req('POST', '/api/auth/signup', { name, phone, password: PASSWORD }, null)).json()

// Create a lead owned by `tok`'s agent, team-stamped if they're on a team.
const simulate = (tok, from, text = 'Looking for a 3BHK') =>
  req('POST', '/api/simulate', { from, text }, tok)

before(async () => {
  await new Promise((r) => (server = app.listen(0, () => (r((base = `http://127.0.0.1:${server.address().port}`))))))
  ;({ token: ownerTok, agent: owner } = await signup('Priya Owner', '+919810000001'))
  ;({ token: amitTok, agent: amit } = await signup('Amit Member', '+919810000002'))
  ;({ token: bhavnaTok, agent: bhavna } = await signup('Bhavna Member', '+919810000003'))
  ;({ token: soloTok, agent: solo } = await signup('Solo Agent', '+919810000004'))
  ;({ token: deepakTok, agent: deepak } = await signup('Deepak Invitee', '+919810000005'))
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- Team lifecycle ---

test('a solo agent has no team', async () => {
  const body = await (await req('GET', '/api/team', undefined, soloTok)).json()
  assert.equal(body.team, null)
  assert.deepEqual(body.incoming_invites, [])
})

test('creating a team makes the creator its owner', async () => {
  const res = await req('POST', '/api/team', { name: 'Priya Realty' }, ownerTok)
  assert.equal(res.status, 200)
  const team = await res.json()
  assert.equal(team.name, 'Priya Realty')
  assert.equal(team.owner_agent_id, owner.id)

  const ctx = await (await req('GET', '/api/team', undefined, ownerTok)).json()
  assert.equal(ctx.role, 'owner')
  assert.equal(ctx.members.length, 1)
  assert.equal(ctx.members[0].role, 'owner')
})

test('an agent cannot own two teams', async () => {
  const res = await req('POST', '/api/team', { name: 'Second Team' }, ownerTok)
  assert.equal(res.status, 409)
  assert.equal((await res.json()).code, 'ALREADY_IN_TEAM')
})

test('creating a team requires a name', async () => {
  assert.equal((await req('POST', '/api/team', { name: '  ' }, soloTok)).status, 400)
})

// --- Invitations ---

test('invite → the invitee sees it and accepts → becomes a member', async () => {
  // Owner invites Amit as a plain agent and Bhavna as a manager.
  assert.equal((await req('POST', '/api/team/invites', { phone: '+919810000002' }, ownerTok)).status, 200)
  assert.equal(
    (await req('POST', '/api/team/invites', { phone: '+919810000003', role: 'manager' }, ownerTok)).status,
    200,
  )

  // Amit sees the pending invite even though he's not on the team yet.
  const amitCtx = await (await req('GET', '/api/team', undefined, amitTok)).json()
  assert.equal(amitCtx.team, null)
  assert.equal(amitCtx.incoming_invites.length, 1)
  const inviteId = amitCtx.incoming_invites[0].id
  assert.equal(amitCtx.incoming_invites[0].team_name, 'Priya Realty')

  const accept = await req('POST', `/api/team/invites/${inviteId}/accept`, {}, amitTok)
  assert.equal(accept.status, 200)
  assert.equal((await accept.json()).role, 'agent')

  // Bhavna accepts her manager invite.
  const bCtx = await (await req('GET', '/api/team', undefined, bhavnaTok)).json()
  await req('POST', `/api/team/invites/${bCtx.incoming_invites[0].id}/accept`, {}, bhavnaTok)

  const members = await (await req('GET', '/api/team/members', undefined, ownerTok)).json()
  assert.equal(members.length, 3)
  assert.equal(members.find((m) => m.agent_id === bhavna.id).role, 'manager')
})

test('a duplicate pending invite is rejected', async () => {
  const res = await req('POST', '/api/team/invites', { phone: '+919810000004' }, ownerTok)
  assert.equal(res.status, 200) // first invite to Solo
  const dup = await req('POST', '/api/team/invites', { phone: '+919810000004' }, ownerTok)
  assert.equal(dup.status, 409)
  assert.equal((await dup.json()).code, 'DUP_INVITE')
})

test('cannot invite someone who already belongs to another team', async () => {
  // Amit is on Priya's team; Solo starts a team and tries to poach him.
  await req('POST', '/api/team', { name: 'Solo Team' }, soloTok)
  const res = await req('POST', '/api/team/invites', { phone: '+919810000002' }, soloTok)
  assert.equal(res.status, 409)
  assert.equal((await res.json()).code, 'IN_OTHER_TEAM')
  // Clean up: disband Solo's team so later tests see Solo as team-less.
  await req('DELETE', '/api/team', undefined, soloTok)
})

test('declining an invite leaves the agent team-less', async () => {
  await req('POST', '/api/team/invites', { phone: '+919810000005' }, ownerTok) // invite Deepak
  const ctx = await (await req('GET', '/api/team', undefined, deepakTok)).json()
  const id = ctx.incoming_invites[0].id
  assert.equal((await req('POST', `/api/team/invites/${id}/decline`, {}, deepakTok)).status, 200)
  assert.equal((await (await req('GET', '/api/team', undefined, deepakTok)).json()).team, null)
})

// --- Privacy wall ---

test('privacy wall: a plain agent is refused manager views', async () => {
  for (const url of ['/api/team/leads', '/api/team/pipeline', '/api/team/leaderboard', '/api/team/stale']) {
    const res = await req('GET', url, undefined, amitTok) // Amit is role 'agent'
    assert.equal(res.status, 403, url)
    assert.equal((await res.json()).code, 'FORBIDDEN')
  }
})

test('privacy wall: a manager and owner may reach team views', async () => {
  for (const tok of [ownerTok, bhavnaTok]) {
    assert.equal((await req('GET', '/api/team/leaderboard', undefined, tok)).status, 200)
    assert.equal((await req('GET', '/api/team/pipeline', undefined, tok)).status, 200)
  }
})

test('privacy wall: agents only ever see their own leads', async () => {
  // Amit creates a lead; Bhavna (manager) must not see it via her own /api/leads,
  // and a plain agent cannot open it by id.
  await simulate(amitTok, 'buyer-amit-1')
  const amitLead = (await (await req('GET', '/api/leads', undefined, amitTok)).json()).find(
    (l) => l.wa_id === 'buyer-amit-1',
  )
  assert.ok(amitLead, 'Amit sees his own lead')
  const bhavnaLeads = await (await req('GET', '/api/leads', undefined, bhavnaTok)).json()
  assert.ok(!bhavnaLeads.some((l) => l.wa_id === 'buyer-amit-1'), 'manager does not see it in her own list')
  assert.equal((await req('GET', `/api/leads/${amitLead.id}`, undefined, bhavnaTok)).status, 404)
  // But a manager sees it through the team inbox.
  const inbox = await (await req('GET', '/api/team/leads', undefined, ownerTok)).json()
  assert.ok(inbox.some((l) => l.wa_id === 'buyer-amit-1'), 'team inbox shows every member lead')
})

// --- Manual assignment / reassignment ---

test('a manager reassigns a lead from one member to another', async () => {
  await simulate(amitTok, 'buyer-reassign-1')
  const lead = (await (await req('GET', '/api/team/leads', undefined, ownerTok)).json()).find(
    (l) => l.wa_id === 'buyer-reassign-1',
  )
  assert.equal(lead.agent_id, amit.id)

  const res = await req('POST', `/api/team/leads/${lead.id}/assign`, { agent_id: bhavna.id }, ownerTok)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).agent_id, bhavna.id)

  // It has moved: Bhavna now owns it, Amit no longer does.
  assert.ok((await (await req('GET', '/api/leads', undefined, bhavnaTok)).json()).some((l) => l.id === lead.id))
  assert.ok(!(await (await req('GET', '/api/leads', undefined, amitTok)).json()).some((l) => l.id === lead.id))
})

test('assigning to a non-member is rejected', async () => {
  const lead = (await (await req('GET', '/api/team/leads', undefined, ownerTok)).json())[0]
  const res = await req('POST', `/api/team/leads/${lead.id}/assign`, { agent_id: solo.id }, ownerTok)
  assert.equal(res.status, 404)
  assert.equal((await res.json()).code, 'NOT_MEMBER')
})

// --- Round-robin & locality assignment (engine, via db) ---

test('round-robin cycles through members who accept leads', async () => {
  const team = await getAgentTeam(owner.id)
  await updateTeam(team.id, { assignment_strategy: 'round_robin' })
  // Owner opts out of receiving leads; Amit & Bhavna remain.
  await updateMember(team.id, owner.id, { accepts_leads: false })
  const picks = [await pickRoundRobin(team.id), await pickRoundRobin(team.id), await pickRoundRobin(team.id)]
  // Two eligible members → the sequence alternates and never lands on the owner.
  assert.ok(!picks.includes(owner.id))
  assert.deepEqual(new Set(picks).size >= 1 ? [...new Set(picks)].sort() : [], [amit.id, bhavna.id].sort())
  assert.equal(picks[0], picks[2], 'cursor wraps around two members')
  assert.notEqual(picks[0], picks[1])
})

test('locality strategy routes to the member who covers that area', async () => {
  const team = await getAgentTeam(owner.id)
  await updateTeam(team.id, { assignment_strategy: 'locality' })
  await updateMember(team.id, amit.id, { localities: ['Wakad', 'Hinjewadi'] })
  await updateMember(team.id, bhavna.id, { localities: ['Baner'] })
  // A pooled team lead in Baner.
  const { rows } = await query(
    `INSERT INTO leads (agent_id, team_id, wa_id, name, locality, pipeline_type, stage)
     VALUES (NULL, $1, 'pool-baner-1', 'Baner Buyer', 'Baner', 'buy_primary', 'New') RETURNING id`,
    [team.id],
  )
  const assigned = await autoAssignTeamLead(team.id, rows[0].id, { locality: 'Baner' })
  assert.equal(assigned.agent_id, bhavna.id)
})

test('distributing the pool places every unassigned lead', async () => {
  const team = await getAgentTeam(owner.id)
  await updateTeam(team.id, { assignment_strategy: 'round_robin' })
  for (const wa of ['pool-d1', 'pool-d2', 'pool-d3']) {
    await query(
      `INSERT INTO leads (agent_id, team_id, wa_id, name, pipeline_type, stage)
       VALUES (NULL, $1, $2, 'Pool Buyer', 'buy_primary', 'New')`,
      [team.id, wa],
    )
  }
  const before = (await distributeTeamPool(team.id)).assigned
  assert.ok(before >= 3, 'at least the three fresh pool leads were assigned')
  const leftover = (
    await query('SELECT COUNT(*)::int AS n FROM leads WHERE team_id = $1 AND agent_id IS NULL', [team.id])
  ).rows[0].n
  assert.equal(leftover, 0)
})

// --- Claim from pool ---

test('a member can claim a lead from the shared pool', async () => {
  const team = await getAgentTeam(owner.id)
  const { rows } = await query(
    `INSERT INTO leads (agent_id, team_id, wa_id, name, pipeline_type, stage)
     VALUES (NULL, $1, 'pool-claim-1', 'Claim Me', 'buy_primary', 'New') RETURNING id`,
    [team.id],
  )
  const res = await req('POST', `/api/team/leads/${rows[0].id}/claim`, {}, amitTok)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).agent_id, amit.id)
  // A second claim now fails — it's taken.
  assert.equal((await req('POST', `/api/team/leads/${rows[0].id}/claim`, {}, bhavnaTok)).status, 409)
})

// --- Roles & membership management ---

test('only the owner can change roles, and the owner role is fixed', async () => {
  const team = await getAgentTeam(owner.id)
  // Manager Bhavna cannot promote Amit.
  assert.equal((await req('PUT', `/api/team/members/${amit.id}/role`, { role: 'manager' }, bhavnaTok)).status, 403)
  // Owner can.
  assert.equal((await req('PUT', `/api/team/members/${amit.id}/role`, { role: 'manager' }, ownerTok)).status, 200)
  // Nobody can change the owner's own role.
  const res = await req('PUT', `/api/team/members/${owner.id}/role`, { role: 'manager' }, ownerTok)
  assert.equal(res.status, 409)
  assert.equal((await res.json()).code, 'OWNER_ROLE')
})

test('a member can leave; the owner cannot be removed', async () => {
  // Amit leaves the team himself.
  assert.equal((await req('DELETE', `/api/team/members/${amit.id}`, undefined, amitTok)).status, 200)
  assert.equal((await (await req('GET', '/api/team', undefined, amitTok)).json()).team, null)
  // The owner cannot be removed.
  const res = await req('DELETE', `/api/team/members/${owner.id}`, undefined, ownerTok)
  assert.equal(res.status, 409)
  assert.equal((await res.json()).code, 'OWNER_REMOVE')
})

test('the leaderboard and pipeline report the whole team', async () => {
  const board = await (await req('GET', '/api/team/leaderboard', undefined, ownerTok)).json()
  assert.ok(Array.isArray(board) && board.length >= 1)
  assert.ok('avg_first_response_s' in board[0] && 'total_leads' in board[0])
  const pipe = await (await req('GET', '/api/team/pipeline?type=buy_primary', undefined, ownerTok)).json()
  assert.equal(pipe.pipeline_type, 'buy_primary')
  assert.ok(Array.isArray(pipe.stages))
})

test('disbanding a team returns members to solo status', async () => {
  assert.equal((await req('DELETE', '/api/team', undefined, ownerTok)).status, 200)
  assert.equal((await (await req('GET', '/api/team', undefined, ownerTok)).json()).team, null)
  assert.equal((await (await req('GET', '/api/team', undefined, bhavnaTok)).json()).team, null)
})
