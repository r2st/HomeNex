// The rest of the team stamp.
//
// R25 found that only inbound WhatsApp leads carried team_id, and criticalFlows.test.js
// closed the biggest half of it: leadSources.ingestLead now stamps walk-ins, portal
// emails and Lead Ads on the way in. But stampLeadTeam only ever runs as a lead is
// CREATED, and a lead can join a team three other ways — which left the same symptom
// (a lead its owner can see and their manager cannot) reachable from three directions:
//
//   1. The agent creates a team. Everything they worked before that moment stays NULL,
//      so a solo agent who has built a book of 200 leads and then forms an agency looks
//      to their own new board like they have never taken a lead.
//   2. The agent accepts an invite. Same shape, and worse: the manager invited them
//      precisely to see and distribute their pipeline.
//   3. The agent claims a lead from the shared pool (POST /api/leads/:id/assign). The
//      team-scoped sibling, claimTeamLead, keeps the tag. This one dropped it.
//
// Each test asserts through the manager's actual view — GET /api/team/leads — and not
// just on the column, because the column is only interesting for what it makes visible,
// and it is the view that was empty.
//
// removeMember has always cleared team_id on the way out, so the invariant these
// pin down is the round trip: a member's leads are in team scope for exactly as long
// as the member is.
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('teambackfill')

const { app } = await import('../index.js')
const { closePool, query, upsertLead, upsertUnassignedLead, removeMember } = await import('../db.js')

let server, base
const PASSWORD = 'secret123'

const req = (method, url, body, tok) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

const json = async (...args) => (await req(...args)).json()

const signup = async (name, phone) => json('POST', '/api/auth/signup', { name, phone, password: PASSWORD }, null)

const teamIdOf = async (leadId) =>
  (await query('SELECT team_id FROM leads WHERE id = $1', [leadId])).rows[0].team_id

/** The manager's shared inbox, which is the screen the missing stamp emptied. */
const teamLeadNames = async (tok) => (await json('GET', '/api/team/leads', undefined, tok)).map((l) => l.name).sort()

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
})

after(async () => {
  await new Promise((r) => server.close(r))
  await closePool()
  await dropTestDb(dbName)
})

beforeEach(async () => {
  await query('DELETE FROM team_invites')
  await query('DELETE FROM team_members')
  await query('DELETE FROM leads')
  await query('DELETE FROM teams')
})

let seq = 0
const nextPhone = () => `+9198765${String(10000 + seq++).slice(-5)}`

// --- 1. Forming a team brings your existing book with you ---------------------

test('leads worked before the team existed appear in the team the moment it is created', async () => {
  const owner = await signup('Rakesh Menon', nextPhone())
  const before1 = await upsertLead(owner.agent.id, '919000000101', 'Priya (walk-in)')
  const before2 = await upsertLead(owner.agent.id, '919000000102', 'Vikram (99acres)')
  assert.equal(await teamIdOf(before1.id), null, 'a solo agent has no team to stamp')

  const team = await json('POST', '/api/team', { name: 'Menon Realty' }, owner.token)

  assert.equal(await teamIdOf(before1.id), team.id)
  assert.equal(await teamIdOf(before2.id), team.id)
  assert.deepEqual(await teamLeadNames(owner.token), ['Priya (walk-in)', 'Vikram (99acres)'])
})

test('forming a team does not touch another agent\'s leads', async () => {
  const owner = await signup('Rakesh Menon', nextPhone())
  const stranger = await signup('Farida Sheikh', nextPhone())
  const theirs = await upsertLead(stranger.agent.id, '919000000103', 'Not yours')

  await json('POST', '/api/team', { name: 'Menon Realty' }, owner.token)

  assert.equal(await teamIdOf(theirs.id), null)
})

test('forming a team leaves the unclaimed pool alone', async () => {
  const owner = await signup('Rakesh Menon', nextPhone())
  const pooled = await upsertUnassignedLead('919000000104', 'Unknown sender')

  await json('POST', '/api/team', { name: 'Menon Realty' }, owner.token)

  assert.equal(await teamIdOf(pooled.id), null, 'nobody owns it, so it belongs to no team')
})

