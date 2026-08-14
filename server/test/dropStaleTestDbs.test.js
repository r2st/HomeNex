// The sweep that reclaims abandoned test databases.
//
// This is the one script in the repo whose job is to DROP DATABASE, so the interesting
// tests are the ones about what it refuses to touch. The pid check is the whole safety
// property: a suite running in another terminal — or in another agent session sharing
// this checkout, which is how several leftovers were stranded in the first place — must
// come back from the sweep with its databases intact.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyTestDbs, dropStaleTestDbs, pidIsAlive } from '../scripts/dropStaleTestDbs.js'
import { BASE, TEST_DB_NAME_RE, TEST_DB_PREFIX, withAdmin } from './helpers.js'

// A stand-in for process.kill: alive pids return, dead ones throw ESRCH, and a pid
// owned by another user throws EPERM.
const killer = (alive, eperm = []) => (pid) => {
  if (eperm.includes(pid)) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
  if (!alive.includes(pid)) throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
}

test('a database whose pid is gone is stale; one whose pid still runs is not', () => {
  const { stale, kept } = classifyTestDbs(
    ['homenex_test_leads_111', 'homenex_test_leads_222'],
    (pid) => pidIsAlive(pid, killer([222])),
  )
  assert.deepEqual(stale, ['homenex_test_leads_111'])
  assert.deepEqual(kept, [{ name: 'homenex_test_leads_222', why: 'pid 222 is still running' }])
})

test('EPERM counts as alive — the process exists, it just belongs to someone else', () => {
  // Getting this backwards is the dangerous direction: it would drop the databases of
  // a suite running under another user account, mid-run.
  assert.equal(pidIsAlive(333, killer([], [333])), true)
  assert.equal(pidIsAlive(333, killer([])), false)
  assert.equal(pidIsAlive(333, killer([333])), true)
})

test('a hand-named database is never swept, however stale it looks', () => {
  // `homenex_test_repro` is a real example: someone created it to hold a reproduction.
  // It has no pid, so there is no evidence it is abandoned, and the sweep says so
  // rather than guessing.
  const { stale, kept } = classifyTestDbs(
    ['homenex_test_repro', 'homenex_test_scratch_by_hand', 'homenex_test_leads_444'],
    (pid) => pidIsAlive(pid, killer([])),
  )
  assert.deepEqual(stale, ['homenex_test_leads_444'])
  assert.deepEqual(
    kept.map((k) => k.name).sort(),
    ['homenex_test_repro', 'homenex_test_scratch_by_hand'],
  )
  assert.ok(kept.every((k) => k.why === 'not a generated test database name'))
})

test('the name pattern matches what createTestDb builds and nothing wider', () => {
  // If these two ever drift, the sweep silently stops recognising leftovers (harmless
  // but useless) or starts recognising things it did not create (not harmless).
  assert.match(`${TEST_DB_PREFIX}badvalues_12345`, TEST_DB_NAME_RE)
  assert.equal(`${TEST_DB_PREFIX}badvalues_12345`.match(TEST_DB_NAME_RE)[1], '12345')

  // The live database itself, above all, must never match.
  assert.doesNotMatch('homenex', TEST_DB_NAME_RE)
  assert.doesNotMatch('homenex_prod_12345', TEST_DB_NAME_RE)
  // Nor a database that merely starts with the prefix but carries no pid.
  assert.doesNotMatch(`${TEST_DB_PREFIX}12345`, TEST_DB_NAME_RE)
  assert.doesNotMatch(`${TEST_DB_PREFIX}leads_12345_extra`, TEST_DB_NAME_RE)
  assert.doesNotMatch(`${TEST_DB_PREFIX}leads_notapid`, TEST_DB_NAME_RE)
})

test('an empty list sweeps nothing rather than erroring', () => {
  assert.deepEqual(classifyTestDbs([], () => false), { stale: [], kept: [] })
})

test('pidIsAlive believes in this very process', () => {
  // The one assertion that exercises the real process.kill rather than a stand-in.
  assert.equal(pidIsAlive(process.pid), true)
})

// --- The drop itself ------------------------------------------------------------
//
// Everything above is the classifier, which is pure. What follows drives the real
// thing against a real postgres, because the classifier being right is only half of
// it: the sweep still has to read the sizes before the databases are gone, honour
// --dry-run, and — the part worth the setup cost — leave the "keep" list alone while
// dropping the rest in the same pass.

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'dropStaleTestDbs.js')

// A pid that is definitely not running: spawn something trivial and wait for it to
// exit. Inventing a large number would work until the day the OS had reused it.
async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise((resolve) => child.on('exit', resolve))
  assert.equal(pidIsAlive(child.pid), false, 'the probe process outlived its own exit event')
  return child.pid
}

