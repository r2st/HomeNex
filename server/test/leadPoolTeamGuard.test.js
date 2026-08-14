// The shared pool, across the team boundary.
//
// `agent_id IS NULL` means "in the pool", and the solo routes under /api/leads treat
// the pool as one global heap: list it, open it, claim it. That is right for a lead
// that belongs to nobody — an unknown sender on a shared number — and wrong for a
// lead carrying a team tag, because a tagged pool row IS a team's shared inbox.
// Inbound routing puts leads there, the `pool` assignment strategy leaves them there,
// and a manager dropping a lead back sends it there.
//
// /api/team/leads/:id/claim has always joined on team_id, so the team route was
// closed. POST /api/leads/:id/assign was not: it matched on `agent_id IS NULL` alone,
// so any agent on the platform could walk sequential lead ids and take another
// brokerage's pipeline one lead at a time. The read side had the same shape, which
// meant an outsider could also open the thread, its transcript and its internal notes.
//
// Three callers are aimed at one team's pool here: a member of a different team, an
// agent in no team at all, and — as the control that keeps all of this meaningful —
// the team's own member, who must still be able to claim it.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('leadpoolguard')

const { app } = await import('../index.js')
const { closePool, query, getLead, listLeads, leadCounts } = await import('../db.js')

let server, base
const alpha = {}
const beta = {}
let solo
let openLead // a pool lead with no team tag: everyone's to claim

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
  assert.ok(out?.token, `signup failed: ${JSON.stringify(out)}`)
  return { token: out.token, id: out.agent.id, phone, name }
}

async function join(ownerTok, who, role = 'agent') {
  const invite = await jsonOf(await req('POST', '/api/team/invites', { phone: who.phone, role }, ownerTok))
  assert.ok(invite?.id, `invite failed: ${JSON.stringify(invite)}`)
  const joined = await req('POST', `/api/team/invites/${invite.id}/accept`, {}, who.token)
  assert.equal(joined.status, 200, `accept failed: ${await joined.text()}`)
}

// A lead sitting in a pool: agent_id NULL, optionally tagged to a team.
async function poolLead(waId, name, teamId = null) {
  const { rows } = await query(
    `INSERT INTO leads (agent_id, wa_id, name, phone, team_id)
     VALUES (NULL, $1, $2, $1, $3) RETURNING *`,
    [waId, name, teamId],
  )
  return rows[0]
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })

  alpha.owner = await signup('Alpha Owner', '+919811110001')
  alpha.agent = await signup('Alpha Agent', '+919811110002')
  beta.owner = await signup('Beta Owner', '+919811110003')
  beta.agent = await signup('Beta Agent', '+919811110004')
  solo = await signup('Solo Agent', '+919811110005')

  alpha.team = await jsonOf(await req('POST', '/api/team', { name: 'Alpha Realty' }, alpha.owner.token))
  await join(alpha.owner.token, alpha.agent, 'agent')
  beta.team = await jsonOf(await req('POST', '/api/team', { name: 'Beta Realty' }, beta.owner.token))
  await join(beta.owner.token, beta.agent, 'agent')

  openLead = await poolLead('919811900000', 'Unowned Walk-in')
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- The claim itself -------------------------------------------------------

test("a member of another team cannot claim a lead out of Alpha's pool", async () => {
  const lead = await poolLead('919811900001', 'Alpha Pool Buyer', alpha.team.id)
  const res = await req('POST', `/api/leads/${lead.id}/assign`, {}, beta.agent.token)
  assert.equal(res.status, 404, await res.text())
  const after = await getLead(lead.id)
  assert.equal(after.agent_id, null, "Alpha's pool lead changed hands")
  assert.equal(after.team_id, alpha.team.id, "Alpha's pool lead was re-tagged")
})

test("an owner of another team cannot claim a lead out of Alpha's pool either", async () => {
  // The role gates in teamRoutes.js do not apply here — /api/leads is open to every
  // authenticated agent — so a manager's seniority must buy them nothing.
  const lead = await poolLead('919811900002', 'Alpha Pool Buyer Two', alpha.team.id)
  const res = await req('POST', `/api/leads/${lead.id}/assign`, {}, beta.owner.token)
  assert.equal(res.status, 404, await res.text())
  assert.equal((await getLead(lead.id)).agent_id, null)
})

test("an agent in no team at all cannot claim a lead out of Alpha's pool", async () => {
  // A solo agent's team subquery yields NULL. `team_id = NULL` is NULL, never true,
  // so they reach the untagged pool and nothing else.
  const lead = await poolLead('919811900003', 'Alpha Pool Buyer Three', alpha.team.id)
  const res = await req('POST', `/api/leads/${lead.id}/assign`, {}, solo.token)
  assert.equal(res.status, 404, await res.text())
  assert.equal((await getLead(lead.id)).agent_id, null)
})

test('the refusal does not confirm that the lead exists', async () => {
  // A 403 (or a 409 saying "not yours") is itself an oracle: ids are sequential, so an
  // outsider could map another brokerage's pipeline by the shape of the refusals. The
  // answer for a tagged pool lead must be the same as for an id that does not exist.
  const lead = await poolLead('919811900004', 'Alpha Pool Buyer Four', alpha.team.id)
  const [hidden, missing] = await Promise.all([
    req('POST', `/api/leads/${lead.id}/assign`, {}, beta.agent.token),
    req('POST', '/api/leads/99999999/assign', {}, beta.agent.token),
  ])
  assert.equal(hidden.status, missing.status)
  assert.deepEqual(await hidden.json(), await missing.json())
})

