// Team-versus-team isolation.
//
// The existing team suites (team, teamAdmin, teamEdges) all test ONE team: what an
// owner may do that a manager may not, what a plain agent is refused, what a solo
// outsider gets. Every one of those callers is either inside the team or in no team
// at all.
//
// The caller nobody tested is the one that actually worries me: a fully legitimate
// owner/manager OF ANOTHER TEAM. They pass every role gate in teamRoutes.js —
// requireManager only asks "do you hold a manager role", not "over which team" — so
// the only thing standing between Beta's owner and Alpha's roster is whether each
// query carries the caller's team_id in its WHERE clause. Team ids and agent ids are
// sequential integers, so guessing costs nothing.
//
// Alpha is the victim: an owner, a manager, a plain agent, an assigned lead, a pool
// lead and a pending invite. Beta is a real team of its own that aims every
// id-bearing team route at Alpha's rows.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('teamcross')

const { app } = await import('../index.js')
const { closePool, query, upsertLead, getLead, listTeamMembers, getAgentTeam } = await import('../db.js')

let server, base
const alpha = {} // the victim team
const beta = {} // the attacker team

const req = (method, url, body, tok) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

const jsonOf = async (r) => {
  try {
    return await r.json()
  } catch {
    return null
  }
}

async function signup(name, phone) {
  const out = await jsonOf(await req('POST', '/api/auth/signup', { name, phone, password: 'secret123' }))
  return { token: out.token, id: out.agent.id, phone }
}

// Invite `who` into the team `ownerTok` owns, and have them accept.
async function join(ownerTok, who, role = 'agent') {
  const invite = await jsonOf(await req('POST', '/api/team/invites', { phone: who.phone, role }, ownerTok))
  assert.ok(invite?.id, `invite failed: ${JSON.stringify(invite)}`)
  const joined = await req('POST', `/api/team/invites/${invite.id}/accept`, {}, who.token)
  assert.equal(joined.status, 200, `accept failed: ${await joined.text()}`)
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })

  alpha.owner = await signup('Alpha Owner', '+919800001001')
  alpha.manager = await signup('Alpha Manager', '+919800001002')
  alpha.agent = await signup('Alpha Agent', '+919800001003')
  alpha.invitee = await signup('Alpha Invitee', '+919800001004')
  beta.owner = await signup('Beta Owner', '+919800001005')
  beta.agent = await signup('Beta Agent', '+919800001006')

  alpha.team = await jsonOf(await req('POST', '/api/team', { name: 'Alpha Realty' }, alpha.owner.token))
  await join(alpha.owner.token, alpha.manager, 'manager')
  await join(alpha.owner.token, alpha.agent, 'agent')

  beta.team = await jsonOf(await req('POST', '/api/team', { name: 'Beta Realty' }, beta.owner.token))
  await join(beta.owner.token, beta.agent, 'agent')

  // Alpha's leads: one owned by their plain agent, one sitting in their shared pool.
  alpha.lead = await upsertLead(alpha.agent.id, '919800100001', 'Alpha Confidential Buyer')
  await query('UPDATE leads SET team_id = $1 WHERE id = $2', [alpha.team.id, alpha.lead.id])
  const { rows } = await query(
    `INSERT INTO leads (agent_id, wa_id, name, phone, team_id)
     VALUES (NULL, '919800100002', 'Alpha Pool Buyer', '919800100002', $1) RETURNING *`,
    [alpha.team.id],
  )
  alpha.poolLead = rows[0]

  // A pending invite of Alpha's, addressed to someone Beta has nothing to do with.
  alpha.invite = await jsonOf(
    await req('POST', '/api/team/invites', { phone: alpha.invitee.phone, role: 'agent' }, alpha.owner.token),
  )
  assert.ok(alpha.invite?.id)
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- Roster ----------------------------------------------------------------

test("Beta's owner cannot change the role of one of Alpha's members", async () => {
  const res = await req(
    'PUT',
    `/api/team/members/${alpha.agent.id}/role`,
    { role: 'manager' },
    beta.owner.token,
  )
  assert.equal(res.status, 404, await res.text())

  const roster = await listTeamMembers(alpha.team.id)
  assert.equal(roster.find((m) => m.agent_id === alpha.agent.id).role, 'agent', 'the role was changed anyway')
})

test("Beta's owner cannot edit one of Alpha's member profiles", async () => {
  const res = await req(
    'PUT',
    `/api/team/members/${alpha.agent.id}`,
    { localities: ['Somewhere Else'], accepts_leads: 0 },
    beta.owner.token,
  )
  assert.equal(res.status, 404, await res.text())

  const roster = await listTeamMembers(alpha.team.id)
  const member = roster.find((m) => m.agent_id === alpha.agent.id)
  assert.notEqual(member.accepts_leads, 0, "Alpha's member was switched out of lead intake")
})

test("Beta's owner cannot remove one of Alpha's members", async () => {
  const res = await req('DELETE', `/api/team/members/${alpha.agent.id}`, undefined, beta.owner.token)
  assert.equal(res.status, 404, await res.text())

  const team = await getAgentTeam(alpha.agent.id)
  assert.equal(team?.id, alpha.team.id, "Alpha's agent was thrown out of their own team")
})

