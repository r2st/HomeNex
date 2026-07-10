// One-time data import from the old SQLite database into PostgreSQL.
//
//   node scripts/import-sqlite.js [path/to/homenex.db]
//
// Reads the legacy SQLite file (default: server/homenex.db), copies all rows into
// the PostgreSQL database at DATABASE_URL preserving primary keys, then resets the
// id sequences. Refuses to run against a PostgreSQL database that already has
// agents unless --force is passed (rows with conflicting ids are then skipped).
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2).filter((a) => a !== '--force')
const force = process.argv.includes('--force')
const sqliteFile = args[0] || path.join(__dirname, '..', 'homenex.db')

const sqlite = new DatabaseSync(sqliteFile, { readOnly: true })
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL || 'postgres://homenex:homenex@localhost:5432/homenex',
})

// Legacy SQLite datetime('now') strings are UTC without a zone marker; make the
// session parse them as UTC instead of server-local time.
const TABLES = [
  { name: 'agents', cols: ['id', 'name', 'phone', 'email', 'password_hash', 'wa_phone_number_id', 'wa_phone_number', 'waba_status', 'waba_registered_at', 'meta_waba_id', 'is_admin', 'created_at'] },
  { name: 'contacts', cols: ['id', 'agent_id', 'phone', 'name', 'notes', 'created_at'] },
  { name: 'leads', cols: ['id', 'agent_id', 'wa_id', 'name', 'phone', 'source', 'temp', 'score', 'config', 'config_note', 'locality', 'location_note', 'budget_min_l', 'budget_max_l', 'budget_note', 'timeline', 'timeline_note', 'ai_summary', 'next_step', 'score_breakdown', 'ai_enabled', 'first_response_s', 'created_at', 'updated_at'] },
  { name: 'messages', cols: ['id', 'lead_id', 'role', 'text', 'wa_message_id', 'created_at'] },
  { name: 'activity', cols: ['id', 'agent_id', 'lead_id', 'kind', 'text', 'created_at'] },
  { name: 'network_posts', cols: ['id', 'type', 'broker', 'firm', 'text', 'config', 'locality', 'budget_min_l', 'budget_max_l', 'created_at'] },
  { name: 'meta', cols: ['key', 'value'], noSequence: true },
]

// Old SQLite rows can predate later ALTER TABLEs and carry NULLs in columns
// that are NOT NULL in PostgreSQL; fill them with the schema defaults.
const DEFAULTS = {
  agents: { waba_status: 'none', is_admin: 0 },
  leads: { ai_enabled: 1 },
}

try {
  await client.connect()
  await client.query(`SET TIME ZONE 'UTC'`)

  const existing = await client.query('SELECT COUNT(*)::int AS n FROM agents')
  if (existing.rows[0].n > 0 && !force) {
    console.error(
      `Target database already has ${existing.rows[0].n} agents. Re-run with --force to import anyway (conflicting ids are skipped).`,
    )
    process.exit(1)
  }

  await client.query('BEGIN')
  for (const { name, cols, noSequence } of TABLES) {
    let rows = []
    try {
      rows = sqlite.prepare(`SELECT * FROM ${name}`).all()
    } catch {
      console.log(`${name}: not present in SQLite file, skipped`)
      continue
    }
    let copied = 0
    for (const row of rows) {
      const values = cols.map((c) => row[c] ?? DEFAULTS[name]?.[c] ?? null)
      const placeholders = cols.map((_, i) => `$${i + 1}`)
      const conflictKey = noSequence ? '(key)' : '(id)'
      const res = await client.query(
        `INSERT INTO ${name} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})
         ON CONFLICT ${conflictKey} DO NOTHING`,
        values,
      )
      copied += res.rowCount
    }
    if (!noSequence && rows.length) {
      await client.query(
        `SELECT setval(pg_get_serial_sequence('${name}', 'id'), (SELECT COALESCE(MAX(id), 1) FROM ${name}))`,
      )
    }
    console.log(`${name}: ${copied}/${rows.length} rows imported`)
  }
  await client.query('COMMIT')
  console.log('Import complete.')
} catch (err) {
  await client.query('ROLLBACK').catch(() => {})
  console.error('Import failed, rolled back:', err.message)
  process.exitCode = 1
} finally {
  await client.end()
  sqlite.close()
}
