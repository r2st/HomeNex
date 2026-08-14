// Why the coverage report used to move when the code did not.
//
// `npm run test:coverage` runs `node --test --experimental-test-coverage`, which points
// NODE_V8_COVERAGE at a scratch directory, lets every test process write a V8 profile
// into it, and merges the lot when the run ends. Any process that inherits that
// variable joins the merge — including children a test spawns itself.
//
// That merge is not additive in the direction you would expect. V8 reports the
// functions it has compiled, so a profile from a booted server contributes route
// handlers that the in-process suite never compiled at all: they arrive as new
// entries with a zero count and enlarge the denominator. Whether they arrived was a
// race between the child flushing on exit and the runner reading the directory, so
// index.js and leadSources.js swung between 100% and 74% across runs of identical
// code, and `--test-concurrency=4` made the race easy to lose.
//
// The fix is one line in helpers.js — childEnv() takes NODE_V8_COVERAGE back out — and
// the fix is only as good as its use at every spawn site. Hence this file: one test
// for the helper, and one that walks the suite looking for a child spawned without it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { childEnv } from './helpers.js'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))

test('childEnv hands on the environment with the coverage directory removed', () => {
  const env = childEnv({ HARNESS_MODE: 'boot' })

  assert.equal(env.NODE_V8_COVERAGE, undefined)
  assert.equal(env.HARNESS_MODE, 'boot', 'the overrides a caller asked for must survive')
  assert.equal(env.PATH, process.env.PATH, 'the rest of the environment must be handed on intact')
})

test('childEnv removes the coverage directory even when a caller passes one explicitly', () => {
  // The delete has to come after the spread, not before it. Getting that order wrong
  // leaves the variable in place for anyone who names it, which is the one call shape
  // most likely to be reaching for it by mistake.
  assert.equal(childEnv({ NODE_V8_COVERAGE: '/tmp/somewhere' }).NODE_V8_COVERAGE, undefined)
})

test('a child really does inherit the coverage directory unless it is taken out', async () => {
  // The premise of the whole fix, asserted rather than assumed — and asserted in a way
  // that works whether or not this run is itself under --experimental-test-coverage,
  // by setting the variable here instead of relying on the runner having set it.
  const sees = (env) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ['-p', 'process.env.NODE_V8_COVERAGE ?? "unset"'], {
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      let out = ''
      child.stdout.setEncoding('utf8').on('data', (c) => (out += c))
      child.on('exit', () => resolve(out.trim()))
    })

  assert.equal(
    await sees({ ...process.env, NODE_V8_COVERAGE: '/tmp/cov-probe' }),
    '/tmp/cov-probe',
    'a plain env spread hands the coverage directory to the child',
  )
  assert.equal(await sees(childEnv({ NODE_V8_COVERAGE: '/tmp/cov-probe' })), 'unset')
})

test('every child this suite spawns is given childEnv', () => {
  // A spawn added without it would not fail anything — it would quietly put the report
  // back on the wrong side of a race, and the number would only look wrong to whoever
  // happened to run coverage twice. So the guard has to be a test.
  //
  // Deliberately textual: the alternative is parsing, and the shape being guarded is a
  // one-line habit at the call site rather than anything a type could carry.
  const CALL = /\b(?:spawn|spawnSync|execFile|execFileSync|fork)\(\s*process\.execPath/g
  const offenders = []

  // This file is excluded: its own spawn takes the environment as a parameter, because
  // proving the inheritance needs a child that *does* see the variable.
  const SELF = path.basename(fileURLToPath(import.meta.url))
  const files = [
    ...readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.js') && f !== SELF),
    ...readdirSync(path.join(TEST_DIR, 'fixtures')).map((f) => path.join('fixtures', f)),
  ]

  for (const file of files) {
    const src = readFileSync(path.join(TEST_DIR, file), 'utf8')
    for (const m of src.matchAll(CALL)) {
      // The options object always follows the argv within a few lines. Read a generous
      // window rather than balancing braces — a false pass needs childEnv to appear in
      // an unrelated call right below, which is not a way anyone writes this.
      const window = src.slice(m.index, m.index + 600)
      if (!window.includes('childEnv')) {
        offenders.push(`${file}:${src.slice(0, m.index).split('\n').length}`)
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these spawn a node child with an inherited NODE_V8_COVERAGE, which makes the ` +
      `coverage report race:\n  ${offenders.join('\n  ')}\nPass env: childEnv({…}) instead.`,
  )
})

test('the guard above would notice a spawn that skipped childEnv', () => {
  // The guard is a regex over source text, so it is worth proving it can fail: a
  // pattern that matches nothing would pass this suite forever while guarding nothing.
  const CALL = /\b(?:spawn|spawnSync|execFile|execFileSync|fork)\(\s*process\.execPath/g
  const bad = `const child = spawn(process.execPath, [SCRIPT], { stdio: 'ignore' })`
  const good = `const child = spawn(process.execPath, [SCRIPT], { stdio: 'ignore', env: childEnv() })`

  assert.equal([...bad.matchAll(CALL)].length, 1, 'the call pattern no longer matches a spawn')
  assert.ok(!bad.slice(bad.match(CALL).index, 600).includes('childEnv'))
  assert.ok(good.slice(good.match(CALL).index, 600).includes('childEnv'))
})
