// What happens when a migration fails halfway through.
//
// Every other suite proves the chain applies cleanly, because every other suite gets
// its database by running it. Nothing proves the other half of the contract: that a
// file which throws on its third statement leaves the database exactly as it was and
// does NOT get a schema_migrations row.
//
// That property is the difference between a failed deploy and a corrupt one. Without
// the rollback, the two statements that did succeed stay, the version row is absent,
// and the next deploy re-runs the file from the top — onto a database that already
// has half of it. The re-run then fails on "column already exists" and the chain is
// stuck until someone edits the production database by hand.
//
// runMigrations takes its directory as an argument for exactly this test; the fixture
// below is written to a temp directory so the real server/migrations is untouched.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
const dbName = await createTestDb('migrationrollback')

const { closePool, query, ready, runMigrations } = await import('../db.js')

let dir

before(async () => {
  await ready
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homenex-mig-'))
})

after(async () => {
  fs.rmSync(dir, { recursive: true, force: true })
  await closePool()
  await dropTestDb(dbName)
})

// A migration that does real work before it fails. The failure is a syntax error
// rather than a constraint violation so it cannot be mistaken for data trouble.
const HALF_GOOD = `
CREATE TABLE mig_rollback_probe (id SERIAL PRIMARY KEY);
ALTER TABLE mig_rollback_probe ADD COLUMN label TEXT;
THIS IS NOT SQL;
`

test('a migration that throws is rolled back whole and left unrecorded', async () => {
  fs.writeFileSync(path.join(dir, '900_half_good.sql'), HALF_GOOD)

  const err = await runMigrations(dir).then(
    () => null,
    (e) => e,
  )
  assert.ok(err, 'a broken migration resolved instead of throwing')
  assert.match(
    err.message,
    /migration 900_half_good\.sql failed:/,
    'the error did not name the file that failed',
  )

  // The table the first statement created must be gone: the whole file is one
  // transaction, so a partial apply is the bug this guards.
  const { rows } = await query(
    `SELECT to_regclass('mig_rollback_probe') IS NOT NULL AS exists`,
  )
  assert.equal(rows[0].exists, false, 'the failed migration left its table behind')

  // And it must not be recorded, or the next deploy would skip it.
  const recorded = await query('SELECT 1 FROM schema_migrations WHERE version = $1', [
    '900_half_good.sql',
  ])
  assert.equal(recorded.rowCount, 0, 'a failed migration was recorded as applied')
})

test('the advisory lock is released, so the next run is not deadlocked', async () => {
  // The lock is taken before the loop and released in a finally. If the throw above
  // had escaped past it, this second call would block forever rather than fail —
  // which on a deploy looks like a hung process, not a failed migration.
  fs.writeFileSync(path.join(dir, '900_half_good.sql'), HALF_GOOD)
  const err = await runMigrations(dir).then(
    () => null,
    (e) => e,
  )
  assert.match(err.message, /migration 900_half_good\.sql failed:/)
})

test('a chain that applies cleanly records every file exactly once', async () => {
  // The success half, from the same entry point, so the two paths are compared like
  // for like. Re-running is a no-op: already-applied files are skipped, which is what
  // makes a half-finished deploy recoverable by simply running it again.
  fs.rmSync(path.join(dir, '900_half_good.sql'))
  fs.writeFileSync(path.join(dir, '901_good.sql'), 'CREATE TABLE mig_ok_probe (id SERIAL PRIMARY KEY);')
  fs.writeFileSync(path.join(dir, '902_good.sql'), 'ALTER TABLE mig_ok_probe ADD COLUMN note TEXT;')
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a migration')

  await runMigrations(dir)
  await runMigrations(dir) // second pass must change nothing

  const { rows } = await query(
    `SELECT version FROM schema_migrations WHERE version LIKE '90%' ORDER BY version`,
  )
  assert.deepEqual(
    rows.map((r) => r.version),
    ['901_good.sql', '902_good.sql'],
    'the non-.sql file was picked up, or a file was applied twice',
  )
})