// --- 2. Accepting an invite brings your existing book with you ----------------

test('a joining member\'s existing leads reach the manager who invited them', async () => {
  const ownerPhone = nextPhone()
  const joinerPhone = nextPhone()
  const owner = await signup('Rakesh Menon', ownerPhone)
  const joiner = await signup('Sana Qureshi', joinerPhone)
  const carried = await upsertLead(joiner.agent.id, '919000000105', 'Anand (portal email)')

  const team = await json('POST', '/api/team', { name: 'Menon Realty' }, owner.token)
  const invite = await json('POST', '/api/team/invites', { phone: joinerPhone, role: 'agent' }, owner.token)
  const res = await req('POST', `/api/team/invites/${invite.id}/accept`, {}, joiner.token)
  assert.equal(res.status, 200)

  assert.equal(await teamIdOf(carried.id), team.id)
  assert.ok((await teamLeadNames(owner.token)).includes('Anand (portal email)'))
})

test('declining an invite carries nothing into the team', async () => {
  const ownerPhone = nextPhone()
  const joinerPhone = nextPhone()
  const owner = await signup('Rakesh Menon', ownerPhone)
  const joiner = await signup('Sana Qureshi', joinerPhone)
  const kept = await upsertLead(joiner.agent.id, '919000000106', 'Stays private')

  await json('POST', '/api/team', { name: 'Menon Realty' }, owner.token)
  const invite = await json('POST', '/api/team/invites', { phone: joinerPhone, role: 'agent' }, owner.token)
  await req('POST', `/api/team/invites/${invite.id}/decline`, {}, joiner.token)

  assert.equal(await teamIdOf(kept.id), null)
  assert.deepEqual(await teamLeadNames(owner.token), [])
})

test('a rejected accept leaves the backfill unapplied — membership and stamp commit together', async () => {
  const ownerPhone = nextPhone()
  const joinerPhone = nextPhone()
  const owner = await signup('Rakesh Menon', ownerPhone)
  const joiner = await signup('Sana Qureshi', joinerPhone)
  const theirs = await upsertLead(joiner.agent.id, '919000000107', 'Still solo')

  const team = await json('POST', '/api/team', { name: 'Menon Realty' }, owner.token)
  const invite = await json('POST', '/api/team/invites', { phone: joinerPhone, role: 'agent' }, owner.token)
  // The joiner forms their own team first, so the invite can no longer be accepted.
  await json('POST', '/api/team', { name: 'Qureshi Properties' }, joiner.token)

  const res = await req('POST', `/api/team/invites/${invite.id}/accept`, {}, joiner.token)
  assert.equal(res.status, 409)
  assert.notEqual(await teamIdOf(theirs.id), team.id, 'the refused team never sees their leads')
  assert.deepEqual(await teamLeadNames(owner.token), [])
})

test('joining does not re-tag a lead that already belongs to another team', async () => {
  const ownerPhone = nextPhone()
  const joinerPhone = nextPhone()
  const owner = await signup('Rakesh Menon', ownerPhone)
  const joiner = await signup('Sana Qureshi', joinerPhone)

  // The joiner had their own team, took a lead, then disbanded and moved on.
  const old = await json('POST', '/api/team', { name: 'Qureshi Properties' }, joiner.token)
  const historic = await upsertLead(joiner.agent.id, '919000000108', 'From the old shop')
  await query('UPDATE leads SET team_id = $1 WHERE id = $2', [old.id, historic.id])
  await query('DELETE FROM team_members WHERE agent_id = $1', [joiner.agent.id])

  const team = await json('POST', '/api/team', { name: 'Menon Realty' }, owner.token)
  const invite = await json('POST', '/api/team/invites', { phone: joinerPhone, role: 'agent' }, owner.token)
  await req('POST', `/api/team/invites/${invite.id}/accept`, {}, joiner.token)

  assert.equal(await teamIdOf(historic.id), old.id, 'an existing tag is another team\'s to move')
  assert.notEqual(await teamIdOf(historic.id), team.id)
})