test("Beta's roster and invite list never mention Alpha", async () => {
  const roster = await jsonOf(await req('GET', '/api/team/members', undefined, beta.owner.token))
  const names = roster.map((m) => m.name).join(' ')
  assert.doesNotMatch(names, /Alpha/, `Beta's roster leaked: ${names}`)

  const invites = await jsonOf(await req('GET', '/api/team/invites', undefined, beta.owner.token))
  assert.equal(invites.length, 0, "Alpha's pending invite showed up in Beta's list")
})

// --- Invites ---------------------------------------------------------------

test("Beta's owner cannot revoke one of Alpha's pending invites", async () => {
  const res = await req('DELETE', `/api/team/invites/${alpha.invite.id}`, undefined, beta.owner.token)
  assert.equal(res.status, 404, await res.text())

  const invites = await jsonOf(await req('GET', '/api/team/invites', undefined, alpha.owner.token))
  assert.ok(invites.some((i) => i.id === alpha.invite.id), "Alpha's invite was revoked by an outsider")
})

test("Beta's owner cannot accept an invite addressed to somebody else", async () => {
  const res = await req('POST', `/api/team/invites/${alpha.invite.id}/accept`, {}, beta.owner.token)
  assert.equal(res.status, 403, await res.text())
  assert.equal((await getAgentTeam(beta.owner.id)).id, beta.team.id, 'Beta’s owner joined Alpha')
})

test("Beta's owner cannot decline an invite addressed to somebody else", async () => {
  const res = await req('POST', `/api/team/invites/${alpha.invite.id}/decline`, {}, beta.owner.token)
  assert.equal(res.status, 403, await res.text())

  const incoming = await jsonOf(await req('GET', '/api/team/invites/incoming', undefined, alpha.invitee.token))
  assert.ok(incoming.some((i) => i.id === alpha.invite.id), "the real invitee's invite was burned")
})

// --- Leads -----------------------------------------------------------------

test("Beta's owner cannot assign one of Alpha's leads to a Beta member", async () => {
  const res = await req(
    'POST',
    `/api/team/leads/${alpha.lead.id}/assign`,
    { agent_id: beta.agent.id },
    beta.owner.token,
  )
  assert.equal(res.status, 404, await res.text())
  assert.equal((await getLead(alpha.lead.id)).agent_id, alpha.agent.id, 'the lead changed hands')
})

test("Beta's owner cannot assign one of Alpha's leads to an Alpha member either", async () => {
  // A different failure path: the target isn't on Beta, so the membership check
  // rejects before the lead scope is even consulted. Both must refuse.
  const res = await req(
    'POST',
    `/api/team/leads/${alpha.lead.id}/assign`,
    { agent_id: alpha.manager.id },
    beta.owner.token,
  )
  assert.equal(res.status, 404, await res.text())
  assert.equal((await getLead(alpha.lead.id)).agent_id, alpha.agent.id)
})

test("Beta's owner cannot auto-assign one of Alpha's leads into Beta", async () => {
  await query(`UPDATE teams SET assignment_strategy = 'round_robin' WHERE id = $1`, [beta.team.id])
  const res = await req('POST', `/api/team/leads/${alpha.poolLead.id}/auto-assign`, {}, beta.owner.token)
  assert.equal(res.status, 404, await res.text())
  assert.equal((await getLead(alpha.poolLead.id)).agent_id, null, "Alpha's pool lead was routed into Beta")
})

test("a Beta member cannot claim a lead out of Alpha's pool", async () => {
  const res = await req('POST', `/api/team/leads/${alpha.poolLead.id}/claim`, {}, beta.agent.token)
  assert.ok([404, 409].includes(res.status), `expected a refusal, got ${res.status}`)
  assert.equal((await getLead(alpha.poolLead.id)).agent_id, null, "Alpha's pool lead was claimed by an outsider")
})

test("distributing Beta's pool never touches Alpha's unassigned leads", async () => {
  const res = await req('POST', '/api/team/pool/distribute', {}, beta.owner.token)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).assigned, 0, "Beta's distribute reached outside its own team")
  assert.equal((await getLead(alpha.poolLead.id)).agent_id, null)
})

// --- Manager views ---------------------------------------------------------

test("none of Alpha's rows appear in Beta's manager views", async () => {
  const views = ['/api/team/leads', '/api/team/pipeline', '/api/team/leaderboard', '/api/team/stale']
  const leaks = []
  for (const url of views) {
    const res = await req('GET', url, undefined, beta.owner.token)
    assert.equal(res.status, 200, `${url} -> ${res.status}`)
    const text = await res.text()
    if (/Alpha/.test(text)) leaks.push(`${url}: ${text.slice(0, 200)}`)
  }
  assert.deepEqual(leaks, [], `Beta's manager views leaked Alpha rows:\n${leaks.join('\n')}`)
})

