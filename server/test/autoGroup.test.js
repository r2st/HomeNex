// autoGroupContacts used to run a group lookup, a segment resolve and a membership
// insert per distinct value, so one button press on a wide address book cost
// hundreds of round trips. It is now three statements whatever the value count.
// These tests pin the semantics that the set-based rewrite has to keep: the same
// membership rule as a dynamic segment (including the preferred_localities match),
// opted-out contacts excluded, ownership enforced, and idempotent re-runs.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('autogroup')

const db = await import('../db.js')
const { hashPassword } = await import('../auth.js')
const {
  autoGroupContacts, addContact, upsertLead, applyExtraction, createGroup,
  groupMembers, updateContact, pool, closePool,
} = db

let agent, other

// Seeds a contact plus its linked lead. Contacts join leads by phone, so the
// number has to be the same on both sides for a segment to resolve at all.
async function seed(a, digits, name, extraction) {
  const contact = await addContact(a.id, `+91${digits}`, name)
  const lead = await upsertLead(a.id, `91${digits}`, name)
  if (extraction) await applyExtraction(lead.id, extraction)
  return contact
}

async function countQueries(fn) {
  const original = pool.query.bind(pool)
  let n = 0
  pool.query = (...args) => {
    n++
    return original(...args)
  }
  try {
    await fn()
  } finally {
    pool.query = original
  }
  return n
}

const named = (groups, name) => groups.find((g) => g.name === name)

before(async () => {
  await db.ready
  agent = await db.createAgent('Auto Group', '+919812000001', null, hashPassword('secret123'))
  other = await db.createAgent('Other Agent', '+919812000002', null, hashPassword('secret123'))
})

after(async () => {
  await closePool()
  await dropTestDb(dbName)
})

test('rejects a dimension it does not know', async () => {
  await assert.rejects(() => autoGroupContacts(agent.id, 'zodiac'), /unknown grouping dimension/)
  await assert.rejects(() => autoGroupContacts(agent.id, undefined), /unknown grouping dimension/)
  // A prototype key is not a dimension either.
  await assert.rejects(() => autoGroupContacts(agent.id, 'constructor'), /unknown grouping dimension/)
})

test('an agent with no leads gets no groups and runs one query', async () => {
  const empty = await db.createAgent('No Leads', '+919812000003', null, hashPassword('secret123'))
  let groups
  const n = await countQueries(async () => {
    groups = await autoGroupContacts(empty.id, 'locality')
  })
  assert.deepEqual(groups, [])
  assert.equal(n, 1, 'nothing to group short-circuits after the values query')
})

test('groups by locality, matching the same rule a dynamic segment uses', async () => {
  const wakad = await seed(agent, '9812100001', 'Wakad Wendy', { locality: 'Wakad', intent: 'buy', preferred_localities: ['Wakad'] })
  const baner = await seed(agent, '9812100002', 'Baner Bala', { locality: 'Baner', intent: 'invest', preferred_localities: ['Baner'] })
  // Lives in Kharadi but is shopping in Wakad — segmentWhere matches the
  // preferred_localities list as well as the lead's own locality, so this
  // contact belongs to BOTH groups.
  const shopper = await seed(agent, '9812100003', 'Kharadi Kiran', { locality: 'Kharadi', preferred_localities: ['Wakad'] })

  const groups = await autoGroupContacts(agent.id, 'locality')
  assert.deepEqual(
    groups.map((g) => g.name).sort(),
    ['Locality: Baner', 'Locality: Kharadi', 'Locality: Wakad'],
  )

  const wakadGroup = named(groups, 'Locality: Wakad')
  assert.equal(wakadGroup.member_count, 2)
  assert.deepEqual(
    (await groupMembers(wakadGroup.id, agent.id)).map((m) => m.id).sort(),
    [wakad.id, shopper.id].sort(),
  )
  assert.equal(named(groups, 'Locality: Baner').member_count, 1)
  assert.deepEqual((await groupMembers(named(groups, 'Locality: Kharadi').id, agent.id)).map((m) => m.id), [shopper.id])
  assert.equal(named(groups, 'Locality: Baner').kind, 'static')

  // Sanity: the same answer the live segment gives.
  const segment = await db.resolveSegment(agent.id, { locality: 'Wakad' })
  assert.equal(segment.length, wakadGroup.member_count)
  void baner
})

test('re-running tops membership up instead of duplicating groups or rows', async () => {
  const before = await autoGroupContacts(agent.id, 'locality')
  const wakadId = named(before, 'Locality: Wakad').id

  // A new Wakad contact arrives between runs.
  const late = await seed(agent, '9812100004', 'Late Lakshmi', { locality: 'Wakad', preferred_localities: ['Wakad'] })
  const after = await autoGroupContacts(agent.id, 'locality')

  assert.equal(named(after, 'Locality: Wakad').id, wakadId, 'same group, not a second one')
  assert.equal(named(after, 'Locality: Wakad').member_count, 3)
  const members = (await groupMembers(wakadId, agent.id)).map((m) => m.id)
  assert.ok(members.includes(late.id))
  assert.equal(new Set(members).size, members.length, 'no duplicate membership rows')

  const rows = await db.query("SELECT COUNT(*)::int AS n FROM contact_groups WHERE agent_id = $1 AND name = 'Locality: Wakad'", [agent.id])
  assert.equal(rows.rows[0].n, 1)
})

