// The in-batch dedupe key createNotificationsFor builds, and the separator it uses.
//
// The function collapses duplicates on (agent_id, dedupe_key) before the INSERT, by
// joining the pair into one string. The joining character is load-bearing: if it can
// occur inside either half, two DIFFERENT pairs can flatten to the same string and one
// of them is silently dropped. Agent 1 with key "2:stale" and agent 12 with key
// ":stale" would collide on a ":" separator, and the caller would be told it wrote two
// rows when it wrote one.
//
// The separator is NUL, which cannot appear in an id or in any key the schedulers
// build. That used to be written as a literal 0x00 byte in db.js, which made grep(1)
// classify the whole file as binary and drop every match in it; it is now written
// as a backslash-u escape, which is the same character to the engine and the same
// behaviour. This file pins that behaviour, so the separator can never be "tidied"
// into a printable one.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
const dbName = await createTestDb('notifdedupe')

const db = await import('../db.js')
const { hashPassword } = await import('../auth.js')

let a1
let a12

before(async () => {
  await db.ready
  a1 = await db.createAgent('Dedupe One', '+919866000001', null, hashPassword('secret123'))
  a12 = await db.createAgent('Dedupe Two', '+919866000012', null, hashPassword('secret123'))
})

after(async () => {
  await db.closePool()
  await dropTestDb(dbName)
})

const notif = (agent_id, dedupe_key) => ({
  agent_id,
  type: 'stale_followup',
  title: 'Follow up',
  dedupe_key,
})

test('db.js carries no literal NUL byte', () => {
  // A raw 0x00 anywhere in the file makes `grep -r` report "binary file matches" and
  // print nothing, so a search for any symbol in the largest module in the server comes
  // back empty. The escape reads identically to the engine and keeps the file text.
  const raw = readFileSync(new URL('../db.js', import.meta.url))
  assert.equal(raw.includes(0x00), false, 'server/db.js contains a literal NUL byte again')
})

test('two identical (agent, key) pairs in one batch are written once', async () => {
  const written = await db.createNotificationsFor([
    notif(a1.id, 'lead-7-stale'),
    notif(a1.id, 'lead-7-stale'),
  ])
  assert.equal(written, 1, 'the same pair twice was counted twice')

  const rows = await db.listNotifications(a1.id)
  assert.equal(rows.filter((r) => r.dedupe_key === 'lead-7-stale').length, 1)
})

test('the same key for two different agents is two rows, not one', async () => {
  // Two agents watching the same shared lead pool legitimately produce the same key.
  // Collapsing on the key alone would drop one agent's notification entirely.
  const written = await db.createNotificationsFor([
    notif(a1.id, 'pool-lead-42'),
    notif(a12.id, 'pool-lead-42'),
  ])
  assert.equal(written, 2)

  for (const agent of [a1, a12]) {
    const rows = await db.listNotifications(agent.id)
    assert.equal(rows.filter((r) => r.dedupe_key === 'pool-lead-42').length, 1, `agent ${agent.id} lost theirs`)
  }
})

test('pairs that would collide on a printable separator stay distinct', async () => {
  // This is the case the separator exists for. Joined on ":" both pairs become
  // "1:2:collide"; joined on NUL they cannot become the same string, because neither
  // an id nor a key can contain a NUL. Both rows must be written.
  const written = await db.createNotificationsFor([
    notif(a1.id, `${a12.id}:collide`),
    notif(a12.id, ':collide'),
  ])
  assert.equal(written, 2, 'two distinct pairs were collapsed into one — the separator leaked')

  const one = await db.listNotifications(a1.id)
  const two = await db.listNotifications(a12.id)
  assert.ok(one.some((r) => r.dedupe_key === `${a12.id}:collide`))
  assert.ok(two.some((r) => r.dedupe_key === ':collide'))
})

test('rows with no dedupe_key are never collapsed against each other', async () => {
  // The unique index is partial (WHERE dedupe_key IS NOT NULL), and so is the in-batch
  // check: two keyless notifications are two separate things to tell the agent about.
  const written = await db.createNotificationsFor([
    { agent_id: a1.id, type: 'system', title: 'First' },
    { agent_id: a1.id, type: 'system', title: 'Second' },
  ])
  assert.equal(written, 2)
})
