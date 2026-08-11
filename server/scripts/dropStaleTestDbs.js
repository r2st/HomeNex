// Drops the throwaway test databases that earlier runs left behind.
//
//   node scripts/dropStaleTestDbs.js [--dry-run]
//
// Every test file creates `homenex_test_<file>_<pid>` in `before` and drops it in
// `after`. A run that dies in between — a crash, a Ctrl-C, a timeout killed from
// outside — never reaches `after`, and the database survives with a full schema and
// whatever fixture rows the file had written. They accumulate silently: 26 of them,
// ~300MB, had piled up on a dev machine before anyone looked.
//
// What makes this safe to run unattended is the pid in the name. A database is only
// dropped when its pid is not a live process, so a suite running right now — in
// another terminal, or another agent session sharing this checkout, which is exactly
// how several of these were stranded — keeps its own databases. Anything not matching
// `<name>_<pid>` is left alone on purpose: that shape means a person named it, and a
// database someone created by hand to hold a reproduction is not litter.
import { BASE, TEST_DB_NAME_RE, TEST_DB_PREFIX, withAdmin } from '../test/helpers.js'

// True when `pid` belongs to a process we could signal. Signal 0 performs the
// permission and existence checks without delivering anything. EPERM means the
// process exists but belongs to another user — still alive, so still hands off.
export function pidIsAlive(pid, kill = process.kill.bind(process)) {
  try {
    kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

// Splits candidate database names into the ones safe to drop and the ones to keep,
// with the reason. Pure, so the classification is testable without a live postgres.
export function classifyTestDbs(names, isAlive = pidIsAlive) {
  const stale = []
  const kept = []
  for (const name of names) {
    const pid = name.match(TEST_DB_NAME_RE)?.[1]
    if (!pid) kept.push({ name, why: 'not a generated test database name' })
    else if (isAlive(Number(pid))) kept.push({ name, why: `pid ${pid} is still running` })
    else stale.push(name)
  }
  return { stale, kept }
}

export async function dropStaleTestDbs({ dryRun = false, log = console.log } = {}) {
  const dropped = []
  await withAdmin(async (admin) => {
    // pg_size_pretty in the same pass: the size is the whole reason to care, and it
    // cannot be read once the database is gone.
    const { rows } = await admin.query(
      `SELECT datname, pg_database_size(datname) AS bytes
         FROM pg_database
        WHERE datname LIKE $1 || '%'
        ORDER BY bytes DESC`,
      [TEST_DB_PREFIX],
    )
    const sizes = new Map(rows.map((r) => [r.datname, Number(r.bytes)]))
    const { stale, kept } = classifyTestDbs(rows.map((r) => r.datname))

    for (const { name, why } of kept) log(`keeping ${name} — ${why}`)
    for (const name of stale) {
      const mb = (sizes.get(name) / 1024 / 1024).toFixed(1)
      if (dryRun) {
        log(`would drop ${name} (${mb} MB)`)
      } else {
        // FORCE terminates any connection still attached to it: the process that
        // owned this database is gone, but a pooled connection can outlive it.
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
        log(`dropped ${name} (${mb} MB)`)
      }
      dropped.push({ name, bytes: sizes.get(name) })
    }
  })
  return dropped
}

// Only when run directly — importing this from a test must not drop anything.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const dryRun = process.argv.includes('--dry-run')
  const dropped = await dropStaleTestDbs({ dryRun })
  const mb = (dropped.reduce((n, d) => n + d.bytes, 0) / 1024 / 1024).toFixed(1)
  console.log(
    dropped.length
      ? `${dryRun ? 'Would reclaim' : 'Reclaimed'} ${mb} MB from ${dropped.length} stale test database(s) at ${BASE}`
      : 'No stale test databases.',
  )
}
