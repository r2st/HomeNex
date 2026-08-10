// addGroupMembers used to INSERT one row at a time, which made auto-grouping a
// large address book quadratic. It is now a single INSERT ... SELECT, so these
// tests pin the behaviour that the join has to keep enforcing: agent ownership,
// duplicate tolerance, and an honest "added" count.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('groupmembers')

const { app } = await import('../index.js')
const { closePool, pool, addContact, createGroup, addGroupMembers, groupMembers } =
  await import('../db.js')

let server, base, token, agentId, otherToken, otherAgentId

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

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

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const mine = await (await req('POST', '/api/auth/signup', { name: 'Group Agent', phone: '+919800000801', password: 'secret123' }, null)).json()
  token = mine.token
  agentId = mine.agent.id
  const other = await (await req('POST', '/api/auth/signup', { name: 'Other Agent', phone: '+919800000802', password: 'secret123' }, null)).json()
  otherToken = other.token
  otherAgentId = other.agent.id
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

test('adds a batch of owned contacts in one shot', async () => {
  const group = await createGroup(agentId, { name: 'Batch A' })
  const ids = []
  for (let i = 0; i < 5; i++) ids.push((await addContact(agentId, `+91980010000${i}`, `C${i}`)).id)

  const added = await addGroupMembers(group.id, agentId, ids)
  assert.equal(added, 5)
  assert.equal((await groupMembers(group.id, agentId)).length, 5)
})

test('contacts belonging to another agent are silently skipped', async () => {
  const group = await createGroup(agentId, { name: 'Batch B' })
  const mineContact = await addContact(agentId, '+919800102001', 'Mine')
  const theirsContact = await addContact(otherAgentId, '+919800102002', 'Theirs')

  const added = await addGroupMembers(group.id, agentId, [mineContact.id, theirsContact.id])
  assert.equal(added, 1, 'only the owned contact was added')

  const members = await groupMembers(group.id, agentId)
  assert.deepEqual(members.map((m) => m.id), [mineContact.id])
})

test('re-adding is idempotent and reports zero newly added', async () => {
  const group = await createGroup(agentId, { name: 'Batch C' })
  const c = await addContact(agentId, '+919800103001', 'Dup')

  assert.equal(await addGroupMembers(group.id, agentId, [c.id]), 1)
  assert.equal(await addGroupMembers(group.id, agentId, [c.id]), 0, 'second add is a no-op')
  assert.equal((await groupMembers(group.id, agentId)).length, 1)
})

test('duplicate ids within one call insert the contact once', async () => {
  const group = await createGroup(agentId, { name: 'Batch D' })
  const c = await addContact(agentId, '+919800104001', 'Twice')

  const added = await addGroupMembers(group.id, agentId, [c.id, c.id, c.id])
  assert.equal(added, 1)
  assert.equal((await groupMembers(group.id, agentId)).length, 1)
})

test('an empty id list is a no-op that touches no rows', async () => {
  const group = await createGroup(agentId, { name: 'Batch E' })
  assert.equal(await addGroupMembers(group.id, agentId, []), 0)
  assert.equal((await groupMembers(group.id, agentId)).length, 0)
})

test('a group owned by another agent is refused', async () => {
  const theirGroup = await createGroup(otherAgentId, { name: 'Not Mine' })
  const c = await addContact(agentId, '+919800105001', 'X')
  assert.equal(await addGroupMembers(theirGroup.id, agentId, [c.id]), null)
})

test('insert cost does not grow with batch size', async () => {
  const small = await createGroup(agentId, { name: 'Cost Small' })
  const large = await createGroup(agentId, { name: 'Cost Large' })
  const ids = []
  for (let i = 0; i < 40; i++) ids.push((await addContact(agentId, `+9198002${String(i).padStart(5, '0')}`, `Cost${i}`)).id)

  const qSmall = await countQueries(() => addGroupMembers(small.id, agentId, ids.slice(0, 2)))
  const qLarge = await countQueries(() => addGroupMembers(large.id, agentId, ids))

  // getGroup + the single bulk INSERT, whether it's 2 contacts or 40.
  assert.equal(qSmall, 2)
  assert.equal(qLarge, 2)
})

test('POST /api/groups/:id/members reports the added count over HTTP', async () => {
  const group = await createGroup(agentId, { name: 'Over HTTP' })
  const a = await addContact(agentId, '+919800106001', 'H1')
  const b = await addContact(agentId, '+919800106002', 'H2')

  const res = await req('POST', `/api/groups/${group.id}/members`, { contact_ids: [a.id, b.id] })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { added: 2 })

  const again = await req('POST', `/api/groups/${group.id}/members`, { contact_ids: [a.id, b.id] })
  assert.deepEqual(await again.json(), { added: 0 })
})

test('another agent cannot add members to my group over HTTP', async () => {
  const group = await createGroup(agentId, { name: 'Guarded' })
  const c = await addContact(otherAgentId, '+919800107001', 'Intruder')

  const res = await req('POST', `/api/groups/${group.id}/members`, { contact_ids: [c.id] }, otherToken)
  assert.equal(res.status, 400)
  assert.equal((await groupMembers(group.id, agentId)).length, 0)
})
