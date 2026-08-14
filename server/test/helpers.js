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

// The environment to hand a spawned child, with the coverage directory taken back out.
//
// Under `--experimental-test-coverage` the runner points NODE_V8_COVERAGE at a scratch
// directory and merges every profile it finds there when the run ends. A child spawned
// from a test inherits that variable, so it writes a profile too — for the same source
// files the in-process tests are measuring, from a process that only ever boots the
// server and answers one request.
//
// Merging those is what made the report unstable. V8 only reports functions it has
// actually compiled, and a booted server compiles route handlers the in-process suite
// never brings into its own profile. Each child that lands therefore ADDS uncovered
// functions to the denominator — index.js and leadSources.js swung between 100% and
// 74% depending on how many children flushed before the runner read the directory,
// which under `--test-concurrency=4` is a race with nothing holding it either way.
//
// Nothing is lost by dropping them: the code these children exist to exercise is the
// bootstrap block in index.js, which carries `node:coverage disable` for exactly this
// reason. Anything a child is meant to get *credit* for has to be reachable in-process
// as well — see scripts/dropStaleTestDbs.js, whose CLI summary is exported as main()
// so a test can call it rather than reading it back out of a subprocess profile.
export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.NODE_V8_COVERAGE
  return env
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
