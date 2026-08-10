// Edge and rejection arms of the team layer in db.js — the paths team.test.js never
// reaches because it only drives the happy route: a bad team name, an invite to a
// number that is already on the roster, a role change aimed at a stranger, and every
// way lead assignment can find nobody to assign to.
//
// These are the arms that decide whether a mistake becomes a clear sentence or a
// 500, so they are asserted on the error *code*, not just on "it threw".
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('teamedges')

const { app } = await import('../index.js')
const {
  closePool,
  query,
  createTeam,
  updateTeam,
  updateMember,
  setMemberRole,
  removeMember,
  inviteToTeam,
  respondToInvite,
  listIncomingInvites,
  pickRoundRobin,
  autoAssignTeamLead,
  assignTeamLead,
  claimTeamLead,
  distributeTeamPool,
  upsertLead,
  getAgent,
  pool,
} = await import('../db.js')

let server, base
const PASSWORD = 'secret123'
const MISSING_TEAM = 987654

const req = (method, url, body, tok) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

const signup = async (name, phone) =>
  (await req('POST', '/api/auth/signup', { name, phone, password: PASSWORD }, null)).json()

// Asserts fn() rejects, and that it carries the code the UI switches on.
const rejectsWith = async (fn, code, message) => {
  const err = await fn().then(
    () => null,
    (e) => e,
  )
  assert.ok(err, `expected a rejection${message ? ` (${message})` : ''}`)
  if (code) assert.equal(err.code, code, `error code (message was: ${err.message})`)
  return err
}

let owner, member, stranger

before(async () => {
  await new Promise((r) => (server = app.listen(0, () => r((base = `http://127.0.0.1:${server.address().port}`)))))
  owner = (await signup('Edge Owner', '+919812000001')).agent
  member = (await signup('Edge Member', '+919812000002')).agent
  stranger = (await signup('Edge Stranger', '+919812000003')).agent
})