// --- 3. Claiming from the shared pool ----------------------------------------

test('a lead claimed from the shared pool lands in the claimer\'s team', async () => {
  const owner = await signup('Rakesh Menon', nextPhone())
  const team = await json('POST', '/api/team', { name: 'Menon Realty' }, owner.token)
  const pooled = await upsertUnassignedLead('919000000109', 'Walked in off the number')

  const res = await req('POST', `/api/leads/${pooled.id}/assign`, {}, owner.token)
  assert.equal(res.status, 200)

  assert.equal(await teamIdOf(pooled.id), team.id)
  assert.ok((await teamLeadNames(owner.token)).includes('Walked in off the number'))
})

test('a solo agent claiming from the pool still leaves the lead untagged', async () => {
  const solo = await signup('Farida Sheikh', nextPhone())
  const pooled = await upsertUnassignedLead('919000000110', 'Nobody\'s team')

  await req('POST', `/api/leads/${pooled.id}/assign`, {}, solo.token)

  assert.equal(await teamIdOf(pooled.id), null)
})

test('claiming does not move a lead that is already tagged to a team', async () => {
  const ownerA = await signup('Rakesh Menon', nextPhone())
  const ownerB = await signup('Farida Sheikh', nextPhone())
  const teamA = await json('POST', '/api/team', { name: 'Menon Realty' }, ownerA.token)
  await json('POST', '/api/team', { name: 'Sheikh Estates' }, ownerB.token)

  const pooled = await upsertUnassignedLead('919000000111', 'In A\'s pool')
  await query('UPDATE leads SET team_id = $1 WHERE id = $2', [teamA.id, pooled.id])

  await req('POST', `/api/leads/${pooled.id}/assign`, {}, ownerB.token)

  assert.equal(await teamIdOf(pooled.id), teamA.id, 'the tag is team A\'s to move, not this route\'s')
})

test('a second claim on an already-claimed lead is refused and changes no tag', async () => {
  const first = await signup('Rakesh Menon', nextPhone())
  const second = await signup('Farida Sheikh', nextPhone())
  const teamA = await json('POST', '/api/team', { name: 'Menon Realty' }, first.token)
  const teamB = await json('POST', '/api/team', { name: 'Sheikh Estates' }, second.token)
  const pooled = await upsertUnassignedLead('919000000112', 'Contested')

  assert.equal((await req('POST', `/api/leads/${pooled.id}/assign`, {}, first.token)).status, 200)
  assert.equal((await req('POST', `/api/leads/${pooled.id}/assign`, {}, second.token)).status, 409)

  assert.equal(await teamIdOf(pooled.id), teamA.id)
  assert.notEqual(await teamIdOf(pooled.id), teamB.id)
})

// --- The round trip -----------------------------------------------------------

test('a member\'s leads are in team scope for exactly as long as the member is', async () => {
  const ownerPhone = nextPhone()
  const joinerPhone = nextPhone()
  const owner = await signup('Rakesh Menon', ownerPhone)
  const joiner = await signup('Sana Qureshi', joinerPhone)
  const lead = await upsertLead(joiner.agent.id, '919000000113', 'Travels with them')

  const team = await json('POST', '/api/team', { name: 'Menon Realty' }, owner.token)
  const invite = await json('POST', '/api/team/invites', { phone: joinerPhone, role: 'agent' }, owner.token)
  await req('POST', `/api/team/invites/${invite.id}/accept`, {}, joiner.token)
  assert.equal(await teamIdOf(lead.id), team.id, 'in on join')

  await removeMember(team.id, joiner.agent.id)
  assert.equal(await teamIdOf(lead.id), null, 'out on removal')
  assert.deepEqual(await teamLeadNames(owner.token), [])
})