test('opted-out contacts are excluded, exactly as resolveSegment excludes them', async () => {
  const quiet = await seed(agent, '9812100005', 'Quiet Qadir', { locality: 'Hinjewadi', preferred_localities: ['Hinjewadi'] })
  assert.equal(named(await autoGroupContacts(agent.id, 'locality'), 'Locality: Hinjewadi').member_count, 1)

  await updateContact(quiet.id, agent.id, { opt_in_status: 'opted_out' })
  const groups = await autoGroupContacts(agent.id, 'locality')
  // The group still exists (the lead is still there) but the segment is empty.
  assert.equal(named(groups, 'Locality: Hinjewadi').member_count, 0)
})

test('groups by intent and by temperature', async () => {
  const byIntent = await autoGroupContacts(agent.id, 'intent')
  assert.deepEqual(byIntent.map((g) => g.name).sort(), ['Intent: buy', 'Intent: invest'])
  assert.equal(named(byIntent, 'Intent: buy').member_count, 1)
  assert.equal(named(byIntent, 'Intent: invest').member_count, 1)

  const byTemp = await autoGroupContacts(agent.id, 'temp')
  assert.ok(byTemp.length > 0, 'leads carry a temp by default')
  for (const g of byTemp) assert.ok(g.name.startsWith('Temp: '))
  // Temperature groups partition the contacts — nobody is in two at once.
  const seen = new Set()
  for (const g of byTemp) {
    for (const m of await groupMembers(g.id, agent.id)) {
      assert.ok(!seen.has(m.id), `${m.name} is in two temperature groups`)
      seen.add(m.id)
    }
  }
})

test('effective_temp wins over the raw AI temp', async () => {
  const cooled = await seed(agent, '9812100006', 'Cooled Chandra', { temp: 'Hot' })
  const lead = (await db.query('SELECT id FROM leads WHERE agent_id = $1 AND wa_id = $2', [agent.id, '919812100006'])).rows[0]
  await db.query("UPDATE leads SET temp = 'Hot', effective_temp = 'Cold' WHERE id = $1", [lead.id])

  const groups = await autoGroupContacts(agent.id, 'temp')
  const cold = named(groups, 'Temp: Cold')
  assert.ok(cold, 'grouped under the decayed temperature')
  assert.ok((await groupMembers(cold.id, agent.id)).some((m) => m.id === cooled.id))
  const hot = named(groups, 'Temp: Hot')
  if (hot) assert.ok(!(await groupMembers(hot.id, agent.id)).some((m) => m.id === cooled.id))
})

test('another agent\'s contacts never leak into my groups', async () => {
  await seed(other, '9812100007', 'Their Wakad Contact', { locality: 'Wakad', preferred_localities: ['Wakad'] })

  const mine = await autoGroupContacts(agent.id, 'locality')
  const theirs = await autoGroupContacts(other.id, 'locality')

  const mineMembers = await groupMembers(named(mine, 'Locality: Wakad').id, agent.id)
  assert.ok(!mineMembers.some((m) => m.agent_id !== agent.id))
  assert.equal(named(theirs, 'Locality: Wakad').member_count, 1)
  assert.notEqual(named(theirs, 'Locality: Wakad').id, named(mine, 'Locality: Wakad').id)
})

test('a dynamic group of the same name is not given explicit members', async () => {
  // Claim the name with a dynamic group before auto-grouping ever sees it.
  await seed(agent, '9812100008', 'Aundh Anil', { locality: 'Aundh', preferred_localities: ['Aundh'] })
  const dynamic = await createGroup(agent.id, { name: 'Locality: Aundh', kind: 'dynamic', criteria: { locality: 'Aundh' } })

  const groups = await autoGroupContacts(agent.id, 'locality')
  assert.equal(named(groups, 'Locality: Aundh').id, dynamic.id)
  const explicit = await db.query('SELECT COUNT(*)::int AS n FROM contact_group_members WHERE group_id = $1', [dynamic.id])
  assert.equal(explicit.rows[0].n, 0, 'a dynamic group resolves live and must stay empty')
  // It still reports the segment size, and still resolves its members live.
  assert.equal(named(groups, 'Locality: Aundh').member_count, 1)
  assert.equal((await groupMembers(dynamic.id, agent.id)).length, 1)
})

test('query count is flat in the number of distinct values', async () => {
  const narrow = await db.createAgent('Narrow', '+919812000004', null, hashPassword('secret123'))
  const wide = await db.createAgent('Wide', '+919812000005', null, hashPassword('secret123'))

  for (let i = 0; i < 2; i++) {
    await seed(narrow, `98122000${String(i).padStart(2, '0')}`, `N${i}`, { locality: `Narrow${i}`, preferred_localities: [`Narrow${i}`] })
  }
  for (let i = 0; i < 30; i++) {
    await seed(wide, `98123000${String(i).padStart(2, '0')}`, `W${i}`, { locality: `Wide${i}`, preferred_localities: [`Wide${i}`] })
  }

  const qNarrow = await countQueries(() => autoGroupContacts(narrow.id, 'locality'))
  const qWide = await countQueries(() => autoGroupContacts(wide.id, 'locality'))

  // values + bulk group insert + group read-back + the combined membership
  // insert/count — four statements, for 2 localities or for 30.
  assert.equal(qNarrow, 4)
  assert.equal(qWide, 4, `30 localities cost ${qWide} queries, not a flat 4`)
  assert.equal((await autoGroupContacts(wide.id, 'locality')).length, 30)
})