// An agent can only be in one team, so every test needs the three fixtures back on
// the bench. Teams cascade to memberships and invites, and the leads created along
// the way go too — otherwise one failed test would fail every test after it with a
// confusing "already in a team".
beforeEach(async () => {
  await query('DELETE FROM teams')
  await query('DELETE FROM leads')
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- Team creation and rename validation ---------------------------------------

test('a team name must be present and of a sane length', async () => {
  await rejectsWith(() => createTeam(owner.id, '   '), undefined, 'whitespace-only name')
  await rejectsWith(() => createTeam(owner.id, null), undefined, 'no name at all')
  await rejectsWith(() => createTeam(owner.id, 'x'.repeat(121)), undefined, 'over the 120-char cap')
  // 120 exactly is the boundary and must be accepted.
  const team = await createTeam(owner.id, 'y'.repeat(120))
  assert.equal(team.name.length, 120)
})

test('an agent can only own one team', async () => {
  await createTeam(owner.id, 'Edge Realty')
  await rejectsWith(() => createTeam(owner.id, 'Second Empire'), 'ALREADY_IN_TEAM')
})

test('a rename to blank is refused, and an empty patch is a no-op read', async () => {
  const team = await createTeam(owner.id, 'Rename Realty')
  await rejectsWith(() => updateTeam(team.id, { name: '  ' }), undefined, 'blank rename')
  const untouched = await updateTeam(team.id, {})
  assert.equal(untouched.name, 'Rename Realty', 'an empty patch reads the team back unchanged')
  assert.equal(await updateTeam(MISSING_TEAM, {}), null, 'and a missing team reads back as null')
})

// --- Invitations ----------------------------------------------------------------

test('an invite is refused for a bad number, a bad role, and a member already on the roster', async () => {
  const team = await createTeam(owner.id, 'Invite Realty')

  await rejectsWith(() => inviteToTeam(team.id, owner.id, { phone: '12345' }), 'INVALID_PHONE')
  await rejectsWith(() => inviteToTeam(team.id, owner.id, { phone: '' }), 'INVALID_PHONE')
  await rejectsWith(
    () => inviteToTeam(team.id, owner.id, { phone: '+919812000002', role: 'admin' }),
    undefined,
    'role must be manager or agent',
  )
  // The owner is already on their own roster.
  await rejectsWith(() => inviteToTeam(team.id, owner.id, { phone: owner.phone }), 'ALREADY_MEMBER')

  // A second pending invite to the same number is a duplicate, not a second invite.
  await inviteToTeam(team.id, owner.id, { phone: '+919812000002' })
  await rejectsWith(() => inviteToTeam(team.id, owner.id, { phone: '+919812000002' }), 'DUP_INVITE')

})

// The invite is raised while the invitee is still unattached — inviteToTeam refuses
// outright once they belong somewhere — so the race this covers is the real one: the
// invite goes out, the agent joins another team, and only then answers it.
test('an agent already in a team cannot accept an invite into a second one', async () => {
  const second = await createTeam(stranger.id, 'Second Realty')
  const invite = await inviteToTeam(second.id, stranger.id, { phone: owner.phone })
  const incoming = await listIncomingInvites(owner.phone)
  assert.ok(
    incoming.some((i) => i.id === invite.id),
    'the invite reaches the invitee by their login number',
  )

  await createTeam(owner.id, 'First Realty')
  const ownerRow = await getAgent(owner.id)
  await rejectsWith(() => respondToInvite(invite.id, ownerRow, true), 'ALREADY_IN_TEAM')

  // Declining is always allowed, and a handled invite cannot be answered twice.
  assert.deepEqual(await respondToInvite(invite.id, ownerRow, false), { declined: true })
  await rejectsWith(() => respondToInvite(invite.id, ownerRow, false), 'NOT_FOUND')
})

// An invite raised for a number that already belongs to another roster is refused at
// source, before it can become a pending row nobody can act on.
test('an invite cannot be sent to an agent who is already on another team', async () => {
  await createTeam(owner.id, 'Held Realty')
  const other = await createTeam(stranger.id, 'Poaching Realty')
  await rejectsWith(() => inviteToTeam(other.id, stranger.id, { phone: owner.phone }), 'IN_OTHER_TEAM')
})

test('an invite meant for someone else cannot be claimed', async () => {
  const team = await createTeam(owner.id, 'Wrong Invitee Realty')
  const invite = await inviteToTeam(team.id, owner.id, { phone: '+919812009999' })
  const strangerRow = await getAgent(stranger.id)
  await rejectsWith(() => respondToInvite(invite.id, strangerRow, true), 'WRONG_INVITEE')
})

// --- Roles and membership -------------------------------------------------------

test('role changes and removals reject an unknown role, team, or non-member', async () => {
  const team = await createTeam(owner.id, 'Roles Realty')
  const invite = await inviteToTeam(team.id, owner.id, { phone: member.phone })
  await respondToInvite(invite.id, await getAgent(member.id), true)

  await rejectsWith(() => setMemberRole(team.id, member.id, 'overlord'), undefined, 'unknown role')
  await rejectsWith(() => setMemberRole(MISSING_TEAM, member.id, 'manager'), 'NOT_FOUND', 'missing team')
  await rejectsWith(() => setMemberRole(team.id, stranger.id, 'manager'), 'NOT_MEMBER')
  await rejectsWith(() => setMemberRole(team.id, owner.id, 'agent'), 'OWNER_ROLE')

  const promoted = await setMemberRole(team.id, member.id, 'manager')
  assert.equal(promoted.role, 'manager')

  await rejectsWith(() => removeMember(MISSING_TEAM, member.id), 'NOT_FOUND', 'missing team')
  await rejectsWith(() => removeMember(team.id, stranger.id), 'NOT_MEMBER')
  await rejectsWith(() => removeMember(team.id, owner.id), 'OWNER_REMOVE')

})

test('a member patch coerces a non-array locality list and rejects a stranger', async () => {
  const team = await createTeam(owner.id, 'Patch Realty')

  // An empty patch is a plain read of the membership row.
  const read = await updateMember(team.id, owner.id, {})
  assert.equal(Number(read.agent_id), Number(owner.id))

  // localities is a JSON column the router iterates over. A caller sending a bare
  // string must not leave a non-iterable value in the column.
  const coerced = await updateMember(team.id, owner.id, { localities: 'Wakad' })
  assert.deepEqual(coerced.localities, [], 'anything that is not an array becomes an empty list')

  const set = await updateMember(team.id, owner.id, { localities: ['Wakad'], accepts_leads: false })
  assert.deepEqual(set.localities, ['Wakad'])
  assert.equal(Number(set.accepts_leads), 0)

  await rejectsWith(() => updateMember(team.id, stranger.id, { accepts_leads: true }), 'NOT_MEMBER')
})

// --- Assignment with nobody to assign to ----------------------------------------

test('assignment degrades to null rather than throwing when there is no one to pick', async () => {
  const team = await createTeam(owner.id, 'Empty Realty')
  await query('UPDATE teams SET assignment_strategy = $2 WHERE id = $1', [team.id, 'round_robin'])
  // The only member stops accepting leads, so there is no assignable candidate.
  await updateMember(team.id, owner.id, { accepts_leads: false })

  assert.equal(await pickRoundRobin(team.id), null, 'no assignable members')
  const lead = await upsertLead(owner.id, '919812004001', 'Poolside Pooja')
  await query('UPDATE leads SET team_id = $1, agent_id = NULL WHERE id = $2', [team.id, lead.id])

  assert.equal(await autoAssignTeamLead(team.id, lead.id), null, 'nothing to assign to')
  assert.deepEqual(await distributeTeamPool(team.id), { assigned: 0 }, 'the batch places nobody either')

  await query('DELETE FROM leads WHERE id = $1', [lead.id])
})

test('auto-assign is a no-op for a team that does not exist or does not auto-route', async () => {
  assert.equal(await autoAssignTeamLead(MISSING_TEAM, 1), null, 'unknown team')
  assert.deepEqual(await distributeTeamPool(MISSING_TEAM), { assigned: 0 })

  const team = await createTeam(owner.id, 'Manual Realty')
  const lead = await upsertLead(owner.id, '919812004002', 'Manual Manoj')
  await query('UPDATE leads SET team_id = $1, agent_id = NULL WHERE id = $2', [team.id, lead.id])
  // 'manual' leaves every lead for a human to place.
  await query('UPDATE teams SET assignment_strategy = $2 WHERE id = $1', [team.id, 'manual'])
  assert.equal(await autoAssignTeamLead(team.id, lead.id), null, 'manual teams place nothing')
  assert.deepEqual(await distributeTeamPool(team.id), { assigned: 0 })

  await query('DELETE FROM leads WHERE id = $1', [lead.id])
})

test('a pool with no unassigned leads short-circuits before it reads the roster', async () => {
  const team = await createTeam(owner.id, 'Quiet Realty')
  await query('UPDATE teams SET assignment_strategy = $2 WHERE id = $1', [team.id, 'round_robin'])
  assert.deepEqual(await distributeTeamPool(team.id), { assigned: 0 }, 'nothing in the pool')
})

// --- Locality routing fallbacks -------------------------------------------------

test('locality routing falls back to round-robin for an unmatched or absent locality', async () => {
  const team = await createTeam(owner.id, 'Locality Realty')
  await query('UPDATE teams SET assignment_strategy = $2 WHERE id = $1', [team.id, 'locality'])
  const invite = await inviteToTeam(team.id, owner.id, { phone: member.phone })
  await respondToInvite(invite.id, await getAgent(member.id), true)
  // The owner covers Wakad; the member has no localities at all, which is the
  // null-list arm the matcher has to survive.
  await updateMember(team.id, owner.id, { localities: ['Wakad'] })

  const place = async (waId, locality) => {
    const lead = await upsertLead(owner.id, waId, `Buyer ${waId.slice(-4)}`)
    await query('UPDATE leads SET team_id = $1, agent_id = NULL, locality = $3 WHERE id = $2', [
      team.id,
      lead.id,
      locality,
    ])
    const placed = await autoAssignTeamLead(team.id, lead.id, { locality })
    return placed
  }

  const matched = await place('919812005001', 'Wakad')
  assert.equal(Number(matched.agent_id), Number(owner.id), 'a locality match wins outright')

  // Neither of these matches anyone's list, so both fall through to round-robin
  // and must still land on a real member.
  const unmatched = await place('919812005002', 'Timbuktu')
  assert.ok([owner.id, member.id].map(Number).includes(Number(unmatched.agent_id)), 'round-robin fallback')
  const noLocality = await place('919812005003', null)
  assert.ok([owner.id, member.id].map(Number).includes(Number(noLocality.agent_id)), 'no locality at all')

})

test('a batch distribute mixes locality hits and round-robin fallbacks in one pass', async () => {
  const team = await createTeam(owner.id, 'Batch Realty')
  await query('UPDATE teams SET assignment_strategy = $2 WHERE id = $1', [team.id, 'locality'])
  const invite = await inviteToTeam(team.id, owner.id, { phone: member.phone })
  await respondToInvite(invite.id, await getAgent(member.id), true)
  await updateMember(team.id, owner.id, { localities: ['Baner'] })

  for (const [waId, locality] of [
    ['919812006001', 'Baner'],
    ['919812006002', null],
    ['919812006003', 'Nowhere'],
  ]) {
    const lead = await upsertLead(owner.id, waId, null)
    await query('UPDATE leads SET team_id = $1, agent_id = NULL, locality = $3 WHERE id = $2', [
      team.id,
      lead.id,
      locality,
    ])
  }

  assert.deepEqual(await distributeTeamPool(team.id), { assigned: 3 }, 'every pooled lead is placed')
  const { rows } = await query(
    `SELECT locality, agent_id FROM leads WHERE team_id = $1 AND agent_id IS NOT NULL`,
    [team.id],
  )
  assert.equal(rows.length, 3, 'nothing is left unassigned')
  assert.equal(
    Number(rows.find((r) => r.locality === 'Baner').agent_id),
    Number(owner.id),
    'the locality hit still goes to the member who covers it',
  )
})

// --- Cross-team guards ----------------------------------------------------------

test('a lead cannot be assigned to, or claimed by, someone outside the team', async () => {
  const team = await createTeam(owner.id, 'Guard Realty')
  const lead = await upsertLead(owner.id, '919812007001', 'Guarded Gita')
  await query('UPDATE leads SET team_id = $1 WHERE id = $2', [team.id, lead.id])

  await rejectsWith(() => assignTeamLead(team.id, lead.id, stranger.id), 'NOT_MEMBER')
  await rejectsWith(() => claimTeamLead(team.id, stranger.id, lead.id), 'NOT_MEMBER')

  // A lead that isn't tagged to this team can't be pulled into it by id either.
  const outside = await upsertLead(stranger.id, '919812007002', 'Outside Om')
  assert.equal(await assignTeamLead(team.id, outside.id, owner.id), null, 'no cross-team reach')
  assert.equal(await claimTeamLead(team.id, owner.id, outside.id), null)

})

// --- Losing the membership race -------------------------------------------------
//
// Both team-joining paths guard with `agentTeamId()` — a read of COMMITTED rows —
// and then insert into team_members, whose agent_id is UNIQUE. Between the two, a
// second request can take the membership: a double-tapped button, two devices, an
// invite accepted while a team is being created. The insert then raises 23505, and
// what the agent must get is "You are already in a team", not a 500.
//
// Provoked deterministically rather than by racing: a rival transaction takes the
// membership and holds it open. The guard reads committed rows so it sees nothing
// and lets the caller through; the INSERT then blocks on the uncommitted index
// entry; committing the rival turns that block into the unique violation.
const holdMembership = async (teamId, agentId) => {
  const racer = await pool.connect()
  await racer.query('BEGIN')
  await racer.query('INSERT INTO team_members (team_id, agent_id, role) VALUES ($1, $2, $3)', [teamId, agentId, 'member'])
  return {
    async commit() {
      await racer.query('COMMIT')
      racer.release()
    },
  }
}

test('a membership taken mid-createTeam is ALREADY_IN_TEAM, and leaves no orphan team', async () => {
  const rival = await createTeam(stranger.id, 'Rival Realty')
  const held = await holdMembership(rival.id, owner.id)

  // Settled into a value up front: the rejection lands during the wait below, and an
  // unhandled one would fail the run before the assertion ever sees it.
  const attempt = createTeam(owner.id, 'Doomed Realty').then(() => null, (e) => e)
  await new Promise((r) => setTimeout(r, 150))
  await held.commit()

  const err = await attempt
  assert.ok(err, 'the create succeeded even though the membership was gone')
  assert.equal(err.code, 'ALREADY_IN_TEAM')
  assert.match(err.message, /already in a team/)

  // createTeam inserts the team BEFORE the membership, so the failing insert must take
  // the team down with it — otherwise every lost race leaves a nameless empty team.
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM teams WHERE name = 'Doomed Realty'`)
  assert.equal(rows[0].n, 0, 'the rolled-back create left an orphan team behind')
})

test('a membership taken mid-accept is ALREADY_IN_TEAM, and the invite stays pending', async () => {
  const team = await createTeam(owner.id, 'Invite Realty')
  await inviteToTeam(team.id, owner.id, { phone: member.phone, role: 'member' })
  const [invite] = await listIncomingInvites(member.phone)

  const rival = await createTeam(stranger.id, 'Faster Realty')
  const held = await holdMembership(rival.id, member.id)

  const attempt = respondToInvite(invite.id, member, true).then(() => null, (e) => e)
  await new Promise((r) => setTimeout(r, 150))
  await held.commit()

  const err = await attempt
  assert.ok(err, 'the accept succeeded even though the membership was gone')
  assert.equal(err.code, 'ALREADY_IN_TEAM')

  // The accept also marks the invite used and revokes the others; a rolled-back accept
  // must leave all of that alone, or a lost race would silently burn the invite.
  const still = await listIncomingInvites(member.phone)
  assert.equal(still.length, 1, 'a failed accept consumed the invite anyway')
  assert.equal(still[0].id, invite.id)
})
