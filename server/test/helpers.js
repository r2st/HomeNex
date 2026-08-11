// Test-database helper: each test file gets its own throwaway PostgreSQL database
// so files can run in parallel. Set PGTEST_URL if your postgres isn't on the default
// port/credentials, e.g. PGTEST_URL=postgres://homenex:homenex@localhost:5433
import { readFileSync } from 'node:fs'
import pg from 'pg'

// `npm test` runs plain `node --test`, which doesn't load server/.env — so without
// this the suite silently falls back to port 5432 and runs against whatever other
// project's postgres happens to be listening there (or fails to authenticate).
// The dev connection string already lives in server/.env; reuse it.
function urlFromDotEnv() {
  try {
    const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
    return env.match(/^DATABASE_URL\s*=\s*(.+)$/m)?.[1].trim().replace(/^["']|["']$/g, '') || null
  } catch {
    return null // no .env checked out (CI) — fall through to the default below
  }
}

export const BASE = (
  process.env.PGTEST_URL ||
  process.env.DATABASE_URL ||
  urlFromDotEnv() ||
  'postgres://homenex:homenex@localhost:5432/homenex'
)
  .replace(/\/[^/]*$/, '')
  .replace(/\/$/, '')

export async function withAdmin(fn) {
  const admin = new pg.Client({ connectionString: `${BASE}/postgres` })
  await admin.connect()
  try {
    return await fn(admin)
  } finally {
    await admin.end()
  }
}

// Every throwaway database is `homenex_test_<file>_<pid>`. The pid suffix is what
// makes the leftovers sweepable: a database whose pid is no longer a running process
// can never be in use, whoever started it. Keep the two in step — dropStaleTestDbs.js
// recognises leftovers by this exact shape, and anything not matching it (a database
// someone created by hand to reproduce a bug) is deliberately left alone.
export const TEST_DB_PREFIX = 'homenex_test_'
export const TEST_DB_NAME_RE = new RegExp(`^${TEST_DB_PREFIX}[a-z0-9]+_(\\d+)$`)

// Creates a fresh database and points DATABASE_URL at it. Call BEFORE importing
// ../index.js or ../db.js so the pool connects to the test database.
export async function createTestDb(name) {
  const dbName = `${TEST_DB_PREFIX}${name}_${process.pid}`
  await withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${dbName}`)
  })
  process.env.DATABASE_URL = `${BASE}/${dbName}`
  return dbName
}

export async function dropTestDb(dbName) {
  await withAdmin((admin) => admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`))
}
