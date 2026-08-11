// The sweep that reclaims abandoned test databases.
//
// This is the one script in the repo whose job is to DROP DATABASE, so the interesting
// tests are the ones about what it refuses to touch. The pid check is the whole safety
// property: a suite running in another terminal — or in another agent session sharing
// this checkout, which is how several leftovers were stranded in the first place — must
// come back from the sweep with its databases intact.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyTestDbs, pidIsAlive } from '../scripts/dropStaleTestDbs.js'
import { TEST_DB_NAME_RE, TEST_DB_PREFIX } from './helpers.js'

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
