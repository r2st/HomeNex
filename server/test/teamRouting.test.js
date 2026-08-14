// How a team decides who gets a lead, at the two edges the happy path never reaches:
// the rotation landing back on the agent whose line the message arrived on, and a
// locality match run against a member whose locality list is not a list.
//
// Both are cheap to get wrong in a way nobody notices. A rotation that hands the
// lead to "the next member" without checking whether that IS the line owner does a
// pointless reassignment on every other message; a locality match that assumes the
// column holds an array throws on the one member who has never set theirs, and takes
// the whole distribution down with it.
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
process.env.WHATSAPP_APP_SECRET = 'routing-app-secret'
const dbName = await createTestDb('teamrouting')

const { app } = await import('../index.js')
const {
  ready,
  closePool,
  query,
  createAgent,
  createTeam,
  updateTeam,
  updateMember,
  upsertLead,
  autoAssignTeamLead,
  distributeTeamPool,
  getLead,
} = await import('../db.js')
const { hashPassword } = await import('../auth.js')

await ready

const APP_SECRET = 'routing-app-secret'
let server, base
let owner, member

const signup = async (name, phone) =>
  (
    await fetch(`${base}/api/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, phone, password: 'secret123' }),
    })
  ).json()

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  owner = await createAgent('Routing Owner', '+919833000001', null, hashPassword('secret123'))
  member = await createAgent('Routing Member', '+919833000002', null, hashPassword('secret123'))
})

// An agent can only be in one team, and the webhook tests leave messages, contacts
// and activity hanging off their leads — so the reset has to cascade rather than
// delete row by row.
beforeEach(async () => {
  await query('TRUNCATE leads, teams RESTART IDENTITY CASCADE')
})

after(async () => {
  server?.close()
  // The webhook acks before its pipeline finishes; give the tail a moment so a
  // stray write doesn't meet a closed pool.
  await new Promise((r) => setTimeout(r, 150))
  await closePool()
  await dropTestDb(dbName)
})

// A team of exactly two, owner first, so the rotation order is known: member_id
// ascending puts the owner at index 0 and the member at index 1.
async function twoPersonTeam(strategy) {
  const team = await createTeam(owner.id, 'Routing Realty')
  await query('INSERT INTO team_members (team_id, agent_id, role) VALUES ($1, $2, $3)', [
    team.id,
    member.id,
    'agent',
  ])
  await updateTeam(team.id, { assignment_strategy: strategy })
  return team
}

// --- Round-robin on an inbound line ------------------------------------------

let msgSeq = 0
const postWebhook = (from, text, phoneNumberId) => {
  const raw = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: 'Rotation Buyer' }, wa_id: from }],
              messages: [{ from, id: `wamid.RT.${++msgSeq}`, timestamp: '1', type: 'text', text: { body: text } }],
            },
          },
        ],
      },
    ],
  })
  return fetch(`${base}/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex'),
    },
    body: raw,
  })
}

async function until(fn, what, timeoutMs = 5000) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}
const leadByWaId = async (waId) =>
  (await query('SELECT * FROM leads WHERE wa_id = $1', [waId])).rows[0] || null

// The webhook acks before its pipeline finishes, and the last thing a brand-new
// lead gets is its 'new' auto-label. Waiting for that means the team tag and the
// activity note are already written — and that the next test's reset can't truncate
// the table out from under a write still in flight.
const settledLead = async (waId) => {
  const lead = await until(() => leadByWaId(waId), `the lead for ${waId}`)
  await until(
    async () => (await query('SELECT 1 FROM lead_labels WHERE lead_id = $1', [lead.id])).rowCount > 0,
    'the new-lead label',
  )
  return leadByWaId(waId)
}

test('when the rotation lands on the line owner, the lead is not reassigned to them', async () => {
  const team = await twoPersonTeam('round_robin')
  await query('UPDATE agents SET wa_phone_number_id = $2 WHERE id = $1', [owner.id, 'rotation-line'])
  // Cursor 0 → the next pick is index 0, which is the owner: the very agent whose
  // line this is. resolveTeamLineAgent must recognise that and keep them, rather
  // than re-fetching the same agent record to arrive at the same answer.
  await query('UPDATE teams SET rr_cursor = 0 WHERE id = $1', [team.id])

  await postWebhook('919833010001', 'hello', 'rotation-line')
  const lead = await settledLead('919833010001')
  assert.equal(lead.agent_id, owner.id, 'stayed on the line it arrived on')
  assert.equal(lead.team_id, team.id, 'and is tagged to the team either way')
})

test('when the rotation lands on the other member, the lead follows the rotation', async () => {
  const team = await twoPersonTeam('round_robin')
  await query('UPDATE agents SET wa_phone_number_id = $2 WHERE id = $1', [owner.id, 'rotation-line'])
  // Cursor 1 → the next pick is index 1: the other member, not the line owner.
  await query('UPDATE teams SET rr_cursor = 1 WHERE id = $1', [team.id])

  await postWebhook('919833010002', 'hello', 'rotation-line')
  const lead = await settledLead('919833010002')
  assert.equal(lead.agent_id, member.id, 'handed to the next member in rotation')
})