test("filtering Beta's shared inbox by an Alpha member returns nothing, not everything", async () => {
  // ?member= is a bare agent id from the client. A filter that is applied without
  // the team scope — or dropped when it matches nobody — would hand back the wrong
  // team's list.
  const res = await req('GET', `/api/team/leads?member=${alpha.agent.id}`, undefined, beta.owner.token)
  assert.equal(res.status, 200)
  const rows = await res.json()
  assert.deepEqual(rows, [], `expected an empty list, got ${rows.length} lead(s)`)
})

test("Alpha's own manager still sees Alpha's leads", async () => {
  // The negative tests above would all pass if team views were simply broken, so
  // pin the positive case too.
  const rows = await jsonOf(await req('GET', '/api/team/leads', undefined, alpha.manager.token))
  assert.ok(
    rows.some((l) => l.id === alpha.lead.id),
    'the isolation checks are only meaningful if the legitimate view still works',
  )
})

// --- The privacy wall holds for a plain agent of another team ---------------

test("a plain Beta agent is refused Alpha's manager views by role, not just by scope", async () => {
  for (const url of ['/api/team/leads', '/api/team/pipeline', '/api/team/leaderboard', '/api/team/stale']) {
    const res = await req('GET', url, undefined, beta.agent.token)
    assert.equal(res.status, 403, `${url} -> ${res.status}`)
  }
})

test('an agent in no team at all reaches none of it', async () => {
  const solo = await signup('Solo Agent', '+919800001007')
  for (const [method, url, body] of [
    ['GET', '/api/team/leads'],
    ['POST', `/api/team/leads/${alpha.lead.id}/assign`, { agent_id: alpha.agent.id }],
    ['POST', `/api/team/leads/${alpha.poolLead.id}/claim`, {}],
    ['PUT', `/api/team/members/${alpha.agent.id}`, { accepts_leads: 0 }],
    ['DELETE', `/api/team/invites/${alpha.invite.id}`],
  ]) {
    const res = await req(method, url, body, solo.token)
    assert.equal(res.status, 404, `${method} ${url} -> ${res.status}`)
  }
  assert.equal((await getLead(alpha.lead.id)).agent_id, alpha.agent.id)
})

test('a malformed id on a team route is a client error, never a 500', async () => {
  const routes = [
    ['PUT', '/api/team/members/not-an-id/role', { role: 'agent' }],
    ['PUT', '/api/team/members/not-an-id', { accepts_leads: 1 }],
    ['DELETE', '/api/team/members/not-an-id'],
    ['DELETE', '/api/team/invites/not-an-id'],
    ['POST', '/api/team/invites/not-an-id/accept', {}],
    ['POST', '/api/team/invites/not-an-id/decline', {}],
    ['POST', '/api/team/leads/not-an-id/assign', { agent_id: 1 }],
    ['POST', '/api/team/leads/not-an-id/auto-assign', {}],
    ['POST', '/api/team/leads/not-an-id/claim', {}],
  ]
  const crashes = []
  for (const [method, url, body] of routes) {
    const res = await req(method, url, body, beta.owner.token)
    if (res.status >= 500) crashes.push(`${method} ${url} -> ${res.status} ${(await res.text()).slice(0, 120)}`)
  }
  assert.deepEqual(crashes, [], crashes.join('\n'))
})

// --- The paged lead list, under a team ------------------------------------
// GET /api/leads gained limit/offset/q. Each is a new way for a caller to reshape
// the query, so each needs re-checking against the tenant boundary: paging past the
// end, or searching by a name only the other team knows, must not reach around it.

test('paging past your own leads never spills into another agent’s', async () => {
  for (const qs of ['?limit=500', '?offset=0&limit=500', '?offset=1', '?limit=1&offset=0']) {
    const res = await req('GET', `/api/leads${qs}`, undefined, beta.owner.token)
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.doesNotMatch(text, /Alpha Confidential Buyer/, `${qs} leaked an Alpha lead`)
  }
})

test('searching for a name only the other team knows finds nothing', async () => {
  const res = await req('GET', '/api/leads?q=Alpha%20Confidential', undefined, beta.owner.token)
  assert.deepEqual(await res.json(), [], 'search reached across the tenant boundary')
})

test('the lead count endpoint counts only what the caller can see', async () => {
  const betaCounts = await jsonOf(await req('GET', '/api/leads/count', undefined, beta.owner.token))
  const betaList = await jsonOf(await req('GET', '/api/leads?limit=500', undefined, beta.owner.token))
  assert.equal(betaCounts.total, betaList.length, 'the count and the list disagree about what is visible')
  // Alpha's team pool lead has agent_id NULL, which the shared-pool arm of the query
  // matches for everyone — the one lead crossing this line, and by design.
  assert.ok(betaCounts.total <= 1, `Beta sees ${betaCounts.total} leads; only the shared pool should reach them`)
})

test('a manager cannot page the team inbox past their own team either', async () => {
  const res = await req('GET', '/api/team/leads?limit=500&offset=0', undefined, beta.owner.token)
  assert.equal(res.status, 200)
  assert.doesNotMatch(await res.text(), /Alpha/, 'the paged team inbox leaked')
})