test("Alpha's own member still claims from Alpha's pool", async () => {
  // Every check above would also pass if claiming were simply broken.
  const lead = await poolLead('919811900005', 'Alpha Pool Buyer Five', alpha.team.id)
  const res = await req('POST', `/api/leads/${lead.id}/assign`, {}, alpha.agent.token)
  assert.equal(res.status, 200, await res.text())
  const after = await getLead(lead.id)
  assert.equal(after.agent_id, alpha.agent.id)
  assert.equal(after.team_id, alpha.team.id, 'the team tag was dropped on claim')
})

test('an untagged pool lead is still claimable by anyone', async () => {
  // The guard scopes the pool by tag, it does not close it. A walk-in on a shared
  // number belongs to nobody, and the first agent to reach it gets it.
  const lead = await poolLead('919811900006', 'Another Walk-in')
  const res = await req('POST', `/api/leads/${lead.id}/assign`, {}, beta.agent.token)
  assert.equal(res.status, 200, await res.text())
  const after = await getLead(lead.id)
  assert.equal(after.agent_id, beta.agent.id)
  assert.equal(after.team_id, beta.team.id, "the claimer's team tag was not stamped")
})

test('a solo agent claiming an untagged pool lead leaves it untagged', async () => {
  const lead = await poolLead('919811900007', 'Solo Walk-in')
  const res = await req('POST', `/api/leads/${lead.id}/assign`, {}, solo.token)
  assert.equal(res.status, 200, await res.text())
  const after = await getLead(lead.id)
  assert.equal(after.agent_id, solo.id)
  assert.equal(after.team_id, null)
})

test('two agents racing for the same untagged lead: one wins, one gets a 409', async () => {
  const lead = await poolLead('919811900008', 'Contested Walk-in')
  const [a, b] = await Promise.all([
    req('POST', `/api/leads/${lead.id}/assign`, {}, solo.token),
    req('POST', `/api/leads/${lead.id}/assign`, {}, beta.agent.token),
  ])
  const codes = [a.status, b.status].sort()
  assert.deepEqual(codes, [200, 409], `expected one win and one conflict, got ${codes}`)
  const loser = a.status === 409 ? a : b
  const body = await loser.json()
  assert.equal(body.code, 'LEAD_ALREADY_CLAIMED')
  assert.match(body.error, /claimed/i)
  assert.ok(![solo.name, beta.agent.name].some((n) => body.error.includes(n)), 'the 409 named the winner')
})

// --- The read side has to agree with the write side -------------------------

test("another team's pool lead is invisible to the detail, notes and label routes", async () => {
  // A guard on the claim alone would still leave the thread, its transcript and its
  // internal notes open to an outsider who knows the id.
  const lead = await poolLead('919811900010', 'Alpha Private Buyer', alpha.team.id)
  const routes = [
    ['GET', `/api/leads/${lead.id}`],
    ['GET', `/api/leads/${lead.id}/notes`],
    ['POST', `/api/leads/${lead.id}/notes`, { body: 'planted by an outsider' }],
    ['PUT', `/api/leads/${lead.id}/labels/1`, { on: true }],
    ['POST', `/api/leads/${lead.id}/read`, {}],
  ]
  const leaks = []
  for (const [method, url, body] of routes) {
    const res = await req(method, url, body, beta.agent.token)
    const text = await res.text()
    // 'not found' is the lead guard. 'label not found' would mean the lead guard let
    // the caller through and only the label lookup stopped them.
    if (res.status !== 404 || !/"error":"not found"/.test(text)) {
      leaks.push(`${method} ${url} -> ${res.status} ${text.slice(0, 160)}`)
    }
  }
  assert.deepEqual(leaks, [], leaks.join('\n'))

  // And nothing was written by the attempt that should have been refused.
  const notes = await jsonOf(await req('GET', `/api/leads/${lead.id}/notes`, undefined, alpha.owner.token))
  assert.deepEqual(notes, [], 'an outsider planted a note on another team’s lead')
})

test("another team's pool lead never appears in the solo lead list or counts", async () => {
  await poolLead('919811900011', 'Alpha Listed Buyer', alpha.team.id)

  const list = await jsonOf(await req('GET', '/api/leads?limit=500', undefined, beta.agent.token))
  assert.ok(
    !list.some((l) => l.wa_id === '919811900011'),
    `Alpha's pool lead showed up in Beta's list: ${JSON.stringify(list.map((l) => l.wa_id))}`,
  )

  const counts = await jsonOf(await req('GET', '/api/leads/count', undefined, beta.agent.token))
  assert.equal(counts.total, list.length, 'the count and the list disagree about what is visible')
})

test('searching by a name only the other team knows does not surface their pool lead', async () => {
  // The search arm is ORed into the same WHERE, so a filter that reopened the pool
  // would be a second way in.
  const rows = await jsonOf(await req('GET', '/api/leads?q=Alpha%20Listed', undefined, beta.agent.token))
  assert.deepEqual(rows, [], 'search reached into another team’s pool')
})

test("Alpha's own member sees Alpha's pool leads in their list and counts", async () => {
  const list = await listLeads(alpha.agent.id, { limit: 500 })
  assert.ok(
    list.some((l) => l.wa_id === '919811900011'),
    'the isolation checks are only meaningful if the legitimate view still works',
  )
  const counts = await leadCounts(alpha.agent.id)
  assert.ok(counts.unassigned > 0, "Alpha's own unassigned badge went blank")
})

test('an untagged pool lead is listed for everybody', async () => {
  for (const who of [alpha.agent, beta.agent, solo]) {
    const list = await listLeads(who.id, { limit: 500 })
    assert.ok(
      list.some((l) => l.id === openLead.id),
      `${who.name} lost sight of the open pool`,
    )
  }
})