test('a returning sender stays with the member who already owns them', async () => {
  const team = await twoPersonTeam('round_robin')
  await query('UPDATE agents SET wa_phone_number_id = $2 WHERE id = $1', [owner.id, 'rotation-line'])
  await query('UPDATE teams SET rr_cursor = 1 WHERE id = $1', [team.id])

  await postWebhook('919833010003', 'first', 'rotation-line')
  const first = await settledLead('919833010003')
  assert.equal(first.agent_id, member.id)

  // The cursor now points back at the owner. A returning sender must not be
  // re-rotated onto them — the existing owner short-circuits the pick.
  await postWebhook('919833010003', 'second', 'rotation-line')
  await until(
    async () => (await query('SELECT 1 FROM messages WHERE lead_id = $1 AND role = $2', [first.id, 'buyer'])).rowCount === 2,
    'both buyer messages',
    15000,
  )
  const leads = (await query('SELECT * FROM leads WHERE wa_id = $1', ['919833010003'])).rows
  assert.equal(leads.length, 1, 'one sender, one lead')
  assert.equal(leads[0].agent_id, member.id, 'still theirs')
})

// --- Locality matching against a member who has no localities ----------------

// The column is `JSONB NOT NULL DEFAULT '[]'`, which still admits the JSON value
// `null` — and that is what pg hands back as a JS null. A member row written before
// the column existed, or restored from an export that serialised an empty list as
// null, looks exactly like this.
const blankLocalities = (agentId) =>
  query(`UPDATE team_members SET localities = 'null'::jsonb WHERE agent_id = $1`, [agentId])

test('a member with no locality list is skipped, not thrown over', async () => {
  const team = await twoPersonTeam('locality')
  await blankLocalities(owner.id)
  await updateMember(team.id, member.id, { localities: ['Baner', 'Wakad'] })

  const lead = await upsertLead(null, '919833020001', 'Baner Buyer')
  await query('UPDATE leads SET team_id = $1, locality = $2 WHERE id = $3', [team.id, 'Baner', lead.id])

  const assigned = await autoAssignTeamLead(team.id, lead.id, { locality: 'Baner' })
  assert.ok(assigned, 'the lead was placed')
  assert.equal(assigned.agent_id, member.id, 'placed with the member who does cover Baner')
})

test('an empty string in a locality list never matches everything', async () => {
  const team = await twoPersonTeam('locality')
  // A blank chip left behind by the locality editor. Substring matching in either
  // direction would make '' match every locality there is, so it has to be dropped.
  await updateMember(team.id, owner.id, { localities: ['', '  '] })
  await updateMember(team.id, member.id, { localities: ['Kothrud'] })

  const lead = await upsertLead(null, '919833020002', 'Hinjewadi Buyer')
  await query('UPDATE leads SET team_id = $1, locality = $2 WHERE id = $3', [team.id, 'Hinjewadi', lead.id])

  const assigned = await autoAssignTeamLead(team.id, lead.id, { locality: 'Hinjewadi' })
  // Nobody covers Hinjewadi, so this falls through to round-robin rather than
  // matching the owner's blank entry.
  assert.ok(assigned, 'still placed, by rotation')
  assert.ok([owner.id, member.id].includes(assigned.agent_id))
})

test('distributing the pool skips members with no locality list', async () => {
  const team = await twoPersonTeam('locality')
  await blankLocalities(owner.id)
  await updateMember(team.id, member.id, { localities: ['Kothrud'] })

  const matched = await upsertLead(null, '919833020003', 'Kothrud Buyer')
  const unmatched = await upsertLead(null, '919833020004', 'Nowhere Buyer')
  await query('UPDATE leads SET team_id = $1, locality = $2 WHERE id = $3', [team.id, 'Kothrud', matched.id])
  await query('UPDATE leads SET team_id = $1, locality = NULL WHERE id = $2', [team.id, unmatched.id])

  const result = await distributeTeamPool(team.id)
  assert.equal(result.assigned, 2, 'both leads were placed')
  assert.equal((await getLead(matched.id)).agent_id, member.id, 'the Kothrud lead went to the Kothrud member')
  const other = await getLead(unmatched.id)
  assert.ok([owner.id, member.id].includes(other.agent_id), 'the locality-less lead went out by rotation')
})

// --- The claim route's error arm ---------------------------------------------

test('claiming a lead by an id that is not one is refused before any query runs', async () => {
  const solo = await signup('Claim Chetan', '+919833000003')
  const team = await createTeam(solo.agent.id, 'Claim Corp')

  const bad = await fetch(`${base}/api/team/leads/not-a-number/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${solo.token}` },
  })
  assert.equal(bad.status, 400)
  assert.deepEqual(await bad.json(), { error: 'Invalid id', code: 'BAD_ID' })

  // A well-formed id for a lead that isn't claimable is the route's own answer.
  const gone = await fetch(`${base}/api/team/leads/999999/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${solo.token}` },
  })
  assert.equal(gone.status, 409)
  assert.equal((await gone.json()).error, 'lead is not available to claim')
  assert.ok(team.id, 'the team survived both refusals')
})
