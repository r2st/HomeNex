// Test-database helper: each test file gets its own throwaway PostgreSQL database
// so files can run in parallel. Set PGTEST_URL if your postgres isn't on the default
// port/credentials, e.g. PGTEST_URL=postgres://homenex:homenex@localhost:5433
import pg from 'pg'

const BASE = (
  process.env.PGTEST_URL ||
  process.env.DATABASE_URL?.replace(/\/[^/]*$/, '') ||
  'postgres://homenex:homenex@localhost:5432'
).replace(/\/$/, '')

async function withAdmin(fn) {
  const admin = new pg.Client({ connectionString: `${BASE}/postgres` })
  await admin.connect()
  try {
    return await fn(admin)
  } finally {
    await admin.end()
  }
}

// Creates a fresh database and points DATABASE_URL at it. Call BEFORE importing
// ../index.js or ../db.js so the pool connects to the test database.
export async function createTestDb(name) {
  const dbName = `homenex_test_${name}_${process.pid}`
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