const fixtures = []
const makeDb = async (name) => {
  await withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${name}`)
  })
  fixtures.push(name)
  return name
}
const dbExists = async (name) =>
  withAdmin(async (admin) => (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount > 0)

const runScript = (args = []) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.setEncoding('utf8').on('data', (c) => (out += c))
    child.stderr.setEncoding('utf8').on('data', (c) => (out += c))
    child.on('exit', (code) => resolve({ code, out }))
  })

after(async () => {
  for (const name of fixtures) await withAdmin((a) => a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`))
})

test('--dry-run reports exactly what it would drop and drops nothing', async () => {
  const dead = await deadPid()
  const stale = await makeDb(`${TEST_DB_PREFIX}sweepdry_${dead}`)
  // The two the sweep must refuse: one owned by a live process (this one), and one
  // with no pid at all, which means a person named it.
  const live = await makeDb(`${TEST_DB_PREFIX}sweepdry_${process.pid}`)
  const byHand = await makeDb(`${TEST_DB_PREFIX}sweepdryrepro`)

  const lines = []
  const dropped = await dropStaleTestDbs({ dryRun: true, log: (l) => lines.push(l) })

  assert.ok(dropped.some((d) => d.name === stale), 'the abandoned database was not identified')
  assert.ok(!dropped.some((d) => d.name === live || d.name === byHand), 'a live or hand-named database was listed')
  // The size is read in the same pass as the name, because it cannot be read once the
  // database is gone — and the size is the whole reason anyone runs this.
  assert.ok(dropped.find((d) => d.name === stale).bytes > 0, 'no size was captured')
  assert.ok(
    lines.some((l) => l.startsWith(`would drop ${stale}`) && /\d+\.\d MB/.test(l)),
    `expected a "would drop" line with a size, got:\n${lines.join('\n')}`,
  )
  assert.ok(lines.some((l) => l === `keeping ${live} — pid ${process.pid} is still running`))
  assert.ok(lines.some((l) => l === `keeping ${byHand} — not a generated test database name`))

  // The point of --dry-run: all three are still there.
  for (const name of [stale, live, byHand]) {
    assert.equal(await dbExists(name), true, `${name} was dropped during a dry run`)
  }
})

test('a real sweep drops the abandoned database and leaves the other two standing', async () => {
  const dead = await deadPid()
  const stale = await makeDb(`${TEST_DB_PREFIX}sweepreal_${dead}`)
  const live = await makeDb(`${TEST_DB_PREFIX}sweepreal_${process.pid}`)
  const byHand = await makeDb(`${TEST_DB_PREFIX}sweeprealrepro`)

  const lines = []
  const dropped = await dropStaleTestDbs({ log: (l) => lines.push(l) })

  assert.ok(dropped.some((d) => d.name === stale))
  assert.ok(lines.some((l) => l.startsWith(`dropped ${stale}`)))
  assert.equal(await dbExists(stale), false, 'the abandoned database survived the sweep')

  // This is the safety property the whole pid scheme exists for: a suite running in
  // another terminal must come back from someone else's sweep with its databases.
  assert.equal(await dbExists(live), true, 'the sweep dropped a database whose process is still running')
  assert.equal(await dbExists(byHand), true, 'the sweep dropped a database someone named by hand')
})

test('the CLI reclaims what it drops and says how much', async () => {
  const dead = await deadPid()
  const stale = await makeDb(`${TEST_DB_PREFIX}sweepcli_${dead}`)

  const { code, out } = await runScript()
  assert.equal(code, 0, `the sweep exited ${code}:\n${out}`)
  assert.match(out, new RegExp(`dropped ${stale}`))
  assert.match(out, /Reclaimed \d+\.\d MB from \d+ stale test database\(s\) at /)
  assert.match(out, new RegExp(BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the summary must name the cluster it swept')
  assert.equal(await dbExists(stale), false)
})

test('the CLI says so plainly when there is nothing to sweep', async () => {
  // Run straight after the previous test, so everything abandoned has already gone.
  // Anything a parallel test file creates in between is owned by a live process and
  // is kept, so this stays deterministic.
  const { code, out } = await runScript(['--dry-run'])
  assert.equal(code, 0)
  assert.match(out, /No stale test databases\./)
  assert.doesNotMatch(out, /would drop/)
})

test('the CLI names what a dry run would reclaim without reclaiming it', async () => {
  const dead = await deadPid()
  const stale = await makeDb(`${TEST_DB_PREFIX}sweepclidry_${dead}`)

  const { code, out } = await runScript(['--dry-run'])
  assert.equal(code, 0, `the sweep exited ${code}:\n${out}`)
  assert.match(out, new RegExp(`would drop ${stale}`))
  assert.match(out, /Would reclaim \d+\.\d MB from \d+ stale test database\(s\) at /)
  assert.doesNotMatch(out, /^Reclaimed/m, 'a dry run must not claim it reclaimed anything')
  assert.equal(await dbExists(stale), true, 'a dry run dropped a database')
})
